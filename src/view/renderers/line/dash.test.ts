// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the CPU-side splitting of dashed lines
 *
 * The dash length and gap length are specified in screen pixels. Unless the path is measured
 * on the same scale, the specification "dashes 4x the line width" will not look the way it was
 * specified, so the split positions are verified in actual screen pixels.
 *
 * Symptom observed in the field: on a dashed line with a large width (effectively on the
 * order of 100px), a short path (a bar of about 300px) looked solid. Because the path length
 * was estimated at 1/2 to 1/2.5 of its actual size, a single dash covered the whole bar.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_TILE_SIZE } from '../../../shared/math/index.js';
import type { Coordinate } from './dash.js';
import { getStrokeDashPattern, splitIntoDashes } from './dash.js';

const ZOOM = 14;

/**
 * Screen pixels to degrees of longitude (Web Mercator; longitude is constant regardless of
 * latitude)
 */
function pxToLng(pixels: number): number {
  return (pixels * 360) / (DEFAULT_TILE_SIZE * 2 ** ZOOM);
}

/** Screen pixels to degrees of latitude (undoing the Mercator stretch) */
function pxToLat(pixels: number, latitude: number): number {
  return pxToLng(pixels) * Math.cos((latitude * Math.PI) / 180);
}

/** The screen pixel length of an east-west segment */
function lngSpanPx(from: Coordinate, to: Coordinate): number {
  return ((to[0] - from[0]) * (DEFAULT_TILE_SIZE * 2 ** ZOOM)) / 360;
}

/**
 * Counts only the dashes that have length
 *
 * When the path ends exactly on a period boundary, one zero-length fragment is appended at the
 * end (existing behavior of the splitting loop). It does not show up visually, so it is
 * excluded from the count.
 */
function solidDashes(segments: { coords: Coordinate[] }[]): { coords: Coordinate[] }[] {
  return segments.filter(
    (segment) => lngSpanPx(segment.coords[0], segment.coords[segment.coords.length - 1]) > 1e-9,
  );
}

describe('getStrokeDashPattern', () => {
  it('uses dashes 4x the line width and gaps 2x the line width for dashed lines', () => {
    expect(getStrokeDashPattern('dashed', 20)).toEqual([80, 40]);
  });

  it('applies the lower bounds for thin lines (so round caps do not overlap)', () => {
    expect(getStrokeDashPattern('dashed', 2)).toEqual([12, 4]);
  });

  it('gives a solid line no pattern', () => {
    expect(getStrokeDashPattern('solid', 20)).toBeNull();
  });
});

describe('measuring path length in screen pixels', () => {
  it('splits an east-west line on the equator into the dashes as specified', () => {
    // With a period of 80px dash + 40px gap, 480px is worth 4 periods
    const line: Coordinate[] = [
      [0, 0],
      [pxToLng(480), 0],
    ];
    const segments = solidDashes(splitIntoDashes(line, 80, 40, ZOOM));

    expect(segments).toHaveLength(4);
    // The first one runs from 0px to 80px
    expect(lngSpanPx(segments[0].coords[0], segments[0].coords[1])).toBeCloseTo(80, 6);
    // The second one runs from 120px to 200px
    expect(lngSpanPx(line[0], segments[1].coords[0])).toBeCloseTo(120, 6);
    expect(lngSpanPx(segments[1].coords[0], segments[1].coords[1])).toBeCloseTo(80, 6);
  });

  it('splits a north-south line into the same lengths (undoing the Mercator stretch)', () => {
    const latitude = 35.7;
    const eastWest: Coordinate[] = [
      [0, latitude],
      [pxToLng(480), latitude],
    ];
    const northSouth: Coordinate[] = [
      [0, latitude],
      [0, latitude + pxToLat(480, latitude)],
    ];

    // For lines of the same length on screen, the number of dashes is the same even when the
    // direction differs
    expect(splitIntoDashes(northSouth, 80, 40, ZOOM)).toHaveLength(
      splitIntoDashes(eastWest, 80, 40, ZOOM).length,
    );
  });

  it('keeps the scale in the longitude direction unchanged even at high latitudes', () => {
    const equator = splitIntoDashes(
      [
        [0, 0],
        [pxToLng(480), 0],
      ],
      80,
      40,
      ZOOM,
    );
    const highLatitude = splitIntoDashes(
      [
        [0, 60],
        [pxToLng(480), 60],
      ],
      80,
      40,
      ZOOM,
    );
    expect(highLatitude).toHaveLength(equator.length);
  });

  it('doubles the number of dashes for the same geographic length when zoom goes up by 1', () => {
    const line: Coordinate[] = [
      [0, 0],
      [pxToLng(480), 0],
    ];
    expect(splitIntoDashes(line, 80, 40, ZOOM + 1).length).toBeGreaterThan(
      splitIntoDashes(line, 80, 40, ZOOM).length,
    );
  });
});

describe('degenerate cases for short paths', () => {
  it('turns a path shorter than one period into a single solid line (ends mid-dash)', () => {
    const line: Coordinate[] = [
      [0, 0],
      [pxToLng(50), 0],
    ];
    const segments = splitIntoDashes(line, 80, 40, ZOOM);

    expect(segments).toHaveLength(1);
    expect(lngSpanPx(segments[0].coords[0], segments[0].coords[1])).toBeCloseTo(50, 6);
  });

  it('always produces a break once the path exceeds one dash', () => {
    // Reproduction conditions from the field: a 300px bar with an effective width of 15px
    // (60px dash / 30px gap)
    const line: Coordinate[] = [
      [0, 0],
      [pxToLng(300), 0],
    ];
    const segments = splitIntoDashes(line, 60, 30, ZOOM);

    expect(segments.length).toBeGreaterThan(1);
  });

  it('does not split when there is one point or fewer', () => {
    expect(splitIntoDashes([[0, 0]], 80, 40, ZOOM)).toEqual([]);
    expect(splitIntoDashes([], 80, 40, ZOOM)).toEqual([]);
  });
});

describe('polylines', () => {
  it('continues the pattern across intervals', () => {
    // An L shape of 240px + 240px. It is 480px end to end, so the count matches a straight line
    const bent: Coordinate[] = [
      [0, 0],
      [pxToLng(240), 0],
      [pxToLng(240), pxToLat(240, 0)],
    ];
    const straight: Coordinate[] = [
      [0, 0],
      [pxToLng(480), 0],
    ];

    expect(splitIntoDashes(bent, 80, 40, ZOOM)).toHaveLength(
      splitIntoDashes(straight, 80, 40, ZOOM).length,
    );
  });
});
