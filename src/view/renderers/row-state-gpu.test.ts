// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A shader of its own moves what it draws with the rows being dragged as the library moves its
 * points, through the second entry only (run on a real WebGL2, ANGLE on SwiftShader)
 *
 * Rows of points held as rows are put in a moving set and moved, turned or scaled, as a drag of
 * features selected in bulk moves them. A shader of an extension is built from `OFFSET_MODE_GLSL`
 * and `ROW_STATE_GLSL` of `/webgl`, its texture of the state of the rows is filled with
 * `rowStateOf` of the rows being dragged, and its uniforms are written by
 * `ProjectionUniformManager` and `RowStateUniforms` with `rowStateBindingOf`. Transform feedback
 * gives back where it puts each position, and where the program of the library that draws the
 * points of the rows puts the same positions (its source recorded from `PointInstanceRenderer`).
 *
 * - The two are the same, on Web Mercator and on the globe, with the offsets taken from the origin
 *   of what is drawn and projected from it or from the center of the camera
 * - Both are within a hundredth of a pixel of where the rows are written once let go
 *   (`DraggedRows.position`, in float64)
 * - The byte of a row is the one the library gives its points (its moving set, and whether it
 *   keeps its shape)
 * - A binding kept after the rows are let go (while what follows them holds the rows until they
 *   are written) draws them where they were drawn last
 */

import type { ProjectionData } from 'maplibre-gl';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeatureTables } from '../../api/tables.js';
import { draggedRowsOf } from '../../feature-table/dragged-rows.js';
import { BULK_MOVE_SET } from '../../feature-table/row-state.js';
import type { EnuEdit } from '../../geometry/enu-transforms.js';
import { DrawStore } from '../../store/draw-store.js';
import { TableContractStore } from '../../store/table-memory.js';
import type { Feature } from '../../store/types.js';
import {
  frameProjection,
  referenceClip,
  type TestCamera,
} from '../../test-support/glsl-projection.js';
import {
  capturePreludes,
  launchWebGlBrowser,
  openMaplibrePage,
} from '../../test-support/webgl-page.js';
import { browserTimeout, gpuOf, internalsOf } from '../../test-utils.js';
import {
  calculateLngLatOffset,
  createRowStateTexture,
  OFFSET_MODE_GLSL,
  ProjectionUniformManager,
  ROW_STATE_GLSL,
  ROW_STATE_TEXTURE_UNIT,
  RowStateUniforms,
  rowStateBindingOf,
  rowStateOf,
  type ShaderData,
  uploadRowState,
} from '../../webgl/index.js';
import { GpuLedger } from '../gpu-ledger.js';
import {
  calculateOffsetUniforms,
  getProjectionTransitionUniform,
  withSamplerPrecision,
} from '../shaders/helpers.js';
import { PointInstanceRenderer } from './point/point-instance.js';

const WIDTH = 1280;
const HEIGHT = 800;
const CAMERA: Omit<TestCamera, 'center'> = {
  zoom: 15,
  pitch: 40,
  bearing: 20,
  width: WIDTH,
  height: HEIGHT,
};
const CAMERA_CENTER: [number, number] = [139.7012, 35.6815];
/** The origin the offsets of what is drawn are taken from */
const ORIGIN: [number, number] = [Math.fround(139.6987), Math.fround(35.6803)];

/** The points: a turns and scales by its values, b is a Circle, d does not move */
const POINTS: Array<{ id: string; at: [number, number]; type: Feature['type'] }> = [
  { id: 'a', at: [139.7, 35.68], type: 'Marker' },
  { id: 'b', at: [139.703, 35.6823], type: 'Circle' },
  { id: 'c', at: [139.6971, 35.6794], type: 'Point' },
  { id: 'd', at: [139.7043, 35.6788], type: 'Point' },
];

function feature(id: string, at: [number, number], type: Feature['type']): Feature {
  return {
    id,
    type,
    geometry: { type: 'Point', coordinates: at },
    layerId: 'l',
    groupId: undefined,
    properties: type === 'Circle' ? { 'maplibre-gl-draw:radiusMeters': 10 } : {},
    style: {},
    visible: true,
    locked: false,
  };
}

/** Tables of the points, as a store that holds its features as rows has them */
function setup() {
  const store = new DrawStore(new TableContractStore(), { selectionIdsLimit: 2 });
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  store.transact(() => {
    for (const p of POINTS) store.createFeature(feature(p.id, p.at, p.type));
  });
  const tables = store.tables as FeatureTables;
  return { tables, handleOf: (id: string) => tables.findRow(id) as number };
}

/** A GL that keeps the uniforms and the texture uploads it is given */
interface Recorded {
  gl: WebGL2RenderingContext;
  uniforms: Array<{ name: string; method: string; args: unknown[] }>;
  uploads: number[][];
}

function recordingGl(): Recorded {
  const uniforms: Recorded['uniforms'] = [];
  const uploads: number[][] = [];
  const gl = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (/^[A-Z0-9_]+$/.test(prop)) return 0;
        if (prop === 'getUniformLocation') {
          return (_program: unknown, name: string) => ({ name });
        }
        if (prop === 'getParameter') return () => 4;
        if (prop === 'createTexture') return () => ({});
        if (prop === 'texSubImage2D') {
          return (...args: unknown[]) => uploads.push([...(args[8] as Uint8Array)]);
        }
        if (prop.startsWith('uniform')) {
          return (location: { name: string } | null, ...args: unknown[]) => {
            if (!location) return;
            uniforms.push({
              name: location.name,
              method: prop,
              args: args.map((a) =>
                ArrayBuffer.isView(a) || Array.isArray(a) ? [...(a as number[])] : a,
              ),
            });
          };
        }
        return () => undefined;
      },
    },
  ) as unknown as WebGL2RenderingContext;
  return { gl, uniforms, uploads };
}

/** The sources of the program of the library that draws the points of the rows */
function pointRowProgram(shaderData: ShaderData): { vertex: string; fragment: string } {
  const sources = new Map<object, string>();
  const kinds = new Map<object, number>();
  const attached = new Map<object, object[]>();
  const linked: Array<{ vertex: string; fragment: string }> = [];
  const gl = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'VERTEX_SHADER') return 1;
        if (prop === 'FRAGMENT_SHADER') return 2;
        if (/^[A-Z0-9_]+$/.test(prop)) return 0;
        if (prop === 'createShader') {
          return (type: number) => {
            const shader = {};
            kinds.set(shader, type);
            return shader;
          };
        }
        if (prop === 'shaderSource') return (s: object, text: string) => sources.set(s, text);
        if (prop === 'attachShader') {
          return (p: object, s: object) => attached.set(p, [...(attached.get(p) ?? []), s]);
        }
        if (prop === 'linkProgram') {
          return (p: object) => {
            const shaders = attached.get(p) ?? [];
            const of = (kind: number) => sources.get(shaders.find((s) => kinds.get(s) === kind)!);
            linked.push({ vertex: of(1) ?? '', fragment: of(2) ?? '' });
          };
        }
        if (prop.startsWith('get') && prop.endsWith('Parameter')) return () => true;
        if (prop.startsWith('create')) return () => ({});
        if (prop === 'getUniformLocation') return () => ({});
        if (prop === 'canvas') return { width: WIDTH, height: HEIGHT, clientWidth: WIDTH };
        return () => undefined;
      },
    },
  ) as unknown as WebGL2RenderingContext;
  const map = {
    getCanvas: () => ({ width: WIDTH, height: HEIGHT, clientWidth: WIDTH, clientHeight: HEIGHT }),
    getZoom: () => 15,
    getTerrain: () => null,
    transform: { tileSize: 512 },
  } as never;
  const renderer = new PointInstanceRenderer(map, gl, new GpuLedger());
  renderer.ensureShader(shaderData);
  linked.length = 0;
  expect(renderer.ensureRowProgram()).toBe(true);
  expect(linked.length).toBe(1);
  return linked[0] as { vertex: string; fragment: string };
}

/** The vertex shader of an extension, from the second entry only */
function ownVertexSource(prelude: ShaderData): string {
  return `#version 300 es
${prelude.vertexShaderPrelude}
${prelude.define}
${getProjectionTransitionUniform(prelude.vertexShaderPrelude)}${OFFSET_MODE_GLSL}${ROW_STATE_GLSL}
in vec2 a_offset;
in float a_row;
out vec4 v_clip;
void main() {
    vec2 offset = rowStateMove(readRowState(a_row), a_offset);
    v_clip = project_position_to_clipspace_from_offset(offset, u_projection_matrix);
    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
    gl_PointSize = 1.0;
}`;
}

/** What a draw is given on the page */
interface Draw {
  uniforms: Recorded['uniforms'];
  texture: { width: number; height: number; data: number[] };
  unit: number;
  offsets: number[];
  rows: number[];
}

/**
 * Runs both programs on the page's WebGL2 for the same positions, and gives back the screen
 * position in clip space divided by w of each: the shader of the extension first, then the
 * program of the library
 */
async function runOnPage(
  page: Page,
  sources: { own: string; library: { vertex: string; fragment: string } },
  draw: Draw,
): Promise<{ own: number[]; library: number[] }> {
  return page.evaluate(
    ({ sources, draw }) => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) throw new Error('WebGL2 is not available in the browser');
      const compile = (type: number, text: string): WebGLShader => {
        const s = gl.createShader(type) as WebGLShader;
        gl.shaderSource(s, text);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(s) ?? 'compile');
        }
        return s;
      };
      const link = (vertex: string, fragment: string, varying: string): WebGLProgram => {
        const program = gl.createProgram() as WebGLProgram;
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
        gl.transformFeedbackVaryings(program, [varying], gl.SEPARATE_ATTRIBS);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          throw new Error(gl.getProgramInfoLog(program) ?? 'link');
        }
        return program;
      };
      const count = draw.rows.length;
      // The texture of the state of the rows, as the second entry lays it out
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + draw.unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, draw.texture.width, draw.texture.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        draw.texture.width,
        draw.texture.height,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        new Uint8Array(draw.texture.data),
      );
      const run = (
        program: WebGLProgram,
        attributes: Array<{ location: number; data: number[]; size: number }>,
        varying: number,
      ): number[] => {
        gl.useProgram(program);
        for (const write of draw.uniforms) {
          const at = gl.getUniformLocation(program, write.name);
          if (!at) continue;
          const call = (gl as unknown as Record<string, (...a: unknown[]) => void>)[write.method];
          call?.call(gl, at, ...write.args);
        }
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        for (const { location, data, size } of attributes) {
          const buffer = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
          gl.enableVertexAttribArray(location);
          gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
        }
        const output = gl.createBuffer();
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output);
        gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, count * 16, gl.STREAM_READ);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
        gl.enable(gl.RASTERIZER_DISCARD);
        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArrays(gl.POINTS, 0, count);
        gl.endTransformFeedback();
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        const result = new Float32Array(count * 4);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output);
        gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, result);
        gl.bindVertexArray(null);
        const out: number[] = [];
        for (let i = 0; i < count; i++) {
          const w = varying === 0 ? (result[i * 4 + 3] as number) : 1;
          out.push((result[i * 4] as number) / w, (result[i * 4 + 1] as number) / w);
        }
        return out;
      };
      const own = link(
        sources.own,
        '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { o = vec4(1.0); }',
        'v_clip',
      );
      const library = link(sources.library.vertex, sources.library.fragment, 'gl_Position');
      const zeros = new Array(count * 2).fill(0);
      return {
        own: run(
          own,
          [
            { location: gl.getAttribLocation(own, 'a_offset'), data: draw.offsets, size: 2 },
            { location: gl.getAttribLocation(own, 'a_row'), data: draw.rows, size: 1 },
          ],
          0,
        ),
        // The program of the library, its quad at the center of the point (its locations as it
        // declares them)
        library: run(
          library,
          [
            { location: 0, data: zeros, size: 2 },
            { location: 1, data: draw.offsets, size: 2 },
            { location: 8, data: draw.rows, size: 1 },
          ],
          1,
        ),
      };
    },
    { sources, draw },
  );
}

/** The projection data maplibre gives a custom layer for a camera and a transition */
function projectionDataOf(transition: number): ProjectionData {
  const projection = frameProjection({ ...CAMERA, center: CAMERA_CENTER }, transition);
  return {
    mainMatrix: projection.mainMatrix,
    fallbackMatrix: projection.fallbackMatrix,
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [...projection.clippingPlane],
    projectionTransition: projection.projectionTransition,
  } as unknown as ProjectionData;
}

/** A drag of the rows a, b and c: how their moving set moves */
interface Drag {
  name: string;
  edit: EnuEdit | null;
  translation: [number, number];
}

const DRAGS: Drag[] = [
  { name: 'moved', edit: null, translation: [0.0011, -0.0007] },
  {
    name: 'turned',
    edit: { kind: 'rotate', center: [139.7005, 35.6809], angleDegrees: 35 },
    translation: [0, 0],
  },
  {
    name: 'scaled, a Circle and a row scaled by its values keeping their shape',
    edit: {
      kind: 'scale',
      center: [139.6995, 35.6801],
      eastFactor: 1.8,
      northFactor: 0.6,
      sizeFactor: 1.4,
    },
    translation: [0.0002, 0.0001],
  },
];

describe('a shader of its own drawn with the rows being dragged', () => {
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

  /** The tables with the rows a, b and c dragged */
  function dragging(drag: Drag) {
    const { tables, handleOf } = setup();
    const states = internalsOf(tables).states;
    const moving = Int32Array.from(['a', 'b', 'c'].map(handleOf));
    states.setMoving(moving, BULK_MOVE_SET);
    // a turns and scales by its values, as the write of the drag would
    states.setByValues(Int32Array.of(handleOf('a')), true);
    states.setTransform(BULK_MOVE_SET, drag.edit);
    states.setTranslation(BULK_MOVE_SET, drag.translation[0], drag.translation[1]);
    return { tables, handleOf, states, moving };
  }

  /**
   * What the extension gives the page for a draw: its texture filled with the byte of the row of
   * each point, and the uniforms of the projection and of the state of the rows
   */
  function drawOf(
    tables: FeatureTables,
    handleOf: (id: string) => number,
    projection: ProjectionData,
    center: 'origin' | 'camera',
    binding?: ReturnType<typeof rowStateBindingOf>,
    bytes?: number[],
  ): { draw: Draw; binding: ReturnType<typeof rowStateBindingOf>; bytes: number[] } {
    const dragged = draggedRowsOf(tables);
    const recorded = recordingGl();
    const texture = createRowStateTexture(gpuOf(recorded.gl), POINTS.length);
    if (!texture) throw new Error('texture');
    const state = bytes ?? POINTS.map((p) => rowStateOf(dragged, handleOf(p.id)));
    uploadRowState(recorded.gl, texture, Uint8Array.from(state));
    const kept = binding ?? rowStateBindingOf(dragged, texture);
    // The projection centered on the origin (`offsetUniformsAt(ctx, origin)`), or on the camera
    // with the gap of the origin
    const offset = calculateOffsetUniforms(
      center === 'origin' ? ORIGIN : CAMERA_CENTER,
      projection,
    );
    const shift: [number, number] = [
      ORIGIN[0] - offset.centerLngLat[0],
      ORIGIN[1] - offset.centerLngLat[1],
    ];
    const manager = new ProjectionUniformManager(recorded.gl);
    manager.getLocations({} as WebGLProgram);
    manager.setUniforms(projection, offset, shift);
    new RowStateUniforms(recorded.gl, {} as WebGLProgram).write(kept, ORIGIN, offset.centerLngLat);
    const offsets = POINTS.flatMap((p) => calculateLngLatOffset(p.at, ORIGIN).map(Math.fround));
    return {
      draw: {
        uniforms: recorded.uniforms,
        texture: { width: texture.width, height: texture.height, data: recorded.uploads[0] ?? [] },
        unit: ROW_STATE_TEXTURE_UNIT,
        offsets,
        rows: POINTS.map((_, i) => i),
      },
      binding: kept,
      bytes: state,
    };
  }

  /** The largest distance in pixels between two lists of positions in clip space divided by w */
  function worstPx(a: number[], b: number[]): number {
    let worst = 0;
    for (let i = 0; i < a.length; i += 2) {
      const dx = (((a[i] as number) - (b[i] as number)) * WIDTH) / 2;
      const dy = (((a[i + 1] as number) - (b[i + 1] as number)) * HEIGHT) / 2;
      worst = Math.max(worst, Math.hypot(dx, dy));
    }
    return worst;
  }

  /** Where the rows are written once let go, in clip space divided by w */
  function writtenAt(
    tables: FeatureTables,
    handleOf: (id: string) => number,
    transition: number,
  ): number[] {
    const dragged = draggedRowsOf(tables);
    const projection = frameProjection({ ...CAMERA, center: CAMERA_CENTER }, transition);
    return POINTS.flatMap((p) => {
      const at = dragged ? dragged.position(handleOf(p.id), p.at) : p.at;
      const clip = referenceClip(projection, at[0] as number, at[1] as number);
      return [clip[0] / clip[3], clip[1] / clip[3]];
    });
  }

  it('gives a row the byte the library gives its points', () => {
    const { tables, handleOf } = dragging(DRAGS[2] as Drag);
    const dragged = draggedRowsOf(tables);
    const internals = internalsOf(tables);
    for (const p of POINTS) {
      const handle = handleOf(p.id);
      const place = internals.placeOf(handle);
      if (!place) throw new Error(p.id);
      // The bits of the moving set and of keeping the shape
      const library = (place.group.gpuState[place.row] as number) & (6 | 16);
      expect(rowStateOf(dragged, handle), p.id).toBe(library);
      expect(library === 0, p.id).toBe(p.id === 'd');
    }
    expect(rowStateOf(null, handleOf('a'))).toBe(0);
  });

  for (const [projectionName, variant, transition] of [
    ['Web Mercator', 'mercator', 0],
    ['the globe', 'globe', 1],
  ] as const) {
    for (const center of ['origin', 'camera'] as const) {
      it.each(DRAGS.map((drag) => [drag.name, drag] as const))(
        `puts a row %s where the library puts its point, on ${projectionName}, projected from the ${center}`,
        async (_name, drag) => {
          const prelude = preludes.find((p) => p.variantName === variant);
          if (!prelude) throw new Error(`no ${variant} prelude`);
          const { tables, handleOf } = dragging(drag);
          const projection = projectionDataOf(transition);
          const { draw } = drawOf(tables, handleOf, projection, center);
          const result = await runOnPage(
            page,
            {
              own: withSamplerPrecision(ownVertexSource(prelude)),
              library: pointRowProgram(prelude),
            },
            draw,
          );
          const fromLibrary = worstPx(result.own, result.library);
          const fromWritten = worstPx(result.own, writtenAt(tables, handleOf, transition));
          console.log(
            `[rows ${variant} ${center} ${drag.name}] from the points of the library ${fromLibrary.toExponential(2)} px, from where they are written ${fromWritten.toExponential(2)} px`,
          );
          expect(fromLibrary).toBeLessThan(1e-3);
          expect(fromWritten).toBeLessThan(0.01);
          // The rows that move moved
          const unmoved = setup();
          const still = writtenAt(unmoved.tables, unmoved.handleOf, transition);
          expect(worstPx(result.own.slice(0, 6), still.slice(0, 6))).toBeGreaterThan(1);
          expect(worstPx(result.own.slice(6), still.slice(6))).toBeLessThan(0.01);
        },
        browserTimeout(30_000),
      );
    }
  }

  it('draws the rows where they were drawn last with a binding kept after they are let go', async () => {
    const prelude = preludes.find((p) => p.variantName === 'mercator');
    if (!prelude) throw new Error('no mercator prelude');
    const drag = DRAGS[1] as Drag;
    const { tables, handleOf, states, moving } = dragging(drag);
    const projection = projectionDataOf(0);
    const during = drawOf(tables, handleOf, projection, 'origin');
    const moved = writtenAt(tables, handleOf, 0);
    // Let go: the rows leave their moving set, which lets go of its move
    states.setMoving(moving, 0);
    expect(draggedRowsOf(tables)).toBeNull();
    const sources = {
      own: withSamplerPrecision(ownVertexSource(prelude)),
      library: pointRowProgram(prelude),
    };
    const kept = drawOf(tables, handleOf, projection, 'origin', during.binding, during.bytes);
    const keptResult = await runOnPage(page, sources, kept.draw);
    expect(worstPx(keptResult.own, moved)).toBeLessThan(0.01);
    // A binding made now draws them where they are
    const now = drawOf(tables, handleOf, projection, 'origin');
    const nowResult = await runOnPage(page, sources, now.draw);
    expect(worstPx(nowResult.own, writtenAt(tables, handleOf, 0))).toBeLessThan(0.01);
    expect(worstPx(nowResult.own, keptResult.own)).toBeGreaterThan(1);
  });
});
