// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The keys of the order of a place, as a Store of rows makes them for a new feature put there
 *
 * A sketch of a new feature (`draw.sketches`) is drawn among the rows at the place it will be
 * created in, before it is a row: the Store of rows of core gives the keys of that place, found by
 * its tables.
 */

import type { OverlayPlace } from '../feature-table/feature-tables.js';
import type { ItemPlacement } from './types.js';

/**
 * The keys of the order a new feature put in a place gets: of its layer, and in a group its group
 * and its key there (null when the layer or the group is not there)
 *
 * @internal
 */
export type RowPlaceKeys = (to: ItemPlacement) => OverlayPlace | null;

/** The keys of the places by the tables of their Store */
const PLACE_KEYS = new WeakMap<object, RowPlaceKeys>();

/**
 * Tells the keys of the places of the Store whose tables these are
 *
 * @internal
 */
export function setRowPlaceKeys(tables: object, keys: RowPlaceKeys): void {
  PLACE_KEYS.set(tables, keys);
}

/**
 * The keys of the places of the Store whose tables these are (undefined for tables without them)
 *
 * @internal
 */
export function rowPlaceKeysOf(tables: object | undefined): RowPlaceKeys | undefined {
  return tables ? PLACE_KEYS.get(tables) : undefined;
}
