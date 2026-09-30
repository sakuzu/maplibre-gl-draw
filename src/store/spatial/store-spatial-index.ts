// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * StoreSpatialIndex
 *
 * The spatial index as a value derived from the Store. It subscribes to the Store and
 * re-derives the entry of every feature a StoreChange names (created / updated / deleted)
 * from the Store itself, so it holds exactly the features the Store holds, with the extent
 * they have now:
 *
 * - every write path (the public API, the drawing modes, the drag, import, plugins, a mode
 *   of an extension, a change applied from elsewhere to a replaced Store) reaches it in the same way
 * - a write the Store refuses (read-only) notifies nothing, so it leaves no trace here
 * - the features a Store holds when the index is created are loaded then, and a notification
 *   with `reset` (the whole document replaced from elsewhere) rebuilds the index from the Store
 * - an update of the properties (the radius of a Circle, the scale and rotation of an Image)
 *   re-indexes the feature like an update of the coordinates
 * - the intermediate updates of a drag are Store updates too (isIntermediate), so the shape
 *   being dragged is the shape that is indexed
 *
 * The extent of a type registered with a custom bounding box calculator can change for
 * reasons outside the Store (a font that arrives later, for example). Its owner announces
 * that with invalidateType(), which re-derives the features of that type from the Store.
 */

import type { Store } from '../store.js';
import type { BoundingBox, Coordinate, Feature, StoreChange } from '../types.js';
import {
  type CustomBoundingBoxCalculator,
  RBushSpatialIndex,
  type SpatialIndex,
} from './spatial-index.js';

/**
 * The spatial index derived from a Store
 */
export class StoreSpatialIndex implements SpatialIndex {
  readonly #store: Store;
  readonly #index = new RBushSpatialIndex();
  #unsubscribe: (() => void) | null;

  constructor(store: Store) {
    this.#store = store;
    this.#unsubscribe = store.subscribe((changes) => this.#apply(changes));
    // A Store handed in from outside can already hold features
    this.#index.load(store.listFeatures());
  }

  findNear(coordinate: Coordinate, tolerance: number): string[] {
    return this.#index.findNear(coordinate, tolerance);
  }

  findInBounds(bounds: BoundingBox): string[] {
    return this.#index.findInBounds(bounds);
  }

  /**
   * Sets the tile size used to size an Image, and re-derives every feature (a custom
   * calculator also receives the tile size)
   */
  setTileSize(tileSize: number): void {
    this.#index.setTileSize(tileSize);
    this.#rebuild();
  }

  /**
   * Registers the bounding box calculation of a custom feature type, and re-derives the
   * features of that type the Store already holds
   *
   * @returns a function that cancels the registration and measures those features again
   *   with the default calculation
   */
  setCustomBoundingBoxCalculator(
    type: string,
    calculator: CustomBoundingBoxCalculator,
  ): () => void {
    const cancel = this.#index.setCustomBoundingBoxCalculator(type, calculator);
    this.invalidateType(type);
    return () => {
      cancel();
      this.invalidateType(type);
    };
  }

  /**
   * Re-derives the extent of every feature of the given type from the Store
   *
   * For a type whose extent changed for a reason the Store does not see.
   */
  invalidateType(type: string): void {
    for (const feature of this.#store.listFeatures()) {
      if (feature.type === type) {
        this.#index.update(feature.id, feature);
      }
    }
  }

  /**
   * Re-derives the entries of the given features from the Store (an id the Store does not
   * hold is dropped)
   */
  invalidate(ids: Iterable<string>): void {
    for (const id of ids) {
      this.#refresh(id);
    }
  }

  /**
   * Stops following the Store and empties the index
   */
  destroy(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#index.clear();
  }

  #apply(changes: StoreChange): void {
    // A replacement of the whole document is read again from the Store, whatever the
    // notification lists: the index then holds exactly what the new document holds
    if (changes.reset === true) {
      this.#rebuild();
      return;
    }
    const features = changes.features;
    if (!features) return;

    // A bulk creation (import) is loaded in one pass
    const created = features.created;
    if (created && created.length > 0) {
      const present: Feature[] = [];
      for (const { id } of created) {
        const feature = this.#store.getFeature(id);
        if (feature) present.push(feature);
      }
      this.#index.load(present);
    }

    // The final state is read from the Store, so the order of the entries within one
    // notification (created then deleted, updated several times) does not matter
    if (features.updated) {
      for (const { id } of features.updated) this.#refresh(id);
    }
    if (features.deleted) {
      for (const { id } of features.deleted) this.#refresh(id);
    }
  }

  #refresh(id: string): void {
    const feature = this.#store.getFeature(id);
    if (feature) {
      this.#index.update(id, feature);
    } else {
      this.#index.remove(id);
    }
  }

  #rebuild(): void {
    this.#index.clear();
    this.#index.load(this.#store.listFeatures());
  }
}
