// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows being dragged, as what follows them reads them
 *
 * Rows dragged in bulk are not written while they are dragged: they are drawn moved by the state
 * of their rows (a moving set: the edit that moves, rotates or scales them, then a translation).
 * What an extension draws with a row reads here whether its row is dragged and where, to be drawn
 * moved the same way: a position is moved by the computation the rows are written with once let go
 * (the one of the library, in float64).
 */

import type { Position } from 'geojson';
import type { FeatureTables, RowHandle } from '../api/tables.js';
import { type EnuEdit, moveEnuPosition, withinTurn } from '../geometry/enu-transforms.js';
import { DRAW_PROPERTY_KEYS } from '../shared/properties.js';
import type { Feature } from '../shared/types/model.js';
import { featureTablesInternals } from './feature-tables.js';
import { rowType } from './row-read.js';
import {
  GPU_STATE_MOVE_SHIFT,
  GPU_STATE_UNIFORM,
  MOVE_SETS,
  STATE_BY_VALUES,
  STATE_MOVE_MASK,
  STATE_MOVE_SHIFT,
} from './row-state.js';

/**
 * The rows being dragged and how they are moved, while they are drawn moved and not written yet
 *
 * @experimental
 */
export interface DraggedRows {
  /** Whether the row of a handle is being dragged */
  has(handle: RowHandle): boolean;
  /**
   * A position of a row, where the row is drawn now: moved as it is while it is dragged (the
   * values after `x` and `y` kept), as it is otherwise
   */
  position(handle: RowHandle, position: Position): Position;
  /**
   * The angle a row dragged that turns by its rotation (an image, a row of a custom type that
   * declares `angleDegreesKey`, a row of another type that has a rotation) is
   * turned by, in degrees counterclockwise (0 otherwise): its rotation once written is the one it
   * has plus this angle, within [0, 360)
   */
  rotation(handle: RowHandle): number;
  /**
   * The factor of the scale of a row dragged that keeps its shape (an image, a row of a custom
   * type that declares `uniformScale`, a row of another type that has a scale), and of the radius
   * of a Circle (1 otherwise)
   */
  scale(handle: RowHandle): number;
}

/**
 * How the rows being dragged are moved, as the GPU moves them (the state of the rows of
 * `view/renderers/row-state.ts`)
 *
 * @internal
 */
export interface DraggedRowMotions {
  /**
   * The bits of the byte the GPU reads for the row of a handle that tell how it moves: its moving
   * set, and whether it keeps its shape (0 for a row not dragged)
   */
  gpuStateOf(handle: RowHandle): number;
  /** The translation of a moving set (1 to 3), `[dLng, dLat]` in degrees */
  translation(set: number): [number, number];
  /** The edit that moves, rotates or scales a moving set before its translation (null for none) */
  transform(set: number): EnuEdit | null;
}

/** The motions behind each `DraggedRows` made here */
const motions = new WeakMap<DraggedRows, DraggedRowMotions>();

/**
 * How the rows being dragged are moved, as the GPU moves them
 *
 * @returns undefined for an object `draggedRowsOf` did not make
 * @internal
 */
export function draggedRowMotionsOf(dragged: DraggedRows): DraggedRowMotions | undefined {
  return motions.get(dragged);
}

/**
 * The rows being dragged of tables (null when no row is: nothing is drawn moved)
 *
 * @param tables - The tables of a Store that holds its features as rows (`StoreView.tables`)
 * @returns What reads them, or null
 * @experimental
 */
export function draggedRowsOf(tables: FeatureTables | undefined): DraggedRows | null {
  const internals = featureTablesInternals(tables);
  if (!internals) return null;
  const states = internals.states;
  let moving = false;
  for (let set = 1; set <= MOVE_SETS; set++) {
    const [dx, dy] = states.translation(set);
    if (dx !== 0 || dy !== 0 || states.transform(set)) moving = true;
  }
  if (!moving) return null;
  const setOf = (handle: RowHandle): number =>
    (states.stateOf(handle) & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT;
  const byValues = (handle: RowHandle): boolean => (states.stateOf(handle) & STATE_BY_VALUES) !== 0;
  const keepsShape = (handle: RowHandle): boolean => {
    if (byValues(handle)) return true;
    const place = internals.placeOf(handle);
    return place ? rowType(place.group.data, place.row) === 'Circle' : false;
  };
  const dragged: DraggedRows = {
    has: (handle) => setOf(handle) > 0,
    position(handle, position) {
      const set = setOf(handle);
      if (set === 0) return position;
      const edit = states.transform(set);
      // A Circle and a row turned or scaled by its values keep their shape
      const moved = edit ? moveEnuPosition(edit, position, keepsShape(handle)) : [...position];
      const [dx, dy] = states.translation(set);
      return [(moved[0] as number) + dx, (moved[1] as number) + dy, ...moved.slice(2)];
    },
    rotation(handle) {
      if (!byValues(handle)) return 0;
      const edit = states.transform(setOf(handle));
      return edit?.kind === 'rotate' ? edit.angleDegrees : 0;
    },
    scale(handle) {
      if (!keepsShape(handle)) return 1;
      const edit = states.transform(setOf(handle));
      return edit?.kind === 'scale' ? edit.sizeFactor : 1;
    },
  };
  motions.set(dragged, {
    gpuStateOf(handle) {
      const set = setOf(handle);
      if (set === 0) return 0;
      return (set << GPU_STATE_MOVE_SHIFT) | (keepsShape(handle) ? GPU_STATE_UNIFORM : 0);
    },
    translation: (set) => states.translation(set),
    transform: (set) => states.transform(set),
  });
  return dragged;
}

/**
 * A feature of a row being dragged, where the row is drawn: its positions moved by the computation
 * its row is written with once let go, and the rotation, the scale and the radius it holds turned
 * and scaled with them as that write gives them. A feature of a row held that is moved as a whole
 * among many rows held is written where it is moved to, and is given as it is
 *
 * @param feature - The feature of the row, as the Store and the sketches give it
 * @param tables - The tables of the Store
 * @param dragged - The rows being dragged of these tables
 * @returns The feature moved, or the feature given when its row is not dragged
 * @internal
 */
export function draggedFeatureOf(
  feature: Feature,
  tables: FeatureTables,
  dragged: DraggedRows,
): Feature {
  const handle = tables.findRow(feature.id);
  if (handle === undefined || !dragged.has(handle)) return feature;
  const move = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    if (typeof value[0] === 'number') return dragged.position(handle, value as Position);
    return value.map(move);
  };
  const geometry = feature.geometry as unknown as { type: string; coordinates?: unknown };
  const moved = {
    ...feature,
    geometry: { ...geometry, coordinates: move(geometry.coordinates) },
  } as Feature;
  const values: Record<string, number> = {};
  const rotation = dragged.rotation(handle);
  if (rotation !== 0) {
    const had = numberOf(feature, DRAW_PROPERTY_KEYS.rotation) ?? 0;
    values[DRAW_PROPERTY_KEYS.rotation] = withinTurn(had + rotation);
  }
  const scale = dragged.scale(handle);
  if (scale !== 1) {
    if (feature.type === 'Circle') {
      const radius = numberOf(feature, DRAW_PROPERTY_KEYS.radiusMeters);
      if (radius !== undefined) values[DRAW_PROPERTY_KEYS.radiusMeters] = radius * scale;
    } else {
      values[DRAW_PROPERTY_KEYS.scale] = (numberOf(feature, DRAW_PROPERTY_KEYS.scale) ?? 1) * scale;
    }
  }
  if (Object.keys(values).length === 0) return moved;
  return { ...moved, properties: { ...feature.properties, ...values } };
}

/** A finite number of the properties of a feature */
function numberOf(feature: Feature, key: string): number | undefined {
  const value = feature.properties?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
