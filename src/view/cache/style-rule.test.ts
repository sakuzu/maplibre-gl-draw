// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for StyleRuleCache
 *
 * Rule evaluation cannot be run every frame with features on the order of ten thousand,
 * so it is cached by feature ID. Here the hit and miss statistics are used to observe
 * whether re-evaluation happens, and the triggers for invalidation (feature update, rule
 * change) are verified.
 */

import { describe, expect, it } from 'vitest';
import type { Feature, StyleRule } from '../../store/types.js';
import { StyleRuleCache } from './style-rule.js';

function makeFeature(id: string, properties: Record<string, unknown>): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    },
    layerId: 'layer-1',
    groupId: undefined,
    properties,
    locked: false,
    visible: true,
    style: {},
  };
}

const rule: StyleRule = {
  kind: 'categorical',
  property: 'type',
  map: { a: '#ff0000', b: '#00ff00' },
  other: '#888888',
};

describe('StyleRuleCache', () => {
  it('returns re-evaluations of the same feature from the cache', () => {
    const cache = new StyleRuleCache();
    const feature = makeFeature('f1', { type: 'a' });

    expect(cache.resolve(feature, rule)).toBe('#ff0000');
    expect(cache.resolve(feature, rule)).toBe('#ff0000');
    expect(cache.resolve(feature, rule)).toBe('#ff0000');

    const stats = cache.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(2);
    expect(stats.size).toBe(1);
  });

  it('neither evaluates nor caches when there is no rule', () => {
    const cache = new StyleRuleCache();
    const feature = makeFeature('f1', { type: 'a' });

    expect(cache.resolve(feature, undefined)).toBeNull();

    const stats = cache.getStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  it('makes a separate entry for each feature', () => {
    const cache = new StyleRuleCache();

    expect(cache.resolve(makeFeature('f1', { type: 'a' }), rule)).toBe('#ff0000');
    expect(cache.resolve(makeFeature('f2', { type: 'b' }), rule)).toBe('#00ff00');
    expect(cache.getStats().size).toBe(2);
  });

  it('is invalidated by a feature update (delete)', () => {
    const cache = new StyleRuleCache();

    expect(cache.resolve(makeFeature('f1', { type: 'a' }), rule)).toBe('#ff0000');
    cache.delete('f1');
    // A feature whose properties have changed is evaluated again
    expect(cache.resolve(makeFeature('f1', { type: 'b' }), rule)).toBe('#00ff00');
    expect(cache.getStats().misses).toBe(2);
  });

  it('can invalidate several entries with deleteMany', () => {
    const cache = new StyleRuleCache();
    cache.resolve(makeFeature('f1', { type: 'a' }), rule);
    cache.resolve(makeFeature('f2', { type: 'b' }), rule);

    cache.deleteMany(['f1', 'f2']);
    expect(cache.getStats().size).toBe(0);
  });

  it('is evaluated again when the layer rule changes', () => {
    const cache = new StyleRuleCache();
    const feature = makeFeature('f1', { type: 'a' });

    expect(cache.resolve(feature, rule)).toBe('#ff0000');

    const changed: StyleRule = { ...rule, map: { a: '#0000ff' } };
    expect(cache.resolve(feature, changed)).toBe('#0000ff');
    // The entry made with the old rule is not used
    expect(cache.getStats().hits).toBe(0);
  });

  it('invalidates everything and also resets the statistics with clear', () => {
    const cache = new StyleRuleCache();
    cache.resolve(makeFeature('f1', { type: 'a' }), rule);
    cache.resolve(makeFeature('f1', { type: 'a' }), rule);

    cache.clear();

    expect(cache.getStats()).toEqual({ size: 0, hits: 0, misses: 0, hitRate: 0 });
  });

  it('resetStats resets only the statistics and keeps the entries', () => {
    const cache = new StyleRuleCache();
    const feature = makeFeature('f1', { type: 'a' });
    cache.resolve(feature, rule);

    cache.resetStats();
    expect(cache.getStats().size).toBe(1);

    expect(cache.resolve(feature, rule)).toBe('#ff0000');
    expect(cache.getStats().hits).toBe(1);
  });

  it('returns everything from the cache on the second pass over 10,000 features', () => {
    const cache = new StyleRuleCache();
    const features = Array.from({ length: 10000 }, (_, i) =>
      makeFeature(`f${i}`, { type: i % 2 === 0 ? 'a' : 'b' }),
    );

    for (const feature of features) cache.resolve(feature, rule);
    cache.resetStats();
    for (const feature of features) cache.resolve(feature, rule);

    const stats = cache.getStats();
    expect(stats.misses).toBe(0);
    expect(stats.hits).toBe(10000);
    expect(stats.hitRate).toBe(1);
  });
});
