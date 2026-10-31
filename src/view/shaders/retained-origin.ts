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
 *
 * Rows moved on the GPU by the edit of a drag are seen on the screen far from where they are: the
 * region the view sees them from (the view moved back by the edit, `movedViews`) is on the screen
 * for them. A batch that holds such rows takes its origin near that region while they are
 * dragged (`view/renderers/row-motion.ts`): the rows dragged are the ones looked at, and a row of
 * the batch that stays where it is may be far from it then.
 */

import { worldSizeAtZoom } from '../../shared/math/ground-scale.js';
import type { BoundingBox } from '../../store/types.js';

/** The largest screen error of the baked offsets that is accepted (CSS px) */
export const RETAINED_ORIGIN_TOLERANCE_PX = 0.1;

/** The unit roundoff of Float32 */
const FLOAT32_ROUNDOFF = 2 ** -24;

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
  return originErrorPx(
    origin[0],
    origin[1],
    region.minX,
    region.minY,
    region.maxX,
    region.maxY,
    zoom,
  );
}

/** {@link retainedOriginErrorPx} of an origin and a region given as numbers */
function originErrorPx(
  originX: number,
  originY: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  zoom: number,
): number {
  const dLng = Math.max(Math.abs(minX - originX), Math.abs(maxX - originX));
  const dLat = Math.max(Math.abs(minY - originY), Math.abs(maxY - originY));
  const lat = Math.min(Math.max(Math.abs(minY), Math.abs(maxY)), MAX_MERCATOR_LATITUDE);
  const latScale = 1 / Math.cos((lat * Math.PI) / 180);
  const pxPerDegree = worldSizeAtZoom(zoom) / 360;
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
  movedViews?: readonly BoundingBox[],
): [number, number] | null {
  if (!extent) return null;
  return rebasedOriginOf(
    origin,
    extent.minX,
    extent.minY,
    extent.maxX,
    extent.maxY,
    view,
    zoom,
    movedViews,
  );
}

/**
 * {@link rebasedRetainedOrigin} of an extent given as numbers (`[minX, minY, maxX, maxY]`)
 *
 * The drawing asks it of every chunk in view on every frame, so nothing is made unless a new
 * origin is proposed.
 *
 * @param movedViews The regions the view sees the rows of the batch moved on the GPU from: the
 *   parts of the extent in them are the region on screen, in place of the view, when there are
 * @internal
 */
export function rebasedOriginOf(
  origin: readonly [number, number],
  extentMinX: number,
  extentMinY: number,
  extentMaxX: number,
  extentMaxY: number,
  view: BoundingBox | null,
  zoom: number,
  movedViews?: readonly BoundingBox[],
): [number, number] | null {
  // The region on screen: the parts of the extent the rows moved are seen from, or else the
  // extent clipped to the view (the whole extent without a view)
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  if (movedViews) {
    for (const moved of movedViews) {
      const x0 = Math.max(extentMinX, moved.minX);
      const y0 = Math.max(extentMinY, moved.minY);
      const x1 = Math.min(extentMaxX, moved.maxX);
      const y1 = Math.min(extentMaxY, moved.maxY);
      if (!(x0 <= x1 && y0 <= y1)) continue;
      minX = Math.min(minX, x0);
      minY = Math.min(minY, y0);
      maxX = Math.max(maxX, x1);
      maxY = Math.max(maxY, y1);
    }
  }
  if (!(minX <= maxX && minY <= maxY)) {
    minX = view ? Math.max(extentMinX, view.minX) : extentMinX;
    minY = view ? Math.max(extentMinY, view.minY) : extentMinY;
    maxX = view ? Math.min(extentMaxX, view.maxX) : extentMaxX;
    maxY = view ? Math.min(extentMaxY, view.maxY) : extentMaxY;
  }
  if (!(minX <= maxX && minY <= maxY)) return null;

  const error = originErrorPx(origin[0], origin[1], minX, minY, maxX, maxY, zoom);
  if (!(error > RETAINED_ORIGIN_TOLERANCE_PX)) return null;

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return originErrorPx(centerX, centerY, minX, minY, maxX, maxY, zoom) < error / 2
    ? [centerX, centerY]
    : null;
}
