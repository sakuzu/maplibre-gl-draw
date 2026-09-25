// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dash pattern computation utilities
 *
 * Precomputes the dash pattern on the CPU side and returns each dash as an individual segment
 */

import { DEFAULT_TILE_SIZE } from '../../../shared/math/index.js';
import type { Coordinate } from '../../../shared/types/model.js';

export type { Coordinate };

/** One dash of a dashed line, as returned by {@link splitIntoDashes}. */
export interface DashSegment {
  /** The positions `[lng, lat]` of the dash, at least 2 */
  coords: Coordinate[];
}

const RADIANS_PER_DEGREE = Math.PI / 180;

/**
 * Measures the distance between two points in screen pixels
 *
 * The dash length and gap length arrive in screen pixels (the caller derives them from the
 * effective line width), so unless the path is measured on exactly the same scale, the result
 * will not look the way it was specified.
 *
 * In Web Mercator:
 *   - 1 degree of longitude = worldSize / 360 px (constant regardless of latitude)
 *   - 1 degree of latitude = 1 / cos(lat) times that (stretched more at higher latitudes)
 * where worldSize = tileSize x 2^zoom (tileSize is 512).
 *
 * The old implementation used 156543 m/px (= the zoom 0 resolution based on 256 px tiles) and
 * did not account for the latitude stretch either, so it estimated the path length at 1/2 to
 * 1/2.5 of its actual size. As a result, dashes were drawn 2 to 2.5 times longer than
 * specified, and short paths fit within a single dash and looked solid.
 */
function calculateDistance(
  p1: Coordinate,
  p2: Coordinate,
  zoom: number,
  tileSize: number = DEFAULT_TILE_SIZE,
): number {
  const pixelsPerLngDegree = (tileSize * 2 ** zoom) / 360;
  // Determine the stretch per degree from the latitude at the middle of the interval (the
  // mapping is affine within the interval, so interpolating with the ratio computed here still
  // gives exactly the same intersection positions)
  const latitude = (p1[1] + p2[1]) / 2;
  const cosLatitude = Math.max(Math.cos(latitude * RADIANS_PER_DEGREE), 1e-6);

  const x = (p2[0] - p1[0]) * pixelsPerLngDegree;
  const y = ((p2[1] - p1[1]) * pixelsPerLngDegree) / cosLatitude;
  return Math.hypot(x, y);
}

/**
 * Interpolates between two points
 */
function interpolate(p1: Coordinate, p2: Coordinate, t: number): Coordinate {
  return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t];
}

/**
 * Splits a line into the pieces of a dash pattern measured in screen pixels at a zoom.
 *
 * Lengths are measured in Web Mercator pixels of 512 px tiles, so the dashes look the
 * specified length on screen at `zoom`. The pattern continues across vertices.
 *
 * @param coords The vertices `[lng, lat]` in degrees
 * @param dashLength The dash length in screen px
 * @param gapLength The gap length in screen px
 * @param zoom The zoom the lengths are measured at
 * @returns The dashes, in order along the line. An empty array for fewer than 2 positions
 */
export function splitIntoDashes(
  coords: Coordinate[],
  dashLength: number,
  gapLength: number,
  zoom: number,
): DashSegment[] {
  if (coords.length < 2) return [];

  const segments: DashSegment[] = [];

  let currentDash: Coordinate[] = [];
  let distanceInPattern = 0; // Current position within the pattern
  let inDash = true; // Whether we are currently in a dash portion

  // Add the first point
  currentDash.push(coords[0]);

  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const segmentLength = calculateDistance(p1, p2, zoom);

    if (segmentLength === 0) continue;

    let remainingInSegment = segmentLength;
    let currentT = 0; // Current position within the segment (0-1)

    while (remainingInSegment > 0) {
      if (inDash) {
        // Dash portion
        const remainingInDash = dashLength - distanceInPattern;

        if (remainingInSegment >= remainingInDash) {
          // The dash ends
          const t = currentT + remainingInDash / segmentLength;
          const point = interpolate(p1, p2, Math.min(t, 1));
          currentDash.push(point);

          // Store the dash
          if (currentDash.length >= 2) {
            segments.push({ coords: [...currentDash] });
          }
          currentDash = [];

          remainingInSegment -= remainingInDash;
          currentT = t;
          distanceInPattern = 0;
          inDash = false;
        } else {
          // The dash continues within the segment
          distanceInPattern += remainingInSegment;
          remainingInSegment = 0;
        }
      } else {
        // Gap portion
        const remainingInGap = gapLength - distanceInPattern;

        if (remainingInSegment >= remainingInGap) {
          // The gap ends
          const t = currentT + remainingInGap / segmentLength;
          const point = interpolate(p1, p2, Math.min(t, 1));
          currentDash = [point];

          remainingInSegment -= remainingInGap;
          currentT = t;
          distanceInPattern = 0;
          inDash = true;
        } else {
          // The gap continues within the segment
          distanceInPattern += remainingInSegment;
          remainingInSegment = 0;
        }
      }
    }

    // Add the end point of the segment (when we are in a dash portion)
    if (inDash && currentDash.length > 0) {
      currentDash.push(p2);
    }
  }

  // Store the last dash
  if (inDash && currentDash.length >= 2) {
    segments.push({ coords: currentDash });
  }

  return segments;
}

/**
 * Returns the dash and gap lengths in px that suit a line style at a line width.
 *
 * Unlike getDashPattern (preset) in shared/math, this computes dynamically from the stroke
 * width.
 *
 * @param lineStyle The line style
 * @param strokeWidth The line thickness at draw time (pixels)
 * @returns [dashLength, gapLength], or null (for a solid line)
 */
export function getStrokeDashPattern(
  lineStyle: 'solid' | 'dashed' | 'dotted',
  strokeWidth = 2,
): [number, number] | null {
  // The minimum gap at which round caps do not overlap
  const minGap = strokeWidth + 1;

  switch (lineStyle) {
    case 'dashed':
      // Dashed: longer dashes (4x the line width), moderate gaps (2x the line width)
      return [Math.max(12, strokeWidth * 4), Math.max(minGap, strokeWidth * 2)];
    case 'dotted':
      // Dotted: short dots (nearly round), short gaps (about the line width)
      return [Math.max(1, strokeWidth * 0.5), Math.max(minGap, strokeWidth * 1.2)];
    default:
      return null;
  }
}
