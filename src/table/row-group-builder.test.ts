// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import earcut from 'earcut';
import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import { generateCirclePolygon } from '../geometry/circle.js';
import { circleRowRings } from '../shared/circle-rings.js';
import { drawPropertyKey } from '../shared/properties.js';
import { buildEarcutInput } from '../view/renderers/polygon/earcut-input.js';
import { decodeCanonicalValue } from './canonical-value.js';
import { searchPackedRTree } from './packed-rtree.js';
import { pairTriangles } from './row-geometry.js';
import { createRowGroupBuilder, type RowInput, rowGroupTransferList } from './row-group-builder.js';
import {
  ROW_FLAG_DELETED,
  ROW_FLAG_LOCKED,
  ROW_FLAG_VISIBLE,
  type RowGroupData,
} from './row-group-types.js';
import { GeometryColumnReader } from './table.js';
import { hashUtf8, utf8String } from './utf8-column.js';
import { readValue } from './value-column.js';

/** A row with the defaults of the tests */
function row(id: string, order: string, geometry: Geometry | null, extra: Partial<RowInput> = {}) {
  return { id, type: geometry?.type ?? 'Point', geometry, order, ...extra } as RowInput;
}

const point = (x: number, y: number): Geometry => ({ type: 'Point', coordinates: [x, y] });

/** The ids of every group, group after group */
function idsOf(groups: readonly RowGroupData[]): string[] {
  return groups.flatMap((group) =>
    Array.from({ length: group.length }, (_, r) => utf8String(group.ids, r)),
  );
}

/** The coordinates of a row read back through the geometry columns */
function coordinatesOf(group: RowGroupData, r: number): unknown {
  const child = group.geometry.types[r];
  if (child < 0) return null;
  const column = new GeometryColumnReader(group.geometry.children[child], undefined, 'child');
  return column.coordinatesOf(group.geometry.offsets[r]);
}

/** The triangles earcut makes, in the pairs the builder keeps them in */
function paired(triangles: readonly number[], base = 0): number[] {
  const out: number[] = [];
  pairTriangles(triangles, 0, triangles.length, 0, (a, b, c, d) => {
    out.push(a + base, b + base, c + base, d + base);
  });
  return out;
}

/** The indices of the pairs of triangles of a row */
function trianglesOf(group: RowGroupData, r: number): number[] {
  const t = group.triangles;
  const wide = Array.from(t.wideRows).indexOf(r);
  if (wide >= 0)
    return Array.from(t.wideIndices.subarray(t.wideOffsets[wide], t.wideOffsets[wide + 1]));
  return Array.from(t.indices.subarray(t.offsets[r], t.offsets[r + 1]));
}

describe('createRowGroupBuilder', () => {
  it('puts the rows in the order of their keys', () => {
    const builder = createRowGroupBuilder();
    builder.addRow(row('c', 'a2', point(0, 0)));
    builder.addRow(row('a', 'a0', point(1, 1)));
    builder.addRow(row('b', 'a1', point(2, 2)));
    const groups = builder.finish();
    expect(groups).toHaveLength(1);
    expect(idsOf(groups)).toEqual(['a', 'b', 'c']);
    expect(coordinatesOf(groups[0], 0)).toEqual([1, 1]);
    expect(groups[0].handles.every((handle) => handle === -1)).toBe(true);
    expect(groups[0].idHashes[1]).toBe(hashUtf8(groups[0].ids, 1));
  });

  it('puts the members of a group at the key of the group', () => {
    const builder = createRowGroupBuilder({ groups: [{ handle: 4, id: 'g', order: 'a5' }] });
    builder.addRow(row('y', 'a9', point(0, 0)));
    builder.addRow(row('m2', 'zz', point(0, 0), { group: 4, member: 'b' }));
    builder.addRow(row('x', 'a1', point(0, 0)));
    builder.addRow(row('m1', 'a0', point(0, 0), { group: 4, member: 'a' }));
    const [group] = builder.finish();
    expect(idsOf([group])).toEqual(['x', 'm1', 'm2', 'y']);
    expect(Array.from(group.groups)).toEqual([-1, 4, 4, -1]);
    expect(utf8String(group.memberKeys, 2)).toBe('b');
    expect(utf8String(group.memberKeys, 0)).toBe('');
  });

  it('cuts the rows into groups by their number and by their coordinates', () => {
    const byRows = createRowGroupBuilder({ targetRows: 3 });
    for (let i = 0; i < 8; i++) byRows.addRow(row(`r${i}`, `k${i}`, point(i, i)));
    const rowGroups = byRows.finish();
    expect(rowGroups.map((group) => group.length)).toEqual([3, 3, 2]);
    expect(idsOf(rowGroups)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);

    const line = (n: number): Geometry => ({
      type: 'LineString',
      coordinates: Array.from({ length: n }, (_, i) => [i, 0]),
    });
    const byVertices = createRowGroupBuilder({ targetVertices: 10 });
    byVertices.addRow(row('a', 'a', line(4)));
    byVertices.addRow(row('b', 'b', line(4)));
    byVertices.addRow(row('c', 'c', line(4)));
    byVertices.addRow(row('d', 'd', line(25)));
    byVertices.addRow(row('e', 'e', line(2)));
    const vertexGroups = byVertices.finish();
    // A row of more coordinates than the target makes a group of its own
    expect(vertexGroups.map((group) => idsOf([group]))).toEqual([['a', 'b'], ['c'], ['d'], ['e']]);
    expect(vertexGroups.map((group) => group.vertexCount)).toEqual([8, 4, 25, 2]);
  });

  it('keeps the geometry of every type, and the rows without one', () => {
    const geometries: Geometry[] = [
      point(1, 2),
      {
        type: 'MultiPoint',
        coordinates: [
          [1, 1],
          [2, 2],
        ],
      },
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
      },
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 0],
          ],
          [
            [0, 1],
            [1, 1],
            [2, 1],
          ],
        ],
      },
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [4, 0],
            [4, 4],
            [0, 0],
          ],
        ],
      },
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
          [
            [
              [5, 5],
              [9, 5],
              [9, 9],
              [5, 9],
              [5, 5],
            ],
            [
              [6, 6],
              [7, 6],
              [7, 7],
              [6, 6],
            ],
          ],
        ],
      },
    ];
    const builder = createRowGroupBuilder();
    geometries.forEach((geometry, i) => {
      builder.addRow(row(`g${i}`, `k${i}`, geometry));
    });
    builder.addRow(row('none', 'k9', null));
    const [group] = builder.finish();
    geometries.forEach((geometry, i) => {
      expect(coordinatesOf(group, i)).toEqual((geometry as { coordinates: unknown }).coordinates);
    });
    expect(coordinatesOf(group, 6)).toBeNull();
    expect(Number.isNaN(group.rowBounds[6 * 4])).toBe(true);
    expect(Array.from(group.rowBounds.subarray(5 * 4, 5 * 4 + 4))).toEqual([0, 0, 9, 9]);
  });

  it('triangulates the fills as the drawing of a feature does', () => {
    const rings = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [2, 2],
        [4, 2],
        [4, 4],
        [2, 2],
      ],
      // A ring of fewer than 3 coordinates is left out
      [
        [6, 6],
        [6, 6],
      ],
    ];
    const builder = createRowGroupBuilder();
    builder.addRow(row('p', 'a', { type: 'Polygon', coordinates: rings }));
    builder.addRow(
      row('l', 'b', {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }),
    );
    const [group] = builder.finish();
    const input = buildEarcutInput(rings as [number, number][][]);
    expect(trianglesOf(group, 0)).toEqual(paired(earcut(input.flatCoords, input.holeIndices)));
    expect(trianglesOf(group, 1)).toEqual([]);
  });

  it('numbers the triangles of the polygons of a row one after the other', () => {
    const a = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    const b = [
      [5, 5],
      [6, 5],
      [6, 6],
      [5, 6],
      [5, 5],
    ];
    const builder = createRowGroupBuilder();
    builder.addRow(row('m', 'a', { type: 'MultiPolygon', coordinates: [[a], [b]] }));
    const [group] = builder.finish();
    const first = buildEarcutInput([a as [number, number][]]);
    const second = buildEarcutInput([b as [number, number][]]);
    expect(trianglesOf(group, 0)).toEqual([
      ...paired(earcut(first.flatCoords, first.holeIndices)),
      ...paired(earcut(second.flatCoords, second.holeIndices), 3),
    ]);
  });

  it('triangulates a Circle from its radius, with the rings of the Circles', () => {
    const properties = { [drawPropertyKey('radiusMeters')]: 1000 };
    const builder = createRowGroupBuilder({ rings: circleRowRings });
    builder.addRow(row('c', 'a', point(139.7, 35.7), { type: 'Circle', properties }));
    const [group] = builder.finish();
    const ring = generateCirclePolygon([139.7, 35.7], 1000);
    const input = buildEarcutInput([ring]);
    expect(trianglesOf(group, 0)).toEqual(paired(earcut(input.flatCoords, input.holeIndices)));
    expect(group.typeNames[group.types[0]]).toBe('Circle');
    // The bbox is the one of the circle, not of its center
    expect(group.rowBounds[2] - group.rowBounds[0]).toBeGreaterThan(0.01);
    expect(group.vertexCount).toBe(ring.length);
  });

  it('draws a Circle as its point without the rings of the Circles', () => {
    const properties = { [drawPropertyKey('radiusMeters')]: 1000 };
    const builder = createRowGroupBuilder();
    builder.addRow(row('c', 'a', point(139.7, 35.7), { type: 'Circle', properties }));
    const [group] = builder.finish();
    expect(trianglesOf(group, 0)).toEqual([]);
    expect(Array.from(group.rowBounds)).toEqual([139.7, 35.7, 139.7, 35.7]);
    expect(group.vertexCount).toBe(1);
  });

  it('keeps the indices of a large fill in 32 bits', { timeout: 60_000 }, () => {
    const n = 65_600;
    const ring: number[][] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ring.push([Math.cos(a), Math.sin(a)]);
    }
    ring.push(ring[0]);
    const builder = createRowGroupBuilder();
    builder.addRow(row('big', 'a', { type: 'Polygon', coordinates: [ring] }));
    builder.addRow(
      row('small', 'b', {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      }),
    );
    const groups = builder.finish();
    const big = groups[0];
    expect(Array.from(big.triangles.wideRows)).toEqual([0]);
    // The n - 2 triangles of the ring, in pairs (a lone triangle has its third index twice)
    const pairs = trianglesOf(big, 0);
    let triangles = 0;
    for (let i = 0; i < pairs.length; i += 4) triangles += pairs[i + 2] === pairs[i + 3] ? 1 : 2;
    expect(triangles).toBe(n - 2);
    expect(Math.max(...pairs.slice(0, 5000))).toBeLessThan(n);
    const small = groups[groups.length - 1];
    expect(trianglesOf(small, small.length - 1)).toHaveLength(4);
  });

  it('shares the styles of the rows and writes the flags', () => {
    const builder = createRowGroupBuilder();
    builder.addRow(
      row('a', 'a', point(0, 0), { style: { pointColor: '#ff0000', pointRadius: 4 } }),
    );
    builder.addRow(
      row('b', 'b', point(0, 0), { style: { pointRadius: 4, pointColor: '#ff0000' } }),
    );
    builder.addRow(row('c', 'c', point(0, 0), { visible: false, locked: true }));
    builder.addRow(row('d', 'd', point(0, 0), { deleted: true }));
    const [group] = builder.finish();
    expect(group.styles[0]).toBe(group.styles[1]);
    expect(group.styles[2]).not.toBe(group.styles[0]);
    const dictionary = group.styleDictionary as NonNullable<RowGroupData['styleDictionary']>;
    const style = (r: number) =>
      decodeCanonicalValue(
        dictionary.bytes,
        dictionary.offsets[group.styles[r]],
        dictionary.offsets[group.styles[r] + 1],
      );
    expect(style(0)).toEqual({ pointColor: '#ff0000', pointRadius: 4 });
    expect(style(2)).toEqual({});
    expect(Array.from(group.flags)).toEqual([
      ROW_FLAG_VISIBLE,
      ROW_FLAG_VISIBLE,
      ROW_FLAG_LOCKED,
      ROW_FLAG_VISIBLE | ROW_FLAG_DELETED,
    ]);
  });

  it('keeps the attributes, dense and sparse, absent and null apart', () => {
    const builder = createRowGroupBuilder();
    for (let i = 0; i < 10; i++) {
      const properties: Record<string, unknown> = { n: i };
      if (i === 3) properties.rare = null;
      if (i === 8) properties.rare = 'x';
      builder.addRow(row(`r${i}`, `k${i}`, point(i, 0), { properties }));
    }
    const [group] = builder.finish();
    const column = (key: string) => group.properties.columns[group.properties.keys.indexOf(key)];
    expect(column('n').form).toBe('dense');
    expect(column('rare').form).toBe('sparse');
    expect(readValue(column('n'), 4)).toBe(4);
    expect(readValue(column('rare'), 3)).toBeNull();
    expect(readValue(column('rare'), 4)).toBeUndefined();
    expect(readValue(column('rare'), 8)).toBe('x');
  });

  it('indexes the rows of a group by their bbox', () => {
    const builder = createRowGroupBuilder();
    for (let i = 0; i < 50; i++)
      builder.addRow(row(`r${i}`, `k${String(i).padStart(2, '0')}`, point(i, i)));
    const [group] = builder.finish();
    const hits = searchPackedRTree(group.index, 9.5, 9.5, 12.5, 12.5).sort((a, b) => a - b);
    expect(hits).toEqual([10, 11, 12]);
  });

  it('refuses an id added twice and a group it is not given', () => {
    const builder = createRowGroupBuilder();
    builder.addRow(row('a', 'a', point(0, 0)));
    expect(() => builder.addRow(row('a', 'b', point(0, 0)))).toThrow();

    const grouped = createRowGroupBuilder();
    grouped.addRow(row('a', 'a', point(0, 0), { group: 1 }));
    grouped.addRow(row('b', 'b', point(0, 0)));
    expect(() => grouped.finish()).toThrow();
  });

  it('lists every buffer of the groups once for the transfer', () => {
    const builder = createRowGroupBuilder({ targetRows: 2 });
    for (let i = 0; i < 3; i++) {
      builder.addRow(row(`r${i}`, `k${i}`, point(i, 0), { properties: { name: `n${i}` } }));
    }
    const groups = builder.finish();
    const buffers = rowGroupTransferList(groups);
    expect(new Set(buffers).size).toBe(buffers.length);
    expect(buffers).toContain(groups[0].ids.bytes.buffer);
    expect(buffers).toContain(groups[1].properties.columns[0].tags.buffer);
    expect(buffers).toContain(groups[1].index.boxes.buffer);
  });
});
