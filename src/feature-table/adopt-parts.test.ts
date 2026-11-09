// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows of a layer built in parts: rows cut into runs of their keys that
 * follow each other, each run built into row groups by a builder of its own (as several Workers
 * build the parts of a file at once) and taken in run by run, read as the rows one builder
 * builds: the same rows in the same order, the same items and values. The runs taken in out of
 * their order still read in the order of their keys.
 */

import { describe, expect, it } from 'vitest';
import type { FeatureTables } from '../api/tables.js';
import { circleRowRings } from '../table/circle-rings.js';
import { createRowBlockDataBuilder, type RowInput } from '../table/row-group-builder.js';
import type { RowBlockData } from '../table/row-group-types.js';
import { orderKey, randomRowGeometry, seededRandom } from '../test-utils.js';
import { createFeatureTablesStore } from './feature-row-tables.js';
import { type FeatureTablesInternals, featureTablesInternals } from './feature-tables.js';

const TYPES = ['Point', 'LineString', 'Polygon'];

/** Rows at random, in the order of their keys */
function rowsOf(random: () => number, n: number): RowInput[] {
  return Array.from({ length: n }, (_, i) => {
    const type = TYPES[Math.floor(random() * TYPES.length)];
    return {
      id: `r${i}`,
      type,
      geometry: randomRowGeometry(random, type),
      order: orderKey(i),
      style: { fillColor: random() < 0.5 ? '#ff0000' : '#00ff00' },
      properties: { name: `row ${i}`, value: Math.floor(random() * 100) },
    };
  });
}

/** The row groups of rows, built by one builder */
function build(rows: readonly RowInput[]): RowBlockData[] {
  const builder = createRowBlockDataBuilder({ targetRows: 64, rings: circleRowRings });
  for (const row of rows) builder.addRow(row);
  return builder.finish();
}

/** The tables of a layer `rows` that took in the row groups of each part, in the order given */
function tablesOf(parts: readonly RowBlockData[][]): FeatureTables {
  const { tables, writer } = createFeatureTablesStore();
  for (const groups of parts) writer.addRowBlocks('rows', groups);
  (featureTablesInternals(tables) as FeatureTablesInternals).addQueuedRowBlocks();
  return tables;
}

/** What the tables read of the layer: its rows in their order, with their features */
function readOf(tables: FeatureTables): unknown[] {
  const view = tables.get('rows');
  if (!view) return [];
  return Array.from(view.listRowHandles(0, view.rowCount), (handle) => view.getRow(handle));
}

describe('the rows of a layer built in parts', () => {
  it('read as the rows one builder builds, the parts taken in in their order or not', () => {
    for (const seed of [1, 2, 3]) {
      const random = seededRandom(seed);
      const rows = rowsOf(random, 1_000);
      const whole = readOf(tablesOf([build(rows)]));
      // Cut at places at random: the runs of keys follow each other
      const cuts = [0, ...Array.from({ length: 5 }, () => Math.floor(random() * 1_000)), 1_000];
      cuts.sort((a, b) => a - b);
      const parts: RowBlockData[][] = [];
      for (let k = 0; k + 1 < cuts.length; k++) {
        if (cuts[k + 1] > cuts[k]) parts.push(build(rows.slice(cuts[k], cuts[k + 1])));
      }
      expect(readOf(tablesOf(parts)), `seed ${seed}`).toEqual(whole);
      // Taken in as they come (the last part first)
      const again: RowBlockData[][] = [];
      for (let k = 0; k + 1 < cuts.length; k++) {
        if (cuts[k + 1] > cuts[k]) again.push(build(rows.slice(cuts[k], cuts[k + 1])));
      }
      expect(readOf(tablesOf(again.reverse())), `seed ${seed}`).toEqual(whole);
    }
  });
});
