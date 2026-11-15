// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hit testing of the rows of a layer held as columns
 *
 * The candidates are the rows whose boxes meet the box of the click, from the one spatial index of
 * the boxes of every row (`FeatureTablesInternals.searchRowBoxes`: the box of the positions of a
 * row, or the box the calculation of its type gives),
 * tested from the front of the order. A candidate is
 * tested on its column, read in place as a shape, by the same test as a feature of its type: no
 * feature is made. A type whose test reads a feature (an image, the type of an extension, a
 * shape cut on the globe) is tested on the feature of the row (`FeatureCache`), given with the
 * hit for what reads it after. A hidden row (not shown, deleted, hidden by this client) is not a
 * candidate; a row a sketch is drawn over for this client is hit where it is.
 */

import type { PageDictionary } from '@sakuzu/kasane/render';
import { geometryAt, type RowGroup, type RowTable } from '@sakuzu/kasane/render';
import { ColumnRun, type HitShape, type PositionRun } from '../shared/math/position-runs.js';
import { drawPropertyKey } from '../shared/properties.js';
import type { Coordinate, Feature, FeatureStyle, FeatureType } from '../shared/types/model.js';
import { STYLE_COLUMN } from '../table/feature-row-columns.js';
import { STATE_UNHIT_MASK } from './feature-row-states.js';
import type { FeatureTablesInternals } from './feature-tables.js';
import { rowNumber, rowType } from './row-read.js';

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
  /**
   * The points drawn without a depth test (on the terrain), hit where they are drawn on the
   * screen: absent where they are hit at the coordinate, as the rows of the other types
   */
  readonly onScreen?: TableScreenHit;
}

/**
 * How the points of the rows are hit on the screen: the anchor of each point projected as it is
 * drawn (its position and the ground elevation under it), compared with the click
 *
 * The line of sight under the click can meet a ridge in front of a point that is still drawn
 * behind it, so the coordinate of the click is no measure of a point there.
 *
 * @internal
 */
export interface TableScreenHit {
  /**
   * The boxes (degrees, `[minX, minY, maxX, maxY]` one after another, on the copies of the world
   * the rows are stored on) that hold every position whose point may be drawn under the click
   */
  readonly boxes: readonly number[];
  /**
   * The distance on the screen (CSS px) from the click to where the anchor of a position is
   * drawn; null where it is not drawn (behind the camera)
   */
  distancePx(lng: number, lat: number): number | null;
  /** How far from the click on the screen a point of a style is hit (CSS px) */
  reachPx(style: FeatureStyle): number;
}

/** The types whose rows are hit on the screen when {@link TableHitInput.onScreen} is given */
const SCREEN_TYPES: ReadonlySet<FeatureType> = new Set<FeatureType>(['Point', 'MultiPoint']);

/**
 * Whether the rows of a type are hit on the screen when {@link TableHitInput.onScreen} is given
 * (the points, drawn without a depth test)
 *
 * @internal
 */
export function isScreenHitType(type: FeatureType): boolean {
  return SCREEN_TYPES.has(type);
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
  /** The feature it was tested as (null when it was tested by its shape) */
  readonly feature: Feature | null;
  /** The distance on the screen from the click (CSS px), for a point hit on the screen */
  readonly screenDistancePx?: number;
}

/**
 * The frontmost row of a layer hit at a coordinate (null when none is)
 *
 * @internal
 */
export function hitTestLayerTable(
  internals: FeatureTablesInternals,
  table: RowTable,
  input: TableHitInput,
): TableRowHit | null {
  const [x, y] = input.coordinate;
  const reach = input.reach;
  const candidates: Array<{ group: RowGroup; row: number }> = [];
  const take = (group: RowGroup, row: number): void => {
    if ((group.state[row] & STATE_UNHIT_MASK) !== 0) return;
    if (input.skip?.(group, row)) return;
    candidates.push({ group, row });
  };
  const onScreen = input.onScreen;
  if (onScreen) {
    // The rows near the click, and the points along the line of sight under it
    internals.searchRowBoxesIn(
      table,
      [x - reach, y - reach, x + reach, y + reach, ...onScreen.boxes],
      take,
    );
  } else {
    internals.searchRowBoxes(table, x - reach, y - reach, x + reach, y + reach, take);
  }
  // The front first: the rows are found in the order they are drawn
  for (let i = candidates.length - 1; i >= 0; i--) {
    const { group, row } = candidates[i];
    const type = rowType(group.data, row);
    const style = internals.styles.get(
      (group.data.wholes[STYLE_COLUMN] as PageDictionary).indexes[row],
    );
    const tolerance = input.toleranceOf(type, style);
    if (onScreen && SCREEN_TYPES.has(type)) {
      // A point is hit where its anchor is drawn, never at the coordinate
      const distance = rowScreenDistancePx(group, row, onScreen);
      if (distance !== null && distance <= onScreen.reachPx(style)) {
        const shape = rowHitShape(group, row);
        return { group, row, type, tolerance, shape, feature: null, screenDistancePx: distance };
      }
      continue;
    }
    const shape = rowHitShape(group, row);
    let hit = shape ? input.testShape(type, shape, input.coordinate, tolerance) : null;
    if (hit === null) {
      // A type tested on a feature: the one kept of the row, made for the test otherwise
      const feature = internals.featureCache.featureOf(table.tableId, group, row);
      hit = input.test(feature, input.coordinate, tolerance);
      if (hit) return { group, row, type, tolerance, shape: null, feature };
      continue;
    }
    if (hit) return { group, row, type, tolerance, shape, feature: null };
  }
  return null;
}

/**
 * The distance on the screen from the click to the nearest point of a row, as its anchors are
 * drawn (null when none is drawn)
 *
 * @internal
 */
export function rowScreenDistancePx(
  group: RowGroup,
  row: number,
  onScreen: TableScreenHit,
): number | null {
  const at = geometryAt(group, row);
  if (!at) return null;
  const { reader } = at;
  const coords = reader.coords;
  const stride = reader.stride;
  let nearest: number | null = null;
  for (let v = reader.vertexStart(at.at); v < reader.vertexStart(at.at + 1); v++) {
    const distance = onScreen.distancePx(coords[v * stride], coords[v * stride + 1]);
    if (distance !== null && (nearest === null || distance < nearest)) nearest = distance;
  }
  return nearest;
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
