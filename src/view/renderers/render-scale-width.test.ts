// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the factor of the rendering ratio (renderScale) and of baking the line width
 *
 * There are two kinds of baked value (see "the two ratios" in shared/utils/pixel-ratio.ts).
 *
 * - A width fixed in screen pixels (the negative-value convention, `u_width`)... it does not
 *   shrink when the camera pulls back, so the factor is multiplied in as is
 * - A width that scales with the zoom (positive; the GPU multiplies by
 *   `2^(zoom - createdZoom)`)... it already shrinks by the same ratio when the camera pulls
 *   back, so the factor is not multiplied in
 *
 * Getting this wrong makes the shrink apply twice in the print preview (the camera pulls
 * back by δ and a factor of 2^-δ is passed) and only the outlines of the drawn features thin
 * down to 1/k^2 (the defect of 2026-08-10). The interpretation of the sign itself lives in
 * the vertex shader, so what is pinned down here is "which value the CPU passes to the GPU".
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { createPixelRatioSource } from '../../shared/utils/pixel-ratio.js';
import type { Coordinate } from '../../store/types.js';
import type { ShaderData } from '../shaders/helpers.js';
import type { LineBatchItem, LineBatchShape } from './line/line-types.js';
import { SDFLineRenderer } from './line/sdf-line.js';
import type { SDFPolygonBatchData, SDFPolygonStyle } from './polygon/sdf-polygon.js';
import { SDFPolygonRenderer } from './polygon/sdf-polygon.js';

/** A recorded GL call */
interface GLCall {
  name: string;
  args: unknown[];
}

const GL_CONSTANTS = {
  ARRAY_BUFFER: 1,
  ELEMENT_ARRAY_BUFFER: 2,
  STATIC_DRAW: 3,
  DYNAMIC_DRAW: 4,
  STREAM_DRAW: 5,
  FLOAT: 6,
  UNSIGNED_INT: 7,
  TEXTURE_2D: 8,
  RGBA32F: 9,
  RGBA: 10,
  TEXTURE0: 11,
  NEAREST: 12,
  CLAMP_TO_EDGE: 13,
  TEXTURE_MIN_FILTER: 14,
  TEXTURE_MAG_FILTER: 15,
  TEXTURE_WRAP_S: 16,
  TEXTURE_WRAP_T: 17,
  TRIANGLE_STRIP: 18,
  TRIANGLE_FAN: 19,
  TRIANGLES: 20,
  VERTEX_SHADER: 21,
  FRAGMENT_SHADER: 22,
  COMPILE_STATUS: 23,
  LINK_STATUS: 24,
} as const;

interface RecordingGL {
  gl: WebGL2RenderingContext;
  calls: (name: string) => GLCall[];
  reset: () => void;
}

function createRecordingGL(): RecordingGL {
  let calls: GLCall[] = [];
  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, args });
  };

  const gl = {
    canvas: { width: 800, height: 600 },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,

    ...GL_CONSTANTS,

    createTexture: () => ({}),
    deleteTexture: () => {},
    createBuffer: () => ({}),
    deleteBuffer: () => {},
    createVertexArray: () => ({}),
    deleteVertexArray: () => {},

    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: () => {},
    useProgram: () => {},
    getUniformLocation: (_p: unknown, name: string) => ({ name }),

    bindBuffer: () => {},
    bufferData: (target: number, data: unknown, usage: number) =>
      record('bufferData', target, data, usage),
    bindTexture: () => {},
    activeTexture: () => {},
    texImage2D: () => {},
    // Only MAX_TEXTURE_SIZE is asked (the coordinate textures are bounded by it)
    getParameter: () => 4096,
    texStorage2D: () => {},
    texSubImage2D: () => {},
    texParameteri: () => {},
    bindVertexArray: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},

    uniform1f: (location: { name: string } | null, value: number) =>
      record('uniform1f', location?.name, value),
    uniform1i: () => {},
    uniform2f: () => {},
    uniform2fv: () => {},
    uniform3fv: () => {},
    uniform4fv: () => {},
    uniform4f: () => {},
    uniformMatrix4fv: () => {},

    drawArrays: () => {},
    drawArraysInstanced: () => {},
    drawElements: () => {},
  } as unknown as WebGL2RenderingContext;

  return {
    gl,
    calls: (name: string) => calls.filter((call) => call.name === name),
    reset: () => {
      calls = [];
    },
  };
}

const SHADER_DATA: ShaderData = {
  vertexShaderPrelude: 'vec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }',
  define: '',
  variantName: 'mercator',
};

function createProjectionData(): ProjectionData {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return {
    mainMatrix: identity,
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: 0,
    fallbackMatrix: identity,
  } as unknown as ProjectionData;
}

function arrayUploads(mock: RecordingGL): Float32Array[] {
  return mock
    .calls('bufferData')
    .filter((call) => call.args[0] === GL_CONSTANTS.ARRAY_BUFFER)
    .map((call) => call.args[1] as Float32Array);
}

const LINE_SHAPE: LineBatchShape = { lineStyle: 'solid' };
const LINE_STROKE_WIDTH_OFFSET = 5;
const POLYGON_VERTEX_STRIDE = 15;
const POLYGON_STROKE_WIDTH_OFFSET = 13;
/** The CSS pixel width before baking, and the rendering ratio that is injected */
const CSS_WIDTH = 4;
const BASE_DPR = 2;
/** The factors to look at (two on the shrinking side, 1x, and one on the enlarging side) */
const SCALES = [0.2, 0.5, 1, 1.3];

const SEGMENT: Array<[number, number]> = [
  [0, 0],
  [1, 1],
];

function lineItem(strokeWidth: number): LineBatchItem {
  return {
    coords: SEGMENT,
    featureId: 'f',
    closed: false,
    strokeWidth,
    createdZoom: 12,
    color: [1, 0, 0, 1],
    opacity: 1,
  };
}

const SQUARE: Coordinate[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

function polygonStyle(strokeWidth: number): SDFPolygonStyle {
  return {
    fillColor: [1, 0, 0, 0.5],
    fillOpacity: 1,
    strokeColor: [0, 0, 1, 1],
    strokeWidth,
    strokeOpacity: 1,
  };
}

function polygonData(strokeWidth: number): SDFPolygonBatchData {
  return {
    coordinates: [SQUARE],
    style: polygonStyle(strokeWidth),
    createdZoom: 12,
    featureId: 'p',
  };
}

/** The a_extra.y baked into the line batch (the first instance) */
function bakedLineWidth(scale: number, strokeWidth: number): number {
  const source = createPixelRatioSource(BASE_DPR);
  source.setScaleFactor(scale);
  const mock = createRecordingGL();
  const renderer = new SDFLineRenderer({} as MapLibreMap, mock.gl, source);
  renderer.ensureShader(SHADER_DATA);

  mock.reset();
  renderer.drawAll([lineItem(strokeWidth)], LINE_SHAPE, 12, createProjectionData());

  const instanceData = arrayUploads(mock)[0];
  return instanceData[LINE_STROKE_WIDTH_OFFSET];
}

/** The a_extra.y baked into the polygon batch (the first vertex of the outline) */
function bakedPolygonWidth(scale: number, strokeWidth: number): number {
  const source = createPixelRatioSource(BASE_DPR);
  source.setScaleFactor(scale);
  const mock = createRecordingGL();
  const renderer = new SDFPolygonRenderer(mock.gl, source);
  renderer.ensureShader(SHADER_DATA);

  mock.reset();
  renderer.drawBatch([polygonData(strokeWidth)], createProjectionData(), 12, [800, 600]);

  const vertexData = arrayUploads(mock)[0];
  const widths: number[] = [];
  for (let i = 0; i < vertexData.length / POLYGON_VERTEX_STRIDE; i++) {
    widths.push(vertexData[i * POLYGON_VERTEX_STRIDE + POLYGON_STROKE_WIDTH_OFFSET]);
  }
  // The fill vertices stay 0, so the first non-zero value is the outline width
  return widths.find((w) => w !== 0) ?? 0;
}

describe('a width fixed in screen pixels (the negative-value convention)', () => {
  it('multiplies the factor in as is (lines)', () => {
    for (const scale of SCALES) {
      expect(bakedLineWidth(scale, -CSS_WIDTH)).toBeCloseTo(-CSS_WIDTH * BASE_DPR * scale, 5);
    }
  });

  it('multiplies the factor in as is (polygon outlines)', () => {
    for (const scale of SCALES) {
      expect(bakedPolygonWidth(scale, -CSS_WIDTH)).toBeCloseTo(-CSS_WIDTH * BASE_DPR * scale, 5);
    }
  });

  it('is monotonic in the factor and does not become 0 on the shrinking side', () => {
    const inks = SCALES.map((scale) => Math.abs(bakedLineWidth(scale, -CSS_WIDTH)));
    for (const ink of inks) expect(ink).toBeGreaterThan(0);
    for (let i = 1; i < inks.length; i++) expect(inks[i]).toBeGreaterThan(inks[i - 1]);
  });
});

describe('a width that scales with the zoom (positive, relative to createdZoom)', () => {
  it('does not multiply the factor in (lines)', () => {
    for (const scale of SCALES) {
      expect(bakedLineWidth(scale, CSS_WIDTH)).toBeCloseTo(CSS_WIDTH * BASE_DPR, 5);
    }
  });

  it('does not multiply the factor in (polygon outlines)', () => {
    for (const scale of SCALES) {
      expect(bakedPolygonWidth(scale, CSS_WIDTH)).toBeCloseTo(CSS_WIDTH * BASE_DPR, 5);
    }
  });

  it('matches the fixed width at factor 1 (does not change the default behavior)', () => {
    expect(bakedPolygonWidth(1, CSS_WIDTH)).toBeCloseTo(
      Math.abs(bakedPolygonWidth(1, -CSS_WIDTH)),
      5,
    );
    expect(bakedLineWidth(1, CSS_WIDTH)).toBeCloseTo(Math.abs(bakedLineWidth(1, -CSS_WIDTH)), 5);
  });
});

describe('the equivalence of the print preview', () => {
  /**
   * That the paper (factor 1, content zoom zc) and the preview (factor 1/k, display zoom
   * zc - δ) look the same is checked with the formula of the effective width the GPU computes.
   *
   *   effective width = the baked width x 2^(zoom - createdZoom)   (positive)
   *   effective width = |the baked width|                          (negative)
   */
  const createdZoom = 12;
  const contentZoom = 13;
  const k = 4.9166;
  const delta = Math.log2(k);
  const displayZoom = contentZoom - delta;

  function effective(baked: number, zoom: number): number {
    return baked >= 0 ? baked * 2 ** (zoom - createdZoom) : -baked;
  }

  it('makes a width that scales with the zoom 1/k of the paper', () => {
    const paper = effective(bakedPolygonWidth(1, CSS_WIDTH), contentZoom);
    const preview = effective(bakedPolygonWidth(1 / k, CSS_WIDTH), displayZoom);
    expect(preview).toBeCloseTo(paper / k, 5);
  });

  it('makes a width fixed in screen pixels 1/k of the paper as well', () => {
    const paper = effective(bakedPolygonWidth(1, -CSS_WIDTH), contentZoom);
    const preview = effective(bakedPolygonWidth(1 / k, -CSS_WIDTH), displayZoom);
    expect(preview).toBeCloseTo(paper / k, 5);
  });

  it('makes it 1/k of the paper on the enlarging side (k < 1) as well', () => {
    const kSmall = 1 / 1.2711;
    const deltaSmall = Math.log2(kSmall);
    const zoom = contentZoom - deltaSmall;
    const paper = effective(bakedPolygonWidth(1, CSS_WIDTH), contentZoom);
    const preview = effective(bakedPolygonWidth(1 / kSmall, CSS_WIDTH), zoom);
    expect(preview).toBeCloseTo(paper / kSmall, 5);
  });
});
