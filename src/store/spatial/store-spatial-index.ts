// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * StoreSpatialIndex
 *
 * The spatial index of the Store, as the parts of an instance query it. It holds no index of its
 * own: each query asks the layer over the Store for the features whose box meets a box, which the
 * layer reads from the spatial index of the Store (the boxes of its rows). So it answers what the
 * Store holds now, with the extent each feature has now, whatever wrote it:
 *
 * - every write path (the public API, the drawing modes, the drag, import, plugins, a mode of an
 *   extension, a change written to the Store directly) reaches it in the same way, and a write
 *   the Store refuses leaves no trace
 * - it reads nothing when it is made and follows no change: the Store keeps the boxes of its rows
 * - the hidden features are found too, the deleted ones are not; the callers leave out what they
 *   do not show
 *
 * The box of a feature is that of its positions, except for the types whose extent comes from
 * more than their positions: an Image (its size at the zoom it was created at, with the tile
 * size), a Circle (its radius) and a type registered with a calculator of its own. The index
 * sets how those boxes are worked out on the Store while it is there (`setFeatureBoxes` of the
 * layer), and makes them again when what they depend on changes: the tile size, a calculator
 * registered or cancelled, and an extent that changed for a reason outside the Store (a font that
 * arrives later, for example): its owner announces that with invalidateType().
 */

import type { DocumentBoxes, DocumentReads, FeatureBoxes } from '../document-access.js';
import type { BoundingBox, Coordinate, Feature } from '../types.js';
import {
  type CustomBoundingBoxCalculator,
  getBoundingBox,
  type SpatialIndex,
} from './spatial-index.js';

/** The types whose box `getBoundingBox` works out from more than their positions */
const SIZED_TYPES: ReadonlySet<string> = new Set(['Image', 'Circle']);

/** What the index reads of the layer over the Store */
type IndexedDocument = DocumentBoxes & Pick<DocumentReads, 'getFeature'>;

/**
 * The spatial index of the Store, read through the layer over it
 */
export class StoreSpatialIndex implements SpatialIndex {
  readonly #store: IndexedDocument;
  #tileSize = 512; // the MapLibre default
  readonly #calculators = new Map<string, CustomBoundingBoxCalculator>();
  readonly #boxes: FeatureBoxes = {
    gives: (type) => SIZED_TYPES.has(type) || this.#calculators.has(type),
    boxOf: (feature) => this.#boxOf(feature),
  };
  #destroyed = false;

  constructor(store: IndexedDocument) {
    this.#store = store;
    store.setFeatureBoxes(this.#boxes);
  }

  findNear(coordinate: Coordinate, tolerance: number): string[] {
    const [lng, lat] = coordinate;
    return this.findInBounds({
      minX: lng - tolerance,
      minY: lat - tolerance,
      maxX: lng + tolerance,
      maxY: lat + tolerance,
    });
  }

  findInBounds(bounds: BoundingBox): string[] {
    return this.#store.findFeatureIdsInBox(bounds);
  }

  /**
   * Sets the tile size used to size an Image, and makes the boxes again (a custom calculator also
   * receives the tile size)
   */
  setTileSize(tileSize: number): void {
    this.#tileSize = tileSize;
    this.#refresh();
  }

  /**
   * Registers the bounding box calculation of a custom feature type, and makes the boxes again
   * (the features of that type the Store already holds take it)
   *
   * @returns a function that cancels the registration and makes the boxes again with the default
   *   calculation (it does not remove a later registration of the same type)
   */
  setCustomBoundingBoxCalculator(
    type: string,
    calculator: CustomBoundingBoxCalculator,
  ): () => void {
    this.#calculators.set(type, calculator);
    this.#refresh();
    return () => {
      if (this.#calculators.get(type) !== calculator) return;
      this.#calculators.delete(type);
      this.#refresh();
    };
  }

  /**
   * Makes the boxes of the features of the given type again
   *
   * For a type whose extent changed for a reason the Store does not see. A type whose box is that
   * of its positions has nothing to make again.
   */
  invalidateType(type: string): void {
    if (this.#boxes.gives(type)) this.#refresh();
  }

  /**
   * Makes the boxes of the features of every type that gives its box again (the images, the
   * circles, the types registered with a calculator), for extents that changed for a reason the
   * Store does not see. The boxes are read at the next query, and no feature of another type is
   * made for it
   */
  invalidateEvery(): void {
    this.#refresh();
  }

  /**
   * Makes the boxes of the given features again, for an extent that changed for a reason the
   * Store does not see (the box of positions follows the Store by itself)
   */
  invalidate(ids: Iterable<string>): void {
    for (const id of ids) {
      const type = this.#store.getFeature(id)?.type;
      if (type !== undefined && this.#boxes.gives(type)) {
        this.#refresh();
        return;
      }
    }
  }

  /**
   * Takes back the boxes set on the Store: every feature has the box of its positions again
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#store.setFeatureBoxes(null);
  }

  /** The box of a feature of a type that gives it: that of its calculator, or the default one */
  #boxOf(feature: Feature): BoundingBox {
    const calculator = this.#calculators.get(feature.type);
    return calculator
      ? calculator(feature, this.#tileSize)
      : getBoundingBox(feature, this.#tileSize);
  }

  /** Makes the boxes again with what they depend on now (nothing once destroyed) */
  #refresh(): void {
    if (!this.#destroyed) this.#store.setFeatureBoxes(this.#boxes);
  }
}
