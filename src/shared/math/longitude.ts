// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Longitude wrapping
 *
 * The longitude arithmetic that the rendering, the hit testing and the snapping share, so
 * that all of them pick the same copy of the world.
 */

/**
 * Brings a longitude into [-180, 180] (a longitude already inside is returned unchanged)
 */
export function wrapLongitude(lng: number): number {
  if (lng >= -180 && lng <= 180) return lng;
  return lng - 360 * Math.round(lng / 360);
}

/**
 * The copy of a longitude nearest to a reference longitude
 *
 * A longitude within 180 degrees of the reference is returned unchanged (so nothing moves
 * away from the antimeridian); otherwise it is moved by whole turns. This is the choice the
 * rendering makes for a feature near the view: it is drawn on the copy of the world the view
 * shows, which is the copy nearest to the camera. Hit testing and snapping use it around the
 * pointer so that they meet the copy that is drawn.
 */
export function nearestLongitude(lng: number, reference: number): number {
  const delta = lng - reference;
  if (delta >= -180 && delta <= 180) return lng;
  return lng - 360 * Math.round(delta / 360);
}
