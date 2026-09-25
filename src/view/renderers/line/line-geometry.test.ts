// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the vertex data of the SDF line renderer
 *
 * The coordinate texels, the per-segment instances (indices, cumulative distance, width,
 * color), the batch arrays, and the number of subdivisions on terrain are pure functions, so
 * they are checked without GL.
 */

import { describe, expect, it } from 'vitest';
import { EARTH } from '../../../shared/math/constants.js';
import { updateGlobeSubdivision } from '../../globe-subdivision.js';
import { INACTIVE_TERRAIN_STATE, TerrainContext } from '../../terrain/context.js';
import {
  buildLineBatchArrays,
  defaultLineOrigin,
  growFloat32,
  INSTANCE_STRIDE,
  LINE_STATION_BUDGET,
  lineStationsOnMercatorPlane,
  MAX_LINE_STATIONS,
  normalizeOrigin,
  resolveLineStations,
  STATION_VERTICES,
  screenPixelDistance,
  segmentMeters,
  writeLineCoordTexels,
  writeLineInstances,
} from './line-geometry.js';
import type { LineBatchItem } from './line-types.js';
import { resolveDashUniform } from './line-uniforms.js';

/** The indices [start, end, prev, next] of every instance */
function indicesOf(data: Float32Array, count: number, start = 0): number[][] {
  const out: number[][] = [];
  for (let i = start; i < start + count; i++) {
    out.push([...data.subarray(i * INSTANCE_STRIDE, i * INSTANCE_STRIDE + 4)]);
  }
  return out;
}

function terrainWithStep(stepMeters: number): TerrainContext {
  const context = new TerrainContext();
  context.renderState = { ...INACTIVE_TERRAIN_STATE, active: true, stepMeters };
  return context;
}

describe('STATION_VERTICES', () => {
  it('holds a left and a right vertex for every station up to the maximum', () => {
    expect(STATION_VERTICES.length).toBe((MAX_LINE_STATIONS + 1) * 4);
    expect([...STATION_VERTICES.subarray(0, 8)]).toEqual([1, 0, -1, 0, 1, 1, -1, 1]);
  });
});

describe('writeLineCoordTexels', () => {
  it('writes the offset from the origin into x and y of each texel from coordOffset', () => {
    const target = new Float32Array(16);
    writeLineCoordTexels(
      target,
      1,
      [
        [10.5, 20.25],
        [9, 21],
      ],
      [10, 20],
    );

    expect([...target.subarray(4, 12)]).toEqual([0.5, 0.25, 0, 0, -1, 1, 0, 0]);
    expect([...target.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });
});

describe('writeLineInstances', () => {
  const coords: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ];
  const params = {
    closed: false,
    zoom: 0,
    strokeWidth: 3,
    createdZoom: 5,
    dashPixelRatio: 1,
    color: [0.1, 0.2, 0.3, 0.4] as [number, number, number, number],
  };

  it('uses -1 for the neighbors at the ends of an open line', () => {
    const target = new Float32Array(3 * INSTANCE_STRIDE);
    writeLineInstances(target, 0, 0, coords, params);

    expect(indicesOf(target, 3)).toEqual([
      [0, 1, -1, 2],
      [1, 2, 0, 3],
      [2, 3, 1, -1],
    ]);
  });

  it('wraps the neighbors around on a closed line', () => {
    const target = new Float32Array(3 * INSTANCE_STRIDE);
    writeLineInstances(target, 0, 0, coords, { ...params, closed: true });

    expect(indicesOf(target, 3)).toEqual([
      [0, 1, 2, 2],
      [1, 2, 0, 3],
      [2, 3, 1, 1],
    ]);
  });

  it('offsets the indices by coordOffset and writes from instanceStart', () => {
    const target = new Float32Array(5 * INSTANCE_STRIDE);
    writeLineInstances(target, 2, 7, coords, params);

    expect(indicesOf(target, 3, 2)).toEqual([
      [7, 8, -1, 9],
      [8, 9, 7, 10],
      [9, 10, 8, -1],
    ]);
    expect([...target.subarray(0, 2 * INSTANCE_STRIDE)].every((v) => v === 0)).toBe(true);
  });

  it('writes the cumulative distance, the width, createdZoom, the length, and the color', () => {
    const target = new Float32Array(3 * INSTANCE_STRIDE);
    writeLineInstances(target, 0, 0, coords, params);

    // One degree of longitude on the equator at zoom 0: 512 px / 360
    const length = 512 / 360;
    const first = [...target.subarray(4, 12)];
    expect(first[0]).toBe(0);
    expect(first.slice(1, 3)).toEqual([3, 5]);
    expect(first[3]).toBeCloseTo(length, 5);
    expect(first.slice(4)).toEqual([...new Float32Array([0.1, 0.2, 0.3, 0.4])]);
    // The second segment starts where the first ended
    expect(target[INSTANCE_STRIDE + 4]).toBeCloseTo(length, 5);
  });

  it('returns the length of the longest segment in meters', () => {
    const target = new Float32Array(3 * INSTANCE_STRIDE);
    const meters = writeLineInstances(target, 0, 0, coords, params);

    expect(meters).toBeCloseTo(segmentMeters([1, 1], [0, 0]), 6);
  });
});

describe('segmentMeters', () => {
  it('shrinks the longitude by the cosine of the middle latitude', () => {
    expect(segmentMeters([0, 0], [1, 0])).toBeCloseTo(EARTH.METERS_PER_DEGREE, 6);
    expect(segmentMeters([0, 60], [1, 60])).toBeCloseTo(EARTH.METERS_PER_DEGREE / 2, 6);
    expect(segmentMeters([0, 0], [0, 1])).toBeCloseTo(EARTH.METERS_PER_DEGREE, 6);
  });
});

describe('buildLineBatchArrays', () => {
  const item = (
    coords: Array<[number, number]>,
    extra: Partial<LineBatchItem> = {},
  ): LineBatchItem => ({
    coords,
    featureId: 'f',
    closed: false,
    strokeWidth: 2,
    createdZoom: 0,
    color: [1, 1, 1, 1],
    opacity: 1,
    ...extra,
  });

  it('returns null when there are fewer than two coordinates', () => {
    expect(buildLineBatchArrays([item([[0, 0]])], 0, [0, 0], 1)).toBeNull();
  });

  it('lays the lines one after another in the texels and the instances', () => {
    const arrays = buildLineBatchArrays(
      [
        item([
          [0, 0],
          [1, 0],
        ]),
        item([
          [2, 0],
          [3, 0],
          [4, 0],
        ]),
      ],
      0,
      [0, 0],
      1,
    );

    expect(arrays).not.toBeNull();
    if (!arrays) return;
    // 5 coordinates fit in a 3 x 3 texture
    expect(arrays.texSize).toBe(3);
    expect(arrays.instanceCount).toBe(3);
    expect(indicesOf(arrays.instanceData, 3)).toEqual([
      [0, 1, -1, -1],
      [2, 3, -1, 4],
      [3, 4, 2, -1],
    ]);
    expect(arrays.texData[4 * 4]).toBe(4);
    expect(arrays.maxSegmentMeters).toBeCloseTo(EARTH.METERS_PER_DEGREE, 6);
  });

  it('scales a variable width by the content ratio and a fixed width by the screen ratio', () => {
    const arrays = buildLineBatchArrays(
      [
        item(
          [
            [0, 0],
            [1, 0],
          ],
          { strokeWidth: 2 },
        ),
        item(
          [
            [0, 0],
            [1, 0],
          ],
          { strokeWidth: -2 },
        ),
      ],
      0,
      [0, 0],
      { resolve: () => 3, getRenderScale: () => 1.5 },
    );

    expect(arrays?.instanceData[5]).toBe(2 * 2);
    expect(arrays?.instanceData[INSTANCE_STRIDE + 5]).toBe(-2 * 3);
  });

  it('folds the opacity into the instance color', () => {
    const arrays = buildLineBatchArrays(
      [
        item(
          [
            [0, 0],
            [1, 0],
          ],
          { color: [1, 0.5, 0, 1], opacity: 0.5 },
        ),
      ],
      0,
      [0, 0],
      1,
    );

    expect([...(arrays?.instanceData.subarray(8, 12) ?? [])]).toEqual([0.5, 0.25, 0, 0.5]);
  });
});

describe('resolveLineStations', () => {
  it('is 1 while the terrain is inactive', () => {
    expect(resolveLineStations(new TerrainContext(), 10_000, 1)).toBe(1);
  });

  it('splits the longest segment by the subdivision step', () => {
    expect(resolveLineStations(terrainWithStep(100), 1_050, 1)).toBe(11);
    expect(resolveLineStations(terrainWithStep(100), 50, 1)).toBe(1);
  });

  it('never exceeds the maximum number of stations', () => {
    expect(resolveLineStations(terrainWithStep(1), 1e9, 1)).toBe(MAX_LINE_STATIONS);
  });

  it('caps the stations by the vertex budget of the batch', () => {
    const instances = LINE_STATION_BUDGET / 10;
    expect(resolveLineStations(terrainWithStep(1), 1e9, instances)).toBe(10);
  });
});

describe('resolveLineStations on the globe', () => {
  function globe(zoom: number): TerrainContext {
    const context = new TerrainContext();
    updateGlobeSubdivision(context, 1, zoom);
    return context;
  }

  it('splits the longest segment on the Mercator plane by the line cell', () => {
    // A third of the world at 1/512 of the world per cell
    expect(resolveLineStations(globe(1), 0, 1, 1 / 3)).toBe(171);
    expect(resolveLineStations(globe(1), 0, 1, 1 / 1024)).toBe(1);
    expect(lineStationsOnMercatorPlane(globe(1))).toBe(true);
  });

  it('is 1 on a flat map whatever the length', () => {
    expect(resolveLineStations(new TerrainContext(), 0, 1, 1 / 3)).toBe(1);
    expect(lineStationsOnMercatorPlane(new TerrainContext())).toBe(false);
  });

  it('leaves the stations to the terrain while it is drawn', () => {
    const context = globe(1);
    context.renderState = { ...INACTIVE_TERRAIN_STATE, active: true, stepMeters: 100 };
    expect(resolveLineStations(context, 1_050, 1, 1 / 3)).toBe(11);
    expect(lineStationsOnMercatorPlane(context)).toBe(false);
  });

  it('records the longest segment on the Mercator plane in the batch arrays', () => {
    const arrays = buildLineBatchArrays(
      [
        {
          coords: [
            [-60, 45],
            [60, 45],
            [60, 46],
          ],
          featureId: 'f',
          closed: false,
          strokeWidth: 2,
          createdZoom: 0,
          color: [1, 1, 1, 1],
          opacity: 1,
        },
      ],
      3,
      [0, 0],
      1,
    );
    expect(arrays?.maxSegmentMercator).toBeCloseTo(1 / 3, 6);
  });
});

describe('small helpers', () => {
  it('growFloat32 keeps a long enough array and grows to a power of two', () => {
    const array = new Float32Array(100);
    expect(growFloat32(array, 100)).toBe(array);
    expect(growFloat32(array, 101).length).toBe(128);
    expect(growFloat32(new Float32Array(0), 3).length).toBe(64);
  });

  it('normalizeOrigin rounds the origin to Float32', () => {
    expect(normalizeOrigin([0.1, 139.123456789])).toEqual([
      Math.fround(0.1),
      Math.fround(139.123456789),
    ]);
  });

  it('defaultLineOrigin is the first coordinate of the first item, or [0, 0]', () => {
    expect(defaultLineOrigin([])).toEqual([0, 0]);
    expect(
      defaultLineOrigin([
        {
          coords: [[5, 6]],
          featureId: 'f',
          closed: false,
          strokeWidth: 1,
          createdZoom: 0,
          color: [0, 0, 0, 1],
          opacity: 1,
        },
      ]),
    ).toEqual([5, 6]);
  });
});

/** The CSS px of a longitude and a latitude at `zoom` (Web Mercator, 512 px world tile) */
function referenceScreen(lng: number, lat: number, zoom: number): [number, number] {
  const world = 512 * 2 ** zoom;
  const x = ((lng + 180) / 360) * world;
  const y =
    ((180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360) *
    world;
  return [x, y];
}

/** The latitude whose screen y is `pixels` CSS px above `lat` at `zoom` */
function latitudeAbove(lat: number, pixels: number, zoom: number): number {
  const world = 512 * 2 ** zoom;
  const y = referenceScreen(0, lat, zoom)[1] - pixels;
  const mercY = 180 - (y / world) * 360;
  return (360 / Math.PI) * Math.atan(Math.exp((mercY * Math.PI) / 180)) - 90;
}

describe('dash period on screen', () => {
  const dashArray = [8, 6];
  const period = dashArray[0] + dashArray[1];

  for (const zoom of [10, 14]) {
    for (const lat of [0, 60]) {
      for (const ratio of [1, 2]) {
        it(`keeps one period at ${period} CSS px (zoom ${zoom}, latitude ${lat}, ratio ${ratio})`, () => {
          // A line of two legs, each exactly 100 CSS px on screen: east, then north
          const world = 512 * 2 ** zoom;
          const p0: [number, number] = [139, lat];
          const p1: [number, number] = [139 + (100 / world) * 360, lat];
          const p2: [number, number] = [p1[0], latitudeAbove(lat, 100, zoom)];
          const legs = [
            referenceScreen(...p1, zoom)[0] - referenceScreen(...p0, zoom)[0],
            referenceScreen(...p1, zoom)[1] - referenceScreen(...p2, zoom)[1],
          ];
          expect(legs[0]).toBeCloseTo(100, 6);
          expect(legs[1]).toBeCloseTo(100, 6);

          const target = new Float32Array(2 * INSTANCE_STRIDE);
          writeLineInstances(target, 0, 0, [p0, p1, p2], {
            closed: false,
            zoom,
            strokeWidth: 1,
            createdZoom: 0,
            dashPixelRatio: ratio,
            color: [0, 0, 0, 1],
          });
          const uniform = resolveDashUniform({ lineStyle: 'dashed', dashArray }, ratio);
          if (!uniform) throw new Error('expected a dash uniform');

          // The shader compares the cumulative distance with the pattern in the same unit
          const periodsAfterFirstLeg = target[INSTANCE_STRIDE + 4] / uniform[2];
          const periodsAtEnd =
            (target[INSTANCE_STRIDE + 4] + target[INSTANCE_STRIDE + 7]) / uniform[2];
          expect(periodsAfterFirstLeg / (100 / period)).toBeGreaterThan(0.95);
          expect(periodsAfterFirstLeg / (100 / period)).toBeLessThan(1.05);
          expect(periodsAtEnd / (200 / period)).toBeGreaterThan(0.95);
          expect(periodsAtEnd / (200 / period)).toBeLessThan(1.05);
          // The dash itself scales with the same ratio as the distance
          expect(uniform[0] / uniform[2]).toBeCloseTo(dashArray[0] / period, 6);
        });
      }
    }
  }
});

describe('screenPixelDistance', () => {
  it('measures CSS px on a 512 px Web Mercator world', () => {
    expect(screenPixelDistance([0, 0], [360, 0], 0)).toBeCloseTo(512, 6);
    expect(screenPixelDistance([0, 0], [1, 0], 3)).toBeCloseTo((512 * 8) / 360, 6);
  });

  it('stretches the latitude the way the Mercator projection does', () => {
    const [, y0] = referenceScreen(0, 60, 12);
    const [, y1] = referenceScreen(0, 60.01, 12);
    expect(screenPixelDistance([0, 60], [0, 60.01], 12)).toBeCloseTo(Math.abs(y1 - y0), 4);
  });
});

describe('resolveDashUniform', () => {
  it('returns null for a solid line', () => {
    expect(resolveDashUniform({ lineStyle: 'solid', dashArray: [4, 4] }, 2)).toBeNull();
  });

  it('scales the dash and the gap from CSS px into drawing-buffer px', () => {
    expect(resolveDashUniform({ lineStyle: 'dashed', dashArray: [3, 5] }, 2)).toEqual([
      6, 10, 16, 0,
    ]);
  });
});
