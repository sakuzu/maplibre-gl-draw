// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The bounding box of a feature
 *
 * A pure function of the feature (and the tile size for Image). The spatial index of the Store
 * (store/spatial) and the datasets (display/) both use it.
 */

import { circleBoundingBox } from '../../geometry/circle.js';
import { pixelsToDegreesLat, pixelsToDegreesLng, rotateCoordinateOnSphere } from '../math/index.js';
import type {
  BoundingBox,
  Coordinate,
  Feature,
  FeatureCoordinates,
  ImageStyle,
} from '../types/model.js';
import { forEachCoordinateDeep } from './coordinates.js';
import { getCircleRadius, getCreatedZoom, getImageProperties } from './property.js';

/**
 * Computes the bounding box of a feature
 *
 * For an Image, the size at createdZoom is converted into geographic coordinates
 */
function computeBoundingBox(feature: Feature, tileSize: number): BoundingBox {
  const { type, coordinates } = feature;

  // For an Image
  if (type === 'Image') {
    const coord = coordinates as Coordinate;
    const [lng, lat] = coord;
    const props = getImageProperties(feature);
    const style = feature.style as ImageStyle | undefined;

    const imageWidth = style?.width || props.imageWidth || 100;
    const imageHeight = style?.height || props.imageHeight || 100;
    const scale = props.scale ?? 1;
    // createdZoom defaults to 14 when missing. getImageProperties().createdZoom returns 0 when
    // missing, so ?? does not work; therefore getCreatedZoom(number|undefined) is used.
    const createdZoom = getCreatedZoom(feature) ?? 14;
    const rotation = props.rotation ?? 0;

    const displayWidth = imageWidth * scale;
    const displayHeight = imageHeight * scale;

    // Convert the pixel size into degrees
    const halfWidthDeg = pixelsToDegreesLng(displayWidth / 2, lat, createdZoom, tileSize);
    const halfHeightDeg = pixelsToDegreesLat(displayHeight / 2, lat, createdZoom, tileSize);

    // Compute the bounding box taking rotation into account
    return computeRotatedBoundingBox(lng, lat, halfWidthDeg, halfHeightDeg, rotation);
  }

  // For a Circle
  if (type === 'Circle') {
    const coord = coordinates as Coordinate;
    const [lng, lat] = coord;
    const radiusMeters = getCircleRadius(feature);

    if (!radiusMeters || radiusMeters <= 0) {
      return { minX: lng, minY: lat, maxX: lng, maxY: lat };
    }

    // The extent of the geodesic circle as it is drawn (a circle over a pole spans every
    // longitude up to the pole)
    const extent = circleBoundingBox(coord, radiusMeters);
    if (!extent) {
      return { minX: lng, minY: lat, maxX: lng, maxY: lat };
    }
    const [minX, minY, maxX, maxY] = extent;
    return { minX, minY, maxX, maxY };
  }

  // For Point, LineString, Polygon, Freehand and the Multi types
  return computeCoordinateBoundingBox(feature);
}

/** The bounding box for empty or unreadable coordinates (the origin) */
const EMPTY_BOUNDING_BOX: BoundingBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

/**
 * A cache of AABBs determined by the coordinates alone (the key is the coordinate array
 * reference)
 *
 * Premise: coordinate arrays are never rewritten in place (updating coordinates in the Store
 * follows the immutable-update convention of swapping in a new array, both in the core memory
 * implementation and in external store implementations). Therefore the cache stays valid as
 * long as the array reference is the same, and when the coordinates change the key changes so
 * the entry is naturally rebuilt and the old value is reclaimed by the GC. For that reason
 * there is no invalidation logic (the same pattern as the segment grid and the snapping index
 * of hit testing).
 *
 * Image / Circle / custom calculators also depend on things other than the coordinates (size,
 * rotation, radius, tile size), so they are not cached. Point is a single vertex and has no
 * traversal cost, so it is not cached either.
 */
const coordinateBoundingBoxCache = new WeakMap<object, BoundingBox>();

/**
 * Computes the bounding box determined by the coordinates alone (with caching)
 *
 * For a selected feature on the order of 100,000 vertices this is called every frame, so on a
 * cache hit it does not traverse and only returns a copy of the value.
 */
function computeCoordinateBoundingBox(feature: Feature): BoundingBox {
  const { type, coordinates } = feature;

  if (type === 'Point') {
    const [lng, lat] = coordinates as Coordinate;
    return { minX: lng, minY: lat, maxX: lng, maxY: lat };
  }

  // Every other type (the built-in line and area types, and a custom type without its own
  // bounding box calculator) is measured by the extent of its coordinates
  if (!Array.isArray(coordinates)) {
    return { ...EMPTY_BOUNDING_BOX };
  }

  const cached = coordinateBoundingBoxCache.get(coordinates);
  if (cached) {
    // Return a new object every time so that the cache is not polluted if the caller mutates it
    return { ...cached };
  }

  const bbox = computeCoordinateBoundingBoxUncached(type, coordinates);
  coordinateBoundingBoxCache.set(coordinates, bbox);
  return { ...bbox };
}

/**
 * Obtains the AABB by traversing the nested coordinates directly
 *
 * It takes the min and max without building an intermediate array (a flattened coordinate
 * sequence).
 */
function computeCoordinateBoundingBoxUncached(
  type: string,
  coordinates: FeatureCoordinates,
): BoundingBox {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let count = 0;

  const visit = (coord: Coordinate): void => {
    const [cLng, cLat] = coord;
    if (cLng < minX) minX = cLng;
    if (cLat < minY) minY = cLat;
    if (cLng > maxX) maxX = cLng;
    if (cLat > maxY) maxY = cLat;
    count++;
  };

  if (type === 'LineString' || type === 'Freehand') {
    const coords = coordinates as Coordinate[];
    for (let i = 0; i < coords.length; i++) {
      visit(coords[i]);
    }
  } else if (type === 'Polygon') {
    // A Polygon is an array of the outer ring and the inner rings (holes)
    const rings = coordinates as Coordinate[][];
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      for (let i = 0; i < ring.length; i++) {
        visit(ring[i]);
      }
    }
  } else {
    // The Multi types have a nesting depth that differs per type, so a depth-independent
    // traversal is used. The bounding box is simply the union of all the parts.
    forEachCoordinateDeep(coordinates, visit);
  }

  if (count === 0) {
    return { ...EMPTY_BOUNDING_BOX };
  }

  return { minX, minY, maxX, maxY };
}

/**
 * Computes the bounding box taking rotation into account
 *
 * It rotates the four corners using a spherical rotation (Rodrigues' rotation formula) and
 * computes the AABB (axis-aligned bounding box) from the rotated coordinates.
 *
 * @param centerLng the longitude of the center
 * @param centerLat the latitude of the center
 * @param halfWidthDeg the half width (in degrees)
 * @param halfHeightDeg the half height (in degrees)
 * @param rotationDeg the rotation angle (in degrees, counterclockwise)
 * @returns the bounding box
 */
function computeRotatedBoundingBox(
  centerLng: number,
  centerLat: number,
  halfWidthDeg: number,
  halfHeightDeg: number,
  rotationDeg: number,
): BoundingBox {
  // With no rotation, return a simple AABB
  if (rotationDeg === 0) {
    return {
      minX: centerLng - halfWidthDeg,
      minY: centerLat - halfHeightDeg,
      maxX: centerLng + halfWidthDeg,
      maxY: centerLat + halfHeightDeg,
    };
  }

  const center: Coordinate = [centerLng, centerLat];

  // The coordinates of the four corners before rotation
  const corners: Coordinate[] = [
    [centerLng - halfWidthDeg, centerLat + halfHeightDeg], // top-left (northwest)
    [centerLng + halfWidthDeg, centerLat + halfHeightDeg], // top-right (northeast)
    [centerLng - halfWidthDeg, centerLat - halfHeightDeg], // bottom-left (southwest)
    [centerLng + halfWidthDeg, centerLat - halfHeightDeg], // bottom-right (southeast)
  ];

  // Apply the spherical rotation
  const rotatedCorners = corners.map((coord) =>
    rotateCoordinateOnSphere(coord, center, rotationDeg),
  );

  // Compute the AABB from the rotated coordinates
  const lngs = rotatedCorners.map((c) => c[0]);
  const lats = rotatedCorners.map((c) => c[1]);

  return {
    minX: Math.min(...lngs),
    minY: Math.min(...lats),
    maxX: Math.max(...lngs),
    maxY: Math.max(...lats),
  };
}

/**
 * A utility function that computes a bounding box (for public use)
 *
 * @param feature the feature
 * @param tileSize the tile size (512 by default)
 */
export function getBoundingBox(feature: Feature, tileSize = 512): BoundingBox {
  return computeBoundingBox(feature, tileSize);
}
