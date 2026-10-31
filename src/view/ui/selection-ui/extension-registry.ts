// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The registry of the Selection UI extension points
 *
 * A mechanism for the custom feature types of extension implementations to provide their own
 * selection box computation / resize handles / point frame extent.
 *
 * One registry belongs to one draw instance (it is created by its engine and handed to the
 * CustomLayer, the modes and the extension host). Two draw instances on the same page
 * never see each other's registrations, and destroying an instance clears its registry.
 * The tile size of the instance's map is held here as well, because the custom bounding box
 * calculators take it as an argument.
 */

import type { Feature } from '../../../store/types.js';
import type {
  AdditionalResizeHandlesCalculator,
  CustomBoundingBoxCalculator,
  FramePoint,
  PointFrameExtent,
  PointFrameExtentProvider,
} from './types.js';

/**
 * The side of the square selection frame of a point, in CSS px: 12.
 *
 * The same value as DEFAULT_POINT_STYLE.size. Types with neither a registered extent nor a
 * default extent of the registry become this square. A draw instance gives its registry the
 * extent of the marker of a built-in point as the default.
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

  /** Registers the size of the selection frame of a point-like feature type */
  registerPointFrameExtent(type: string, provider: PointFrameExtentProvider): () => void;
  /** Returns the point frame extent provider of a type, or `undefined` */
  getPointFrameExtentProvider(type: string): PointFrameExtentProvider | undefined;
  /**
   * Resolve the half width and half height of the selection box of a zero-area point
   *
   * Types with no registration, types that return null and values that are not finite
   * degrade to the default extent of the registry, and then to the default square (the frame
   * is not broken while the actual size on the extension side is not yet determined).
   */
  resolvePointFrameExtent(feature: Feature): PointFrameExtent;

  /**
   * The four corners of the selection frame of a zero-area feature on the screen, expanded by
   * the margin: the rectangle of {@link resolvePointFrameExtent} around the center
   *
   * @param center The center of the frame on the screen, in CSS px
   * @param margin The margin of the frame, in CSS px
   */
  resolvePointFrameCorners(feature: Feature, center: FramePoint, margin: number): FramePoint[];

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
 * @param defaultPointFrameExtent - The extent of the frame of a point whose type registers
 *   none, or whose provider gives none; without it (or when it returns null) the frame is the
 *   square of DEFAULT_POINT_FRAME_SIZE
 * @returns A new registry with no registration
 */
export function createSelectionExtensionRegistry(
  defaultPointFrameExtent?: PointFrameExtentProvider,
): SelectionExtensionRegistry {
  const boundingBoxes = new Map<string, CustomBoundingBoxCalculator>();
  const additionalHandles = new Map<string, AdditionalResizeHandlesCalculator>();
  const pointFrameExtents = new Map<string, PointFrameExtentProvider>();
  let tileSize = DEFAULT_REGISTRY_TILE_SIZE;
  /** The extent provider of a type, falling back to the default extent of the registry */
  const extentProviderOf = (type: string): PointFrameExtentProvider | undefined => {
    const own = pointFrameExtents.get(type);
    if (!defaultPointFrameExtent) return own;
    if (!own) return defaultPointFrameExtent;
    return (feature) => validExtent(own(feature)) ?? defaultPointFrameExtent(feature);
  };

  return {
    registerBoundingBox: (type, calculator) => registerIn(boundingBoxes, type, calculator),
    getBoundingBoxCalculator: (type) => boundingBoxes.get(type),

    registerAdditionalResizeHandles: (type, calculator) =>
      registerIn(additionalHandles, type, calculator),
    getAdditionalResizeHandlesCalculator: (type) => additionalHandles.get(type),

    registerPointFrameExtent: (type, provider) => registerIn(pointFrameExtents, type, provider),
    getPointFrameExtentProvider: (type) => pointFrameExtents.get(type),
    resolvePointFrameExtent(feature) {
      return resolvePointFrameExtentWith(extentProviderOf(feature.type), feature);
    },

    resolvePointFrameCorners(feature, center, margin) {
      return resolvePointFrameCornersWith(extentProviderOf(feature.type), feature, center, margin);
    },

    getTileSize: () => tileSize,
    setTileSize(value) {
      tileSize = value;
    },

    clear() {
      boundingBoxes.clear();
      additionalHandles.clear();
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
  const extent = validExtent(provider?.(feature));
  if (!extent) {
    const half = DEFAULT_POINT_FRAME_SIZE / 2;
    return { halfWidth: half, halfHeight: half };
  }
  return extent;
}

/** The extent when it is one (finite and not negative), else null */
function validExtent(extent: PointFrameExtent | null | undefined): PointFrameExtent | null {
  if (
    !extent ||
    !Number.isFinite(extent.halfWidth) ||
    !Number.isFinite(extent.halfHeight) ||
    extent.halfWidth < 0 ||
    extent.halfHeight < 0
  ) {
    return null;
  }
  return extent;
}

/**
 * The four corners of the selection frame of a zero-area feature on the screen, expanded by
 * the margin, with an optional provider: the rectangle of the extent around the center, widened
 * by the margin on every side
 */
export function resolvePointFrameCornersWith(
  extentProvider: PointFrameExtentProvider | undefined,
  feature: Feature,
  center: FramePoint,
  margin: number,
): FramePoint[] {
  const extent = resolvePointFrameExtentWith(extentProvider, feature);
  const halfWidth = extent.halfWidth + margin;
  const halfHeight = extent.halfHeight + margin;
  return [
    { x: center.x - halfWidth, y: center.y - halfHeight },
    { x: center.x + halfWidth, y: center.y - halfHeight },
    { x: center.x + halfWidth, y: center.y + halfHeight },
    { x: center.x - halfWidth, y: center.y + halfHeight },
  ];
}
