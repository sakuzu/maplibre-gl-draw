// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hit testing the frames of the selection
 *
 * Tests a point of the screen against the frames the selection UI draws, made by the same
 * functions: a frame laid on the map is tested on the map, and the frame of a point, which is
 * drawn on the screen around it, on the screen.
 */

import type { SelectionUIConfig } from '../../shared/config/selection.js';
import type { CoordinateTransform, ScreenPoint } from '../../shared/math/index.js';
import { applyMarginToBoundingBox } from '../../shared/math/index.js';
import type { Coordinate, Feature } from '../../store/types.js';
import {
  type BoundingBoxCoords,
  computeBoundingBox,
  computeCombinedBoundingBox,
  hasZeroArea,
  resolvePointFrameCornersWith,
  type SelectionExtensionRegistry,
} from './selection-ui/index.js';

/**
 * Whether a point of the screen is inside the frames drawn around the selection
 *
 * The frames are the ones the selection UI draws, made by the same functions:
 *
 * - a feature with an extent has its box widened by the margin on the ground
 *   (`applyMarginToBoundingBox`), and the position under the point is tested against it
 * - a feature of a single position (a point) has the frame of its marker and the margin on the
 *   screen around the point, as its marker is drawn, and the point is tested on the screen
 * - several features have the frame of all of them (the box of their positions, a point counting
 *   by its position, widened by the margin) besides the frame of each
 *
 * @param screenPoint The point, in CSS pixels
 * @param features The selected features
 * @param transform The coordinate transform (the projection the markers are drawn with)
 * @param config The selection UI configuration
 * @param extensions The draw instance's extension points (custom bounding boxes and point frames)
 */
export function isPointInSelectionFrame(
  screenPoint: ScreenPoint,
  features: readonly Feature[],
  transform: CoordinateTransform,
  config: SelectionUIConfig,
  extensions?: SelectionExtensionRegistry,
): boolean {
  if (features.length === 0) return false;
  const margin = config.boundingBox.margin;
  let underPoint: Coordinate | null = null;
  const inFrame = (box: BoundingBoxCoords): boolean => {
    if (!underPoint) {
      const lngLat = transform.unproject(screenPoint);
      underPoint = [lngLat.lng, lngLat.lat];
    }
    return isPointInGeoBoundingBox(underPoint, {
      ...applyMarginToBoundingBox(box, margin, transform),
      center: box.center,
    });
  };

  if (features.length > 1) {
    const combined = computeCombinedBoundingBox([...features], extensions);
    if (combined && inFrame(combined)) return true;
  }
  for (const feature of features) {
    const box = computeBoundingBox(feature, extensions);
    if (!box) continue;
    const inside = hasZeroArea(box)
      ? isPointInPointFrame(screenPoint, feature, box.center, transform, margin, extensions)
      : inFrame(box);
    if (inside) return true;
  }
  return false;
}

/**
 * Whether a point of the screen is inside the frame of a feature of a single position: the extent
 * of its marker (registrable per type; the marker of a built-in point, or a 12px square when
 * unregistered) plus the margin, around the point on the screen, as the selection UI draws it
 *
 * The position received is the center of the bbox (features other than Point can also be
 * zero-area, e.g. a MultiPoint with a single point).
 */
function isPointInPointFrame(
  screenPoint: ScreenPoint,
  feature: Feature,
  position: Coordinate,
  transform: CoordinateTransform,
  margin: number,
  extensions: SelectionExtensionRegistry | undefined,
): boolean {
  const center = transform.project(position);
  const corners = extensions
    ? extensions.resolvePointFrameCorners(feature, center, margin)
    : resolvePointFrameCornersWith(undefined, undefined, feature, center, margin);
  return corners.length === 4 && isPointInQuad(screenPoint, corners);
}

/** Whether a point is inside a convex quadrilateral (the cross product method) */
function isPointInQuad(point: ScreenPoint, corners: readonly ScreenPoint[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const p1 = corners[i];
    const p2 = corners[(i + 1) % 4];
    const cross = (p2.x - p1.x) * (point.y - p1.y) - (p2.y - p1.y) * (point.x - p1.x);
    const side = cross >= 0 ? 1 : -1;
    if (sign === 0) sign = side;
    else if (side !== sign) return false;
  }
  return true;
}

/**
 * Decide whether a point in geographic coordinates is inside a convex quadrilateral
 *
 * Uses the cross product method. It decides whether the point is inside the convex
 * quadrilateral enclosed by the 4 corners.
 *
 * @param lngLat The geographic coordinate to test [lng, lat]
 * @param bbox The bounding box in geographic coordinates
 * @returns true when the point is inside the bbox
 */
export function isPointInGeoBoundingBox(lngLat: Coordinate, bbox: BoundingBoxCoords): boolean {
  // Inside test for a convex quadrilateral (the cross product method)
  const corners = [bbox.topLeft, bbox.topRight, bbox.bottomRight, bbox.bottomLeft];

  // For each edge, decide which side the point is on
  // If it is on the same side for every edge, it is inside
  let sign: number | null = null;

  for (let i = 0; i < 4; i++) {
    const p1 = corners[i];
    const p2 = corners[(i + 1) % 4];

    // The edge vector
    const edgeX = p2[0] - p1[0];
    const edgeY = p2[1] - p1[1];

    // The vector to the point
    const toPointX = lngLat[0] - p1[0];
    const toPointY = lngLat[1] - p1[1];

    // The cross product (2D)
    const cross = edgeX * toPointY - edgeY * toPointX;

    if (sign === null) {
      sign = cross >= 0 ? 1 : -1;
    } else {
      if ((cross >= 0 ? 1 : -1) !== sign) {
        return false;
      }
    }
  }

  return true;
}
