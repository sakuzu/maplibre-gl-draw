// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The comparison of two sets of pictures: a scene given a bound fails only past it, and a scene
 * given none fails at one pixel that differs
 */

import { describe, expect, it } from 'vitest';
import { compareSets, difference, type Picture, shareOver } from './compare-pictures.js';

/** A picture of `n` pixels, each drawn (alpha 255) unless `blank` */
function picture(n: number, blank = false): Picture {
  const pixels = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) pixels.set([10, 20, 30, blank ? 0 : 255], i * 4);
  return { width: n, height: 1, pixels };
}

/** The picture with the red of the first `count` pixels raised by `by` */
function changed(base: Picture, count: number, by: number): Picture {
  const pixels = base.pixels.slice();
  for (let i = 0; i < count; i++) pixels[i * 4] += by;
  return { ...base, pixels };
}

describe('the comparison of the pictures of a scene', () => {
  const before = picture(1_000);

  it('fails a scene given no bound at one pixel that differs', () => {
    const [c] = compareSets(new Map([['s', before]]), new Map([['s', changed(before, 1, 1)]]));
    expect(c.failed).toBe(true);
    const [same] = compareSets(new Map([['s', before]]), new Map([['s', picture(1_000)]]));
    expect(same.failed).toBe(false);
  });

  it('passes a scene within its bound, and fails it past the bound', () => {
    const bounds = new Map([['s', { levels: 8, share: 0.01 }]]);
    // 10 of 1,000 pixels by more than 8 levels: 1%, within it
    const within = compareSets(
      new Map([['s', before]]),
      new Map([['s', changed(before, 10, 9)]]),
      new Set(),
      bounds,
    );
    expect(within[0].failed).toBe(false);
    // Every pixel by 8 levels: none counts
    const small = compareSets(
      new Map([['s', before]]),
      new Map([['s', changed(before, 1_000, 8)]]),
      new Set(),
      bounds,
    );
    expect(small[0].failed).toBe(false);
    // 11 of 1,000 by more than 8 levels: past it
    const past = compareSets(
      new Map([['s', before]]),
      new Map([['s', changed(before, 11, 9)]]),
      new Set(),
      bounds,
    );
    expect(past[0].failed).toBe(true);
  });

  it('measures the share among the pixels drawn in either picture', () => {
    const half = picture(1_000);
    half.pixels.fill(0, 2_000);
    const d = difference(half, changed(half, 5, 3));
    expect(d.drawn).toBe(500);
    expect(shareOver(d, 2)).toBeCloseTo(0.01);
    expect(shareOver(d, 8)).toBe(0);
    expect(d.largest).toBe(3);
    // A pixel drawn in one picture only is drawn
    expect(difference(picture(10, true), picture(10)).drawn).toBe(10);
  });

  it('fails a scene given a bound whose picture is missing', () => {
    const [c] = compareSets(
      new Map([['s', before]]),
      new Map(),
      new Set(),
      new Map([['s', { levels: 2, share: 0.5 }]]),
    );
    expect(c.failed).toBe(true);
  });
});
