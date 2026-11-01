// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type definitions related to the selection UI
 *
 * Gathers the types of BoundingBox, resize computation and the custom feature extension points.
 */

import type { BoundingBoxCoords } from '../../../shared/types/selection-box.js';
import type { Feature } from '../../../store/types.js';

// BoundingBoxCoords is a basic type (operations/ reads it too), defined in shared/.
export type { BoundingBoxCoords } from '../../../shared/types/selection-box.js';

/**
 * Computes the selection box of a feature of a custom type.
 *
 * `tileSize` is the tile size in px of the map, for types whose size is given in pixels.
 * The box is returned as its four corners and its center in degrees, or null when the feature
 * has nothing to draw.
 */
export type CustomBoundingBoxCalculator = (
  feature: Feature,
  tileSize: number,
) => BoundingBoxCoords | null;

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
 * Returning null gives the default dimensions: the extent of the marker for a point the
 * built-in type draws, else the square of DEFAULT_POINT_FRAME_SIZE.
 */
export type PointFrameExtentProvider = (feature: Feature) => PointFrameExtent | null;

/** A point on the screen in CSS px, from the top left of the map */
export interface FramePoint {
  x: number;
  y: number;
}
