// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BoundingBox computation and rendering
 *
 * Provides the functions that compute BoundingBoxCoords from a feature, and the function
 * that draws a BoundingBox with StrokeRenderer.
 *
 * Image (an OBB that takes the rotation into account) is computed by computeOrientedBoundingBox,
 * and custom features use the calculator registered in the draw instance's
 * SelectionExtensionRegistry.
 */

import { circleBoundingBox } from '../../../geometry/circle.js';
import { pixelsToDegreesLat, pixelsToDegreesLng } from '../../../shared/math/index.js';
import { fromPlane, toPlane } from '../../../shared/math/mercator-plane.js';
import { coordinatesOf } from '../../../shared/utils/coordinates.js';
import {
  getCircleRadius,
  getCreatedZoom,
  getImageProperties,
} from '../../../shared/utils/property.js';
import { getBoundingBox } from '../../../store/spatial/index.js';
import type { Coordinate, Feature } from '../../../store/types.js';
import type { SelectionExtensionRegistry } from './extension-registry.js';
import type { BoundingBoxCoords } from './types.js';

/**
 * Determines whether a selection box has no area, that is whether both ends of its diagonal
 * are the same coordinate (a Point).
 *
 * @param bbox The corners of the box in degrees
 * @returns `true` when the top-left and bottom-right corners are exactly equal
 */
export function hasZeroArea(bbox: BoundingBoxCoords): boolean {
  return bbox.topLeft[0] === bbox.bottomRight[0] && bbox.topLeft[1] === bbox.bottomRight[1];
}

/**
 * Computes the selection box of a feature: its four corners and its center in degrees.
 *
 * A Point gives a box with no area at its position, a Circle the box of the circle, an
 * Image an oriented box that takes the rotation into account, and the other built-in types
 * the axis-aligned box of their coordinates.
 * A custom feature uses the calculator registered in the draw instance's registry. Without a
 * registry only the standard feature types are known (a custom type falls back to the
 * extent of its coordinates).
 *
 * @param feature The feature
 * @param extensions The selection extension points of the draw instance, for custom types
 * @returns The box, or `null` when the feature has no coordinates to measure
 */
export function computeBoundingBox(
  feature: Feature,
  extensions?: SelectionExtensionRegistry,
): BoundingBoxCoords | null {
  const customCalculator = extensions?.getBoundingBoxCalculator(feature.type);
  if (customCalculator && extensions) {
    return customCalculator(feature, extensions.getTileSize());
  }

  if (feature.type === 'Point') {
    const coord = coordinatesOf(feature) as Coordinate;
    return {
      topLeft: coord,
      topRight: coord,
      bottomRight: coord,
      bottomLeft: coord,
      center: coord,
    };
  }

  if (feature.type === 'Image') {
    return computeOrientedBoundingBox(feature);
  }

  if (feature.type === 'Circle') {
    return computeCircleBoundingBox(feature);
  }

  // LineString / Polygon / the Multi kinds compute an AABB
  // (for the Multi kinds getBoundingBox flattens all the parts, so this is their union as is)
  const bounds = getBoundingBox(feature);
  if (bounds.minX === 0 && bounds.minY === 0 && bounds.maxX === 0 && bounds.maxY === 0) {
    return null;
  }
  const centerLng = (bounds.minX + bounds.maxX) / 2;
  const centerLat = (bounds.minY + bounds.maxY) / 2;
  return {
    topLeft: [bounds.minX, bounds.maxY],
    topRight: [bounds.maxX, bounds.maxY],
    bottomRight: [bounds.maxX, bounds.minY],
    bottomLeft: [bounds.minX, bounds.minY],
    center: [centerLng, centerLat],
  };
}

/**
 * The frame of a Circle: the extent of the geodesic circle as it is drawn, around its center
 */
function computeCircleBoundingBox(feature: Feature): BoundingBoxCoords {
  const center = coordinatesOf(feature) as Coordinate;
  const radiusMeters = getCircleRadius(feature);
  const extent = radiusMeters && radiusMeters > 0 ? circleBoundingBox(center, radiusMeters) : null;

  if (!extent) {
    return {
      topLeft: center,
      topRight: center,
      bottomRight: center,
      bottomLeft: center,
      center,
    };
  }

  const [west, south, east, north] = extent;
  return {
    topLeft: [west, north],
    topRight: [east, north],
    bottomRight: [east, south],
    bottomLeft: [west, south],
    center,
  };
}

/**
 * Compute the OBB (Oriented Bounding Box) of an Image, taking the rotation into account
 *
 * Applies a planar rotation with a latitude correction instead of a spherical rotation
 * (the same method as computeQuadVertices in quad-shader.ts).
 */
function computeOrientedBoundingBox(feature: Feature): BoundingBoxCoords | null {
  const coord = coordinatesOf(feature) as Coordinate;
  const [lng, lat] = coord;
  const tileSize = 512;

  const props = getImageProperties(feature);

  const imageWidth = props.imageWidth || 100;
  const imageHeight = props.imageHeight || 100;
  const scale = props.scale ?? 1;
  // getImageProperties().createdZoom returns 0 when it is missing, so ?? does not work.
  // getCreatedZoom(number|undefined) is used so that 14 is the default when it is missing.
  const createdZoom = getCreatedZoom(feature) ?? 14;
  // Only props.rotation is used (the same as ImageRenderer)
  const rotation = props.rotation ?? 0;

  const displayWidth = imageWidth * scale;
  const displayHeight = imageHeight * scale;
  const halfWidthDeg = pixelsToDegreesLng(displayWidth / 2, lat, createdZoom, tileSize);
  const halfHeightDeg = pixelsToDegreesLat(displayHeight / 2, lat, createdZoom, tileSize);

  const rotationRad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const latCos = Math.cos((lat * Math.PI) / 180);

  // Normalize to the latitude degree scale
  let hwNorm = halfWidthDeg * latCos;
  let hhNorm = halfHeightDeg;

  // Determine the scale factor from the latitude offset after the rotation
  const MAX_LATITUDE = 89.9;
  const baseCorners = [
    { x: -hwNorm, y: hhNorm },
    { x: hwNorm, y: hhNorm },
    { x: hwNorm, y: -hhNorm },
    { x: -hwNorm, y: -hhNorm },
  ];
  let maxLatOffset = 0;
  for (const c of baseCorners) {
    const ry = c.x * sin + c.y * cos;
    maxLatOffset = Math.max(maxLatOffset, Math.abs(ry));
  }
  const maxAllowedOffset = MAX_LATITUDE - Math.abs(lat);
  if (maxLatOffset > maxAllowedOffset && maxLatOffset > 0) {
    const scaleFactor = maxAllowedOffset / maxLatOffset;
    hwNorm *= scaleFactor;
    hhNorm *= scaleFactor;
  }

  const localCorners = [
    { x: -hwNorm, y: hhNorm }, // top-left
    { x: hwNorm, y: hhNorm }, // top-right
    { x: hwNorm, y: -hhNorm }, // bottom-right
    { x: -hwNorm, y: -hhNorm }, // bottom-left
  ];
  const rotatedCorners = localCorners.map((c) => {
    const rx = c.x * cos - c.y * sin;
    const ry = c.x * sin + c.y * cos;
    return [lng + rx / latCos, lat + ry] as Coordinate;
  });

  return {
    topLeft: rotatedCorners[0],
    topRight: rotatedCorners[1],
    bottomRight: rotatedCorners[2],
    bottomLeft: rotatedCorners[3],
    center: coord,
  };
}

/**
 * Compute the combined BoundingBox of several features
 *
 * A single feature returns its OBB as is. Several features return an AABB that contains
 * all the vertices.
 */
export function computeCombinedBoundingBox(
  features: Feature[],
  extensions?: SelectionExtensionRegistry,
): BoundingBoxCoords | null {
  if (features.length === 0) return null;
  if (features.length === 1) return computeBoundingBox(features[0], extensions);

  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  for (const feature of features) {
    const bbox = computeBoundingBox(feature, extensions);
    if (!bbox) continue;
    const corners = [bbox.topLeft, bbox.topRight, bbox.bottomRight, bbox.bottomLeft];
    for (const corner of corners) {
      minLng = Math.min(minLng, corner[0]);
      maxLng = Math.max(maxLng, corner[0]);
      minLat = Math.min(minLat, corner[1]);
      maxLat = Math.max(maxLat, corner[1]);
    }
  }

  if (!Number.isFinite(minLng)) return null;
  const centerLng = (minLng + maxLng) / 2;
  const centerLat = (minLat + maxLat) / 2;
  return {
    topLeft: [minLng, maxLat],
    topRight: [maxLng, maxLat],
    bottomRight: [maxLng, minLat],
    bottomLeft: [minLng, minLat],
    center: [centerLng, centerLat],
  };
}

/**
 * Rotate a BoundingBox around its center
 *
 * Rotates in Web Mercator, the same plane and angle convention as the rotate operation
 * (operations/rotate.ts), so the frame drawn during a rotation drag stays on the corners of
 * the rotated feature at any latitude and size.
 *
 * @param angle Rotation (radians, counterclockwise in the transform plane)
 * @param rotationCenter The center of the rotation. The frame's own center when omitted
 */
export function rotateBoundingBox(
  bbox: BoundingBoxCoords,
  angle: number,
  rotationCenter?: Coordinate,
): BoundingBoxCoords {
  const center = rotationCenter ?? bbox.center;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const [cx, cy] = toPlane(center);

  const rotatePoint = (coord: Coordinate): Coordinate => {
    const [x, y] = toPlane(coord);
    const dx = x - cx;
    const dy = y - cy;
    return fromPlane(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
  };

  return {
    topLeft: rotatePoint(bbox.topLeft),
    topRight: rotatePoint(bbox.topRight),
    bottomRight: rotatePoint(bbox.bottomRight),
    bottomLeft: rotatePoint(bbox.bottomLeft),
    center: rotatePoint(bbox.center),
  };
}
