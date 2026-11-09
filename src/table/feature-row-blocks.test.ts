// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The builder and the merge of the row blocks of the features (`feature-row-blocks.ts`)
 *
 * - The builder gives the rows the rings of the Circles when no rings are given, and the rings
 *   given otherwise; the row blocks are those of the builder of the tables given the same
 * - The merge merges as the merge of the tables does
 * - What the tables throw is a DrawError
 */

import { utf8String } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import { DrawError } from '../api/errors.js';
import { circleRowRings } from '../shared/circle-rings.js';
import { drawPropertyKey } from '../shared/properties.js';
import { createFeatureRowBlockBuilder, mergeFeatureRowBlock } from './feature-row-blocks.js';
import { createRowBlockBuilder, type RowInput } from './row-group-builder.js';
import { mergeRowBlock } from './row-group-merge.js';
import type { RowBlock, RowBlockData } from './row-group-types.js';
import type { RowRings } from './row-rings.js';

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
    const none: RowRings = { draws: () => false, ringOf: () => null, ringVertices: 1 };
    const blocks = build(createFeatureRowBlockBuilder({ rings: none }));
    expect(blocks).toEqual(build(createRowBlockBuilder({ rings: none })));
    expect(blocks).not.toEqual(build(createFeatureRowBlockBuilder()));
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
