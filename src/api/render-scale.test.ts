// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the render scale API (draw.getRenderScale / setRenderScale / getPixelRatio)
 *
 * The factor rewrites the source in the Context (pixelRatioSource) and is multiplied onto
 * the resolved ratio. A repaint is requested only when the value has changed (it is not
 * pushed on every frame).
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPixelRatioSource } from '../shared/utils/pixel-ratio.js';
import { createInstanceApi, type InstanceApiDeps } from './instance-api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function createApi(pixelRatio?: number) {
  let repaints = 0;
  const map = {
    triggerRepaint: () => {
      repaints += 1;
    },
  } as unknown as MapLibreMap;
  const pixelRatioSource = createPixelRatioSource(pixelRatio);
  const api = createInstanceApi({
    map,
    pixelRatioSource,
  } as unknown as InstanceApiDeps);
  return { api, pixelRatioSource, repaints: () => repaints };
}

describe('the render scale API of draw', () => {
  it('defaults the factor to 1 and reads window when nothing is injected', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const { api } = createApi();

    expect(api.getRenderScale()).toBe(1);
    expect(api.getPixelRatio()).toBe(2);
  });

  it('multiplies the factor onto the resolved ratio and repaints only when it changes', () => {
    const { api, repaints } = createApi(3.125);

    api.setRenderScale(0.5);
    expect(api.getRenderScale()).toBe(0.5);
    expect(api.getPixelRatio()).toBe(3.125 * 0.5);
    expect(repaints()).toBe(1);

    // Setting the same value again does not request one
    api.setRenderScale(0.5);
    expect(repaints()).toBe(1);

    api.setRenderScale(1);
    expect(api.getPixelRatio()).toBe(3.125);
    expect(repaints()).toBe(2);
  });

  it('ignores values of 0 or less and non-numbers', () => {
    const { api, repaints } = createApi(2);

    api.setRenderScale(0);
    api.setRenderScale(-1);
    api.setRenderScale(Number.NaN);

    expect(api.getRenderScale()).toBe(1);
    expect(repaints()).toBe(0);
  });
});
