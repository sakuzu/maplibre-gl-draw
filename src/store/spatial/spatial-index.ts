// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SpatialIndex
 *
 * A spatial index that uses rbush.
 * It provides fast spatial queries over features.
 */

import RBush from 'rbush';
import { getBoundingBox } from '../../shared/utils/feature-bbox.js';
import type { BoundingBox, Coordinate, Feature } from '../types.js';

// The bounding box of a feature is a pure function of the feature, so it is defined in
// shared/ (display/ uses it too); re-exported here for the existing imports
export { getBoundingBox } from '../../shared/utils/feature-bbox.js';

/**
 * The type of the items stored in rbush
 */
interface IndexItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  featureId: string;
}

/**
 * The type of a custom bounding box calculation function
 */
export type CustomBoundingBoxCalculator = (feature: Feature, tileSize: number) => BoundingBox;

/**
 * The queries of a spatial index (what the hit testing, the snapping, the rendering and the
 * modes read)
 */
export interface SpatialQuery {
  /**
   * Gets the IDs of the features near the given coordinate
   *
   * @param coordinate the coordinate to search at [lng, lat]
   * @param tolerance the tolerance (in degrees)
   */
  findNear(coordinate: Coordinate, tolerance: number): string[];

  /**
   * Gets the IDs of the features inside the given bounding box
   */
  findInBounds(bounds: BoundingBox): string[];
}

/**
 * The SpatialIndex interface
 *
 * The queries and the configuration of the extent calculation. It has no writes: the index
 * a draw instance holds is derived from the Store (StoreSpatialIndex), so a feature enters
 * and leaves it only through the Store. The writes belong to the implementation
 * (RBushSpatialIndex).
 */
export interface SpatialIndex extends SpatialQuery {
  /**
   * Sets the tile size (used for computing the size of an Image)
   */
  setTileSize?(tileSize: number): void;

  /**
   * Registers a custom bounding box calculation function
   *
   * This is to support the custom feature types of an extension (registerFeatureHandler).
   * @param type the feature type
   * @param calculator the bounding box calculation function
   * @returns a function that cancels the registration (it does not remove a later
   *   registration of the same type)
   */
  setCustomBoundingBoxCalculator?(
    type: string,
    calculator: CustomBoundingBoxCalculator,
  ): () => void;
}

/**
 * The rbush-based SpatialIndex implementation
 */
export class RBushSpatialIndex implements SpatialIndex {
  private tree = new RBush<IndexItem>();
  private items = new Map<string, IndexItem>();
  private tileSize = 512; // the MapLibre default
  private customCalculators = new Map<string, CustomBoundingBoxCalculator>();

  /**
   * Sets the tile size
   *
   * The tile size can differ depending on the MapLibre style, so setting an appropriate
   * value improves the accuracy of the size computation for an Image
   */
  setTileSize(tileSize: number): void {
    this.tileSize = tileSize;
  }

  /**
   * Registers a custom bounding box calculation function
   */
  setCustomBoundingBoxCalculator(
    type: string,
    calculator: CustomBoundingBoxCalculator,
  ): () => void {
    this.customCalculators.set(type, calculator);
    return () => {
      if (this.customCalculators.get(type) === calculator) this.customCalculators.delete(type);
    };
  }

  /** Adds a feature to the index */
  insert(feature: Feature): void {
    // An id is held at most once, so inserting a feature that is already indexed replaces it
    this.update(feature.id, feature);
  }

  /**
   * Indexes several features at once (a bulk load of rbush, much faster than inserting one
   * by one). A feature that is already indexed is replaced.
   */
  load(features: readonly Feature[]): void {
    const items: IndexItem[] = [];
    for (const feature of features) {
      this.remove(feature.id);
      const item: IndexItem = {
        ...this.computeBoundingBoxForFeature(feature),
        featureId: feature.id,
      };
      this.items.set(feature.id, item);
      items.push(item);
    }
    this.tree.load(items);
  }

  /** Whether the feature with this id is indexed */
  has(id: string): boolean {
    return this.items.has(id);
  }

  /**
   * Computes the bounding box of a feature
   *
   * If a custom calculation function is registered, it is used.
   */
  private computeBoundingBoxForFeature(feature: Feature): BoundingBox {
    // Use the custom calculation function if there is one
    const customCalc = this.customCalculators.get(feature.type);
    if (customCalc) {
      return customCalc(feature, this.tileSize);
    }
    // The default computation
    return getBoundingBox(feature, this.tileSize);
  }

  /** Updates the entry of a feature */
  update(id: string, feature: Feature): void {
    // Remove the existing item
    this.remove(id);

    // Compute the new bounding box and insert it
    const bbox = this.computeBoundingBoxForFeature(feature);
    const item: IndexItem = {
      ...bbox,
      featureId: feature.id,
    };

    this.items.set(feature.id, item);
    this.tree.insert(item);
  }

  /** Removes a feature from the index */
  remove(id: string): void {
    const item = this.items.get(id);
    if (item) {
      this.tree.remove(item);
      this.items.delete(id);
    }
  }

  /** Clears the index */
  clear(): void {
    this.tree.clear();
    this.items.clear();
  }

  findNear(coordinate: Coordinate, tolerance: number): string[] {
    const [lng, lat] = coordinate;
    const bounds: BoundingBox = {
      minX: lng - tolerance,
      minY: lat - tolerance,
      maxX: lng + tolerance,
      maxY: lat + tolerance,
    };

    return this.findInBounds(bounds);
  }

  findInBounds(bounds: BoundingBox): string[] {
    const results = this.tree.search({
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY,
    });

    return results.map((item) => item.featureId);
  }
}
