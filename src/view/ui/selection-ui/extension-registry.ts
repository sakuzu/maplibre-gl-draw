// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The registry of the Selection UI extension points
 *
 * A mechanism for the custom feature types of extension implementations to provide their own
 * boundingBox computation / resize handles / resize strategy / point frame extent.
 *
 * One registry belongs to one draw instance (it is created by createMapLibreGLDraw and handed
 * to the CustomLayer, the modes and the extension API). Two draw instances on the same page
 * never see each other's registrations, and destroying an instance clears its registry.
 * The tile size of the instance's map is held here as well, because the custom bounding box
 * calculators take it as an argument.
 */

import type { Feature } from '../../../store/types.js';
import type {
  AdditionalResizeHandlesCalculator,
  CustomBoundingBoxCalculator,
  CustomResizeCalculator,
  PointFrameExtent,
  PointFrameExtentProvider,
  ResizeStrategy,
} from './types.js';

/**
 * The side of the square selection frame of a point, in CSS px: 12.
 *
 * The same value as DEFAULT_POINT_STYLE.size. Types with no registered extent become this
 * square (the same look as the former fixed value).
 */
export const DEFAULT_POINT_FRAME_SIZE = 12;

/** The tile size used until the map reports its own (maplibre's default) */
const DEFAULT_REGISTRY_TILE_SIZE = 512;

/**
 * The Selection UI extension points of one draw instance
 *
 * Every register method returns a function that cancels the registration. Cancelling after
 * the same type has been registered again does not remove the later registration.
 */
export interface SelectionExtensionRegistry {
  /** Registers how the selection box of a feature type is computed */
  registerBoundingBox(type: string, calculator: CustomBoundingBoxCalculator): () => void;
  /** Returns the bounding box calculator of a type, or `undefined` */
  getBoundingBoxCalculator(type: string): CustomBoundingBoxCalculator | undefined;

  /** Registers the resize handles a feature type adds to the four corner handles */
  registerAdditionalResizeHandles(
    type: string,
    calculator: AdditionalResizeHandlesCalculator,
  ): () => void;
  /** Returns the additional resize handles calculator of a type, or `undefined` */
  getAdditionalResizeHandlesCalculator(type: string): AdditionalResizeHandlesCalculator | undefined;

  /** Registers how a feature type is resized, replacing the built-in computation */
  registerCustomResize(type: string, calculator: CustomResizeCalculator): () => void;
  /** Returns the custom resize calculator of a type, or `undefined` */
  getCustomResizeCalculator(type: string): CustomResizeCalculator | undefined;

  /** Registers whether a feature type resizes by its coordinates or by its scale */
  registerResizeStrategy(type: string, strategy: ResizeStrategy): () => void;
  /** Returns the resize strategy of a type, or `undefined` */
  getResizeStrategy(type: string): ResizeStrategy | undefined;

  /** Registers the size of the selection frame of a point-like feature type */
  registerPointFrameExtent(type: string, provider: PointFrameExtentProvider): () => void;
  /** Returns the point frame extent provider of a type, or `undefined` */
  getPointFrameExtentProvider(type: string): PointFrameExtentProvider | undefined;
  /**
   * Resolve the half width and half height of the selection box of a zero-area point
   *
   * Types with no registration, types that return null and values that are not finite
   * degrade to the default square (the frame is not broken while the actual size on the
   * extension side is not yet determined).
   */
  resolvePointFrameExtent(feature: Feature): PointFrameExtent;

  /** The tile size in px of the instance's map (passed to the custom bounding box calculators) */
  getTileSize(): number;
  /** Sets the tile size in px (the draw instance sets it from the map) */
  setTileSize(tileSize: number): void;

  /** Cancels every registration (called when the draw instance is destroyed) */
  clear(): void;
}

/**
 * A map whose registrations return a cancel function
 */
function registerIn<T>(map: Map<string, T>, type: string, value: T): () => void {
  map.set(type, value);
  return () => {
    if (map.get(type) === value) map.delete(type);
  };
}

/**
 * Creates an empty {@link SelectionExtensionRegistry} with a tile size of 512 px, for testing a
 * custom feature handler in isolation.
 *
 * @returns A new registry with no registration
 */
export function createSelectionExtensionRegistry(): SelectionExtensionRegistry {
  const boundingBoxes = new Map<string, CustomBoundingBoxCalculator>();
  const additionalHandles = new Map<string, AdditionalResizeHandlesCalculator>();
  const customResizes = new Map<string, CustomResizeCalculator>();
  const resizeStrategies = new Map<string, ResizeStrategy>();
  const pointFrameExtents = new Map<string, PointFrameExtentProvider>();
  let tileSize = DEFAULT_REGISTRY_TILE_SIZE;

  return {
    registerBoundingBox: (type, calculator) => registerIn(boundingBoxes, type, calculator),
    getBoundingBoxCalculator: (type) => boundingBoxes.get(type),

    registerAdditionalResizeHandles: (type, calculator) =>
      registerIn(additionalHandles, type, calculator),
    getAdditionalResizeHandlesCalculator: (type) => additionalHandles.get(type),

    registerCustomResize: (type, calculator) => registerIn(customResizes, type, calculator),
    getCustomResizeCalculator: (type) => customResizes.get(type),

    registerResizeStrategy: (type, strategy) => registerIn(resizeStrategies, type, strategy),
    getResizeStrategy: (type) => resizeStrategies.get(type),

    registerPointFrameExtent: (type, provider) => registerIn(pointFrameExtents, type, provider),
    getPointFrameExtentProvider: (type) => pointFrameExtents.get(type),
    resolvePointFrameExtent(feature) {
      return resolvePointFrameExtentWith(pointFrameExtents.get(feature.type), feature);
    },

    getTileSize: () => tileSize,
    setTileSize(value) {
      tileSize = value;
    },

    clear() {
      boundingBoxes.clear();
      additionalHandles.clear();
      customResizes.clear();
      resizeStrategies.clear();
      pointFrameExtents.clear();
    },
  };
}

/**
 * Resolve the extent of a point's selection box with an optional provider
 *
 * Without a registry (callers outside a draw instance) the default square is returned.
 */
export function resolvePointFrameExtentWith(
  provider: PointFrameExtentProvider | undefined,
  feature: Feature,
): PointFrameExtent {
  const extent = provider?.(feature);
  if (
    !extent ||
    !Number.isFinite(extent.halfWidth) ||
    !Number.isFinite(extent.halfHeight) ||
    extent.halfWidth < 0 ||
    extent.halfHeight < 0
  ) {
    const half = DEFAULT_POINT_FRAME_SIZE / 2;
    return { halfWidth: half, halfHeight: half };
  }
  return extent;
}
