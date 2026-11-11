// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The builder and the merge of the pages of the features (`feature-row-blocks.ts`)
 *
 * - The builder gives the rows the rings of the Circles when no rings are given, and the rings
 *   given otherwise, read from the type, the point and the attributes of a row, and the triangles
 *   of the fills as a cache; the pages are those of the builder of the tables given the
 *   same. The builder of the tables has no rings and no caches of its own
 * - The merge merges as the merge of the tables does
 * - What the tables throw is a DrawError
 */

import type { Page } from '@sakuzu/kasane';
import { mergePages, type PointRowRings } from '@sakuzu/kasane';
import type { PageData } from '@sakuzu/kasane/render';
import { rowRingsOfPoint } from '@sakuzu/kasane/render';
import { utf8String } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import { DrawError } from '../api/errors.js';
import { drawPropertyKey } from '../shared/properties.js';
import { featureRowBuilder as createPageBuilder } from '../test-utils.js';
import { circleRowRings } from './circle-rings.js';
import {
  createFeaturePageBuilder,
  mergeFeaturePages,
  type FeatureRowInput as RowInput,
} from './feature-row-blocks.js';
import { FEATURE_CACHES } from './fill-triangles.js';
import { FEATURE_TABLE_COLUMNS } from './tabane/columns.js';

const ROWS: RowInput[] = [
  {
    id: 'c',
    type: 'Circle',
    geometry: { type: 'Point', coordinates: [10, 20] },
    key: 'a1',
    properties: { [drawPropertyKey('radiusMeters')]: 5000 },
  },
  { id: 'p', type: 'Point', geometry: { type: 'Point', coordinates: [1, 2] }, key: 'a0' },
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
    key: 'a2',
  },
];

function build(builder: { addRow(row: RowInput): void; finish(): Page[] }): Page[] {
  for (const row of ROWS) builder.addRow(row);
  return builder.finish();
}

describe('the builder of the pages of the features', () => {
  it('gives the rows the rings of the Circles when no rings are given', () => {
    const blocks = build(createFeaturePageBuilder());
    expect(blocks).toEqual(
      build(
        createPageBuilder({
          columns: FEATURE_TABLE_COLUMNS,
          rings: circleRowRings,
          caches: FEATURE_CACHES,
        }),
      ),
    );
    const [block] = blocks as PageData[];
    // The Circle (the second row in the order) has the box of its ring, past its center
    const circle = 1;
    expect(utf8String(block.ids, circle)).toBe('c');
    expect(block.rowBounds[circle * 4 + 2] - block.rowBounds[circle * 4]).toBeGreaterThan(0);
  });

  it('gives the rows the rings given', () => {
    const none: PointRowRings = { draws: () => false, ringOf: () => null, ringVertices: 1 };
    const blocks = build(createFeaturePageBuilder({ rings: none }));
    expect(blocks).toEqual(
      build(
        createPageBuilder({
          columns: FEATURE_TABLE_COLUMNS,
          rings: rowRingsOfPoint(none),
          caches: FEATURE_CACHES,
        }),
      ),
    );
    expect(blocks).not.toEqual(build(createFeaturePageBuilder()));
    // The builder of the tables draws no ring when given none, and has no cache of its own
    expect(
      build(createPageBuilder({ columns: FEATURE_TABLE_COLUMNS, caches: FEATURE_CACHES })),
    ).toEqual(blocks);
    expect(
      (build(createPageBuilder({ columns: FEATURE_TABLE_COLUMNS })) as PageData[])[0].caches,
    ).toEqual([]);
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
    const [block] = build(createFeaturePageBuilder({ rings: square })) as PageData[];
    expect(asked[0]).toEqual(['Circle', 10, 20, 5000, undefined]);
    const circle = 1;
    expect(Array.from(block.rowBounds.subarray(circle * 4, circle * 4 + 4))).toEqual([
      10, 20, 11, 21,
    ]);
  });

  it('throws an error of the tables as a DrawError', () => {
    const builder = createFeaturePageBuilder();
    builder.addRow(ROWS[0]);
    expect(() => builder.addRow(ROWS[0])).toThrow(DrawError);
  });
});

describe('the merge of the pages of the features', () => {
  it('merges as the merge of the tables', () => {
    // Sources whose styles are numbered, as the tables hold them
    const sources = (build(createFeaturePageBuilder()) as PageData[]).map((block) => ({
      ...block,
      wholes: block.wholes.map((w) => (w && 'dictionary' in w ? { ...w, dictionary: null } : w)),
    }));
    const merge = {
      sources,
      rows: Int32Array.of(0, 2, 0, 0),
      ringVertices: circleRowRings.ringVertices,
    };
    expect(mergeFeaturePages(merge)).toEqual(mergePages(merge));
  });

  it('throws an error of the tables as a DrawError', () => {
    const sources = build(createFeaturePageBuilder());
    expect(() => mergeFeaturePages({ sources, rows: Int32Array.of(0, 0) })).toThrow(DrawError);
  });
});
