// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The origin of a retained batch and the precision it leaves
 *
 * A retained batch bakes its vertices as Float32 offsets from an origin, and each frame the
 * shader adds the Float32 uniform `u_origin_shift` (origin minus screen center). Both terms are
 * rounded to 24 bits, so a vertex seen at the screen center is off by about
 * `2^-24 * (|vertex - origin| + |origin - center|)`: roughly twice the distance from the origin
 * to what is on screen, times 2^-24. The error is fixed by the distance, not by the zoom, so it
 * grows on screen with every zoom level, and the part that comes from the shift changes as the
 * camera pans (it shakes).
 *
 * The rule is therefore that the origin stays near what is on screen: a batch is built with the
 * center of its extent as the origin, and when the error for the region on screen would exceed
 * `RETAINED_ORIGIN_TOLERANCE_PX`, the batch is built again with the center of that region as the
 * origin. At the zoom levels where the data spreads over a large part of the screen the error is
 * far below a pixel, so this only happens at high zoom, where the region on screen is small.
 */

import type { BoundingBox } from '../../store/types.js';

/** The largest screen error of the baked offsets that is accepted (CSS px) */
export const RETAINED_ORIGIN_TOLERANCE_PX = 0.1;

/** The unit roundoff of Float32 */
const FLOAT32_ROUNDOFF = 2 ** -24;

/** The width of the world in CSS px at zoom 0 (the tile size of maplibre) */
const WORLD_SIZE_PX = 512;

/** The latitude where Web Mercator stops (the scale diverges at the poles) */
const MAX_MERCATOR_LATITUDE = 85.0511287798;

/**
 * The center of a bounding box
 */
export function boundsCenter(bounds: BoundingBox): [number, number] {
  return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
}

/**
 * The screen error (CSS px) that the baked offsets of a batch leave in a region
 *
 * It is the bound described in the module comment, measured at the corner of the region
 * farthest from the origin. A latitude difference is longer on screen by 1 / cos φ, so it is
 * weighted with the highest latitude of the region.
 *
 * @param origin The origin of the batch
 * @param region The region on screen (longitude / latitude)
 * @param zoom The zoom of the camera
 */
export function retainedOriginErrorPx(
  origin: readonly [number, number],
  region: BoundingBox,
  zoom: number,
): number {
  const dLng = Math.max(Math.abs(region.minX - origin[0]), Math.abs(region.maxX - origin[0]));
  const dLat = Math.max(Math.abs(region.minY - origin[1]), Math.abs(region.maxY - origin[1]));
  const lat = Math.min(
    Math.max(Math.abs(region.minY), Math.abs(region.maxY)),
    MAX_MERCATOR_LATITUDE,
  );
  const latScale = 1 / Math.cos((lat * Math.PI) / 180);
  const pxPerDegree = (WORLD_SIZE_PX * 2 ** zoom) / 360;
  return 2 * FLOAT32_ROUNDOFF * Math.max(dLng, dLat * latScale) * pxPerDegree;
}

/**
 * The origin a batch should be built with again for the current view (null = keep it)
 *
 * The region on screen is the extent of the batch clipped to the view. When the current origin
 * leaves more than the tolerance there, the center of that region is proposed, provided it at
 * least halves the error (so that a region that is large on screen, where no origin can do
 * better, does not rebuild every frame).
 *
 * @param origin The origin the batch was built with
 * @param extent The extent of the batch (null when unknown: kept)
 * @param view The view (null when unknown: the whole extent is taken as on screen)
 * @param zoom The zoom of the camera
 */
export function rebasedRetainedOrigin(
  origin: readonly [number, number],
  extent: BoundingBox | null,
  view: BoundingBox | null,
  zoom: number,
): [number, number] | null {
  if (!extent) return null;
  const region: BoundingBox = view
    ? {
        minX: Math.max(extent.minX, view.minX),
        minY: Math.max(extent.minY, view.minY),
        maxX: Math.min(extent.maxX, view.maxX),
        maxY: Math.min(extent.maxY, view.maxY),
      }
    : extent;
  if (!(region.minX <= region.maxX && region.minY <= region.maxY)) return null;

  const error = retainedOriginErrorPx(origin, region, zoom);
  if (!(error > RETAINED_ORIGIN_TOLERANCE_PX)) return null;

  const candidate = boundsCenter(region);
  return retainedOriginErrorPx(candidate, region, zoom) < error / 2 ? candidate : null;
}
