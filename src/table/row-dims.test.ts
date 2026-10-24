// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

/**
 * The row groups of coordinates of every dimensions (`xy`, `xyz`, `xym`, `xyzm`)
 *
 * - A position shorter than the dimensions gets NaN, a longer one is refused
 * - The groups of the same rows in every dimensions draw and index the same: the bboxes, the
 *   triangles and the spatial index are made of `x` and `y` only
 * - A `z` costs 8 bytes per coordinate, a `z` and an `m` 16, and `xy` nothing: the bytes of the
 *   groups of `xy` are the ones they were before the dimensions (their hash is pinned)
 * - A merge copies the coordinates with their values, into more dimensions with NaN
 */

import { createHash } from 'node:crypto';
import type { CoordinateDimensions } from '@sakuzu/tabane';
import type { Geometry, Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import { circleRowRings } from '../shared/circle-rings.js';
import { toRowGeometry } from './row-geometry.js';
import {
  blockTransferList,
  createRowBlockDataBuilder,
  type RowBlockBuilderOptions,
  type RowInput,
} from './row-group-builder.js';
import { mergeRowBlockData } from './row-group-merge.js';
import type { RowBlockData } from './row-group-types.js';
import { GeometryColumnReader } from './table.js';

const ALL_DIMS: readonly CoordinateDimensions[] = ['xy', 'xyz', 'xym', 'xyzm'];

/** A random number generator with a seed (mulberry32) */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Rows of every kind at random: points, lines, polygons with holes, the multi kinds, Circles and
 * rows without a geometry. `extra` gives the values after `x` and `y` of a position
 */
function randomRows(
  count: number,
  seed: number,
  extra: (random: () => number) => number[] = () => [],
  prefix = 'r',
): RowInput[] {
  const random = seeded(seed);
  // The values after x and y come from numbers of their own, so the rows are the same rows
  const values = seeded(seed + 1000);
  const at = (x: number, y: number): Position => [x, y, ...extra(values)];
  const ring = (cx: number, cy: number, n: number, r: number): Position[] => {
    const out: Position[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      out.push(at(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
    out.push([...out[0]]);
    return out;
  };
  const rows: RowInput[] = [];
  for (let i = 0; i < count; i++) {
    const x = 139 + random();
    const y = 35 + random();
    const pick = Math.floor(random() * 8);
    let type = 'Point';
    let geometry: Geometry | null = { type: 'Point', coordinates: at(x, y) };
    if (pick === 1) {
      type = 'LineString';
      const n = 2 + Math.floor(random() * 6);
      geometry = {
        type: 'LineString',
        coordinates: Array.from({ length: n }, (_, k) => at(x + k * 0.001, y + random() * 0.001)),
      };
    } else if (pick === 2) {
      type = 'Polygon';
      geometry = {
        type: 'Polygon',
        coordinates: [ring(x, y, 3 + Math.floor(random() * 8), 0.002), ring(x, y, 4, 0.0005)],
      };
    } else if (pick === 3) {
      type = 'MultiPolygon';
      geometry = {
        type: 'MultiPolygon',
        coordinates: [[ring(x, y, 5, 0.001)], [ring(x + 0.01, y, 4, 0.001)]],
      };
    } else if (pick === 4) {
      type = 'MultiLineString';
      geometry = {
        type: 'MultiLineString',
        coordinates: [
          [at(x, y), at(x + 0.001, y)],
          [at(x, y + 0.001), at(x + 0.002, y)],
        ],
      };
    } else if (pick === 5) {
      type = 'MultiPoint';
      geometry = { type: 'MultiPoint', coordinates: [at(x, y), at(x + 0.001, y + 0.001)] };
    } else if (pick === 6) {
      type = 'Circle';
    } else if (pick === 7 && random() < 0.3) {
      geometry = null;
    }
    rows.push({
      id: `${prefix}${i}`,
      type,
      geometry,
      order: `k${String(Math.floor(random() * 1e9)).padStart(10, '0')}`,
      style: { strokeColor: i % 2 ? '#ff0000' : '#00ff00' },
      properties:
        type === 'Circle'
          ? { 'maplibre-gl-draw:radiusMeters': 50 + i, n: i }
          : { n: i, name: `n${i % 13}` },
    });
  }
  return rows;
}

function build(rows: readonly RowInput[], options: RowBlockBuilderOptions = {}): RowBlockData[] {
  const builder = createRowBlockDataBuilder({ rings: circleRowRings, ...options });
  for (const row of rows) builder.addRow(row);
  return builder.finish();
}

/** The hash of every array of groups (the bytes a Worker sends) */
function hashOf(groups: readonly RowBlockData[]): string {
  const hash = createHash('sha256');
  for (const buffer of blockTransferList(groups)) hash.update(new Uint8Array(buffer));
  return hash.digest('hex');
}

/** The bytes of every array of groups */
function bytesOf(groups: readonly RowBlockData[]): number {
  return blockTransferList(groups).reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

/** The number of values of the coordinates the geometry columns of groups hold */
function coordinatesOf(groups: readonly RowBlockData[]): number {
  let count = 0;
  for (const group of groups) {
    for (const child of group.geometry.children) {
      count += child.coords.length;
    }
  }
  return count;
}

/** The values after `x` and `y` of the positions of each dimensions, at random */
const EXTRA: Readonly<Record<CoordinateDimensions, (random: () => number) => number[]>> = {
  xy: () => [],
  xyz: (random) => [Math.round(random() * 1000)],
  xym: (random) => [1.7e12 + Math.floor(random() * 1e6)],
  xyzm: (random) => [Math.round(random() * 1000), 1.7e12 + Math.floor(random() * 1e6)],
};

describe('the positions of a row', () => {
  it('get NaN for the values they do not have and keep their values in the order of the dims', () => {
    const point = (coordinates: Position): Geometry => ({ type: 'Point', coordinates });
    expect(Array.from(toRowGeometry(point([1, 2]), 'xyz').coords)).toEqual([1, 2, Number.NaN]);
    expect(Array.from(toRowGeometry(point([1, 2, 7]), 'xym').coords)).toEqual([1, 2, 7]);
    expect(Array.from(toRowGeometry(point([1, 2, 7]), 'xyzm').coords)).toEqual([
      1,
      2,
      7,
      Number.NaN,
    ]);
    const line = toRowGeometry(
      {
        type: 'LineString',
        coordinates: [
          [0, 0, 5],
          [1, 1],
        ],
      },
      'xyz',
    );
    expect(Array.from(line.coords)).toEqual([0, 0, 5, 1, 1, Number.NaN]);
    expect(line.stride).toBe(3);
  });

  it('are refused when they have more values than the dims (no value is dropped)', () => {
    expect(() => toRowGeometry({ type: 'Point', coordinates: [1, 2, 3] })).toThrow(
      /3 values does not fit coordinates of xy/,
    );
    expect(() => toRowGeometry({ type: 'LineString', coordinates: [[0, 0, 1, 2]] }, 'xyz')).toThrow(
      /4 values does not fit coordinates of xyz/,
    );
    const builder = createRowBlockDataBuilder();
    expect(() =>
      builder.addRow({
        id: 'a',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [1, 2, 3] },
        order: 'k',
      }),
    ).toThrow(/does not fit/);
  });
});

describe('the row groups of every dimensions', () => {
  it('draw and index the same: the bboxes, the triangles and the index of x and y', () => {
    const xy = build(randomRows(600, 3), { targetRows: 100 });
    for (const dims of ALL_DIMS) {
      const groups = build(randomRows(600, 3, EXTRA[dims]), { targetRows: 100, dimensions: dims });
      expect(groups.length).toBe(xy.length);
      groups.forEach((group, g) => {
        const other = xy[g];
        expect(group.geometry.children.every((child) => child.dimensions === dims)).toBe(true);
        expect(group.rowBounds).toEqual(other.rowBounds);
        expect(group.triangles).toEqual(other.triangles);
        expect(group.index).toEqual(other.index);
        expect(group.vertexCount).toBe(other.vertexCount);
        expect(Array.from(group.geometry.types)).toEqual(Array.from(other.geometry.types));
        expect(Array.from(group.geometry.offsets)).toEqual(Array.from(other.geometry.offsets));
      });
    }
  });

  it('cost 8 bytes per coordinate for a z or an m, 16 for both, nothing for xy', () => {
    const xy = build(randomRows(800, 5));
    const coordinates = coordinatesOf(xy) / 2;
    expect(coordinates).toBeGreaterThan(1000);
    const extra: Record<CoordinateDimensions, number> = { xy: 0, xyz: 8, xym: 8, xyzm: 16 };
    for (const dims of ALL_DIMS) {
      const groups = build(randomRows(800, 5, EXTRA[dims]), { dimensions: dims });
      expect(bytesOf(groups)).toBe(bytesOf(xy) + extra[dims] * coordinates);
    }
  });

  it('of xy hold the bytes they held before the dimensions', () => {
    // The hashes of the groups built before the coordinates had dimensions (the same rows)
    expect(hashOf(build(randomRows(3000, 7)))).toBe(PINNED.mixed);
    expect(hashOf(build(randomRows(3000, 8), { targetRows: 100, targetVertices: 900 }))).toBe(
      PINNED.small,
    );
    const groups = build(randomRows(3000, 9), { targetRows: 300 });
    for (const group of groups) group.styleDictionary = null;
    const pairs: number[] = [];
    groups.forEach((group, source) => {
      for (let r = 0; r < group.length; r += 2) pairs.push(source, r);
    });
    const merged = mergeRowBlockData({
      sources: groups,
      rows: Int32Array.from(pairs),
      ringVertices: circleRowRings.ringVertices,
    });
    expect(hashOf(merged)).toBe(PINNED.merged);
  });

  it('are read with every value, the NaN at the end left out', () => {
    const [group] = build(
      [
        {
          id: 'a',
          type: 'LineString',
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1, 5],
              [2, 2, Number.NaN, 9],
              [3, 3, 6, 10],
            ],
          },
          order: 'k',
        },
      ],
      { dimensions: 'xyzm' },
    );
    const reader = new GeometryColumnReader(group.geometry.children[0], undefined, 'child');
    expect(reader.stride).toBe(4);
    expect(reader.fullCoordinatesOf(0)).toEqual([
      [0, 0],
      [1, 1, 5],
      [2, 2, Number.NaN, 9],
      [3, 3, 6, 10],
    ]);
    // What is drawn and hit: x and y
    expect(reader.coordinatesOf(0)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });
});

describe('a merge of row groups of dimensions', () => {
  const numbered = (groups: RowBlockData[]): RowBlockData[] => {
    for (const group of groups) group.styleDictionary = null;
    return groups;
  };

  it('copies the coordinates into the dimensions of the merge, the ones missing NaN', () => {
    const xy = numbered(build(randomRows(40, 11), { targetRows: 1000 }));
    const xyz = numbered(
      build(randomRows(40, 12, EXTRA.xyz, 'z'), { targetRows: 1000, dimensions: 'xyz' }),
    );
    const rows: number[] = [];
    for (let r = 0; r < 40; r++) rows.push(0, r, 1, r);
    const [merged] = mergeRowBlockData({
      sources: [xy[0], xyz[0]],
      rows: Int32Array.from(rows),
      dimensions: 'xyz',
      targetRows: 1000,
      targetVertices: 1e9,
    });
    expect(merged.geometry.children.every((child) => child.dimensions === 'xyz')).toBe(true);
    const readers = merged.geometry.children.map(
      (child) => new GeometryColumnReader(child, undefined, 'child'),
    );
    const sources = [xy[0], xyz[0]].map((data) => ({
      data,
      readers: data.geometry.children.map(
        (child) => new GeometryColumnReader(child, undefined, 'child'),
      ),
    }));
    const byId = (data: RowBlockData, readers: GeometryColumnReader[]) => {
      const out = new Map<string, unknown>();
      for (let r = 0; r < data.length; r++) {
        const child = data.geometry.types[r];
        const id = new TextDecoder().decode(
          data.ids.bytes.subarray(data.ids.offsets[r], data.ids.offsets[r + 1]),
        );
        out.set(id, child < 0 ? null : readers[child].fullCoordinatesOf(data.geometry.offsets[r]));
      }
      return out;
    };
    const read = byId(merged, readers);
    for (const source of sources) {
      for (const [id, positions] of byId(source.data, source.readers)) {
        expect(read.get(id)).toEqual(positions);
      }
    }
  });

  it('is refused for sources of other dimensions, or of more dimensions than the merge', () => {
    const xy = numbered(build(randomRows(10, 13)));
    const xyz = numbered(build(randomRows(10, 14, EXTRA.xyz, 'z'), { dimensions: 'xyz' }));
    const rows = Int32Array.of(0, 0, 1, 0);
    expect(() => mergeRowBlockData({ sources: [xy[0], xyz[0]], rows })).toThrow(/coordinates of/);
    expect(() =>
      mergeRowBlockData({ sources: [xyz[0]], rows: Int32Array.of(0, 0), dimensions: 'xym' }),
    ).toThrow(/coordinates of xyz/);
  });
});

/** The hashes of the groups of xy, taken from the version before the dimensions */
const PINNED = {
  mixed: '2cca5ebcc537112afec355837cf39ece2dec71d5ac1f218d6907c2d38d7f5dbd',
  small: 'b39a1553ed817e77dcf77fbf31d0466e852ec82e3e345b9ba0b02dd9268ca59c',
  merged: '34cc8d4661df224d7985211a009ec1e74a16a6596bab5ba5ce9b6272d2d255f7',
};
