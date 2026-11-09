// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the origin of a retained batch
 *
 * The shader arithmetic is reproduced with Math.fround: the CPU bakes `fround(vertex - origin)`,
 * the uniform is `fround(origin - center)` (both Float32 values), and the GPU adds the two in
 * Float32. The error is measured against the exact offset from the center, in CSS px.
 */

import { describe, expect, it } from 'vitest';
import type { BBox } from '../../geometry/types.js';
import { seededRandom } from '../../test-utils.js';
import {
  boundsCenter,
  RETAINED_ORIGIN_TOLERANCE_PX,
  rebasedOriginOf,
  rebasedRetainedOrigin,
  retainedOriginErrorPx,
} from './retained-origin.js';

/** CSS px per degree of longitude at a zoom */
function pxPerDegree(zoom: number): number {
  return (512 * 2 ** zoom) / 360;
}

/**
 * The screen error (CSS px) of one vertex drawn from a retained batch, as the GPU computes it
 */
function simulatedErrorPx(
  vertex: [number, number],
  origin: [number, number],
  center: [number, number],
  zoom: number,
): number {
  const o: [number, number] = [Math.fround(origin[0]), Math.fround(origin[1])];
  const c: [number, number] = [Math.fround(center[0]), Math.fround(center[1])];
  const cos = Math.cos((vertex[1] * Math.PI) / 180);
  let worst = 0;
  for (const axis of [0, 1]) {
    const baked = Math.fround(vertex[axis] - o[axis]);
    const shift = Math.fround(o[axis] - c[axis]);
    const onGpu = Math.fround(baked + shift);
    const exact = vertex[axis] - c[axis];
    const scale = axis === 1 ? 1 / cos : 1;
    worst = Math.max(worst, Math.abs(onGpu - exact) * scale * pxPerDegree(zoom));
  }
  return worst;
}

/** The worst simulated error over a grid of vertices in a region */
function worstInRegion(origin: [number, number], region: BBox, zoom: number): number {
  let worst = 0;
  const center: [number, number] = [(region[0] + region[2]) / 2, (region[1] + region[3]) / 2];
  for (let i = 0; i <= 20; i++) {
    for (let j = 0; j <= 20; j++) {
      const vertex: [number, number] = [
        region[0] + ((region[2] - region[0]) * i) / 20,
        region[1] + ((region[3] - region[1]) * j) / 20,
      ];
      worst = Math.max(worst, simulatedErrorPx(vertex, origin, center, zoom));
    }
  }
  return worst;
}

const TOKYO: [number, number] = [139.7671, 35.6812];
/** About 1000 px around Osaka at zoom 22 */
const OSAKA_VIEW: BBox = [135.4959, 34.7024, 135.4961, 34.7026];
const TOKYO_OSAKA: BBox = [135.4959, 34.7024, 139.7671, 35.6812];
/** The center of the view on Osaka */
const OSAKA_VIEW_CENTER: [number, number] = [135.496, 34.7025];

describe('the precision of a retained batch', () => {
  it('an origin in Tokyo leaves more than 0.1 px in Osaka at zoom 22 (the defect)', () => {
    expect(worstInRegion(TOKYO, OSAKA_VIEW, 22)).toBeGreaterThan(RETAINED_ORIGIN_TOLERANCE_PX);
  });

  it('the error bound is never below the simulated error', () => {
    const cases: Array<[[number, number], BBox, number]> = [
      [TOKYO, OSAKA_VIEW, 22],
      [TOKYO, OSAKA_VIEW, 18],
      [[135.49, 34.7], OSAKA_VIEW, 22],
      [[0, 0], [10, 60, 10.001, 60.001], 20],
    ];
    for (const [origin, region, zoom] of cases) {
      expect(retainedOriginErrorPx(origin, region, zoom)).toBeGreaterThanOrEqual(
        worstInRegion(origin, region, zoom),
      );
    }
  });

  it('the origin chosen for the view keeps the error within 0.1 px at zoom 22', () => {
    const origin = rebasedRetainedOrigin(TOKYO, TOKYO_OSAKA, OSAKA_VIEW, 22);
    expect(origin).not.toBeNull();
    expect(worstInRegion(origin as [number, number], OSAKA_VIEW, 22)).toBeLessThanOrEqual(
      RETAINED_ORIGIN_TOLERANCE_PX,
    );
  });

  it('keeps the origin when the error is already within the tolerance', () => {
    expect(rebasedRetainedOrigin(TOKYO, TOKYO_OSAKA, OSAKA_VIEW, 14)).toBeNull();
    expect(rebasedRetainedOrigin([135.496, 34.7025], TOKYO_OSAKA, OSAKA_VIEW, 22)).toBeNull();
  });

  it('keeps the origin when no origin can do much better (the region is large on screen)', () => {
    // The whole extent in view: its center is already the best origin
    const center: [number, number] = [137.6315, 35.1918];
    expect(rebasedRetainedOrigin(center, TOKYO_OSAKA, null, 22)).toBeNull();
  });

  it('is taken near where the view sees the rows of the batch moved on the GPU from', () => {
    // Rows of Tokyo dragged to Osaka: the view on Osaka sees them from Tokyo
    const tokyoView: BBox = [TOKYO[0] - 0.0001, TOKYO[1] - 0.0001, TOKYO[0], TOKYO[1]];
    const origin = rebasedRetainedOrigin(OSAKA_VIEW_CENTER, TOKYO_OSAKA, OSAKA_VIEW, 22, [
      tokyoView,
    ]);
    expect(origin).not.toBeNull();
    expect(worstInRegion(origin as [number, number], tokyoView, 22)).toBeLessThanOrEqual(
      RETAINED_ORIGIN_TOLERANCE_PX,
    );
    // Without the rows moved, the origin stays in Osaka
    expect(rebasedRetainedOrigin(OSAKA_VIEW_CENTER, TOKYO_OSAKA, OSAKA_VIEW, 22)).toBeNull();
    // A region off the extent is not on the screen: the view is
    const away: BBox = [0, 0, 1, 1];
    expect(
      rebasedRetainedOrigin(OSAKA_VIEW_CENTER, TOKYO_OSAKA, OSAKA_VIEW, 22, [away]),
    ).toBeNull();
  });

  it('keeps the origin when the extent is not in view', () => {
    const away: BBox = [0, 0, 1, 1];
    expect(rebasedRetainedOrigin(TOKYO, TOKYO_OSAKA, away, 22)).toBeNull();
    expect(rebasedRetainedOrigin(TOKYO, null, OSAKA_VIEW, 22)).toBeNull();
  });
});

describe('the origin chosen for the view, from an extent given as numbers', () => {
  /** The choice as it is described: the extent clipped to the view, as a box */
  function reference(
    origin: [number, number],
    extent: BBox,
    view: BBox | null,
    zoom: number,
  ): [number, number] | null {
    const region: BBox = view
      ? [
          Math.max(extent[0], view[0]),
          Math.max(extent[1], view[1]),
          Math.min(extent[2], view[2]),
          Math.min(extent[3], view[3]),
        ]
      : extent;
    if (!(region[0] <= region[2] && region[1] <= region[3])) return null;
    const error = retainedOriginErrorPx(origin, region, zoom);
    if (!(error > RETAINED_ORIGIN_TOLERANCE_PX)) return null;
    const candidate = boundsCenter(region);
    return retainedOriginErrorPx(candidate, region, zoom) < error / 2 ? candidate : null;
  }

  it('is the choice of the boxes, for extents, views and zooms at random', () => {
    const random = seededRandom(11);
    const box = (): BBox => {
      const x = random() * 340 - 170;
      const y = random() * 160 - 80;
      const w = random() ** 3 * 20;
      const h = random() ** 3 * 10;
      return [x, y, x + w, y + h];
    };
    let rebased = 0;
    for (let i = 0; i < 2000; i++) {
      const extent = box();
      const pick = random();
      // No view, a view at random, the extent itself, or a small view inside the extent
      const x = extent[0] + (extent[2] - extent[0]) * random();
      const y = extent[1] + (extent[3] - extent[1]) * random();
      const inside: BBox = [x, y, x + 0.001, y + 0.001];
      const view = pick < 0.1 ? null : pick < 0.3 ? box() : pick < 0.4 ? extent : inside;
      const origin: [number, number] = [extent[0], extent[1]];
      const zoom = 10 + random() * 14;
      const expected = reference(origin, extent, view, zoom);
      if (expected) rebased++;
      const args: BBox = [extent[0], extent[1], extent[2], extent[3]] as const;
      expect(rebasedOriginOf(origin, ...args, view, zoom)).toEqual(expected);
      expect(rebasedRetainedOrigin(origin, extent, view, zoom)).toEqual(expected);
    }
    // Both outcomes are exercised
    expect(rebased).toBeGreaterThan(0);
    expect(rebased).toBeLessThan(2000);
  });
});
