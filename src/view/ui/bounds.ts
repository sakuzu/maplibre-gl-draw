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
  resolvePointFrameExtentWith,
  type SelectionExtensionRegistry,
} from './selection-ui/index.js';

/**
 * The selection box of one feature: its footprint with the margin, as the selection UI draws and
 * hits it
 *
 * - a footprint laid on the map: its corners with the margin laid on the ground
 *   (`applyMarginToBoundingBox`) at the scale of the frame of the transform
 * - a footprint of the screen (a box without area on the map): its position, and the half sizes
 *   of its extent on the screen with the margin
 *
 * @internal
 */
export type SelectionBoxShape =
  | {
      kind: 'ground';
      topLeft: Coordinate;
      topRight: Coordinate;
      bottomRight: Coordinate;
      bottomLeft: Coordinate;
    }
  | { kind: 'screen'; position: Coordinate; halfWidth: number; halfHeight: number };

/**
 * The selection box of one feature (see {@link SelectionBoxShape})
 *
 * @param transform The coordinate transform of the frame (the scale the margin is laid with)
 * @param margin The margin of the box, in CSS pixels
 * @param extensions The draw instance's extension points (custom boxes and point frames)
 * @returns The box, or null when the feature has nothing to draw
 * @internal
 */
export function selectionBoxOf(
  feature: Feature,
  transform: Pick<CoordinateTransform, 'metersPerPixel'>,
  margin: number,
  extensions?: SelectionExtensionRegistry,
): SelectionBoxShape | null {
  const box = computeBoundingBox(feature, extensions);
  if (!box) return null;
  if (hasZeroArea(box)) {
    const extent = extensions
      ? extensions.resolvePointFrameExtent(feature)
      : resolvePointFrameExtentWith(undefined, feature);
    return {
      kind: 'screen',
      position: box.center,
      halfWidth: extent.halfWidth + margin,
      halfHeight: extent.halfHeight + margin,
    };
  }
  return { kind: 'ground', ...applyMarginToBoundingBox(box, margin, transform) };
}

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
  const margin = config.box.margin;
  let underPoint: Coordinate | null = null;
  const underPointOf = (): Coordinate => {
    if (!underPoint) {
      const lngLat = transform.unproject(screenPoint);
      underPoint = [lngLat.lng, lngLat.lat];
    }
    return underPoint;
  };
  const inFrame = (box: BoundingBoxCoords): boolean =>
    isPointInGeoBoundingBox(underPointOf(), applyMarginToBoundingBox(box, margin, transform));

  if (features.length > 1) {
    const combined = computeCombinedBoundingBox([...features], extensions);
    if (combined && inFrame(combined)) return true;
  }
  for (const feature of features) {
    const box = selectionBoxOf(feature, transform, margin, extensions);
    if (!box) continue;
    const inside =
      box.kind === 'screen'
        ? isPointInScreenBox(screenPoint, box, transform)
        : isPointInGeoBoundingBox(underPointOf(), box);
    if (inside) return true;
  }
  return false;
}

/**
 * Whether a point of the screen is inside a selection box of the screen: its half sizes around
 * its position on the screen, as the selection UI draws it
 */
function isPointInScreenBox(
  screenPoint: ScreenPoint,
  box: Extract<SelectionBoxShape, { kind: 'screen' }>,
  transform: CoordinateTransform,
): boolean {
  const center = transform.project(box.position);
  return (
    Math.abs(screenPoint.x - center.x) <= box.halfWidth &&
    Math.abs(screenPoint.y - center.y) <= box.halfHeight
  );
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
export function isPointInGeoBoundingBox(
  lngLat: Coordinate,
  bbox: Pick<BoundingBoxCoords, 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft'>,
): boolean {
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
