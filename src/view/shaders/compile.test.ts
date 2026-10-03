// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Compiles and links every shader program of the engine on a real WebGL2 implementation
 *
 * The other tests run with a stub GL, where a GLSL typo still passes and only shows up as a
 * map with nothing drawn. This test builds the source of every program the way the renderers
 * do, with the preludes maplibre actually hands to a custom layer (Mercator and globe), and
 * gives them to the WebGL2 of headless Chromium (ANGLE on SwiftShader), which compiles and
 * links them.
 *
 * - The preludes are taken from a maplibre map running in the same page, so a change of
 *   maplibre's prelude is caught as well
 * - The sources are recorded from the renderers themselves through a GL that records
 *   `shaderSource` and `linkProgram`, so what is compiled is exactly what the renderers build
 * - A guard counts the `createProgram(` call sites of `src/view`, so a new program cannot be
 *   added without adding it here
 *
 * The browser is the one playwright-core installs (`npx playwright-core install
 * chromium-headless-shell`).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTimeout } from '../../test-utils.js';
import { AnchoredOutlineRenderer } from '../renderers/anchored-outline.js';
import { SDFLineRenderer } from '../renderers/line/sdf-line.js';
import { PointInstanceRenderer } from '../renderers/point/point-instance.js';
import { PointShapeRenderer } from '../renderers/point/point-shape.js';
import { PolygonBatchRenderer } from '../renderers/polygon/batch.js';
import { FillShaderManager } from '../renderers/polygon/fill.js';
import { SDFPolygonRenderer } from '../renderers/polygon/sdf-polygon.js';
import { StrokeRenderer } from '../renderers/stroke.js';
import { DemAtlas } from '../terrain/dem-atlas.js';
import { QuadDrapeRenderer } from '../terrain/drape/quad.js';
import { DrapeRenderer } from '../terrain/drape/renderer.js';
import { SAMPLER_PRECISION_GLSL, type ShaderData } from './helpers.js';
import { QuadShader } from './quad.js';

/** One program as the renderers give it to GL */
interface RecordedProgram {
  name: string;
  vertex: string;
  fragment: string;
}

/** The result of compiling and linking one program */
interface CompileResult {
  name: string;
  ok: boolean;
  log: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const srcView = join(here, '..');
const maplibreDist = join(
  dirname(createRequire(import.meta.url).resolve('maplibre-gl/package.json')),
  'dist',
);
const ORIGIN = 'http://glsl.test';

/**
 * A WebGL2 context that accepts every call and records the shader sources of each program
 *
 * The renderers only need their calls to succeed; what is kept is the pair of sources attached
 * to each program when it is linked.
 */
function createRecordingGl(): { gl: WebGL2RenderingContext; programs: RecordedProgram[] } {
  const programs: RecordedProgram[] = [];
  const sources = new Map<object, string>();
  const kinds = new Map<object, number>();
  const attached = new Map<object, object[]>();
  const constants = new Map<string, number>();
  let label = '';

  const constantOf = (name: string): number => {
    let value = constants.get(name);
    if (value === undefined) {
      value = 0x1000 + constants.size;
      constants.set(name, value);
    }
    return value;
  };

  const functions: Record<string, (...args: never[]) => unknown> = {
    createShader: (type: number) => {
      const shader = { kind: 'shader' };
      kinds.set(shader, type);
      return shader;
    },
    shaderSource: (shader: object, source: string) => {
      sources.set(shader, source);
    },
    createProgram: () => ({ kind: 'program' }),
    attachShader: (program: object, shader: object) => {
      const list = attached.get(program) ?? [];
      list.push(shader);
      attached.set(program, list);
    },
    linkProgram: (program: object) => {
      const shaders = attached.get(program) ?? [];
      const vertex = shaders.find((s) => kinds.get(s) === constantOf('VERTEX_SHADER'));
      const fragment = shaders.find((s) => kinds.get(s) === constantOf('FRAGMENT_SHADER'));
      programs.push({
        name: `${label} #${programs.filter((p) => p.name.startsWith(label)).length + 1}`,
        vertex: (vertex && sources.get(vertex)) ?? '',
        fragment: (fragment && sources.get(fragment)) ?? '',
      });
    },
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getUniformLocation: () => ({}),
    getAttribLocation: () => 0,
    getUniformBlockIndex: () => 0,
    checkFramebufferStatus: () => constantOf('FRAMEBUFFER_COMPLETE'),
    getParameter: () => 4096,
    getExtension: () => null,
    getSupportedExtensions: () => [],
    isContextLost: () => false,
  };

  const gl = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === '__label') return label;
        if (/^[A-Z0-9_]+$/.test(prop)) return constantOf(prop);
        if (prop === 'canvas') return { width: 800, height: 600, clientWidth: 800 };
        if (prop === 'drawingBufferWidth') return 800;
        if (prop === 'drawingBufferHeight') return 600;
        if (prop.startsWith('create') && !(prop in functions)) return () => ({ kind: prop });
        return functions[prop] ?? (() => undefined);
      },
      set(_target, prop, value) {
        if (prop === '__label') label = String(value);
        return true;
      },
    },
  ) as unknown as WebGL2RenderingContext;

  return { gl, programs };
}

/** The part of the maplibre Map the renderers read while building their programs */
const mapStub = {
  getCanvas: () => ({ width: 800, height: 600, clientWidth: 800, clientHeight: 600 }),
  getZoom: () => 14,
  getTerrain: () => null,
  transform: { tileSize: 512 },
} as unknown as MapLibreMap;

/**
 * Builds every program of the engine for one prelude and returns their sources
 *
 * Each entry names the renderer; the count of entries is checked against the call sites.
 */
function recordPrograms(shaderData: ShaderData): RecordedProgram[] {
  const { gl, programs } = createRecordingGl();
  const withLabel = (name: string, build: () => void): void => {
    (gl as unknown as { __label: string }).__label = `${shaderData.variantName}/${name}`;
    build();
  };

  withLabel('StrokeRenderer', () => new StrokeRenderer(mapStub, gl).ensureShader(shaderData));
  withLabel('AnchoredOutlineRenderer', () =>
    new AnchoredOutlineRenderer(mapStub, gl).ensureShader(shaderData),
  );
  withLabel('PointInstanceRenderer', () =>
    new PointInstanceRenderer(mapStub, gl).ensureShader(shaderData),
  );
  withLabel('PointShapeRenderer', () =>
    new PointShapeRenderer(mapStub, gl).ensureShader(shaderData),
  );
  withLabel('SDFPolygonRenderer', () => new SDFPolygonRenderer(gl).ensureShader(shaderData));
  withLabel('PolygonBatchRenderer', () => new PolygonBatchRenderer(gl).ensureShader(shaderData));
  withLabel('FillShaderManager', () => new FillShaderManager(gl).ensureShader(shaderData));
  withLabel('SDFLineRenderer', () => new SDFLineRenderer(mapStub, gl).ensureShader(shaderData));
  withLabel('QuadShader', () => new QuadShader(gl).ensureShader(shaderData));
  withLabel('DrapeRenderer', () => {
    expect(new DrapeRenderer(gl).ensure(shaderData, 16)).toBe(true);
  });
  withLabel('QuadDrapeRenderer', () => {
    const quad = new QuadDrapeRenderer(gl);
    expect(quad.ensure(shaderData, 16)).toBe(true);
    expect(quad.ensureSurface(shaderData, 16)).toBe(true);
  });
  withLabel('DemAtlas', () => {
    expect(new DemAtlas(gl).ensureProgram()).toBe(true);
  });

  return programs;
}

/** Every non-test TypeScript file under a directory */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) files.push(path);
  }
  return files;
}

/** Serves the maplibre build to the page, so the page can run a real map */
async function openPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(browserTimeout(30_000));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><div id="map" style="width:256px;height:256px"></div>' +
          '<script type="module">' +
          "import * as maplibre from '/maplibre-gl.mjs';" +
          "maplibre.setWorkerUrl('/maplibre-gl-worker.mjs');" +
          'window.maplibre = maplibre;' +
          '</script>',
      });
    }
    return route.fulfill({
      contentType: 'text/javascript',
      body: readFileSync(join(maplibreDist, path.slice(1))),
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => 'maplibre' in window);
  return page;
}

/**
 * The preludes maplibre hands to a custom layer, by projection
 *
 * A background-only map is rendered once in Mercator and once on the globe, and a custom layer
 * records the `shaderData` of each.
 */
async function capturePreludes(page: Page): Promise<ShaderData[]> {
  return page.evaluate(async (renderTimeout) => {
    const maplibre = (window as unknown as { maplibre: typeof import('maplibre-gl') }).maplibre;
    const map = new maplibre.Map({
      container: 'map',
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#fff' } }],
      },
      center: [0, 0],
      zoom: 1,
    });
    const seen = new Map<string, ShaderData>();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('maplibre did not render')), renderTimeout);
      map.on('load', () => {
        map.addLayer({
          id: 'capture',
          type: 'custom',
          renderingMode: '3d',
          render(_gl: unknown, options: { shaderData: ShaderData }) {
            const { variantName, vertexShaderPrelude, define } = options.shaderData;
            seen.set(variantName, { variantName, vertexShaderPrelude, define });
            if (seen.size >= 2) {
              clearTimeout(timer);
              resolve();
            } else {
              map.setProjection({ type: 'globe' });
              map.triggerRepaint();
            }
          },
        });
      });
    });
    map.remove();
    return [...seen.values()];
  }, browserTimeout(15_000));
}

/** Compiles and links the programs on the page's WebGL2 */
async function compileOnPage(page: Page, programs: RecordedProgram[]): Promise<CompileResult[]> {
  return page.evaluate((list) => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) throw new Error('WebGL2 is not available in the browser');
    const compile = (type: number, source: string): [WebGLShader, string] => {
      const shader = gl.createShader(type) as WebGLShader;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
      return [shader, ok ? '' : `compile: ${gl.getShaderInfoLog(shader)}`];
    };
    return list.map(({ name, vertex, fragment }) => {
      const [vs, vsLog] = compile(gl.VERTEX_SHADER, vertex);
      const [fs, fsLog] = compile(gl.FRAGMENT_SHADER, fragment);
      if (vsLog || fsLog) return { name, ok: false, log: `${vsLog} ${fsLog}`.trim() };
      const program = gl.createProgram() as WebGLProgram;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      const ok = gl.getProgramParameter(program, gl.LINK_STATUS) === true;
      return { name, ok, log: ok ? '' : `link: ${gl.getProgramInfoLog(program)}` };
    });
  }, programs);
}

describe('shader programs on a real WebGL2', () => {
  let browser: Browser | null = null;
  let page: Page;
  let preludes: ShaderData[] = [];

  beforeAll(async () => {
    try {
      browser = await chromium.launch({
        args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
      });
    } catch (error) {
      throw new Error(
        `Headless Chromium could not be started. Install it with ` +
          `\`npx playwright-core install chromium-headless-shell\`.\n${String(error)}`,
      );
    }
    page = await openPage(browser);
    preludes = await capturePreludes(page);
  }, browserTimeout(60_000));

  afterAll(async () => {
    await browser?.close();
  });

  it('receives the Mercator and the globe prelude from maplibre', () => {
    expect(preludes.map((p) => p.variantName).sort()).toEqual(['globe', 'mercator']);
  });

  it('builds a program at every createProgram call site of src/view', () => {
    const sites = sourceFiles(srcView).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/(?<!function |[.\w])createProgram\(/g)].map(
        () => file,
      ),
    );
    // 11 renderers with one program each and the drape of a quad with two (image and paper);
    // the image and the paper share one call site
    expect(sites).toHaveLength(12);
    const programs = recordPrograms(preludes[0]);
    expect(programs).toHaveLength(13);
  });

  it(
    'compiles and links every program with the Mercator and the globe prelude',
    async () => {
      const programs = preludes.flatMap((prelude) => recordPrograms(prelude));
      expect(programs.length).toBe(26);
      const failures = (await compileOnPage(page, programs)).filter((result) => !result.ok);
      expect(failures).toEqual([]);
    },
    browserTimeout(30_000),
  );

  it('gives every stage of every program highp samplers', () => {
    for (const program of recordPrograms(preludes[0])) {
      expect(program.vertex, program.name).toContain(SAMPLER_PRECISION_GLSL);
      expect(program.fragment, program.name).toContain(SAMPLER_PRECISION_GLSL);
    }
  });

  it('reports a broken shader (the check itself works)', async () => {
    const [program] = recordPrograms(preludes[0]);
    const broken = { ...program, name: 'broken', fragment: program.fragment.replace(';', '') };
    const [result] = await compileOnPage(page, [broken]);
    expect(result.ok).toBe(false);
  });
});
