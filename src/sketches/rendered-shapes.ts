// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shapes as they are seen (`RenderedShapes`): the one place that makes them, and the one place
 * what draws and what picks reads them from
 *
 * The shape of a feature on the screen is held nowhere: it is made here from where the edits under
 * way are kept. That is the value of the Store, the sketches applied over it, and the rows drawn
 * moved by their state (a sketch of this client that moves them, the arrow keys), which are made a
 * shape with the computation the GPU draws them with;
 * a shape being drawn (a sketch of an edit `create` with its vertices placed so far) is read here as
 * well, and has no ID of its own. A reader names what it reads here and never picks a place: each reader that differs
 * from the shape itself has its own read, which says how.
 *
 * What the GPU moves stays with the GPU: the rows are drawn by the bits of their state and the
 * motions of their moving sets (`rowMotion`, `rowMotionOf`, `bulkRowMotionOf`), their values are
 * not read and no shape is made for them at each frame. The sketches of a Store of rows are rows of
 * its deltas, drawn among its rows.
 *
 * A frame of an image of the map reads the shapes as they are written (`setWritten`): what draws
 * reads the value of the Store, with no sketch of any client over it, no shape being drawn and no
 * row moved by its moving set, while the frame is drawn. What hits and what snaps reads as it does
 * in every frame.
 */

import type { PageData } from '@sakuzu/kasane/render';
import type { DraggedRows } from '../feature-table/dragged-rows.js';
import {
  draggedFeatureOf,
  draggedRowsInPlace,
  draggedRowsOf,
} from '../feature-table/dragged-rows.js';
import { BULK_MOVE_SET, type RowStateSets } from '../feature-table/feature-row-states.js';
import type { FeatureTablesInternals } from '../feature-table/feature-tables.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { forEachSnapRow, type SnapRow } from '../feature-table/snap-rows.js';
import type { EnuEdit } from '../geometry/enu-transforms.js';
import type { BBox } from '../geometry/types.js';
import { featuresOfKnownTypes, isKnownFeatureType, rowTypeKnown } from '../store/feature-types.js';
import { getDisplayFeatures } from '../store/local-visibility.js';
import type { Store } from '../store/store.js';
import { transformFieldsOfStore } from '../store/transform-roles.js';
import type { DragTargets, Feature } from '../store/types.js';
import type { DraggedFeatures } from './sketch-controller.js';
import type { ShapeBeingDrawn, SketchView } from './sketch-view.js';

/** No shape being drawn */
const NO_DRAWINGS: readonly ShapeBeingDrawn[] = Object.freeze([]);

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
  /** What the drag of this client edits (null when no drag is shown by a sketch) */
  dragged(): DraggedFeatures | null;
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

/** No motion: the rows where they are written */
const NO_MOTION: RowMotion = Object.freeze({
  translation: Object.freeze([0, 0]) as unknown as readonly [number, number],
  transform: null,
});

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
 * The features snapping leaves out while features selected in bulk are moved: the ones listed,
 * and the rows being moved (asked by id; the rows are not listed)
 */
class RowsExclusion extends Set<string> {
  constructor(
    ids: readonly string[],
    private readonly moving: (id: string) => boolean,
  ) {
    super(ids);
  }

  override has(id: string): boolean {
    return super.has(id) || this.moving(id);
  }
}

/**
 * The shapes of an instance as they are seen
 *
 * @internal
 */
export class RenderedShapes {
  readonly #store: Store;
  #sketches: ShapeSketches | null = null;
  /** The rows being dragged as read last, and the revision of the motions they were read at */
  #draggedRead: {
    readonly states: RowStateSets;
    readonly revision: number;
    readonly dragged: DraggedRows | null;
  } | null = null;
  /** The features made where their rows are drawn, while the rows move the same way */
  readonly #moved = new Map<string, { readonly from: Feature; readonly feature: Feature }>();
  /** Whether what draws reads the shapes as they are written (a frame of an image of the map) */
  #written = false;
  /** The rows being dragged as read last, drawn where they are written */
  #inPlace: { readonly dragged: DraggedRows; readonly inPlace: DraggedRows } | null = null;
  /** What is told when the shapes read as written are seen as they are again */
  readonly #seenAgain = new Set<() => void>();

  constructor(store: Store) {
    this.#store = store;
  }

  /** Reads the sketches of the instance */
  useSketches(sketches: ShapeSketches): void {
    this.#sketches = sketches;
  }

  // ==========================================================================
  // The shapes as they are written
  // ==========================================================================

  /** Whether what draws reads the shapes as they are written (a frame of an image of the map) */
  get written(): boolean {
    return this.#written;
  }

  /**
   * Makes what draws read the shapes as they are written, with no sketch of any client, no shape
   * being drawn and no row moved by its moving set, or as they are seen again. The sketches leave
   * what they draw (`SketchView.leaveOut`), and come back when the shapes are seen again
   */
  setWritten(written: boolean): void {
    if (this.#written === written) return;
    this.#written = written;
    this.#sketches?.view.leaveOut(written);
    if (!written) for (const listener of [...this.#seenAgain]) listener();
  }

  /**
   * Follows the shapes being seen again after they were read as written: what was drawn of the
   * sketches and of the rows moved changed back
   *
   * @returns The function that stops it
   */
  onSeenAgain(listener: () => void): () => void {
    this.#seenAgain.add(listener);
    return () => {
      this.#seenAgain.delete(listener);
    };
  }

  /**
   * How a moving set of rows moves its rows as they are drawn: as the GPU moves them, and not at
   * all while the shapes are read as written
   *
   * @param tables - The rows drawn (those of the document shown)
   * @param set - The moving set (1 to 3)
   */
  rowMotion(tables: FeatureTablesInternals, set: number): RowMotion {
    return this.#written ? NO_MOTION : rowMotionOf(tables, set);
  }

  // ==========================================================================
  // The shapes
  // ==========================================================================

  /**
   * A feature as it is seen: the value of the Store, the sketches applied over it, moved where its
   * row is drawn while its row is moved by its state.
   * A feature a sketch creates is read by the ID it is drawn with
   */
  get(id: string): Feature | undefined {
    return this.#shapeOf(id, this.draggedRows());
  }

  /** Features as they are seen, in the order of the IDs */
  getMany(ids: readonly string[]): (Feature | undefined)[] {
    const dragged = this.draggedRows();
    return ids.map((id) => this.#shapeOf(id, dragged));
  }

  #shapeOf(id: string, dragged: DraggedRows | null): Feature | undefined {
    if (this.#written) return this.#store.getFeature(id);
    const sketches = this.#sketches;
    const feature =
      sketches?.appliedFeature(id) ?? sketches?.view.drawnFeature(id) ?? this.#store.getFeature(id);
    const tables = this.#store.tables;
    if (!feature || !tables || !dragged) return feature;
    const known = this.#moved.get(id);
    if (known?.from === feature) return known.feature;
    const moved = draggedFeatureOf(feature, tables, dragged);
    if (moved !== feature) this.#moved.set(id, { from: feature, feature: moved });
    return moved;
  }

  /**
   * The rows being dragged and where each is drawn, while they are not written yet (read once for
   * each change of how they move: a frame reads it for each feature it asks for). While the shapes
   * are read as written, the same rows drawn where they are written
   */
  draggedRows(): DraggedRows | null {
    if (this.#written) {
      // The same rows, drawn where they are written: what keeps the motion of the last frame that
      // had rows dragged draws them in place too
      const dragged = this.#draggedNow();
      if (!dragged) return null;
      if (this.#inPlace?.dragged !== dragged) {
        this.#inPlace = { dragged, inPlace: draggedRowsInPlace(dragged) };
      }
      return this.#inPlace.inPlace;
    }
    return this.#draggedNow();
  }

  #draggedNow(): DraggedRows | null {
    const tables = this.#store.tables;
    const states = featureTablesInternals(tables)?.states;
    if (!states) return null;
    const read = this.#draggedRead;
    if (read?.states === states && read.revision === states.revision) return read.dragged;
    this.#moved.clear();
    const dragged = draggedRowsOf(tables);
    this.#draggedRead = { states, revision: states.revision, dragged };
    return dragged;
  }

  /**
   * The shapes being drawn, in the order they are drawn: they have no ID, and no feature of the
   * document holds them
   */
  drawings(): readonly ShapeBeingDrawn[] {
    if (this.#written) return NO_DRAWINGS;
    return this.#sketches?.view.drawings() ?? NO_DRAWINGS;
  }

  /**
   * The shape this client draws (the last one it added; null when it draws none), which the
   * snapping reads whether the shapes are read as written or not
   */
  drawing(): ShapeBeingDrawn | null {
    const drawings = this.#sketches?.view.drawings() ?? NO_DRAWINGS;
    for (let i = drawings.length - 1; i >= 0; i--) {
      if (drawings[i].owner === null) return drawings[i];
    }
    return null;
  }

  // ==========================================================================
  // The types the instance knows
  // ==========================================================================

  /**
   * A number that changes whenever the types the instance knows change (a custom type defined,
   * or no longer): what is kept of the features drawn, hit and framed follows it
   */
  get typesRevision(): number {
    return transformFieldsOfStore(this.#store)?.revision ?? 0;
  }

  /**
   * Whether the instance knows the type of a feature: a feature of a type it does not know is not
   * drawn, hit, snapped to nor framed (`feature-types.ts`)
   */
  knows(feature: Feature): boolean {
    return isKnownFeatureType(feature.type, transformFieldsOfStore(this.#store));
  }

  /** Whether the instance knows the type of a row of a page (as `knows`) */
  knowsRow(data: PageData, row: number): boolean {
    return rowTypeKnown(data, row, transformFieldsOfStore(this.#store));
  }

  /** The features of the types the instance knows, in their order (the same list for all) */
  ofKnownTypes(features: Feature[]): Feature[] {
    return featuresOfKnownTypes(features, transformFieldsOfStore(this.#store));
  }

  // ==========================================================================
  // What the drawing of a Store of objects draws
  // ==========================================================================

  /** Whether the sketches draw anything over a Store of objects */
  get sketched(): boolean {
    if (this.#written) return false;
    const view = this.#sketches?.view;
    return view !== undefined && view.size > 0 && this.#store.tables === undefined;
  }

  /** The features of a Store of objects as they are drawn, in no order */
  drawnFeatures(): Feature[] {
    const list = this.#store.listFeatures();
    if (this.#written) return list;
    return this.#sketches?.view.unordered(list) ?? list;
  }

  /** The features of a Store of objects as they are drawn, in the stacking order */
  drawnFeaturesInOrder(): Feature[] {
    const list = this.#store.listFeaturesInOrder();
    if (this.#written) return list;
    return this.#sketches?.view.ordered(list, this.#store) ?? list;
  }

  /** The IDs of the features the sketches draw, wherever the document has them */
  sketchedIds(): readonly string[] {
    if (this.#written) return [];
    return this.#sketches?.view.ids() ?? [];
  }

  /** The IDs the features the sketches create are drawn with */
  createdIds(): readonly string[] {
    if (this.#written) return [];
    return this.#sketches?.view.creates().map((create) => create.key) ?? [];
  }

  // ==========================================================================
  // What is hit
  // ==========================================================================

  /**
   * A feature as a hit reads it: the value of the Store. What a sketch with an owner moves is hit
   * where the document has it, and the rows moved by their state where they are written. A
   * feature of a type the instance does not know is not hit
   */
  hitFeature(id: string): Feature | undefined {
    const feature = this.#store.getFeature(id);
    return feature && this.knows(feature) ? feature : undefined;
  }

  /**
   * The features a hit tests, in the stacking order: those shown, each as `hitFeature` reads it,
   * without what the drag of this client edits, nor the features of a type the instance does not
   * know
   */
  hitFeatures(): Feature[] {
    const features = this.ofKnownTypes(getDisplayFeatures(this.#store));
    const dragged = this.#sketches?.dragged();
    return dragged ? features.filter((feature) => !dragged.hasFeature(feature.id)) : features;
  }

  /**
   * The features shown of the layers of objects, in the stacking order, as the document has them,
   * what the drag of this client edits included: a pick reads the ones a sketch edits as they are
   * seen (`get`). Not the features of a type the instance does not know
   */
  shownFeatures(): Feature[] {
    return this.ofKnownTypes(getDisplayFeatures(this.#store));
  }

  /** The rows a hit tests, read where they are written and left out by their state */
  hitRows(): FeatureTablesInternals | undefined {
    return featureTablesInternals(this.#store.tables);
  }

  /**
   * Whether a hit leaves out the row of a handle besides its state: what the drag of this client
   * edits (null when it leaves out none)
   */
  hitRowsLeftOut(): ((handle: number) => boolean) | null {
    const dragged = this.#sketches?.dragged();
    return dragged ? (handle) => dragged.hasRow(handle) : null;
  }

  /**
   * The features of these IDs the handles of the selection are grabbed on: as they are seen, so
   * that a handle is grabbed where it is drawn. A feature of a type the instance does not know
   * has no handle
   */
  handleFeatures(ids: readonly string[]): Feature[] {
    return this.getMany(ids).filter(
      (feature): feature is Feature => feature !== undefined && this.knows(feature),
    );
  }

  /** What this client drags, which the hit tests of the extensions leave out */
  draggedIds(): readonly string[] {
    return this.#sketches?.dragged()?.ids ?? this.#store.getDragState()?.movingFeatureIds ?? [];
  }

  // ==========================================================================
  // What is snapped to
  // ==========================================================================

  /**
   * A feature as the snapping reads it: as a hit reads it, and what the drag of this client edits
   * as its sketch leaves it (the vertices and the edges a drag names are the ones of the feature
   * it shows, and a vertex that follows along is not left behind)
   */
  snapFeature(id: string): Feature | undefined {
    const sketches = this.#sketches;
    if (sketches?.dragged()?.hasFeature(id)) return sketches.appliedFeature(id);
    return this.hitFeature(id);
  }

  /**
   * Calls `visit` with every row the snapping reads whose bbox meets a box: shown, not held as a
   * feature, of a type the instance knows, not left out by `shown` and `skip`
   *
   * @param shown Whether the rows of a layer and a group are shown
   * @param skip Whether a row is left out, by its ID
   */
  forEachSnapRow(
    bbox: BBox,
    shown: (layerId: string, groupId: string | undefined) => boolean,
    skip: (id: string) => boolean,
    visit: (row: SnapRow) => void,
  ): void {
    const types = transformFieldsOfStore(this.#store);
    forEachSnapRow(this.#store.tables, bbox, shown, skip, (row) => {
      if (isKnownFeatureType(row.type, types)) visit(row);
    });
  }

  /**
   * What the snapping leaves out while a drag goes on: the features and the rows it changes as a
   * whole (the rows are asked by ID, they are not listed). Undefined when it leaves out none
   */
  snapExclusion(targets: DragTargets | null): ReadonlySet<string> | undefined {
    const moving = targets?.movingFeatureIds;
    const movingRows = targets?.movingRows;
    const tables = this.#store.tables;
    if (movingRows && tables) {
      return new RowsExclusion(moving ?? [], (id) => {
        const handle = tables.getRowRef(id);
        return handle !== undefined && movingRows.has(handle);
      });
    }
    return moving && moving.length > 0 ? new Set(moving) : undefined;
  }
}
