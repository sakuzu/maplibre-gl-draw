// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the resolution of the style of a point marker
 */

import { describe, expect, it } from 'vitest';
import { toPointInstanceData } from '../batch-manager.js';
import type { PointStyle } from './point-shape.js';
import { resolvePointStyle } from './point-style.js';

const DEFAULTS: PointStyle = {
  shape: 'circle',
  size: 12,
  fillColor: [1, 0.4, 0.2, 1],
  fillOpacity: 1,
  strokeColor: [1, 1, 1, 1],
  strokeWidth: 2,
  strokeOpacity: 0.8,
};

describe('resolvePointStyle', () => {
  it('keeps the opacities of the default without a pointOpacity', () => {
    const style = resolvePointStyle({ pointColor: '#000000' }, DEFAULTS);

    expect(style.fillOpacity).toBe(1);
    expect(style.strokeOpacity).toBe(0.8);
  });

  it('multiplies pointOpacity into the fill and the outline of the marker', () => {
    const style = resolvePointStyle({ pointOpacity: 0.5 }, DEFAULTS);

    expect(style.fillOpacity).toBe(0.5);
    expect(style.strokeOpacity).toBeCloseTo(0.4);
    // The marker reaches the GPU with the opacity folded into the alpha
    const instance = toPointInstanceData([0, 0], style);
    expect(instance.fillColor[3]).toBe(0.5);
    expect(instance.strokeColor[3]).toBeCloseTo(0.4);
    expect(instance.strokeWidth).toBe(2);
  });

  it('draws nothing of the marker at pointOpacity 0', () => {
    const instance = toPointInstanceData([0, 0], resolvePointStyle({ pointOpacity: 0 }, DEFAULTS));

    expect(instance.fillColor[3]).toBe(0);
    expect(instance.strokeWidth).toBe(0);
  });

  it('ignores a pointOpacity outside 0 to 1', () => {
    expect(resolvePointStyle({ pointOpacity: 2 }, DEFAULTS).fillOpacity).toBe(1);
    expect(resolvePointStyle({ pointOpacity: -1 }, DEFAULTS).fillOpacity).toBe(1);
    expect(resolvePointStyle({ pointOpacity: Number.NaN }, DEFAULTS).fillOpacity).toBe(1);
  });
});
