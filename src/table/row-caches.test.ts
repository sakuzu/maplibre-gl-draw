// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The caches of the rows the user of the tables declares (`row-caches.ts`)
 *
 * - The builder makes the numbers of every row of every cache declared, once per row, and none
 *   without a cache declared
 * - A merge copies the numbers as they are, by the name of the cache, and makes none
 * - The tables make the numbers of a row written again, and of no other row; a row block taken in
 *   without a cache declared has it made, and its caches are put in the order of the declaration
 * - Numbers wider than the width of a cache are kept apart; a cache of 32 bits keeps every row in
 *   its numbers
 * - The triangles of the fills of the library fit a row when they are in pairs within the vertices
 *   of its fill
 */

import { describe, expect, it } from 'vitest';
import { createTables, featureTablesInternals } from '../feature-table/feature-tables.js';
import type { RowBlockData } from '../table/row-group-types.js';
import { circleRowRings } from './circle-rings.js';
import { FILL_TRIANGLES } from './fill-triangles.js';
import {
  cacheNumbersOf,
  type RowCache,
  type RowCacheColumn,
  RowCacheWriter,
} from './row-caches.js';
import { createRowBlockDataBuilder, type RowInput } from './row-group-builder.js';
import { mergeRowBlockData } from './row-group-merge.js';
import type { RowRead } from './row-read-type.js';
import { FEATURE_TABLE_COLUMNS } from './tabane/columns.js';

/** A cache of the first point and the type of each row, which counts the rows it is made of */
function countingCache(name = 'test:first-point:1'): RowCache & { readonly made: string[] } {
  const made: string[] = [];
  return {
    name,
    width: 16,
    made,
    build: (row: RowRead) => {
      const shape = row.shape();
      made.push(String(row.value('id') ?? row.handle));
      if (!shape) return [];
      const { coords, stride } = shape.column;
      let at = shape.at;
      for (const level of shape.column.offsets) at = level[at];
      return [coords[at * stride], coords[at * stride + 1], row.type.length];
    },
    fits: () => true,
  };
}

function rowOf(i: number): RowInput {
  return {
    id: `r${i}`,
    type: i % 2 === 0 ? 'Point' : 'LineString',
    geometry:
      i % 2 === 0
        ? { type: 'Point', coordinates: [i, 1] }
        : {
            type: 'LineString',
            coordinates: [
              [i, 2],
              [i + 1, 3],
            ],
          },
    order: `a${String(i).padStart(3, '0')}`,
    properties: { id: `r${i}` },
  };
}

function build(cache: RowCache | null, count: number, targetRows = 1000): RowBlockData[] {
  const builder = createRowBlockDataBuilder({ caches: cache ? [cache] : [], targetRows });
  for (let i = 0; i < count; i++) builder.addRow(rowOf(i));
  return builder.finish();
}

function numbersOf(column: RowCacheColumn | undefined, row: number): number[] {
  return column ? Array.from(cacheNumbersOf(column, row)) : [];
}

describe('the caches of the rows of the builder', () => {
  it('are made of every row, once, of each cache declared', () => {
    const cache = countingCache();
    const [block] = build(cache, 4);
    expect(cache.made).toEqual(['r0', 'r1', 'r2', 'r3']);
    expect(block.caches.map((c) => c.name)).toEqual(['test:first-point:1']);
    expect(numbersOf(block.caches[0], 1)).toEqual([1, 2, 10]);
    expect(numbersOf(block.caches[0], 2)).toEqual([2, 1, 5]);
  });

  it('are none without a cache declared', () => {
    expect(build(null, 3)[0].caches).toEqual([]);
  });
});

describe('the caches of the rows of a merge', () => {
  it('are copied by their names, and made of no row', () => {
    const cache = countingCache();
    const blocks = build(cache, 6, 3).map((b) => ({ ...b, styleDictionary: null }));
    cache.made.length = 0;
    const [merged] = mergeRowBlockData({ sources: blocks, rows: Int32Array.of(1, 2, 0, 1) });
    expect(cache.made).toEqual([]);
    expect(merged.caches.map((c) => c.name)).toEqual([cache.name]);
    expect(numbersOf(merged.caches[0], 0)).toEqual(numbersOf(blocks[0].caches[0], 1));
    expect(numbersOf(merged.caches[0], 1)).toEqual(numbersOf(blocks[1].caches[0], 2));
  });
});

describe('the caches of the rows of the tables', () => {
  it('are made again for a row written only', () => {
    const cache = countingCache();
    const { tables, writer } = createTables({
      columns: FEATURE_TABLE_COLUMNS,
      caches: [cache],
      rings: circleRowRings,
    });
    writer.addRowBlocks('a', build(cache, 6));
    const internals = featureTablesInternals(tables);
    internals?.addQueuedRowBlocks();
    cache.made.length = 0;
    const point = tables.findRow('r2') as number;
    const line = tables.findRow('r3') as number;
    const read = (handle: number) => {
      const place = internals?.placeOf(handle);
      return place ? numbersOf(place.group.data.caches[0], place.row) : null;
    };
    // A point written in place: its numbers are made again, into the column of its row block
    writer.apply({
      handles: Int32Array.of(point),
      fields: new Map([['geometry', [{ type: 'Point', coordinates: [7, 8] }]]]),
      deleted: new Uint8Array(1),
    });
    expect(cache.made).toEqual(['r2']);
    expect(read(point)).toEqual([7, 8, 5]);
    // A line of another shape: its numbers are made again (as many: into the column)
    writer.apply({
      handles: Int32Array.of(line),
      fields: new Map([
        [
          'geometry',
          [
            {
              type: 'LineString',
              coordinates: [
                [9, 9],
                [1, 1],
                [2, 2],
              ],
            },
          ],
        ],
      ]),
      deleted: new Uint8Array(1),
    });
    expect(cache.made).toEqual(['r2', 'r3']);
    expect(read(line)).toEqual([9, 9, 10]);
    expect(read(point)).toEqual([7, 8, 5]);
    expect(read(tables.findRow('r4') as number)).toEqual([4, 1, 5]);
  });

  it('are made for a row block taken in without one, and put in the order declared', () => {
    const first = countingCache('test:a:1');
    const second = countingCache('test:b:1');
    const { tables, writer } = createTables({
      columns: FEATURE_TABLE_COLUMNS,
      caches: [first, second],
    });
    const builder = createRowBlockDataBuilder({ caches: [second] });
    for (let i = 0; i < 3; i++) builder.addRow(rowOf(i));
    const blocks = builder.finish();
    first.made.length = 0;
    second.made.length = 0;
    writer.addRowBlocks('a', blocks);
    featureTablesInternals(tables)?.addQueuedRowBlocks();
    expect(blocks[0].caches.map((c) => c.name)).toEqual(['test:a:1', 'test:b:1']);
    expect(first.made).toHaveLength(3);
    expect(second.made).toEqual([]);
    expect(numbersOf(blocks[0].caches[0], 1)).toEqual(numbersOf(blocks[0].caches[1], 1));
  });
});

describe('the column of a cache', () => {
  it('keeps the numbers wider than its width apart, and every number of a cache of 32 bits', () => {
    const narrow = new RowCacheWriter('n', 16, 3);
    narrow.put(0, [1, 2]);
    narrow.put(1, [70_000, 3]);
    narrow.put(2, Uint32Array.of(4));
    const n = narrow.finish();
    expect(n.numbers).toBeInstanceOf(Uint16Array);
    expect(Array.from(n.wideRows)).toEqual([1, 2]);
    expect([0, 1, 2].map((r) => numbersOf(n, r))).toEqual([[1, 2], [70_000, 3], [4]]);
    const wide = new RowCacheWriter('w', 32, 2);
    wide.put(0, [70_000]);
    wide.put(1, Uint32Array.of(5));
    const w = wide.finish();
    expect(w.numbers).toBeInstanceOf(Uint32Array);
    expect(Array.from(w.wideRows)).toEqual([]);
    expect([0, 1].map((r) => numbersOf(w, r))).toEqual([[70_000], [5]]);
  });
});

describe('the triangles of the fills of the library', () => {
  it('fit a row when they are in pairs within the vertices of its fill', () => {
    const square = {
      handle: -1,
      type: 'Polygon',
      value: () => undefined,
      shape: () => ({
        column: {
          type: 'Polygon',
          coords: Float64Array.of(0, 0, 1, 0, 1, 1, 0, 1, 0, 0),
          stride: 2,
          offsets: [Int32Array.of(0, 1), Int32Array.of(0, 5)],
        },
        at: 0,
      }),
    } satisfies RowRead;
    const made = Array.from(FILL_TRIANGLES.build(square, null));
    expect(made).toHaveLength(4);
    expect(FILL_TRIANGLES.fits(square, null, made)).toBe(true);
    expect(FILL_TRIANGLES.fits(square, null, [0, 1, 2])).toBe(false);
    expect(FILL_TRIANGLES.fits(square, null, [0, 1, 2, 4])).toBe(false);
  });
});
