// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pairs of triangles kept with the rows
 *
 * - The pairs a group keeps for a row are the triangles earcut makes of it, paired
 * - Packing the rows reads the pairs as they are kept: neither earcut nor the pairing runs for
 *   a row that did not change; a row whose geometry is written runs them once
 * - The fill instances of a row are its pairs
 */

import { planarCoordinates } from '@sakuzu/tabane';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rowTriangles } from '../../feature-table/row-read.js';
import { writeRowGeometry } from '../../feature-table/row-write.js';
import { circleRowRings } from '../../table/circle-rings.js';
import { FEATURE_CACHES } from '../../table/fill-triangles.js';
import { pairTriangles } from '../../table/row-geometry.js';
import { createTestDrawer, feature, tablesOfFeatures } from '../../test-utils.js';
import { buildEarcutInput } from '../renderers/polygon/earcut-input.js';
import { ROWS_KIND, RowsPalette, readRowsInstance } from '../renderers/rows/rows-format.js';
import { TerrainContext } from '../terrain/context.js';
import { collectRow, RowStyleSlots, RowsDraft, RowsStyles } from './table-collect.js';

const calls = vi.hoisted(() => ({ earcut: 0 }));

vi.mock('earcut', async (importOriginal) => {
  const actual = await importOriginal<typeof import('earcut')>();
  return {
    default: (...args: Parameters<typeof actual.default>) => {
      calls.earcut++;
      return actual.default(...args);
    },
  };
});

beforeEach(() => {
  calls.earcut = 0;
});

const square = (x: number, y: number, side: number): number[][] => [
  [x, y],
  [x + side, y],
  [x + side, y + side],
  [x, y + side],
  [x, y],
];

/** A ring of `n` corners around a center */
const round = (x: number, y: number, n: number): number[][] => {
  const ring: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push([x + Math.cos(a), y + Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
};

function setup() {
  const features = [
    feature('a', 'Polygon', [round(0, 0, 12), square(-0.2, -0.2, 0.4)]),
    feature('b', 'MultiPolygon', [[square(5, 5, 1)], [round(8, 8, 7)]]),
    feature('c', 'Polygon', [round(20, 20, 30)]),
  ];
  const tables = tablesOfFeatures('layer', features);
  const group = tables.table.groupAt(0);
  const slots = new RowStyleSlots(createTestDrawer(), tables.internals.styles, undefined);
  const palette = new RowsPalette();
  const context = {
    slots,
    strings: tables.internals.strings,
    pixelRatio: 1,
    terrain: new TerrainContext(),
    rowsStyles: new RowsStyles(slots, palette, 1, tables.internals.styles),
    spriteSourceOf: () => undefined,
  };
  const pack = () => {
    const draft = new RowsDraft(group.data.length, 0, undefined, palette);
    for (let row = 0; row < group.data.length; row++) {
      collectRow(group, row, row, draft, [0, 0], context);
    }
    return draft;
  };
  return { tables, group, features, pack };
}

describe('the pairs of triangles of the rows', () => {
  it('are the triangles of earcut, paired', () => {
    const { group, features } = setup();
    const rings = (features[2].geometry as { coordinates: number[][][] }).coordinates;
    const input = buildEarcutInput(rings as [number, number][][]);
    const expected: number[] = [];
    const triangles = earcutOf(input.flatCoords, input.holeIndices);
    pairTriangles(triangles, 0, triangles.length, 0, (a, b, c, d) => {
      expected.push(a, b, c, d);
    });
    expect(Array.from(rowTriangles(group, 2))).toEqual(expected);
  });

  it('are read as they are kept when the rows are packed, and made again for a row written', () => {
    const { tables, group, pack } = setup();
    calls.earcut = 0;
    pack();
    expect(calls.earcut).toBe(0);
    // A corner of the square of the second row moved: its two polygons are triangulated again
    writeRowGeometry(
      tables.table,
      group,
      1,
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [5, 5],
              [6.3, 5],
              [6, 6],
              [5, 6],
              [5, 5],
            ],
          ],
          [round(8, 8, 7)],
        ],
      },
      planarCoordinates,
      circleRowRings,
      FEATURE_CACHES,
    );
    expect(calls.earcut).toBe(2);
    calls.earcut = 0;
    pack();
    expect(calls.earcut).toBe(0);
  });

  it('are the fill instances of a row', () => {
    const { group, pack } = setup();
    const draft = pack();
    for (let row = 0; row < group.data.length; row++) {
      const pairs = Array.from(rowTriangles(group, row));
      const fills: number[] = [];
      for (let i = draft.rowFirst[row]; i < draft.rowFirst[row + 1]; i++) {
        const instance = readRowsInstance(draft.instances, i);
        if (instance.kind === ROWS_KIND.fill) fills.push(...instance.indices);
      }
      // The coordinates of the row start at its first one (the fill reads them from there)
      const first = draft.coordFirst[row];
      expect(fills.map((index) => index - first)).toEqual(pairs);
    }
  });
});

/** The triangles of earcut, without counting the call */
function earcutOf(flat: number[], holes: number[]): number[] {
  const before = calls.earcut;
  const out = earcutModule(flat, holes);
  calls.earcut = before;
  return out;
}

let earcutModule: (flat: number[], holes: number[]) => number[] = () => [];
beforeEach(async () => {
  const module = await import('earcut');
  earcutModule = module.default as unknown as (flat: number[], holes: number[]) => number[];
});
