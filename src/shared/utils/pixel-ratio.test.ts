// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the resolution of the rendering pixel ratio
 *
 * When there is no injection it reads `window.devicePixelRatio` on every call (it does not
 * fix the value at startup). When there is an injection it does not look at window.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPixelRatioSource,
  resolveContentPixelRatio,
  resolvePixelRatio,
} from './pixel-ratio.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolvePixelRatio', () => {
  it('returns the injected value when there is one', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    expect(resolvePixelRatio(3.125)).toBe(3.125);
  });

  it('returns window.devicePixelRatio when there is no injection', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    expect(resolvePixelRatio()).toBe(2);
    expect(resolvePixelRatio(undefined)).toBe(2);
  });

  it('re-reads on every call when there is no injection', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    expect(resolvePixelRatio()).toBe(1);

    // This corresponds to moving it to a different display
    vi.stubGlobal('window', { devicePixelRatio: 3 });
    expect(resolvePixelRatio()).toBe(3);
  });

  it('stays at the fixed value even when window changes, given an injection', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    expect(resolvePixelRatio(3.125)).toBe(3.125);

    vi.stubGlobal('window', { devicePixelRatio: 3 });
    expect(resolvePixelRatio(3.125)).toBe(3.125);
  });

  it('returns 1 in an environment without window', () => {
    vi.stubGlobal('window', undefined);
    expect(resolvePixelRatio()).toBe(1);
  });

  it('rounds to 1 when devicePixelRatio is 0 or missing', () => {
    vi.stubGlobal('window', { devicePixelRatio: 0 });
    expect(resolvePixelRatio()).toBe(1);

    vi.stubGlobal('window', {});
    expect(resolvePixelRatio()).toBe(1);
  });

  it('ignores an injection at most 0 or not a number and reads from window', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    expect(resolvePixelRatio(0)).toBe(2);
    expect(resolvePixelRatio(-1)).toBe(2);
    expect(resolvePixelRatio(Number.NaN)).toBe(2);
    expect(resolvePixelRatio(Number.POSITIVE_INFINITY)).toBe(2);
  });
});

describe('injection with a function', () => {
  it('evaluates it on every call', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    let value = 3;
    const source = () => value;
    expect(resolvePixelRatio(source)).toBe(3);
    value = 1.5;
    expect(resolvePixelRatio(source)).toBe(1.5);
  });

  it('reads from window when the function returns at most 0 or not a number', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    expect(resolvePixelRatio(() => 0)).toBe(2);
    expect(resolvePixelRatio(() => Number.NaN)).toBe(2);
  });
});

describe('createPixelRatioSource', () => {
  it('the default factor is 1, and it reads window when there is no injection', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const source = createPixelRatioSource();
    expect(source.getRenderScale()).toBe(1);
    expect(source.resolve()).toBe(2);
  });

  it('returns the value multiplied by the factor (both with and without an injection)', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const injected = createPixelRatioSource(3.125);
    expect(injected.setRenderScale(0.5)).toBe(true);
    expect(injected.resolve()).toBe(3.125 * 0.5);

    const fromWindow = createPixelRatioSource();
    fromWindow.setRenderScale(0.25);
    expect(fromWindow.resolve()).toBe(0.5);
  });

  it('reads the fallback (the map) instead of window when nothing is injected', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    let mapRatio = 1.5;
    const source = createPixelRatioSource(undefined, () => mapRatio);
    expect(source.resolve()).toBe(1.5);
    mapRatio = 3;
    expect(source.resolve()).toBe(3);
    // An injected value wins over the map
    expect(createPixelRatioSource(1.25, () => mapRatio).resolve()).toBe(1.25);
  });

  it('returns true only when the factor changed', () => {
    const source = createPixelRatioSource(2);
    expect(source.setRenderScale(0.5)).toBe(true);
    expect(source.setRenderScale(0.5)).toBe(false);
    expect(source.setRenderScale(1)).toBe(true);
  });

  it('ignores a factor at most 0 or not a number', () => {
    const source = createPixelRatioSource(2);
    source.setRenderScale(0.5);
    expect(source.setRenderScale(0)).toBe(false);
    expect(source.setRenderScale(-1)).toBe(false);
    expect(source.setRenderScale(Number.NaN)).toBe(false);
    expect(source.setRenderScale(Number.POSITIVE_INFINITY)).toBe(false);
    expect(source.getRenderScale()).toBe(0.5);
  });

  it('a provider can be resolved as the injected value as is', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const source = createPixelRatioSource(3.125);
    expect(resolvePixelRatio(source)).toBe(3.125);
    source.setRenderScale(0.5);
    expect(resolvePixelRatio(source)).toBe(3.125 * 0.5);
  });
});

describe('resolveContentPixelRatio (for dimensions that scale with the zoom)', () => {
  it('passing a provider returns the ratio without the factor applied', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const source = createPixelRatioSource(3.125);
    expect(resolveContentPixelRatio(source)).toBe(3.125);

    source.setRenderScale(0.2);
    // Dimensions fixed in screen pixels shrink
    expect(resolvePixelRatio(source)).toBeCloseTo(0.625, 10);
    // Dimensions that scale with the zoom do not shrink (they have already shrunk through
    // the camera pulling back)
    expect(resolveContentPixelRatio(source)).toBeCloseTo(3.125, 10);
  });

  it('it matches resolvePixelRatio when the factor is 1', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const source = createPixelRatioSource();
    expect(resolveContentPixelRatio(source)).toBe(resolvePixelRatio(source));
  });

  it('the factor is not applied on the enlarging side either', () => {
    const source = createPixelRatioSource(2);
    source.setRenderScale(1.27);
    expect(resolvePixelRatio(source)).toBeCloseTo(2.54, 10);
    expect(resolveContentPixelRatio(source)).toBeCloseTo(2, 10);
  });

  it('a non-provider injection matches resolvePixelRatio', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    expect(resolveContentPixelRatio(3.125)).toBe(3.125);
    expect(resolveContentPixelRatio(() => 1.5)).toBe(1.5);
    expect(resolveContentPixelRatio()).toBe(2);
  });
});
