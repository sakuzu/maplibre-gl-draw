// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hit testing of the rows of a layer held as columns
 *
 * The candidates are the rows whose bbox meets the box of the click (the spatial index of each
 * row group, and the index of the rows moved since their group was built), tested from the front of the order: the last group first, the last row of a group
 * first. Only the candidates become features, to be tested by the same tests as the features of
 * the Store; the feature of a candidate is made for the test and dropped. A hidden row (not
 * shown, deleted, hidden by this client) is not a candidate.
 */

import type { Coordinate, Feature } from '../shared/types/model.js';
import type { FeatureTablesInternals } from './feature-tables.js';
import type { LayerTable, RowGroup } from './layer-table.js';
import { rowFeature } from './row-read.js';
import { STATE_HIDDEN_MASK } from './row-state.js';

/**
 * What a hit test of the rows reads besides the rows
 *
 * @internal
 */
export interface TableHitInput {
  /** The coordinate of the click */
  readonly coordinate: Coordinate;
  /** How far from the click a candidate may be (degrees; the reach of the largest marker) */
  readonly reach: number;
  /** The tolerance a row is tested with (degrees) */
  toleranceOf(feature: Feature): number;
  /** Whether a feature is hit at a coordinate with a tolerance */
  test(feature: Feature, coordinate: Coordinate, tolerance: number): boolean;
}

/**
 * A row hit
 *
 * @internal
 */
export interface TableRowHit {
  readonly group: RowGroup;
  readonly row: number;
  /** The feature the row was tested as (made for the test) */
  readonly feature: Feature;
}

/**
 * The frontmost row of a layer hit at a coordinate (null when none is)
 *
 * @internal
 */
export function hitTestLayerTable(
  internals: FeatureTablesInternals,
  table: LayerTable,
  input: TableHitInput,
): TableRowHit | null {
  const [x, y] = input.coordinate;
  const reach = input.reach;
  const rows: number[] = [];
  for (let g = table.groupCount - 1; g >= 0; g--) {
    const group = table.groupAt(g);
    rows.length = 0;
    table.searchRows(group, x - reach, y - reach, x + reach, y + reach, rows);
    if (rows.length === 0) continue;
    // The front first: the rows of a group are in the order they are drawn
    rows.sort((a, b) => b - a);
    for (const row of rows) {
      if ((group.state[row] & STATE_HIDDEN_MASK) !== 0) continue;
      const feature = rowFeature(internals.readContext, table.layerId, group, row);
      if (input.test(feature, input.coordinate, input.toleranceOf(feature))) {
        return { group, row, feature };
      }
    }
  }
  return null;
}
