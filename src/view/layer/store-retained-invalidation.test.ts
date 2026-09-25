// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the detection of the inputs that discard every retained chunk
 */

import { describe, expect, it } from 'vitest';
import type { FeatureCompanionRegistry } from '../feature-companion.js';
import type { TerrainContext } from '../terrain/context.js';
import { RetainedInvalidationWatch } from './store-retained-invalidation.js';

function companionsAt(generation: number): FeatureCompanionRegistry {
  return { generation: () => generation } as unknown as FeatureCompanionRegistry;
}

function terrainAt(
  generation: number,
  elevationGeneration: number,
  globeGeneration = 0,
): TerrainContext {
  return {
    renderState: { generation },
    elevationGeneration,
    globeGeneration,
  } as unknown as TerrainContext;
}

describe('RetainedInvalidationWatch', () => {
  it('only records the hidden set on the first call', () => {
    const watch = new RetainedInvalidationWatch();
    expect(watch.locallyHiddenChanged(new Set(['a']))).toBe(false);
    expect(watch.locallyHiddenChanged(new Set(['a']))).toBe(false);
  });

  it('detects a hidden set changed in place, with the same size or not', () => {
    const watch = new RetainedInvalidationWatch();
    const hidden = new Set(['a']);
    watch.locallyHiddenChanged(hidden);

    hidden.delete('a');
    hidden.add('b');
    expect(watch.locallyHiddenChanged(hidden)).toBe(true);
    expect(watch.locallyHiddenChanged(hidden)).toBe(false);

    hidden.add('c');
    expect(watch.locallyHiddenChanged(hidden)).toBe(true);
  });

  it('records the hidden set again after a reset', () => {
    const watch = new RetainedInvalidationWatch();
    watch.locallyHiddenChanged(new Set(['a']));
    watch.resetLocallyHidden();
    expect(watch.locallyHiddenChanged(new Set(['b']))).toBe(false);
  });

  it('reports a companion generation change except on the first call', () => {
    const watch = new RetainedInvalidationWatch();
    expect(watch.companionsChanged(companionsAt(3))).toBe(false);
    expect(watch.companionsChanged(companionsAt(3))).toBe(false);
    expect(watch.companionsChanged(companionsAt(4))).toBe(true);
  });

  it('reports a change of either terrain generation', () => {
    const watch = new RetainedInvalidationWatch();
    expect(watch.terrainChanged(terrainAt(0, 0))).toBe(false);
    expect(watch.terrainChanged(terrainAt(1, 0))).toBe(true);
    expect(watch.terrainChanged(terrainAt(1, 1))).toBe(true);
    expect(watch.terrainChanged(terrainAt(1, 1))).toBe(false);
  });

  it('reports a change of the cells of the globe', () => {
    const watch = new RetainedInvalidationWatch();
    expect(watch.terrainChanged(terrainAt(0, 0, 0))).toBe(false);
    expect(watch.terrainChanged(terrainAt(0, 0, 1))).toBe(true);
    expect(watch.terrainChanged(terrainAt(0, 0, 1))).toBe(false);
  });
});
