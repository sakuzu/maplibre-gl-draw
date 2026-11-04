// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Coordinate transformation utilities
 *
 * Converts between geographic coordinates and screen coordinates in both directions.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

import type { Coordinate } from '../types/model.js';
import { metersOnTangentPlane, offsetOnTangentPlane } from './ground-scale.js';
import { metersPerPixelInFrame, type ScreenScaleFrame } from './screen-scale.js';

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

  /**
   * The meters a CSS pixel spans on the ground at a position, in the frame drawn last
   * ({@link metersPerPixelInFrame}): what turns a size of the current view in pixels into a
   * length laid around a feature
   */
  metersPerPixel(lngLat: Coordinate): number;
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
  /**
   * The boxes that hold every position whose anchor is drawn within `reachPx` CSS pixels of a
   * point of the screen, on the ground along the line of sight under it (an anchor behind a
   * ridge is drawn, and far from the position the point unprojects to): where the hit testing
   * looks for the anchors it compares on the screen
   *
   * @param near The position the point unprojects to
   * @returns The boxes, `[minLng, minLat, maxLng, maxLat]` one after another, the longitudes on
   *   the copy of the world drawn under the point; null when it cannot be used (as `project`)
   */
  searchBoxes?(x: number, y: number, reachPx: number, near: LngLat): number[] | null;
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
 * The conversion between positions and points of the screen in the frame drawn last
 *
 * The drawing and the hit testing read the frame drawn last, so that what is grabbed is what was
 * drawn: a camera moved after the frame (by code, between two frames) does not move what is hit
 * away from where it is drawn. The view layer computes it with the projection of the shaders in
 * float64, on the terrain when it is on (`view/terrain/anchor.ts`), and injects it here per map.
 */
export interface ViewProjector {
  /**
   * The point of the screen (CSS pixels) where a position is drawn in the frame drawn last; null
   * behind the camera or before the first frame
   */
  project(lng: number, lat: number): ScreenPoint | null;
  /**
   * The position drawn at a point of the screen in the frame drawn last, found from a position
   * near it (what maplibre unprojects the point to with its current camera); null when no
   * position is drawn there or before the first frame
   */
  unproject(x: number, y: number, near: LngLat): LngLat | null;
}

/** The view of the frame drawn last, per map */
const viewProjectors = new WeakMap<object, ViewProjector>();

/** Injects the view of the frame drawn last (the view layer calls this per map; null removes it) */
export function setViewProjector(map: MapLibreMap, projector: ViewProjector | null): void {
  if (projector) viewProjectors.set(map, projector);
  else viewProjectors.delete(map);
}

/** The view of the frame drawn last of a map, or null when none is injected */
export function getViewProjector(map: MapLibreMap): ViewProjector | null {
  return viewProjectors.get(map) ?? null;
}

/**
 * The scale of the frame drawn last, per map
 *
 * The selection UI is drawn in a frame and hit tested between frames, so both read the frame
 * drawn last: what is grabbed is what was drawn. Keyed by the map, as the anchor projection is.
 */
const screenScaleFrames = new WeakMap<object, ScreenScaleFrame>();

/**
 * Records the scale of the frame being drawn (the view layer calls this per frame; null forgets
 * it)
 */
export function setScreenScaleFrame(map: MapLibreMap, frame: ScreenScaleFrame | null): void {
  if (frame) screenScaleFrames.set(map, frame);
  else screenScaleFrames.delete(map);
}

/**
 * The scale of the frame drawn last; before the first frame, that of the camera of the map on
 * Web Mercator
 */
export function screenScaleFrameOf(
  map: Pick<MapLibreMap, 'getZoom' | 'getCenter'>,
): ScreenScaleFrame {
  const drawn = screenScaleFrames.get(map);
  if (drawn) return drawn;
  return { zoom: map.getZoom(), centerLatitude: map.getCenter().lat, transition: 0 };
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
      const drawn = viewProjectors.get(map)?.project(coord[0], coord[1]);
      if (drawn) return drawn;
      const anchored = anchorProjectors.get(map)?.project(coord[0], coord[1]);
      if (anchored) return anchored;
      const p = map.project([coord[0], coord[1]]);
      return { x: p.x, y: p.y };
    },
    unproject: (point: { x: number; y: number }) => {
      const ll = map.unproject([point.x, point.y]);
      const near = { lng: ll.lng, lat: ll.lat };
      return viewProjectors.get(map)?.unproject(point.x, point.y, near) ?? near;
    },
    metersPerPixel: (lngLat: Coordinate) =>
      metersPerPixelInFrame(screenScaleFrameOf(map), lngLat[1]),
  };
}

/**
 * Moves every edge of a four-cornered outline outward by a margin
 *
 * The corners are in the order top left, top right, bottom right, bottom left of the shape as
 * it stands unturned, in a space whose y axis points down (the screen). Each corner moves by
 * the margin along both edges that meet at it, so the frame keeps the margin on every side and
 * its corners stay on the diagonals of the outline turned as it is. An edge of no length (the
 * outline of a straight horizontal or vertical line) takes the direction square to the other
 * one, and an outline of no size is widened as an unturned square.
 *
 * @param corners The four corners
 * @param margin The margin, in the unit of the corners
 * @returns The four corners moved outward, in the same order
 */
export function expandQuad(
  corners: readonly { x: number; y: number }[],
  margin: number,
): { x: number; y: number }[] {
  const [tl, tr, br, bl] = corners;
  const unit = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    return length > 0 ? { x: dx / length, y: dy / length } : null;
  };
  let u = unit(tl, tr) ?? unit(bl, br);
  let v = unit(tl, bl) ?? unit(tr, br);
  // With y pointing down, the bottom direction is the right direction turned clockwise
  if (!u && v) u = { x: v.y, y: -v.x };
  if (u && !v) v = { x: -u.y, y: u.x };
  const right = u ?? { x: 1, y: 0 };
  const down = v ?? { x: 0, y: 1 };
  const at = (corner: { x: number; y: number }, alongRight: number, alongDown: number) => ({
    x: corner.x + (right.x * alongRight + down.x * alongDown) * margin,
    y: corner.y + (right.y * alongRight + down.y * alongDown) * margin,
  });
  return [at(tl, -1, -1), at(tr, 1, -1), at(br, 1, 1), at(bl, -1, 1)];
}

/**
 * Applies a margin in pixels to a bounding box
 *
 * Every edge moves outward by the margin ({@link expandQuad}), on the ground: the margin is
 * turned into meters at the center of the box with the scale of the frame drawn last
 * (`transform.metersPerPixel`) and laid on the plane tangent to the sphere there, so the frame
 * tilts and turns with the map. The drawing and the hit testing make the frame with this same
 * function. It never goes through the screen and back: with terrain, a position projected and
 * unprojected again lands elsewhere, and a tilted view would move the frame by kilometers.
 *
 * @param coords Coordinates of the 4 corners of the bounding box
 *   [topLeft, topRight, bottomRight, bottomLeft]
 * @param margin Margin size (CSS pixels)
 * @param transform What gives the scale of the frame
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
  transform: Pick<CoordinateTransform, 'metersPerPixel'>,
): {
  topLeft: Coordinate;
  topRight: Coordinate;
  bottomRight: Coordinate;
  bottomLeft: Coordinate;
} {
  const corners = [coords.topLeft, coords.topRight, coords.bottomRight, coords.bottomLeft];
  const center: Coordinate = [
    (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4,
    (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4,
  ];
  const metersPerPixel = transform.metersPerPixel(center);
  if (!(metersPerPixel > 0) || !Number.isFinite(metersPerPixel)) {
    return {
      topLeft: coords.topLeft,
      topRight: coords.topRight,
      bottomRight: coords.bottomRight,
      bottomLeft: coords.bottomLeft,
    };
  }

  // In meters on the tangent plane, with y pointing down as on the screen
  const expanded = expandQuad(
    corners.map((corner) => {
      const [east, north] = metersOnTangentPlane(center, corner);
      return { x: east, y: -north };
    }),
    margin * metersPerPixel,
  ).map(({ x, y }) => offsetOnTangentPlane(center, x, -y));

  return {
    topLeft: expanded[0],
    topRight: expanded[1],
    bottomRight: expanded[2],
    bottomLeft: expanded[3],
  };
}
