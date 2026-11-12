// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The merge of rows of row groups (`mergePageData`)
 *
 * - The rows merged are the rows built at once, in the order of the layer: the same ids, keys,
 *   types, geometries, attributes, styles, flags, bboxes and triangles
 * - The triangles are copied from the cache of the groups (earcut does not run)
 * - The members of a group of features follow each other at the key of the group
 * - A merge within twice the targets stays one group when asked; past it, it is cut into groups
 *   of the target sizes at once
 */

import type { PageData } from '@sakuzu/kasane/render';
import { cacheNumbersOf, mergePageData, ShapeFormReader, shapeRowOf } from '@sakuzu/kasane/render';
import { readValue, utf8ColumnLength, utf8String } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import { featureRowDataBuilder as createPageDataBuilder, seededRandom } from '../test-utils.js';
import type { FeatureRowInput as RowInput } from './feature-row-blocks.js';
import {
  geometryColumnOf,
  propertyColumnsOf,
  ROW_FLAG_HIDDEN,
  ROW_FLAG_LOCKED,
  styleColumnOf,
  typeColumnOf,
} from './feature-row-columns.js';
import { FEATURE_CACHES, FILL_TRIANGLES_AT } from './fill-triangles.js';
import { FEATURE_TABLE_COLUMNS } from './tabane/columns.js';

/** Numbers the styles of groups built by builders, as the table of styles of a document does */
function numbered(groups: PageData[], numbers: Map<string, number>): PageData[] {
  for (const group of groups) {
    const dictionary = styleColumnOf(group).dictionary;
    if (!dictionary) continue;
    const local = Array.from({ length: utf8ColumnLength(dictionary) }, (_, i) => {
      const bytes = utf8String(dictionary, i);
      let n = numbers.get(bytes);
      if (n === undefined) {
        n = numbers.size;
        numbers.set(bytes, n);
      }
      return n;
    });
    for (let r = 0; r < group.length; r++)
      styleColumnOf(group).indexes[r] = local[styleColumnOf(group).indexes[r]];
    styleColumnOf(group).dictionary = null;
  }
  return groups;
}

/** Builds rows into groups */
function build(rows: RowInput[], numbers: Map<string, number>, targetRows?: number) {
  const builder = createPageDataBuilder({
    columns: FEATURE_TABLE_COLUMNS,
    targetRows,
    caches: FEATURE_CACHES,
  });
  for (const row of rows) builder.addRow(row);
  return numbered(builder.finish(), numbers);
}

/** A random row: a point, a line, a polygon with a hole, a MultiPolygon or a Circle */
function randomRow(random: () => number, i: number): RowInput {
  const x = random() * 10;
  const y = random() * 10;
  const pick = random();
  let geometry: Geometry;
  let type = '';
  if (pick < 0.2) geometry = { type: 'Point', coordinates: [x, y] };
  else if (pick < 0.4)
    geometry = {
      type: 'LineString',
      coordinates: [
        [x, y],
        [x + 1, y],
        [x + 1, y + 1],
      ],
    };
  else if (pick < 0.6)
    geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [x, y],
          [x + 2, y],
          [x + 2, y + 2],
          [x, y + 2],
          [x, y],
        ],
        [
          [x + 0.5, y + 0.5],
          [x + 1, y + 0.5],
          [x + 1, y + 1],
          [x + 0.5, y + 0.5],
        ],
      ],
    };
  else if (pick < 0.8)
    geometry = {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [x, y],
            [x + 1, y],
            [x, y + 1],
            [x, y],
          ],
        ],
        [
          [
            [x + 2, y],
            [x + 3, y],
            [x + 2, y + 1],
            [x + 2, y],
          ],
        ],
      ],
    };
  else {
    geometry = { type: 'Point', coordinates: [x, y] };
    type = 'Circle';
  }
  return {
    id: `r${i}`,
    type: type || geometry.type,
    geometry,
    key: `k${String(Math.floor(random() * 1e6)).padStart(7, '0')}`,
    style: { strokeColor: ['#ff0000', '#00ff00', '#0000ff'][i % 3] },
    properties: {
      n: i,
      name: i % 2 === 0 ? `row ${i}` : undefined,
      tags: i % 5 === 0 ? ['a', i] : undefined,
      ...(type === 'Circle' ? { '@draw:radiusMeters': 1000 + i } : {}),
    },
    hidden: i % 7 === 0,
    locked: i % 11 === 0,
  };
}

/** Everything a row holds, read back */
function readRow(group: PageData, r: number, styles: Map<number, string>) {
  const child = geometryColumnOf(group)!.types[r];
  const triangles = Array.from(cacheNumbersOf(group.caches[FILL_TRIANGLES_AT], r));
  const properties: Record<string, unknown> = {};
  propertyColumnsOf(group).keys.forEach((key, k) => {
    const value = readValue(propertyColumnsOf(group).columns[k], r);
    if (value !== undefined) properties[key] = value;
  });
  return {
    id: utf8String(group.ids, r),
    handle: group.handles[r],
    hash: group.idHashes[r],
    type: typeColumnOf(group).values[typeColumnOf(group).indexes[r]],
    key: utf8String(group.keys, r),
    group: group.groups[r],
    flags: group.flags[r],
    style: styles.get(styleColumnOf(group).indexes[r]),
    geometry:
      child < 0
        ? null
        : new ShapeFormReader(geometryColumnOf(group)!.children[child]).coordinatesOf(
            shapeRowOf(geometryColumnOf(group)!, r),
          ),
    bounds: Array.from(group.rowBounds.subarray(r * 4, r * 4 + 4)),
    triangles,
    properties,
  };
}

/** Every row of groups, group after group */
function readAll(groups: PageData[], numbers: Map<string, number>) {
  const styles = new Map([...numbers].map(([bytes, n]) => [n, bytes]));
  return groups.flatMap((group) =>
    Array.from({ length: group.length }, (_, r) => readRow(group, r, styles)),
  );
}

/** The pairs `[source, row]` of every row of the groups */
function everyRow(groups: PageData[], first = 0): number[] {
  return groups.flatMap((group, g) =>
    Array.from({ length: group.length }, (_, r) => [first + g, r]).flat(),
  );
}

describe('mergePageData', () => {
  it('merges rows of groups into the rows built at once, in the order of the layer', () => {
    for (const seed of [1, 2, 3]) {
      const random = seededRandom(seed);
      const numbers = new Map<string, number>();
      const rows = Array.from({ length: 300 }, (_, i) => randomRow(random, i));
      // Some rows built in groups of 64, the others on their own (the rows changed since)
      const base = build(rows.slice(0, 200), numbers, 64);
      const changed = build(rows.slice(200), numbers);
      // Every row of the base but a few, and every changed row
      const all = everyRow(base);
      const taken: number[] = [];
      for (let i = 0; i < all.length; i += 2) {
        if ((i / 2) % 9 !== 4) taken.push(all[i], all[i + 1]);
      }
      const kept = new Set<string>();
      for (let i = 0; i < taken.length; i += 2) {
        kept.add(utf8String(base[taken[i]].ids, taken[i + 1]));
      }
      const merged = mergePageData({
        sources: [...base, ...changed],
        rows: Int32Array.from([...taken, ...everyRow(changed, base.length)]),
        targetRows: 1000,
      });
      expect(merged).toHaveLength(1);
      const expected = build(
        rows.filter((row, i) => i >= 200 || kept.has(row.id)),
        numbers,
        1000,
      );
      const got = readAll(merged, numbers);
      const want = readAll(expected, numbers);
      expect(got.map((row) => ({ ...row, handle: 0 }))).toEqual(
        want.map((row) => ({ ...row, handle: 0 })),
      );
      expect(merged[0].vertexCount).toBe(expected[0].vertexCount);
    }
  });

  it('copies the triangles of the rows from the cache of their groups', () => {
    const numbers = new Map<string, number>();
    const random = seededRandom(4);
    const rows = Array.from({ length: 40 }, (_, i) => randomRow(random, i));
    const [group] = build(rows, numbers);
    // A mark in the cache: a merge that ran earcut again would not keep it
    const t = group.caches[FILL_TRIANGLES_AT];
    let marked = -1;
    for (let r = 0; r < group.length && marked < 0; r++) {
      if (t.offsets[r + 1] - t.offsets[r] >= 4) marked = r;
    }
    t.numbers[t.offsets[marked]] = 7777;
    const merged = mergePageData({
      sources: [group],
      rows: Int32Array.from(everyRow([group])),
    });
    const at = merged[0].caches[FILL_TRIANGLES_AT].offsets[marked];
    expect(merged[0].caches[FILL_TRIANGLES_AT].numbers[at]).toBe(7777);
  });

  it('keeps the handles, the flags and the hashes of the rows', () => {
    const numbers = new Map<string, number>();
    const random = seededRandom(5);
    const [group] = build(
      Array.from({ length: 30 }, (_, i) => randomRow(random, i)),
      numbers,
    );
    for (let r = 0; r < group.length; r++) group.handles[r] = 1000 + r;
    const [merged] = mergePageData({
      sources: [group],
      rows: Int32Array.from(everyRow([group])),
      sort: false,
    });
    expect(Array.from(merged.handles)).toEqual(Array.from(group.handles));
    expect(Array.from(merged.idHashes)).toEqual(Array.from(group.idHashes));
    expect(Array.from(merged.flags)).toEqual(Array.from(group.flags));
    expect(merged.flags.some((f) => (f & ROW_FLAG_HIDDEN) !== 0)).toBe(true);
    expect(merged.flags.some((f) => (f & ROW_FLAG_LOCKED) !== 0)).toBe(true);
  });

  it('puts the members of a group of features at the key of the group', () => {
    const numbers = new Map<string, number>();
    const groups = [{ handle: 3, id: 'g', key: 'k5' }];
    const builder = createPageDataBuilder({
      columns: FEATURE_TABLE_COLUMNS,
      groups,
      caches: FEATURE_CACHES,
    });
    const point = { type: 'Point', coordinates: [0, 0] } as Geometry;
    for (const [id, order] of [
      ['a', 'k1'],
      ['b', 'k9'],
    ]) {
      builder.addRow({ id, type: 'Point', geometry: point, key: order });
    }
    const outside = numbered(builder.finish(), numbers);
    const members = createPageDataBuilder({
      columns: FEATURE_TABLE_COLUMNS,
      groups,
      caches: FEATURE_CACHES,
    });
    members.addRow({ id: 'm2', type: 'Point', geometry: point, key: 'b', group: 3 });
    members.addRow({ id: 'm1', type: 'Point', geometry: point, key: 'a', group: 3 });
    const inside = numbered(members.finish(), numbers);
    const merged = mergePageData({
      sources: [...outside, ...inside],
      rows: Int32Array.from([...everyRow(outside), ...everyRow(inside, outside.length)]),
      groups,
    });
    expect(readAll(merged, numbers).map((row) => row.id)).toEqual(['a', 'm1', 'm2', 'b']);
  });

  it('keeps one group within twice the targets, and cuts past it into groups of the targets', () => {
    const numbers = new Map<string, number>();
    const random = seededRandom(6);
    const rows = Array.from({ length: 70 }, (_, i) => ({
      ...randomRow(random, i),
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i, 0] } as Geometry,
    }));
    const [group] = build(rows, numbers);
    const all = Int32Array.from(everyRow([group]));
    expect(mergePageData({ sources: [group], rows: all, targetRows: 40, cutPast: 2 })).toHaveLength(
      1,
    );
    const cut = mergePageData({ sources: [group], rows: all, targetRows: 20, cutPast: 2 });
    expect(cut.map((g) => g.length)).toEqual([20, 20, 20, 10]);
    expect(readAll(cut, numbers).map((row) => row.id)).toEqual(
      readAll([group], numbers).map((row) => row.id),
    );
    // The coordinates count too
    const byVertices = mergePageData({
      sources: [group],
      rows: all,
      targetRows: 1000,
      targetVertices: 25,
    });
    expect(byVertices.map((g) => g.length)).toEqual([25, 25, 20]);
  });

  it('refuses sources whose styles are not numbered', () => {
    const builder = createPageDataBuilder({
      columns: FEATURE_TABLE_COLUMNS,
      caches: FEATURE_CACHES,
    });
    builder.addRow({ id: 'a', type: 'Point', geometry: null, key: 'k' });
    const [group] = builder.finish();
    expect(() => mergePageData({ sources: [group], rows: Int32Array.of(0, 0) })).toThrow(
      /not numbered/,
    );
  });
});
