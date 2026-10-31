// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scale of a size of the current view: the meters a CSS pixel spans on the ground at a
 * position, in a frame of the map
 *
 * It follows the projection of the frame, read from what maplibre hands a custom layer (the zoom,
 * the center and the transition to the globe), and the drawing and the hit testing read it from
 * the frame drawn last (`transform.ts`), so that what is grabbed is what was drawn. The length is
 * laid on the plane tangent to the sphere of the map (`ground-scale.ts`).
 */

import { EARTH } from './constants.js';
import { degreesPerMeterAt, worldSizeAtZoom } from './ground-scale.js';

/** The latitude limit of Web Mercator (degrees), past which no scale is finite */
const MAX_MERCATOR_LATITUDE = 85.0511287798066;

/**
 * What the scale of a size of the current view reads from a frame of the map
 *
 * @internal
 */
export interface ScreenScaleFrame {
  /** The zoom the frame was drawn at */
  readonly zoom: number;
  /** The latitude of the center of the view, in degrees */
  readonly centerLatitude: number;
  /** How far the projection is from Web Mercator (0) to the globe (1) */
  readonly transition: number;
}

/**
 * The Mercator units of a meter at a latitude: the value of maplibre's
 * `MercatorCoordinate.meterInMercatorCoordinateUnits` there, on the same sphere (computed here so
 * that no entry of the library loads maplibre at runtime; a test holds the two equal)
 *
 * @internal
 */
export function mercatorUnitsPerMeter(latitude: number): number {
  const lat = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
  return 1 / (EARTH.CIRCUMFERENCE_METERS * Math.cos((lat * Math.PI) / 180));
}

/**
 * The meters a CSS pixel spans at a latitude in a frame: the scale of a size of the current view
 *
 * A pixel is `worldSize * mix(m(latitude), m(center), transition)` Mercator units of a meter, where
 * `m` is the Mercator units of a meter at a latitude and `worldSize` the width of the world in
 * pixels at the zoom of the frame: the scale of Web Mercator at the latitude on Web Mercator, the
 * scale at the center of the view on the globe (whose sphere has the same scale everywhere), and
 * the mix of the two in the transition from one to the other.
 *
 * @param frame - The frame
 * @param latitude - The latitude in degrees
 */
export function metersPerPixelInFrame(frame: ScreenScaleFrame, latitude: number): number {
  const t = Math.max(0, Math.min(1, frame.transition));
  const here = mercatorUnitsPerMeter(latitude);
  const units = t === 0 ? here : here + (mercatorUnitsPerMeter(frame.centerLatitude) - here) * t;
  return 1 / (worldSizeAtZoom(frame.zoom) * units);
}

/**
 * The values a shader computes {@link metersPerPixelInFrame} from, for many latitudes at once
 *
 * The Mercator units of a meter at a latitude are those at the equator times the secant of the
 * latitude, so a shader takes a pixel at a latitude as `pixelsPerMeterAtEquator *
 * mix(1 / cos(latitude), centerSecant, transition)` meters of the inverse, and a meter north as
 * `degreesPerMeterNorth` degrees of latitude on the tangent plane (`ground-scale.ts`).
 *
 * @internal
 */
export interface ScreenScaleUniforms {
  /** The CSS pixels of a meter at the equator on Web Mercator, at the zoom of the frame */
  readonly pixelsPerMeterAtEquator: number;
  /** The Mercator units of a meter at the center of the view over those at the equator */
  readonly centerSecant: number;
  /** How far the projection is from Web Mercator (0) to the globe (1) */
  readonly transition: number;
  /** The degrees of latitude of a meter north */
  readonly degreesPerMeterNorth: number;
}

/**
 * The values a shader computes the scale of a frame from ({@link ScreenScaleUniforms})
 *
 * @internal
 */
export function screenScaleUniformsOf(frame: ScreenScaleFrame): ScreenScaleUniforms {
  const atEquator = mercatorUnitsPerMeter(0);
  return {
    pixelsPerMeterAtEquator: worldSizeAtZoom(frame.zoom) * atEquator,
    centerSecant: mercatorUnitsPerMeter(frame.centerLatitude) / atEquator,
    transition: Math.max(0, Math.min(1, frame.transition)),
    degreesPerMeterNorth: degreesPerMeterAt(0)[1],
  };
}
