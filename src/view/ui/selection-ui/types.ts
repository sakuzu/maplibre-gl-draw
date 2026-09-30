// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type definitions related to the selection UI
 *
 * Gathers the types of BoundingBox, resize computation and the custom feature extension points.
 */

import type { BoundingBoxCoords } from '../../../shared/types/selection-box.js';
import type { Coordinate, Feature } from '../../../store/types.js';

// BoundingBoxCoords is a basic type (operations/ reads it too), defined in shared/.
// TypeResizeCalculator is an extension contract, defined in extension/.
export type { TypeResizeCalculator } from '../../../extension/index.js';
export type { BoundingBoxCoords } from '../../../shared/types/selection-box.js';

/**
 * Computes the selection box of a feature of a custom type.
 *
 * `tileSize` is the tile size in px of the map, for types whose size is given in pixels.
 * The box is returned as its four corners and its center in degrees.
 */
export type CustomBoundingBoxCalculator = (feature: Feature, tileSize: number) => BoundingBoxCoords;

/**
 * The half width and half height of the selection frame of a point, in CSS px.
 *
 * A point stays zero-area and keeps the branch of "the look of a point" (the frame only,
 * no resize / rotate handles, move inside the frame). It changes only the frame dimensions.
 */
export interface PointFrameExtent {
  /** The half width from the center (CSS pixels) */
  halfWidth: number;
  /** The half height from the center (CSS pixels) */
  halfHeight: number;
}

/**
 * Returns the size of the selection frame of a point-like feature.
 *
 * Returning null gives the default dimensions (the square of DEFAULT_POINT_FRAME_SIZE).
 */
export type PointFrameExtentProvider = (feature: Feature) => PointFrameExtent | null;

/** A point on the screen in CSS px, from the top left of the map */
export interface FramePoint {
  x: number;
  y: number;
}

/**
 * Returns the outline of the selection frame of a point-like feature: its four corners on the
 * screen in CSS px, in the order top left, top right, bottom right, bottom left of the shape.
 *
 * The frame of a rotated shape is drawn along it. The point stays zero-area: no resize or
 * rotate handle appears. Returning null (or anything but four finite corners) gives the frame
 * of {@link PointFrameExtentProvider}.
 */
export type PointFrameOutlineProvider = (feature: Feature) => readonly FramePoint[] | null;

/**
 * A resize handle a custom feature type adds to the built-in ones (the same shape as
 * {@link HandleInfo}).
 */
export interface AdditionalHandleInfo {
  /** The handle kind, passed back to the resize computation when it is dragged */
  type: string;
  /** The position of the handle, `[lng, lat]` in degrees */
  position: Coordinate;
}

/**
 * Returns the resize handles a feature of a custom type adds, given its selection box.
 */
export type AdditionalResizeHandlesCalculator = (
  feature: Feature,
  bbox: BoundingBoxCoords,
) => AdditionalHandleInfo[];

/**
 * How a feature type is resized.
 *
 *   - scale       : changes the scale property (as with Text and Image)
 *   - coordinates : changes the coordinates directly (as with Polygon and LineString)
 */
export type ResizeStrategy = 'scale' | 'coordinates';
