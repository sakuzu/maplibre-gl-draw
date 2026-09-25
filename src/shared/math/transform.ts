// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Coordinate transformation utilities
 *
 * Converts between geographic coordinates and screen coordinates in both directions.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

import type { Coordinate } from '../types/model.js';
import { pixelsToDegreesLat, pixelsToDegreesLng } from './distance.js';

/**
 * Clamps a latitude into the valid range
 *
 * MapLibre's project() throws an error when the latitude is outside the range -90 to 90, and
 * the latitude can fall outside that range, for example when a large image is placed at a low
 * zoom level.
 *
 * @param latitude - The latitude to clamp (degrees)
 * @returns The latitude clamped into the range -89.9 to 89.9
 */
export function clampLatitude(latitude: number): number {
  return Math.max(-89.9, Math.min(89.9, latitude));
}

/**
 * Clamps the latitude of a coordinate into the valid range
 *
 * @param coord - The coordinate to clamp [lng, lat]
 * @returns The coordinate with its latitude clamped
 */
export function clampCoordinate(coord: Coordinate): Coordinate {
  return [coord[0], clampLatitude(coord[1])];
}

/**
 * Mercator coordinate (in the range 0-1)
 */
export type MercatorCoord = [number, number];

/**
 * Converts a longitude/latitude into a Mercator coordinate (in the range 0-1)
 *
 * @param coord Longitude/latitude coordinate [lng, lat]
 * @returns Mercator coordinate [x, y] (in the range 0-1)
 */
export function lngLatToMercator(coord: Coordinate): MercatorCoord {
  const x = (coord[0] + 180) / 360;
  const y =
    (1 -
      Math.log(Math.tan((coord[1] * Math.PI) / 180) + 1 / Math.cos((coord[1] * Math.PI) / 180)) /
        Math.PI) /
    2;
  return [x, y];
}

/**
 * A point on the screen in CSS pixels, from the top-left corner of the map
 */
export interface ScreenPoint {
  /** The distance from the left edge */
  x: number;
  /** The distance from the top edge */
  y: number;
}

/**
 * A geographic position as an object, in degrees
 */
export interface LngLat {
  /** The longitude */
  lng: number;
  /** The latitude */
  lat: number;
}

/**
 * Coordinate transformation interface
 *
 * Wraps MapLibre's map.project() / map.unproject() and supports both the Mercator projection
 * and the globe projection.
 */
export interface CoordinateTransform {
  /** Converts a geographic coordinate into a screen coordinate */
  project(lngLat: Coordinate): ScreenPoint;

  /** Converts a screen coordinate into a geographic coordinate */
  unproject(point: ScreenPoint): LngLat;
}

/**
 * Injection point for the terrain-aware anchor projection
 *
 * When terrain is enabled, this is the only path that maps a UI anchor (longitude/latitude +
 * ground elevation) into screen coordinates. So that the rendering side (the vertex shader)
 * and the hit-testing side (this transformation) are structurally guaranteed to go through the
 * same elevation, the same matrices and the same branches, the implementation is owned by the
 * view layer (`view/terrain/anchor.ts`) and injected here. shared cannot depend on view, so
 * the direction is reversed into "shared opens a socket and view plugs into it".
 *
 * When project returns null (terrain is disabled, or the frame state is not yet established),
 * it falls back to MapLibre's project. The path taken when there is no terrain is exactly the
 * same as before the injection existed (which guarantees zero regression).
 */
export interface AnchorProjector {
  /**
   * Maps longitude/latitude + ground elevation into a screen coordinate (CSS pixels). null
   * when it cannot be used.
   */
  project(lng: number, lat: number): ScreenPoint | null;
}

/**
 * The injected anchor projection (per map)
 *
 * A single page can have several rendering instances (the screen + a thumbnail + a
 * preview + printing), so holding just one globally would make hit testing use the frame of
 * the instance that was created last. Keying by the map structurally rules out that mix-up.
 */
const anchorProjectors = new WeakMap<object, AnchorProjector>();

/**
 * Injects an anchor projection (the view layer calls this per map; null removes it)
 */
export function setAnchorProjector(map: MapLibreMap, projector: AnchorProjector | null): void {
  if (projector) anchorProjectors.set(map, projector);
  else anchorProjectors.delete(map);
}

/**
 * Gets the anchor projection that is currently injected
 */
export function getAnchorProjector(map: MapLibreMap): AnchorProjector | null {
  return anchorProjectors.get(map) ?? null;
}

/**
 * Creates a CoordinateTransform from a MapLibre map
 *
 * When terrain is enabled, project goes through the anchor projection (elevation included, one
 * matrix pass). With terrain enabled, MapLibre's map.project internally raycasts against the
 * terrain mesh, which measured at roughly 307μs per point (roughly 1μs without terrain). Hit
 * testing calls project for every vertex, so editing would not hold up as is.
 *
 * unproject is called for only a single screen point (roughly 43μs), so MapLibre's is used as
 * is. That is also because it has to solve the intersection with the terrain mesh by
 * raycasting, which cannot be obtained from matrices alone.
 *
 * @param map MapLibre map instance
 * @returns A CoordinateTransform instance
 */
export function createCoordinateTransform(map: MapLibreMap): CoordinateTransform {
  return {
    project: (coord: Coordinate) => {
      const anchored = anchorProjectors.get(map)?.project(coord[0], coord[1]);
      if (anchored) return anchored;
      const p = map.project([coord[0], coord[1]]);
      return { x: p.x, y: p.y };
    },
    unproject: (point: { x: number; y: number }) => {
      const ll = map.unproject([point.x, point.y]);
      return { lng: ll.lng, lat: ll.lat };
    },
  };
}

/**
 * Applies a margin in pixels to a bounding box
 *
 * When zoom is passed, the expansion is done on the map plane. When it is not passed, the
 * expansion round-trips through screen coordinates. It must not round-trip when there is
 * terrain: with terrain enabled, project projects a point at the height of the ground surface
 * and unproject casts a ray from the screen onto the ground surface and comes back, so the
 * round trip is no longer the identity mapping. With a tilted view, the returned values drift
 * by kilometers, and the box appears far away from the feature, with a different shape too.
 *
 * @param coords Coordinates of the 4 corners of the bounding box
 *   [topLeft, topRight, bottomRight, bottomLeft]
 * @param margin Margin size (pixels)
 * @param transform Coordinate transformation interface
 * @param zoom Current zoom (when passed, the expansion is done on the map plane; required when
 *   there is terrain)
 * @returns Coordinates of the 4 corners after the margin is applied
 */
export function applyMarginToBoundingBox(
  coords: {
    topLeft: Coordinate;
    topRight: Coordinate;
    bottomRight: Coordinate;
    bottomLeft: Coordinate;
  },
  margin: number,
  transform: CoordinateTransform,
  zoom?: number,
): {
  topLeft: Coordinate;
  topRight: Coordinate;
  bottomRight: Coordinate;
  bottomLeft: Coordinate;
} {
  if (zoom !== undefined) return marginOnMapPlane(coords, margin, zoom);

  // Convert the 4 corners into screen coordinates (clamp the latitude to prevent
  // out-of-range errors)
  const corners = [
    transform.project(clampCoordinate(coords.topLeft)),
    transform.project(clampCoordinate(coords.topRight)),
    transform.project(clampCoordinate(coords.bottomRight)),
    transform.project(clampCoordinate(coords.bottomLeft)),
  ];

  // Compute the center of the OBB
  const centerX = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
  const centerY = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;

  // Expand each vertex outward from the center
  const expandedCorners = corners.map((corner) => {
    const dx = corner.x - centerX;
    const dy = corner.y - centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return corner;

    // Extend by the margin while keeping the direction of the vector
    const scale = (dist + margin) / dist;
    return {
      x: centerX + dx * scale,
      y: centerY + dy * scale,
    };
  });

  // Convert into geographic coordinates
  const topLeftResult = transform.unproject(expandedCorners[0]);
  const topRightResult = transform.unproject(expandedCorners[1]);
  const bottomRightResult = transform.unproject(expandedCorners[2]);
  const bottomLeftResult = transform.unproject(expandedCorners[3]);

  return {
    topLeft: [topLeftResult.lng, topLeftResult.lat],
    topRight: [topRightResult.lng, topRightResult.lat],
    bottomRight: [bottomRightResult.lng, bottomRightResult.lat],
    bottomLeft: [bottomLeftResult.lng, bottomLeftResult.lat],
  };
}

/**
 * Widens the 4 corners outward from the center on the map plane
 *
 * It does not round-trip through screen coordinates, so it is affected by neither terrain nor
 * tilt. How many degrees one pixel amounts to is derived from the latitude of the center and
 * the current zoom.
 */
function marginOnMapPlane(
  coords: {
    topLeft: Coordinate;
    topRight: Coordinate;
    bottomRight: Coordinate;
    bottomLeft: Coordinate;
  },
  margin: number,
  zoom: number,
): {
  topLeft: Coordinate;
  topRight: Coordinate;
  bottomRight: Coordinate;
  bottomLeft: Coordinate;
} {
  const corners = [coords.topLeft, coords.topRight, coords.bottomRight, coords.bottomLeft];
  const centerLng = (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4;
  const centerLat = (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4;
  const degPerPxLng = pixelsToDegreesLng(1, centerLat, zoom);
  const degPerPxLat = pixelsToDegreesLat(1, centerLat, zoom);
  if (!(degPerPxLng > 0) || !(degPerPxLat > 0)) {
    return {
      topLeft: coords.topLeft,
      topRight: coords.topRight,
      bottomRight: coords.bottomRight,
      bottomLeft: coords.bottomLeft,
    };
  }

  // The vertical and horizontal scales differ, so convert into pixel-equivalent amounts
  // first and then widen
  const expanded = corners.map(([lng, lat]): Coordinate => {
    const dx = (lng - centerLng) / degPerPxLng;
    const dy = (lat - centerLat) / degPerPxLat;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return [lng, lat];
    const scale = (dist + margin) / dist;
    return [centerLng + dx * scale * degPerPxLng, centerLat + dy * scale * degPerPxLat];
  });

  return {
    topLeft: expanded[0],
    topRight: expanded[1],
    bottomRight: expanded[2],
    bottomLeft: expanded[3],
  };
}
