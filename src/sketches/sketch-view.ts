// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the sketches draw (`SketchView`): each feature a sketch edits, drawn as the sketches leave it in
 * the place of the feature, and each feature a sketch creates, drawn in the place it will be
 * created in
 *
 * A feature of a sketch is drawn in place of the feature it edits, one for each feature whatever
 * the number of sketches that edit it (they are applied one after the other). Over a Store of rows,
 * the sketches are rows of the deltas drawn and not read, and the row of a feature a sketch edits is
 * hidden by the mark of the sketches (`FeatureTables` internals, `showSketches`). Over a Store of
 * objects, the drawing reads the features through this view (`ordered`, `drawnFeature`), and is
 * told which features it draws otherwise (`onChange`), as a change of the Store tells it.
 *
 * What the sketches draw can be left out (`leaveOut`), for a frame of an image of the map: the rows
 * of the deltas are no longer drawn and the rows they hid are drawn again, the drawing of a Store of
 * objects is told the features as the Store has them, and the sketches that change meanwhile are
 * kept, drawn once they are no longer left out.
 */

import type { SketchOverlay } from '../feature-table/feature-tables.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { DRAW_PROPERTY_KEYS } from '../shared/properties.js';
import type { TentativeState } from '../shared/types/model.js';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import { rowPlaceKeysOf } from '../store/row-places.js';
import type { Store } from '../store/store.js';
import type { Feature, ItemPlacement, StoreChange } from '../store/types.js';
import type { CreateEdit } from './sketch-edits.js';

/**
 * A shape being drawn, as a sketch of an edit `create` with its vertices placed so far gives it: it
 * has no ID of the document, and is drawn with the look of a shape being drawn in the layer it will
 * be created in
 *
 * @internal
 */
export interface ShapeBeingDrawn extends TentativeState {
  /** Who draws it: `null` for this client */
  readonly owner: string | null;
}

/**
 * The shape being drawn of an edit `create` of a sketch, over the feature it creates
 *
 * @internal
 */
export function shapeBeingDrawnOf(
  feature: Feature,
  edit: CreateEdit,
  owner: string | null,
): ShapeBeingDrawn {
  const shape: ShapeBeingDrawn = {
    owner,
    type: feature.type,
    coordinates: coordinatesOf(feature) as TentativeState['coordinates'],
    layerId: feature.layerId,
    pendingFeatureId: feature.id,
  };
  if (edit.placedVertexCount !== undefined) shape.confirmedCount = edit.placedVertexCount;
  if (edit.highlightedVertexIndex !== undefined) {
    shape.highlightedVertexIndex = edit.highlightedVertexIndex;
  }
  const radius = feature.properties[DRAW_PROPERTY_KEYS.radiusMeters];
  const angle = feature.properties[DRAW_PROPERTY_KEYS.radiusHandleAngle];
  if (typeof radius === 'number') shape.radiusMeters = radius;
  if (typeof angle === 'number') shape.radiusHandleAngle = angle;
  return shape;
}

/**
 * A feature a sketch creates, as it is drawn
 *
 * @internal
 */
export interface DrawnCreate {
  /** The ID it is drawn with: an ID of no feature of the document */
  readonly key: string;
  /** The feature, with that ID */
  readonly feature: Feature;
  /**
   * Where it is drawn: just above the item `below` of its layer or group (at the back for null, at
   * the front for undefined)
   */
  readonly placement: ItemPlacement & { readonly below: string | null | undefined };
}

/** What the order of the features with the sketches reads of a Store of objects */
interface OrderStore {
  getLayerOrder(): readonly string[];
  getGroup(id: string): { readonly layerId: string } | undefined;
}

/**
 * What the sketches draw, and its changes
 *
 * @internal
 */
export class SketchView {
  readonly #store: Store;
  /** The features sketches edit, as they are drawn, by ID */
  #live = new Map<string, Feature>();
  /** The features sketches create, as they are drawn, in the order they are drawn */
  #creates: readonly DrawnCreate[] = [];
  /** The same, by the ID they are drawn with */
  #createByKey = new Map<string, DrawnCreate>();
  /** The shapes being drawn, in the order they are drawn */
  #drawings: readonly ShapeBeingDrawn[] = [];
  readonly #listeners = new Set<(change: StoreChange) => void>();
  readonly #redraws = new Set<() => void>();
  /** Whether what the sketches draw is left out (a frame of an image of the map) */
  #leftOut = false;

  constructor(store: Store) {
    this.#store = store;
  }

  /** The number of features drawn for the sketches */
  get size(): number {
    return this.#live.size + this.#creates.length;
  }

  /** The feature drawn for the sketches with this ID (a feature edited, or one created) */
  drawnFeature(id: string): Feature | undefined {
    return this.#live.get(id) ?? this.#createByKey.get(id)?.feature;
  }

  /** The features sketches edit, as they are drawn, by ID */
  liveFeatures(): ReadonlyMap<string, Feature> {
    return this.#live;
  }

  /** The features sketches create, as they are drawn */
  creates(): readonly DrawnCreate[] {
    return this.#creates;
  }

  /** The shapes being drawn, in the order they are drawn (they have no ID of the document) */
  drawings(): readonly ShapeBeingDrawn[] {
    return this.#drawings;
  }

  /** The IDs of the features drawn for the sketches */
  ids(): string[] {
    return [...this.#live.keys(), ...this.#creates.map((create) => create.key)];
  }

  /**
   * Follows what the drawing of a Store of objects draws in place of the Store: told with a change
   * of the Store that lists the features drawn otherwise (each with the one drawn before)
   *
   * @returns The function that stops it
   */
  onChange(listener: (change: StoreChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Follows what the sketches draw where no change of the Store tells it: the rows they move on
   * the GPU
   *
   * @returns The function that stops it
   */
  onRedraw(listener: () => void): () => void {
    this.#redraws.add(listener);
    return () => {
      this.#redraws.delete(listener);
    };
  }

  /** Asks for the next frame: the rows the sketches move on the GPU moved */
  redraw(): void {
    for (const listener of [...this.#redraws]) listener();
  }

  /**
   * Sets what the sketches draw: the features they edit as they leave them, the features they
   * create, and the shapes being drawn (a change of them asks for the next frame)
   */
  set(
    live: ReadonlyMap<string, Feature>,
    creates: readonly DrawnCreate[],
    drawings: readonly ShapeBeingDrawn[] = [],
  ): void {
    if (drawings.length > 0 || this.#drawings.length > 0) {
      this.#drawings = drawings;
      this.redraw();
    }
    const before = this.#live;
    const createsBefore = this.#createByKey;
    if (live.size === 0 && before.size === 0 && creates.length === 0 && createsBefore.size === 0) {
      return;
    }
    this.#live = new Map(live);
    this.#creates = [...creates];
    this.#createByKey = new Map(creates.map((create) => [create.key, create]));
    // Left out: drawn once they are no longer
    if (this.#leftOut) return;
    const store = this.#store;
    if (store.tables) {
      this.#showRows();
      return;
    }
    const change = this.#changeOf(before, createsBefore);
    if (!change) return;
    for (const listener of [...this.#listeners]) listener(change);
  }

  /**
   * Leaves out what the sketches draw, or draws it again: over a Store of rows, the rows of the
   * deltas go and the rows they hid are drawn; the drawing of a Store of objects is told each
   * feature as the Store has it (and as the sketches leave it again once they are drawn again)
   */
  leaveOut(leftOut: boolean): void {
    if (this.#leftOut === leftOut) return;
    this.#leftOut = leftOut;
    if (this.#live.size === 0 && this.#creates.length === 0) return;
    const store = this.#store;
    if (store.tables) {
      if (leftOut) featureTablesInternals(store.tables)?.showSketches([]);
      else this.#showRows();
      return;
    }
    const change = leftOut ? this.#changeToStore() : this.#changeOf(new Map(), new Map());
    if (!change) return;
    for (const listener of [...this.#listeners]) listener(change);
  }

  /**
   * The change of what the drawing of a Store of objects draws once the sketches are left out:
   * each feature drawn otherwise as the Store has it, and the features the sketches create gone
   */
  #changeToStore(): StoreChange | null {
    const store = this.#store;
    const updated: NonNullable<NonNullable<StoreChange['features']>['updated']> = [];
    const deleted: Feature[] = [];
    for (const [id, previous] of this.#live) {
      const feature = store.getFeature(id);
      if (feature === previous) continue;
      if (feature) updated.push({ id, feature, previous });
      else deleted.push(previous);
    }
    for (const create of this.#creates) deleted.push(create.feature);
    if (updated.length + deleted.length === 0) return null;
    return {
      source: 'local',
      features: {
        ...(updated.length > 0 ? { updated } : {}),
        ...(deleted.length > 0 ? { deleted } : {}),
      },
    };
  }

  /** Draws the sketches among the rows of a Store of rows */
  #showRows(): void {
    const tables = featureTablesInternals(this.#store.tables);
    if (!tables) return;
    const placeKeys = rowPlaceKeysOf(this.#store.tables);
    const overlays: SketchOverlay[] = [];
    for (const feature of this.#live.values()) overlays.push({ feature });
    for (const create of this.#creates) {
      const place = placeKeys?.(create.placement);
      if (place) overlays.push({ feature: create.feature, place });
    }
    tables.showSketches(overlays);
  }

  /**
   * The change of what the drawing of a Store of objects draws: each feature drawn otherwise, with
   * the one drawn before (the feature of the Store when it was not sketched, or is no longer)
   */
  #changeOf(
    before: ReadonlyMap<string, Feature>,
    createsBefore: ReadonlyMap<string, DrawnCreate>,
  ): StoreChange | null {
    const store = this.#store;
    const updated: NonNullable<NonNullable<StoreChange['features']>['updated']> = [];
    const created: Feature[] = [];
    const deleted: Feature[] = [];
    for (const [id, feature] of this.#live) {
      const previous = before.get(id) ?? store.getFeature(id);
      if (previous === feature) continue;
      if (previous) updated.push({ id, feature, previous });
      else created.push(feature);
    }
    for (const [id, previous] of before) {
      if (this.#live.has(id)) continue;
      const feature = store.getFeature(id);
      if (feature === previous) continue;
      if (feature) updated.push({ id, feature, previous });
      else deleted.push(previous);
    }
    for (const create of this.#creates) {
      const previous = createsBefore.get(create.key);
      if (previous === create) continue;
      // A feature put in another place is drawn again in its layer
      if (previous) deleted.push(previous.feature);
      created.push(create.feature);
    }
    for (const [key, previous] of createsBefore) {
      if (!this.#createByKey.has(key)) deleted.push(previous.feature);
    }
    if (updated.length + created.length + deleted.length === 0) return null;
    return {
      source: 'local',
      features: {
        ...(created.length > 0 ? { created } : {}),
        ...(updated.length > 0 ? { updated } : {}),
        ...(deleted.length > 0 ? { deleted } : {}),
      },
    };
  }

  /**
   * The features of a Store of objects in stacking order with the sketches: each feature a sketch
   * edits as it is drawn, and each feature a sketch creates in its place
   *
   * @param list The features of the Store in stacking order
   */
  ordered(list: readonly Feature[], store: OrderStore): Feature[] {
    const live = this.#live;
    let out = live.size === 0 ? [...list] : list.map((feature) => live.get(feature.id) ?? feature);
    if (this.#creates.length === 0) return out;
    out = [...out];
    /** The features created put in so far, by the item they are just above */
    for (const create of this.#creates) {
      out.splice(insertionIndex(out, create, store, this.#createByKey), 0, create.feature);
    }
    return out;
  }

  /** The features of a Store of objects, in no order, with the sketches (see `ordered`) */
  unordered(list: readonly Feature[]): Feature[] {
    const live = this.#live;
    const out =
      live.size === 0 ? [...list] : list.map((feature) => live.get(feature.id) ?? feature);
    for (const create of this.#creates) out.push(create.feature);
    return out;
  }
}

/**
 * Where a feature created goes among features in stacking order: just above the item it names
 * (and the features created above that item before it), the back of its layer or group for null,
 * and the front of them when it names none or the item is not there
 */
function insertionIndex(
  list: readonly Feature[],
  create: DrawnCreate,
  store: OrderStore,
  creates: ReadonlyMap<string, DrawnCreate>,
): number {
  const { layerId, groupId, below } = create.placement;
  const inContainer = (feature: Feature): boolean =>
    creates.has(feature.id)
      ? (creates.get(feature.id) as DrawnCreate).placement.layerId === layerId &&
        (creates.get(feature.id) as DrawnCreate).placement.groupId === groupId
      : feature.layerId === layerId && (groupId === undefined || feature.groupId === groupId);
  let first = -1;
  let last = -1;
  let after = -1;
  for (let i = 0; i < list.length; i++) {
    const feature = list[i];
    if (!inContainer(feature)) continue;
    if (first < 0) first = i;
    last = i;
    // At the back, or at the front of the features created there before it
    if (below === null || below === undefined) continue;
    const made = creates.get(feature.id);
    // The item named, the members of the group named, and the features created above it before
    if (
      feature.id === below ||
      (groupId === undefined && !made && feature.groupId === below) ||
      (made && made.placement.below === below)
    ) {
      after = i;
    }
  }
  if (below === null && first >= 0) {
    // At the back, above the features created at the back before it
    let at = first;
    while (at < list.length && creates.get(list[at].id)?.placement.below === null) at++;
    return at;
  }
  if (after >= 0) return after + 1;
  if (last >= 0) return last + 1;
  // A layer with no feature drawn: after the features of the layers behind it
  const order = store.getLayerOrder();
  const rank = order.indexOf(layerId);
  for (let i = 0; i < list.length; i++) {
    const at = order.indexOf(list[i].layerId);
    if (rank >= 0 && at > rank) return i;
  }
  return list.length;
}
