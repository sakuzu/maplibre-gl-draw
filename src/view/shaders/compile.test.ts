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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  capturePreludes,
  launchWebGlBrowser,
  openMaplibrePage,
} from '../../test-support/webgl-page.js';
import { browserTimeout, gpuOf } from '../../test-utils.js';
import { GpuLedger } from '../gpu-ledger.js';
import { AnchoredOutlineRenderer } from '../renderers/anchored-outline.js';
import { SDFLineRenderer } from '../renderers/line/sdf-line.js';
import { PointInstanceRenderer } from '../renderers/point/point-instance.js';
import { PointShapeRenderer } from '../renderers/point/point-shape.js';
import { PolygonBatchRenderer } from '../renderers/polygon/batch.js';
import { FillShaderManager } from '../renderers/polygon/fill.js';
import { SDFPolygonRenderer } from '../renderers/polygon/sdf-polygon.js';
import { RowsRenderer } from '../renderers/rows/rows-renderer.js';
import { StrokeRenderer } from '../renderers/stroke.js';
import { DemAtlas } from '../terrain/dem-atlas.js';
import { QuadDrapeRenderer } from '../terrain/drape/quad.js';
import { DrapeRenderer } from '../terrain/drape/renderer.js';
import { BulkFramesRenderer } from '../ui/bulk-frames.js';
import { SAMPLER_PRECISION_GLSL, type ShaderData } from './helpers.js';
import { QuadImageContent, QuadShader } from './quad.js';

/**
 * A content of a draped quad that reads its texture in a loop, with `textureGrad` and the
 * derivatives the library gives it
 */
const BLURRED_CONTENT = {
  glsl: `
uniform sampler2D u_blur_texture;
uniform vec2 u_blur_step;

vec4 quadDrapeColor(vec2 uv, vec2 uvDx, vec2 uvDy, float shade) {
    vec4 sum = vec4(0.0);
    for (int i = -2; i <= 2; i++) {
        vec2 at = clamp(uv + float(i) * u_blur_step, 0.0, 1.0);
        sum += textureGrad(u_blur_texture, at, uvDx, uvDy);
    }
    vec4 color = sum / 5.0;
    return vec4(color.rgb * shade * color.a, color.a);
}
`,
  bind: () => {},
};

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

  withLabel('StrokeRenderer', () =>
    new StrokeRenderer(mapStub, gl, new GpuLedger()).ensureShader(shaderData),
  );
  withLabel('AnchoredOutlineRenderer', () =>
    new AnchoredOutlineRenderer(mapStub, gl, new GpuLedger()).ensureShader(shaderData),
  );
  withLabel('PointInstanceRenderer', () =>
    new PointInstanceRenderer(mapStub, gl, new GpuLedger()).ensureShader(shaderData),
  );
  withLabel('PointInstanceRenderer (rows)', () => {
    const renderer = new PointInstanceRenderer(mapStub, gl, new GpuLedger());
    renderer.ensureShader(shaderData);
    expect(renderer.ensureRowProgram()).toBe(true);
  });
  withLabel('PointShapeRenderer', () =>
    new PointShapeRenderer(mapStub, gl, new GpuLedger()).ensureShader(shaderData),
  );
  withLabel('SDFPolygonRenderer', () =>
    new SDFPolygonRenderer(gl, { gpu: new GpuLedger() }).ensureShader(shaderData),
  );
  withLabel('SDFPolygonRenderer (rows)', () => {
    const renderer = new SDFPolygonRenderer(gl, { gpu: new GpuLedger() });
    renderer.ensureShader(shaderData);
    expect(renderer.ensureRowProgram()).toBe(true);
  });
  withLabel('PolygonBatchRenderer', () =>
    new PolygonBatchRenderer(gl, { gpu: new GpuLedger() }).ensureShader(shaderData),
  );
  withLabel('FillShaderManager', () =>
    new FillShaderManager(gl, new GpuLedger()).ensureShader(shaderData),
  );
  withLabel('SDFLineRenderer', () =>
    new SDFLineRenderer(mapStub, gl, new GpuLedger()).ensureShader(shaderData),
  );
  withLabel('SDFLineRenderer (rows)', () => {
    const renderer = new SDFLineRenderer(mapStub, gl, new GpuLedger());
    renderer.ensureShader(shaderData);
    expect(renderer.ensureRowProgram()).toBe(true);
  });
  withLabel('RowsRenderer', () => {
    const renderer = new RowsRenderer(mapStub, gl, new GpuLedger());
    renderer.ensureShader(shaderData);
    expect(renderer.ready).toBe(true);
    // The variant whose polygons and lines read the ground seen at each pixel (the drape band)
    expect(renderer.groundReady).toBe(true);
  });
  withLabel('QuadShader', () => new QuadShader(gpuOf(gl)).ensureShader(shaderData));
  withLabel('DrapeRenderer', () => {
    expect(new DrapeRenderer(gl, new GpuLedger()).ensure(shaderData, 16)).toBe(true);
  });
  withLabel('DrapeRenderer (rows)', () => {
    expect(new DrapeRenderer(gl, new GpuLedger(), true).ensure(shaderData, 16)).toBe(true);
  });
  withLabel('QuadDrapeRenderer', () => {
    const quad = new QuadDrapeRenderer(gl, new GpuLedger());
    expect(quad.ensure(new QuadImageContent(), shaderData, 16)).toBe(true);
    // A content as the contract allows it: textures read in a loop with the derivatives given
    expect(quad.ensure(BLURRED_CONTENT, shaderData, 16)).toBe(true);
  });
  withLabel('DemAtlas', () => {
    expect(new DemAtlas(gl, new GpuLedger()).ensureProgram()).toBe(true);
  });
  withLabel('BulkFramesRenderer', () => {
    const renderer = new BulkFramesRenderer(gl, new GpuLedger());
    renderer.ensureShader(shaderData);
    expect(renderer.ensureProgram()).toBe(true);
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
    browser = await launchWebGlBrowser();
    page = await openMaplibrePage(browser);
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
    // 12 renderers with one program each (the frames of the features selected in bulk among
    // them; the drape builds the variant that draws the rows at the same call site, recorded
    // apart) and the drape of a quad with one for each content (an image and a content that reads
    // its texture in a loop); the contents share one call site. The point, the line and the polygon
    // renderers also build the variant that draws rows held as columns at the same call site;
    // each variant is recorded with the program it is a variant of. The renderer of the rows
    // drawn in one draw links its programs without waiting for them (`gl.createProgram`), which
    // the count of the call sites does not see; they are recorded among the programs: one for
    // the flat map and one for the globe, from its own preludes, whatever prelude maplibre gives,
    // and the variant whose polygons and lines read the ground seen at each pixel for the prelude
    // given
    expect(sites).toHaveLength(13);
    const programs = recordPrograms(preludes[0]);
    expect(programs).toHaveLength(24);
  });

  it('builds every program that moves rows with their moving set', () => {
    // The variants that draw rows held as columns and the frames of the rows selected in bulk
    // turn the GLSL of the state of the rows on and move a dragged row as they draw it: a call of
    // `rowStateMove` besides its definition (the GLSL of the state is in every program, off)
    const moving = recordPrograms(preludes[0])
      .filter(
        (program) =>
          /^#define TABLE_ROWS$/m.test(program.vertex) &&
          program.vertex.split('rowStateMove(').length > 2,
      )
      .map((program) => program.name.replace(/^[^/]+\//, ''));
    expect(moving.sort()).toEqual([
      'BulkFramesRenderer #1',
      'PointInstanceRenderer (rows) #2',
      'RowsRenderer #1',
      'RowsRenderer #2',
      'RowsRenderer #3',
      'SDFLineRenderer (rows) #2',
      'SDFPolygonRenderer (rows) #2',
    ]);
  });

  it(
    'compiles and links every program with the Mercator and the globe prelude',
    async () => {
      const programs = preludes.flatMap((prelude) => recordPrograms(prelude));
      expect(programs.length).toBe(48);
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

  it('takes no number out of an attribute with an operation GLSL ES 3.00 lets err', () => {
    // A number an attribute carries (a row, a kind, an index) is read as it is (`int(a_x)`,
    // `int(a_x + 0.5)`: exact for the integers a float holds) or from an integer attribute with
    // shifts and masks. A division may err by 2.5 ULP, and `floor`, `fract` and `mod` of it move
    // to the next integer on a GPU that uses the freedom (SwiftShader divides exactly)
    const code = (source: string): string => source.replace(/\/\/[^\n]*/g, '');
    const roundedQuotient = /\b(floor|fract|mod|u?int)\s*\([^;]*\ba_\w+[^;]*\//;
    const ofAttribute = /\b(floor|fract|mod)\s*\([^;]*\ba_\w+/;
    for (const program of recordPrograms(preludes[0])) {
      for (const stage of [program.vertex, program.fragment]) {
        const lines = code(stage).split('\n');
        expect(
          lines.filter((line) => roundedQuotient.test(line) || ofAttribute.test(line)),
          program.name,
        ).toEqual([]);
      }
    }
    // The rows drawn in one draw read their kind and their row from an integer attribute
    const rows = recordPrograms(preludes[0]).find((p) => p.name.endsWith('RowsRenderer #1'));
    expect(rows?.vertex).toMatch(/\bin uint a_tag;/);
  });

  it('reports a broken shader (the check itself works)', async () => {
    const [program] = recordPrograms(preludes[0]);
    const broken = { ...program, name: 'broken', fragment: program.fragment.replace(';', '') };
    const [result] = await compileOnPage(page, [broken]);
    expect(result.ok).toBe(false);
  });
});
