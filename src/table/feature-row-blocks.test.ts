// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The builder and the merge of the row blocks of the features (`feature-row-blocks.ts`)
 *
 * - The builder gives the rows the rings of the Circles when no rings are given, and the rings
 *   given otherwise, read from the type, the point and the attributes of a row; the row blocks
 *   are those of the builder of the tables given the same. The builder of the tables has no rings
 *   of its own
 * - The merge merges as the merge of the tables does
 * - What the tables throw is a DrawError
 */

import { utf8String } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import { DrawError } from '../api/errors.js';
import { drawPropertyKey } from '../shared/properties.js';
import { circleRowRings } from './circle-rings.js';
import { createFeatureRowBlockBuilder, mergeFeatureRowBlock } from './feature-row-blocks.js';
import { createRowBlockBuilder, type RowInput } from './row-group-builder.js';
import { mergeRowBlock } from './row-group-merge.js';
import type { RowBlock, RowBlockData } from './row-group-types.js';
import { type PointRowRings, rowRingsOfPoint } from './row-rings.js';

const ROWS: RowInput[] = [
  {
    id: 'c',
    type: 'Circle',
    geometry: { type: 'Point', coordinates: [10, 20] },
    order: 'a1',
    properties: { [drawPropertyKey('radiusMeters')]: 5000 },
  },
  { id: 'p', type: 'Point', geometry: { type: 'Point', coordinates: [1, 2] }, order: 'a0' },
  {
    id: 'l',
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
    order: 'a2',
  },
];

function build(builder: { addRow(row: RowInput): void; finish(): RowBlock[] }): RowBlock[] {
  for (const row of ROWS) builder.addRow(row);
  return builder.finish();
}

describe('the builder of the row blocks of the features', () => {
  it('gives the rows the rings of the Circles when no rings are given', () => {
    const blocks = build(createFeatureRowBlockBuilder());
    expect(blocks).toEqual(build(createRowBlockBuilder({ rings: circleRowRings })));
    const [block] = blocks as RowBlockData[];
    // The Circle (the second row in the order) has the box of its ring, past its center
    const circle = 1;
    expect(utf8String(block.ids, circle)).toBe('c');
    expect(block.rowBounds[circle * 4 + 2] - block.rowBounds[circle * 4]).toBeGreaterThan(0);
  });

  it('gives the rows the rings given', () => {
    const none: PointRowRings = { draws: () => false, ringOf: () => null, ringVertices: 1 };
    const blocks = build(createFeatureRowBlockBuilder({ rings: none }));
    expect(blocks).toEqual(build(createRowBlockBuilder({ rings: rowRingsOfPoint(none) })));
    expect(blocks).not.toEqual(build(createFeatureRowBlockBuilder()));
    // The builder of the tables draws no ring when given none
    expect(build(createRowBlockBuilder())).toEqual(blocks);
  });

  it('reads the rings given from the type, the point and the attributes of a row', () => {
    const asked: unknown[] = [];
    const square: PointRowRings = {
      draws: (type) => type === 'Circle',
      ringOf: (type, x, y, value) => {
        asked.push([type, x, y, value(drawPropertyKey('radiusMeters')), value('none')]);
        return Float64Array.of(x, y, x + 1, y, x + 1, y + 1, x, y);
      },
      ringVertices: 4,
    };
    const [block] = build(createFeatureRowBlockBuilder({ rings: square })) as RowBlockData[];
    expect(asked[0]).toEqual(['Circle', 10, 20, 5000, undefined]);
    const circle = 1;
    expect(Array.from(block.rowBounds.subarray(circle * 4, circle * 4 + 4))).toEqual([
      10, 20, 11, 21,
    ]);
  });

  it('throws an error of the tables as a DrawError', () => {
    const builder = createFeatureRowBlockBuilder();
    builder.addRow(ROWS[0]);
    expect(() => builder.addRow(ROWS[0])).toThrow(DrawError);
  });
});

describe('the merge of the row blocks of the features', () => {
  it('merges as the merge of the tables', () => {
    // Sources whose styles are numbered, as the tables hold them
    const sources = (build(createFeatureRowBlockBuilder()) as RowBlockData[]).map((block) => ({
      ...block,
      styleDictionary: null,
    }));
    const merge = {
      sources,
      rows: Int32Array.of(0, 2, 0, 0),
      ringVertices: circleRowRings.ringVertices,
    };
    expect(mergeFeatureRowBlock(merge)).toEqual(mergeRowBlock(merge));
  });

  it('throws an error of the tables as a DrawError', () => {
    const sources = build(createFeatureRowBlockBuilder());
    expect(() => mergeFeatureRowBlock({ sources, rows: Int32Array.of(0, 0) })).toThrow(DrawError);
  });
});
