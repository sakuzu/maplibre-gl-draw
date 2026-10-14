// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hit testing of the rows of a layer held as columns
 *
 * The candidates are the rows whose bbox meets the box of the click (the spatial index of each
 * row group and of the delta of the layer, the index of the rows moved since their group was
 * built, and the new rows not taken in yet), tested from the front of the order. A candidate is
 * tested on its column, read in place as a shape, by the same test as a feature of its type: no
 * feature is made. A type whose test reads a feature (an image, the type of an extension, a
 * shape cut on the globe) is tested on a feature made of the row for the test and dropped. A
 * hidden row (not shown, deleted, hidden by this client) is not a candidate; a row a feature is
 * drawn over for this client (`overlay`) is hit where it is.
 */

import { ColumnRun, type HitShape, type PositionRun } from '../shared/math/position-runs.js';
import { drawPropertyKey } from '../shared/properties.js';
import type { Coordinate, Feature, FeatureStyle, FeatureType } from '../shared/types/model.js';
import type { FeatureTablesInternals } from './feature-tables.js';
import { geometryAt, type LayerTable, type RowGroup } from './layer-table.js';
import { rowFeature, rowNumber, rowType } from './row-read.js';
import { STATE_UNHIT_MASK } from './row-state.js';

/** The key of the radius of a Circle in the attributes of a row */
const RADIUS_KEY = drawPropertyKey('radiusMeters');

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
  /** The tolerance a row of a type and a style is tested with (degrees) */
  toleranceOf(type: FeatureType, style: FeatureStyle): number;
  /**
   * Whether the shape of a row of a type is hit at a coordinate with a tolerance (null when the
   * test of its type reads a feature)
   */
  testShape(
    type: FeatureType,
    shape: HitShape,
    coordinate: Coordinate,
    tolerance: number,
  ): boolean | null;
  /** Whether a feature is hit at a coordinate with a tolerance */
  test(feature: Feature, coordinate: Coordinate, tolerance: number): boolean;
  /** Whether a row is left out besides its state (its group hidden by this client) */
  skip?(group: RowGroup, row: number): boolean;
}

/**
 * A row hit
 *
 * @internal
 */
export interface TableRowHit {
  readonly group: RowGroup;
  readonly row: number;
  /** Its type */
  readonly type: FeatureType;
  /** The tolerance it was tested with (degrees) */
  readonly tolerance: number;
  /** Its shape as it was tested (null when it was tested as a feature) */
  readonly shape: HitShape | null;
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
  const candidates: Array<{ group: RowGroup; row: number }> = [];
  table.searchInOrder(x - reach, y - reach, x + reach, y + reach, (group, row) => {
    if ((group.state[row] & STATE_UNHIT_MASK) !== 0) return;
    if (input.skip?.(group, row)) return;
    candidates.push({ group, row });
  });
  // The front first: the rows are found in the order they are drawn
  for (let i = candidates.length - 1; i >= 0; i--) {
    const { group, row } = candidates[i];
    const type = rowType(group.data, row);
    const tolerance = input.toleranceOf(type, internals.styles.get(group.data.styles[row]));
    const shape = rowHitShape(group, row);
    let hit = shape ? input.testShape(type, shape, input.coordinate, tolerance) : null;
    if (hit === null) {
      // A type tested on a feature: one made for the test and dropped
      const feature = rowFeature(internals.readContext, table.layerId, group, row);
      hit = input.test(feature, input.coordinate, tolerance);
      if (hit) return { group, row, type, tolerance, shape: null };
      continue;
    }
    if (hit) return { group, row, type, tolerance, shape };
  }
  return null;
}

/**
 * The shape of a row read in place from its column (the geometry written in place when there
 * is), with the radius of a Circle (null for a row without a geometry)
 *
 * @internal
 */
export function rowHitShape(group: RowGroup, row: number): HitShape | null {
  const at = geometryAt(group, row);
  if (!at) return null;
  const { reader } = at;
  const o = reader.offsets;
  const run = (from: number, to: number): PositionRun =>
    new ColumnRun(reader.coords, from, to - from, reader.stride);
  let parts: PositionRun[][];
  switch (reader.type) {
    case 'Point': {
      const v = reader.vertexStart(at.at);
      parts = [[run(v, v + 1)]];
      break;
    }
    case 'LineString':
    case 'MultiPoint':
      parts = [[run(o[0][at.at], o[0][at.at + 1])]];
      break;
    case 'Polygon':
    case 'MultiLineString': {
      const runs: PositionRun[] = [];
      for (let r = o[0][at.at]; r < o[0][at.at + 1]; r++) runs.push(run(o[1][r], o[1][r + 1]));
      parts = [runs];
      break;
    }
    case 'MultiPolygon': {
      parts = [];
      for (let p = o[0][at.at]; p < o[0][at.at + 1]; p++) {
        const rings: PositionRun[] = [];
        for (let r = o[1][p]; r < o[1][p + 1]; r++) rings.push(run(o[2][r], o[2][r + 1]));
        parts.push(rings);
      }
      break;
    }
    default:
      return null;
  }
  if (rowType(group.data, row) !== 'Circle') return { parts };
  return { parts, radiusMeters: rowNumber(group, row, RADIUS_KEY) };
}
