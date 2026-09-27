// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the members about the drawing: getLayerStack, hasPendingWork and debug.terrain
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapStub } from '../../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';

let draw: Draw;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

describe('getLayerStack', () => {
  it('gives one frozen entry per run of layers', () => {
    draw = createDraw(createMapStub().map);
    const stack = draw.getLayerStack();
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({ from: 0, to: 1 });
    expect(typeof stack[0].layerId).toBe('string');
    expect(Object.isFrozen(stack)).toBe(true);
    expect(Object.isFrozen(stack[0])).toBe(true);
  });

  it('asks the function of the entries from outside the document', () => {
    draw = createDraw(createMapStub().map, { isExternalEntry: (id) => id.startsWith('base:') });
    expect(draw.getLayerStack()).toHaveLength(1);
  });
});

describe('hasPendingWork and debug.terrain', () => {
  it('has no pending work and reports the terrain as inactive before anything is drawn', () => {
    draw = createDraw(createMapStub().map);
    expect(draw.hasPendingWork()).toBe(false);
    const terrain = draw.debug.terrain();
    expect(terrain.render.active).toBe(false);
    expect(terrain.render.atlasRect).toHaveLength(4);
    expect(terrain.render.atlasSize).toHaveLength(2);
    expect(terrain.drape).toMatchObject({ used: false, reason: 'not-evaluated', featureCount: 0 });
    expect(Object.isFrozen(terrain)).toBe(true);
  });
});
