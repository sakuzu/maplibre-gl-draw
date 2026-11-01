// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the retained draws reuse instead of making per draw
 *
 * - The gap between the origin of a batch and the camera center is written into one array of
 *   the renderer for every draw, and the uniform still gets the gap of each batch
 * - The halves of the depth test of the billboards and of the culling of the fills do what the
 *   forms with a callback do
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDepthTestEnabled, setDepthTestEnabled } from '../layer/depth-state.js';
import { beginRenderFrame } from '../shaders/frame.js';
import { calculateOffsetUniforms, type ShaderData } from '../shaders/helpers.js';
import { ProjectionUniformManager } from '../shaders/projection.js';
import { TerrainContext } from '../terrain/context.js';
import { setTerrainRenderState } from '../terrain/state.js';
import { ROW_LINE_STRIDE } from './line/line-geometry.js';
import { SDFLineRenderer } from './line/sdf-line.js';
import {
  disableDepthForBillboards,
  drawBillboardsWithoutDepth,
  restoreDepthAfterBillboards,
} from './point/billboard-depth.js';
import { PointInstanceRenderer, ROW_POINT_STRIDE } from './point/point-instance.js';
import { SDFPolygonRenderer } from './polygon/sdf-polygon.js';
import {
  beginTerrainCull,
  drawFillWithTerrainCull,
  endTerrainCull,
} from './polygon/terrain-cull.js';
import { createRowStateTexture, type RowStateBinding } from './row-state.js';

interface Call {
  name: string;
  args: unknown[];
}

function createGL() {
  const calls: Call[] = [];
  let next = 1;
  const target: Record<string, unknown> = {
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    canvas: { width: 800, height: 600 },
  };
  const gl = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (/^[A-Z_0-9]+$/.test(prop)) return prop.length;
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        if (prop.startsWith('create')) return { id: next++ };
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return true;
        if (prop === 'getUniformLocation') return { name: args[1] };
        if (prop === 'getParameter') return 4096;
        return undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;
  return { gl, calls };
}

const SHADER_DATA: ShaderData = { vertexShaderPrelude: '', define: '', variantName: 'mercator' };

const projection = (): ProjectionData =>
  ({
    mainMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: 0,
    fallbackMatrix: new Float32Array(16),
  }) as unknown as ProjectionData;

const CAMERA: [number, number] = [139.7, 35.68];
const ORIGINS: Array<[number, number]> = [
  [139.71, 35.69],
  [139.65, 35.6],
];

afterEach(() => {
  vi.restoreAllMocks();
});

/** The gaps given to the projection, and whether every draw gave the same array */
function recordShifts(): { shifts: number[][]; arrays: Set<unknown> } {
  const shifts: number[][] = [];
  const arrays = new Set<unknown>();
  const original = ProjectionUniformManager.prototype.setUniforms;
  vi.spyOn(ProjectionUniformManager.prototype, 'setUniforms').mockImplementation(function (
    this: ProjectionUniformManager,
    ...args: Parameters<ProjectionUniformManager['setUniforms']>
  ) {
    const shift = args[2];
    if (shift) {
      shifts.push([shift[0], shift[1]]);
      arrays.add(shift);
    }
    original.apply(this, args);
  });
  return { shifts, arrays };
}

function expectedShifts(): number[][] {
  const camera = calculateOffsetUniforms(CAMERA, projection());
  return ORIGINS.map((origin) => [
    Math.fround(origin[0]) - camera.centerLngLat[0],
    Math.fround(origin[1]) - camera.centerLngLat[1],
  ]);
}

function binding(gl: WebGL2RenderingContext): RowStateBinding {
  const texture = createRowStateTexture(gl, 2);
  if (!texture) throw new Error('texture');
  return { texture, translations: new Float32Array(8) };
}

describe('the gap of the origin of a retained batch', () => {
  it('is written into one array per renderer, with the gap of each batch', () => {
    const { gl } = createGL();
    const camera = calculateOffsetUniforms(CAMERA, projection());
    const point = new PointInstanceRenderer({} as MapLibreMap, gl, 1);
    const line = new SDFLineRenderer({} as MapLibreMap, gl, 1);
    const polygon = new SDFPolygonRenderer(gl, 1);
    for (const renderer of [point, line, polygon]) {
      renderer.ensureShader(SHADER_DATA);
      renderer.setOffsetUniforms(camera);
    }
    const state = binding(gl);
    const draws: Array<() => void> = [];
    for (const origin of ORIGINS) {
      const points = point.buildRetainedRows(
        new Float32Array(ROW_POINT_STRIDE),
        1,
        origin,
        Int32Array.of(0, 1),
      );
      const lines = line.buildRetainedRows(
        {
          texData: new Float32Array(16),
          texSize: 2,
          instanceData: new Float32Array(ROW_LINE_STRIDE),
          instanceCount: 1,
          maxSegmentMeters: 1,
          maxSegmentMercator: 0,
        },
        origin,
        Int32Array.of(0, 1),
      );
      const polygons = polygon.createRetainedRows(3, 3, origin, Int32Array.of(0, 3));
      const single = polygon.buildRetained(
        [
          {
            coordinates: [
              [
                [origin[0], origin[1]],
                [origin[0] + 0.01, origin[1]],
                [origin[0], origin[1] + 0.01],
                [origin[0], origin[1]],
              ],
            ],
            style: {
              fillColor: [1, 0, 0, 1],
              fillOpacity: 1,
              strokeColor: [0, 0, 0, 1],
              strokeWidth: 0,
              strokeOpacity: 0,
            },
            createdZoom: 0,
          },
        ],
        { origin },
      );
      if (!points || !lines || !polygons || !single) throw new Error('batch');
      draws.push(
        () => point.drawRetainedRange(points, 0, 1, 14, projection(), state),
        () => line.drawRetainedRange(lines, 0, 1, 14, projection(), state),
        () => polygon.drawRetainedRange(polygons, 0, 1, 14, projection(), [800, 600], state),
        () => polygon.drawRetained(single, 14, projection(), [800, 600]),
      );
    }
    beginRenderFrame();
    const { shifts, arrays } = recordShifts();
    for (const draw of draws) draw();
    const [first, second] = expectedShifts();
    expect(shifts).toEqual([first, first, first, first, second, second, second, second]);
    // One array per renderer (the point, the line, the polygon), whatever the number of draws
    expect(arrays.size).toBe(3);
  });
});

describe('the halves of the state changes around a draw', () => {
  it('of the depth test of the billboards do what the form with a callback does', () => {
    for (const enabled of [true, false]) {
      const withCallback = createGL();
      setDepthTestEnabled(withCallback.gl, enabled);
      withCallback.calls.length = 0;
      drawBillboardsWithoutDepth(withCallback.gl, () => withCallback.gl.drawArrays(0, 0, 4));

      const halves = createGL();
      setDepthTestEnabled(halves.gl, enabled);
      halves.calls.length = 0;
      const was = disableDepthForBillboards(halves.gl);
      expect(isDepthTestEnabled(halves.gl)).toBe(false);
      halves.gl.drawArrays(0, 0, 4);
      restoreDepthAfterBillboards(halves.gl, was);

      expect(halves.calls).toEqual(withCallback.calls);
      expect(isDepthTestEnabled(halves.gl)).toBe(enabled);
    }
  });

  it('of the culling of the fills do what the form with a callback does', () => {
    for (const active of [true, false]) {
      const terrain = new TerrainContext();
      if (active) {
        setTerrainRenderState(terrain, { ...terrain.renderState, active: true });
      }
      const withCallback = createGL();
      drawFillWithTerrainCull(withCallback.gl, terrain, () =>
        withCallback.gl.drawElements(0, 3, 0, 0),
      );
      const halves = createGL();
      const culled = beginTerrainCull(halves.gl, terrain);
      halves.gl.drawElements(0, 3, 0, 0);
      endTerrainCull(halves.gl, culled);
      expect(halves.calls).toEqual(withCallback.calls);
      expect(halves.calls.length).toBe(active ? 5 : 1);
    }
  });
});
