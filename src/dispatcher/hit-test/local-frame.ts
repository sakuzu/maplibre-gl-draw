// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The local frame of hit testing
 *
 * Hit testing decides "within clickTolerance screen pixels of the click". Coordinates are
 * longitude / latitude, so that decision is made in a frame where one unit is the same
 * screen length in every direction: the Web Mercator plane around the click. Near a
 * latitude φ a latitude difference is 1 / cos φ times longer on screen than the same
 * longitude difference, so latitude differences are divided by cos φ and every distance
 * comes out in degrees of longitude at the click latitude.
 *
 * The tolerance is expressed in the same unit. It is the ground length of clickTolerance
 * pixels along the screen x axis, measured with unproject, so it does not depend on the
 * bearing (the length of a displacement does not change when the map is turned) and follows
 * the local scale under pitch (the screen x axis is never foreshortened).
 *
 * This is the contract every HitTestStrategy receives as `toleranceLngLat`: degrees of
 * longitude at the click latitude. A latitude tolerance is `toleranceLngLat * cos φ`.
 */

import type { ScreenPoint } from '../../shared/math/index.js';
import { wrapLongitude } from '../../shared/math/longitude.js';
import type { Coordinate } from '../../store/types.js';

/** Converts a screen point into longitude / latitude */
type Unproject = (point: ScreenPoint) => { lng: number; lat: number };

/** Lower bound of cos φ (guards against the poles, where Web Mercator diverges) */
const MIN_LATITUDE_SCALE = 1e-6;

/**
 * cos φ of a latitude: how much shorter a latitude difference is than on screen, relative
 * to the same longitude difference
 */
export function latitudeScale(latitude: number): number {
  return Math.max(Math.cos((latitude * Math.PI) / 180), MIN_LATITUDE_SCALE);
}

/**
 * Wraps a longitude difference into [-180, 180)
 */
function wrapLngDelta(delta: number): number {
  return ((((delta + 180) % 360) + 360) % 360) - 180;
}

/**
 * The click on the copies of the world whose stored features it can reach
 *
 * The features are stored with longitudes in [-180, 180], while the click unprojects to the
 * unwrapped longitude of the view (above 180 on the copy east of the antimeridian, which the
 * rendering draws as a second copy of the stored features). The click is therefore brought
 * into [-180, 180], where it meets the stored coordinates of the copy drawn under it. When its
 * reach runs past ±180, the click is also given on the neighbouring copy, so a feature just
 * across the line is found too. Away from the antimeridian this is the click alone, unchanged.
 *
 * The first step is the rule InputRouter applies to every event before a mode sees it
 * (`toStoredCopy`), so a click routed through it arrives here already in [-180, 180]; the
 * wrapping stays for the callers that hit test a raw pointer position.
 *
 * @param coordinate The click (unwrapped longitude)
 * @param reach How far the test reaches from the click (degrees of longitude)
 * @returns The click on each copy to test, the stored copy first
 */
export function clickCopies(coordinate: Coordinate, reach: number): Coordinate[] {
  const lng = wrapLongitude(coordinate[0]);
  const lat = coordinate[1];
  const copies: Coordinate[] = [lng === coordinate[0] ? coordinate : [lng, lat]];
  if (lng + reach > 180) copies.push([lng - 360, lat]);
  if (lng - reach < -180) copies.push([lng + 360, lat]);
  return copies;
}

/**
 * The click tolerance in degrees of longitude at the click latitude
 *
 * It measures the ground length of `tolerancePx` pixels along the screen x axis, so turning
 * the map does not change it.
 */
export function toleranceDegrees(
  unproject: Unproject,
  point: ScreenPoint,
  tolerancePx: number,
): number {
  if (!(tolerancePx > 0)) return 0;
  const origin = unproject(point);
  const offset = unproject({ x: point.x + tolerancePx, y: point.y });
  const dLng = wrapLngDelta(offset.lng - origin.lng);
  const dLat = (offset.lat - origin.lat) / latitudeScale(origin.lat);
  return Math.hypot(dLng, dLat);
}

/**
 * The distance between two points in the local frame (degrees of longitude)
 *
 * @param latScale latitudeScale of the click latitude
 */
export function localDistance(a: Coordinate, b: Coordinate, latScale: number): number {
  const dx = b[0] - a[0];
  const dy = (b[1] - a[1]) / latScale;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * The distance from a point to a segment in the local frame (degrees of longitude)
 *
 * @param latScale latitudeScale of the click latitude
 */
export function localPointToSegmentDistance(
  point: Coordinate,
  start: Coordinate,
  end: Coordinate,
  latScale: number,
): number {
  const px = point[0];
  const py = point[1] / latScale;
  const ax = start[0];
  const ay = start[1] / latScale;
  const dx = end[0] - ax;
  const dy = end[1] / latScale - ay;
  const lengthSquared = dx * dx + dy * dy;

  // The same arithmetic as shared/math pointToSegmentDistance, so that a latScale of 1
  // gives bit-identical results
  if (lengthSquared === 0) return planarDistance(px, py, ax, ay);

  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return planarDistance(px, py, ax + t * dx, ay + t * dy);
}

function planarDistance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * The shortest distance from a point to a polyline in the local frame (degrees of longitude)
 *
 * An array with fewer than two vertices has no segment and is infinitely far.
 *
 * @param latScale latitudeScale of the click latitude
 */
export function localPointToPolylineDistance(
  point: Coordinate,
  coords: Coordinate[],
  latScale: number,
): number {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < coords.length - 1; i++) {
    const distance = localPointToSegmentDistance(point, coords[i], coords[i + 1], latScale);
    if (distance < min) min = distance;
  }
  return min;
}
