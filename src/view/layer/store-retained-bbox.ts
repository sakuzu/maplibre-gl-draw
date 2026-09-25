// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Longitude/latitude extents of the retained chunks
 *
 * A retained batch does not depend on the camera, so each chunk keeps the bbox of its features
 * and a frame skips the chunks that do not intersect the expanded viewport. The functions here
 * compute that bbox, grow it during an incremental update and test it against the viewport.
 */

import { circleBoundingBox } from '../../geometry/circle.js';
import { DEFAULT_TILE_SIZE } from '../../shared/math/index.js';
import { getCircleRadius } from '../../shared/utils/property.js';
import { getBoundingBox } from '../../store/spatial/index.js';
import type { BoundingBox, Coordinate, Feature } from '../../store/types.js';
import type { SelectionExtensionRegistry } from '../ui/selection-ui/index.js';

/**
 * Longitude/latitude bounding box of a chunk `[minLng, minLat, maxLng, maxLat]`
 */
export type ChunkBBox = [number, number, number, number];

/**
 * Whether the chunk bbox intersects the expanded viewport
 *
 * Both are treated as longitude/latitude rectangles (touching edges count as intersecting).
 */
export function bboxIntersects(bbox: ChunkBBox, viewport: BoundingBox): boolean {
  return (
    bbox[0] <= viewport.maxX &&
    bbox[2] >= viewport.minX &&
    bbox[1] <= viewport.maxY &&
    bbox[3] >= viewport.minY
  );
}

/**
 * The chunk bbox as a BoundingBox
 */
export function chunkBBoxToBounds(bbox: ChunkBBox): BoundingBox {
  return { minX: bbox[0], minY: bbox[1], maxX: bbox[2], maxY: bbox[3] };
}

/**
 * Expands the chunk bbox by one point (it never shrinks it)
 *
 * The incremental update of vertices only looks at the vertices that moved, so the bbox cannot be
 * recomputed exactly. As long as it only grows, "retained mode ⊇ immediate mode" holds: thinning
 * simply misses and the rendering result stays correct. The exact bbox comes back with the next
 * rebuild.
 *
 * @param bbox The current bbox. null (= always drawn without thinning) is returned as it is
 */
export function expandBBox(bbox: ChunkBBox | null, coord: Coordinate): ChunkBBox | null {
  if (!bbox) return null;

  const [lng, lat] = coord;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return bbox;

  return [
    Math.min(bbox[0], lng),
    Math.min(bbox[1], lat),
    Math.max(bbox[2], lng),
    Math.max(bbox[3], lat),
  ];
}

/**
 * Walks the nesting of coordinates (Coordinate / Coordinate[] / Coordinate[][] / ...)
 *
 * To avoid having a branch per feature type, it recurses until it reaches a pair of numbers. It
 * also withstands the unknown nesting of a custom type.
 */
function walkCoordinates(value: unknown, visit: (lng: number, lat: number) => void): void {
  if (!Array.isArray(value)) return;

  if (typeof value[0] === 'number' && typeof value[1] === 'number') {
    visit(value[0], value[1]);
    return;
  }

  for (const item of value) walkCoordinates(item, visit);
}

/**
 * Computes the rectangle occupied by a feature that spreads around its anchor
 *
 * A kind where "coordinates is a single anchor point and the body spreads around it", such as
 * Note / Text, degenerates into a point of zero area when only the coordinates are walked. The
 * whole chunk would then be thinned away the moment the center of the map enters it (= the moment
 * the anchor leaves the expanded viewport), and a feature that should cover the whole screen
 * would disappear entirely.
 *
 * The rectangle it actually occupies is already known to the calculator registered by the
 * extension (for Note, the selection box including the rotation) and to the size computation of
 * Image. That is folded into an AABB and used.
 *
 * @returns null for a kind where walking the raw coordinates is enough (Point / LineString /
 *   Polygon and so on) and when the computation did not produce finite values (the caller then
 *   walks them as before)
 */
function computeAnchoredExtent(
  feature: Feature,
  extensions: SelectionExtensionRegistry | undefined,
): ChunkBBox | null {
  const tileSize = extensions?.getTileSize() ?? DEFAULT_TILE_SIZE;
  // A custom type folds its registered rectangle (the 4 corners)
  const calculator = extensions?.getBoundingBoxCalculator(feature.type);
  if (calculator) {
    const box = calculator(feature, tileSize);
    if (!box) return null;
    return cornersToBBox([box.topLeft, box.topRight, box.bottomRight, box.bottomLeft]);
  }

  // Image is a standard kind of core, but its size is determined by the style and createdZoom
  if (feature.type === 'Image') {
    const box = getBoundingBox(feature, tileSize);
    return isFiniteBBox([box.minX, box.minY, box.maxX, box.maxY])
      ? [box.minX, box.minY, box.maxX, box.maxY]
      : null;
  }

  return null;
}

/**
 * Folds a sequence of coordinates into an AABB (null when a non-finite value is mixed in)
 */
function cornersToBBox(corners: readonly Coordinate[]): ChunkBBox | null {
  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  for (const corner of corners) {
    const lng = corner?.[0];
    const lat = corner?.[1];
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return corners.length > 0 ? [minLng, minLat, maxLng, maxLat] : null;
}

/** Whether all 4 values of the bbox are finite */
function isFiniteBBox(bbox: ChunkBBox): boolean {
  return bbox.every((value) => Number.isFinite(value));
}

/**
 * Computes the longitude/latitude bbox of a list of features
 *
 * min/max are taken on the raw longitude values without normalization. Data crossing ±180 ends up
 * with a huge bbox, so the thinning misses and it is always drawn (erring on the safe side).
 *
 * @returns null when there is not a single coordinate (= no thinning)
 */
export function computeFeaturesBBox(
  features: readonly Feature[],
  extensions: SelectionExtensionRegistry | undefined,
): ChunkBBox | null {
  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let found = false;

  const visit = (lng: number, lat: number): void => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    found = true;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };

  for (const feature of features) {
    // A kind that spreads around its anchor (a custom type, Image) uses the rectangle it really
    // occupies. For a standard kind that falls back to walking the raw coordinates this only adds
    // one registry lookup, and the cost per chunk build does not change.
    const extent = computeAnchoredExtent(feature, extensions);
    if (extent) {
      visit(extent[0], extent[1]);
      visit(extent[2], extent[3]);
      continue;
    }

    if (feature.type === 'Circle') {
      const radiusMeters = getCircleRadius(feature);
      const center = feature.coordinates as Coordinate;
      if (radiusMeters && radiusMeters > 0 && typeof center?.[0] === 'number') {
        // The box of the geodesic circle, whose east and west extremes lie poleward of due
        // east and west; it contains the polygon used for drawing (generateCirclePolygon).
        const box = circleBoundingBox(center, radiusMeters);
        if (box) {
          visit(box[0], box[1]);
          visit(box[2], box[3]);
          continue;
        }
      }
    }

    walkCoordinates(feature.coordinates, visit);
  }

  return found ? [minLng, minLat, maxLng, maxLat] : null;
}
