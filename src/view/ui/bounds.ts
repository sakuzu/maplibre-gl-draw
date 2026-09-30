// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Computing the selection bounding box
 *
 * Computes the bounding box in geographic coordinates uniformly for every feature type.
 * Used by hit testing.
 *
 * The basic policy (see docs/internals/architecture.md):
 * - Data and computation are in geographic coordinates
 * - Hit testing unprojects the click position and decides in geographic coordinates
 * - Only rendering converts into screen coordinates
 */

import type { SelectionUIConfig } from '../../shared/config/selection.js';
import type { CoordinateTransform } from '../../shared/math/index.js';
import { applyMarginToBoundingBox } from '../../shared/math/index.js';
import type { Coordinate, Feature } from '../../store/types.js';
import {
  type BoundingBoxCoords,
  computeBoundingBox,
  hasZeroArea,
  resolvePointFrameCornersWith,
  type SelectionExtensionRegistry,
} from './selection-ui/index.js';

/**
 * Compute the bounding box with a margin of a feature in geographic coordinates
 *
 * Supports every feature type:
 * - Point: the icon size + the margin are computed in screen coordinates and converted
 *   into geographic coordinates
 * - LineString/Polygon: the margin is applied by applyMarginToBoundingBox
 *
 * @param feature The target feature
 * @param transform The coordinate transform
 * @param config The selection UI configuration
 * @returns The bounding box with a margin in geographic coordinates, or null when it
 * cannot be computed
 */
export function computeFeatureGeoBoundingBox(
  feature: Feature,
  transform: CoordinateTransform,
  config: SelectionUIConfig,
  extensions?: SelectionExtensionRegistry,
): BoundingBoxCoords | null {
  const margin = config.boundingBox.margin;

  // Compute the bbox for the selection UI (the draw instance's custom types included)
  const selectionBbox = computeBoundingBox(feature, extensions);
  if (!selectionBbox) return null;

  // Zero area (a single-coordinate feature such as Point) is expanded in pixels on screen
  if (hasZeroArea(selectionBbox)) {
    return computeSingleCoordGeoBoundingBox(
      feature,
      selectionBbox.center,
      transform,
      margin,
      extensions,
    );
  }

  // A bbox that has a size is expanded by the margin
  const marginedBbox = applyMarginToBoundingBox(selectionBbox, margin, transform);
  return {
    ...marginedBbox,
    center: selectionBbox.center,
  };
}

/**
 * Compute the combined geographic bounding box of several features (with a margin)
 *
 * @param features The array of target features
 * @param transform The coordinate transform
 * @param config The selection UI configuration
 * @param extensions The draw instance's extension points (custom bounding boxes and point
 *   frame extents)
 * @returns The bounding box with a margin in geographic coordinates, or null when it
 * cannot be computed
 */
export function computeCombinedGeoBoundingBox(
  features: Feature[],
  transform: CoordinateTransform,
  config: SelectionUIConfig,
  extensions?: SelectionExtensionRegistry,
): BoundingBoxCoords | null {
  if (features.length === 0) return null;

  // For a single feature the OBB is returned as is
  if (features.length === 1) {
    return computeFeatureGeoBoundingBox(features[0], transform, config, extensions);
  }

  // For several features, an AABB containing all the vertices is computed
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  for (const feature of features) {
    const bbox = computeFeatureGeoBoundingBox(feature, transform, config, extensions);
    if (!bbox) continue;

    // Update the min/max of the 4 corners
    const corners = [bbox.topLeft, bbox.topRight, bbox.bottomRight, bbox.bottomLeft];
    for (const corner of corners) {
      minLng = Math.min(minLng, corner[0]);
      maxLng = Math.max(maxLng, corner[0]);
      minLat = Math.min(minLat, corner[1]);
      maxLat = Math.max(maxLat, corner[1]);
    }
  }

  if (!Number.isFinite(minLng)) return null;

  return {
    topLeft: [minLng, maxLat],
    topRight: [maxLng, maxLat],
    bottomRight: [maxLng, minLat],
    bottomLeft: [minLng, minLat],
    center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2],
  };
}

/**
 * Compute the bounding box with a margin of a single-coordinate feature in geographic coordinates
 *
 * The extent of the frame of a point (registrable per type; 12px square when unregistered)
 * plus the margin is computed in screen coordinates and converted into geographic ones.
 * The coordinate received is the center of the bbox (since features other than Point can
 * also be zero-area, e.g. a MultiPoint with a single point; coordinates must not be
 * treated as a Coordinate).
 */
function computeSingleCoordGeoBoundingBox(
  feature: Feature,
  coord: Coordinate,
  transform: CoordinateTransform,
  margin: number,
  extensions: SelectionExtensionRegistry | undefined,
): BoundingBoxCoords {
  const center = transform.project(coord);

  // The corners of the frame of the point (its outline, or its extent) + the margin
  const corners = extensions
    ? extensions.resolvePointFrameCorners(feature, center, margin)
    : resolvePointFrameCornersWith(undefined, undefined, feature, center, margin);

  // Convert the 4 corners in screen coordinates into geographic coordinates
  const [topLeft, topRight, bottomRight, bottomLeft] = corners.map((corner) =>
    transform.unproject(corner),
  );

  return {
    topLeft: [topLeft.lng, topLeft.lat],
    topRight: [topRight.lng, topRight.lat],
    bottomRight: [bottomRight.lng, bottomRight.lat],
    bottomLeft: [bottomLeft.lng, bottomLeft.lat],
    center: coord,
  };
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
