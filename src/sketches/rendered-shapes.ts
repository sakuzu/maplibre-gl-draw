// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shapes as they are seen (`RenderedShapes`): the one place that makes them, and the one place
 * what draws and what picks reads them from
 *
 * The shape of a feature on the screen is held nowhere: it is made here from where the edits under
 * way are kept. That is the value of the Store with the writes in the middle of an edit, the
 * sketches applied over it, and the rows drawn moved by their state, which are made a shape with
 * the computation the GPU draws them with; a shape being drawn is read here as well, and has no ID
 * of its own. A reader names what it reads here and never picks a place: each reader that differs
 * from the shape itself has its own read, which says how.
 *
 * What the GPU moves stays with the GPU: the rows are drawn by the bits of their state and the
 * motions of their moving sets (`rowMotionOf`, `bulkRowMotionOf`), their values are not read and
 * no shape is made for them at each frame. The sketches of a Store of rows are rows of its deltas,
 * drawn among its rows.
 */

import type { DraggedRows } from '../feature-table/dragged-rows.js';
import { draggedFeatureOf, draggedRowsOf } from '../feature-table/dragged-rows.js';
import type { FeatureTablesInternals } from '../feature-table/feature-tables.js';
import { BULK_MOVE_SET } from '../feature-table/row-state.js';
import type { EnuEdit } from '../geometry/enu-transforms.js';
import type { TentativeState } from '../shared/types/model.js';
import type { Store } from '../store/store.js';
import type { Feature } from '../store/types.js';
import type { SketchView } from './sketch-view.js';

/**
 * What the shapes read of the sketches
 *
 * @internal
 */
export interface ShapeSketches {
  /** What the sketches draw */
  readonly view: SketchView;
  /** A feature of the Store as the sketches edit it (the feature itself when none does) */
  appliedFeature(id: string): Feature | undefined;
}

/**
 * How a moving set of rows moves its rows, as the GPU moves them
 *
 * @internal
 */
export interface RowMotion {
  /** The translation, `[dLng, dLat]` in degrees */
  readonly translation: readonly [number, number];
  /** The edit that moves, rotates or scales the rows before the translation (null for none) */
  readonly transform: EnuEdit | null;
}

/**
 * The moving set the rows selected in bulk are in once dragged, whose rows the GPU keeps apart
 * before they are dragged
 *
 * @internal
 */
export const BULK_ROWS_SET = BULK_MOVE_SET;

/**
 * How a moving set of rows moves its rows
 *
 * @param tables - The rows drawn (those of the document shown)
 * @param set - The moving set (1 to 3)
 * @internal
 */
export function rowMotionOf(tables: FeatureTablesInternals, set: number): RowMotion {
  const [dLng, dLat] = tables.states.translation(set);
  return { translation: [dLng, dLat], transform: tables.states.transform(set) };
}

/**
 * How the rows selected in bulk are moved
 *
 * @param tables - The rows drawn (those of the document shown)
 * @internal
 */
export function bulkRowMotionOf(tables: FeatureTablesInternals): RowMotion {
  return rowMotionOf(tables, BULK_ROWS_SET);
}

/**
 * The shapes of an instance as they are seen
 *
 * @internal
 */
export class RenderedShapes {
  readonly #store: Store;
  #sketches: ShapeSketches | null = null;

  constructor(store: Store) {
    this.#store = store;
  }

  /** Reads the sketches of the instance */
  useSketches(sketches: ShapeSketches): void {
    this.#sketches = sketches;
  }

  // ==========================================================================
  // The shapes
  // ==========================================================================

  /**
   * A feature as it is seen: the value of the Store with the writes in the middle of an edit, the
   * sketches applied over it, moved where its row is drawn while its row is moved by its state.
   * A feature a sketch creates is read by the ID it is drawn with
   */
  get(id: string): Feature | undefined {
    const sketches = this.#sketches;
    const feature =
      sketches?.appliedFeature(id) ?? sketches?.view.drawnFeature(id) ?? this.#store.getFeature(id);
    if (!feature) return undefined;
    const tables = this.#store.tables;
    if (!tables) return feature;
    const dragged = draggedRowsOf(tables);
    return dragged ? draggedFeatureOf(feature, tables, dragged) : feature;
  }

  /** The rows being dragged and where each is drawn, while they are not written yet */
  draggedRows(): DraggedRows | null {
    return draggedRowsOf(this.#store.tables);
  }

  /** The shape being drawn: it has no ID, and no feature of the document holds it */
  tentative(): TentativeState | null {
    return this.#store.getTentative();
  }

  // ==========================================================================
  // What the drawing of a Store of objects draws
  // ==========================================================================

  /** Whether the sketches draw anything over a Store of objects */
  get sketched(): boolean {
    const view = this.#sketches?.view;
    return view !== undefined && view.size > 0 && this.#store.tables === undefined;
  }

  /** The features of a Store of objects as they are drawn, in no order */
  drawnFeatures(): Feature[] {
    const list = this.#store.listFeatures();
    return this.#sketches?.view.unordered(list) ?? list;
  }

  /** The features of a Store of objects as they are drawn, in the stacking order */
  drawnFeaturesInOrder(): Feature[] {
    const list = this.#store.listFeaturesInOrder();
    return this.#sketches?.view.ordered(list, this.#store) ?? list;
  }

  /** The IDs of the features the sketches draw, wherever the document has them */
  sketchedIds(): readonly string[] {
    return this.#sketches?.view.ids() ?? [];
  }
}
