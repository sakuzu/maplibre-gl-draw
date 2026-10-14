// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The legend of a layer held as rows: the shape of its swatches read from the types of its first
// features (a Store of rows lists its features up to a limit only)

import type { Feature, FeatureListOptions, FeatureType, Layer } from '@sakuzu/maplibre-gl-draw';
import { describe, expect, it, vi } from 'vitest';
import { type LegendSource, legendBlocks } from '../src/layers/legend.js';
import { resolveMessages } from '../src/messages.js';

const en = resolveMessages('en');

/** A layer held as rows with a rule, its features of these types */
function tableSource(types: FeatureType[]): LegendSource & { list: ReturnType<typeof vi.fn> } {
  const layer: Layer = {
    id: 'rows',
    name: 'Rows',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: { kind: 'single', color: '#123456' },
    metadata: undefined,
  };
  const features = types.map(
    (type, i) => ({ id: `f${i}`, type, layerId: 'rows' }) as unknown as Feature,
  );
  const list = vi.fn((filter: { layerId: string }, options: FeatureListOptions) => {
    if (options?.limit === undefined) throw new Error('A Store of rows lists up to a limit');
    return filter.layerId === 'rows' ? features.slice(0, options.limit) : [];
  });
  return {
    layers: { get: (id) => (id === 'rows' ? layer : undefined), getOrder: () => ['rows'] },
    features: { list },
    list,
  };
}

describe('the legend of a layer held as rows', () => {
  it('reads the shape of its swatches from the types of its first features', () => {
    const shape = (types: FeatureType[]) => legendBlocks(tableSource(types), en)[0].shape;
    expect(shape(['Polygon', 'Polygon', 'Circle'])).toBe('area');
    expect(shape(['Point', 'Point', 'Point'])).toBe('dot');
    expect(shape(['LineString', 'Image', 'LineString'])).toBe('line');
    expect(shape(['Point', 'Polygon', 'Point'])).toBe('box');
    expect(shape([])).toBe('box');
    expect(legendBlocks(tableSource(['Point']), en)[0].entries).toEqual([
      { label: 'All', color: '#123456' },
    ]);
  });

  it('reads a thousand features at most', () => {
    const source = tableSource(['Point']);
    legendBlocks(source, en);
    expect(source.list).toHaveBeenCalledWith({ layerId: 'rows' }, { limit: 1000 });
  });
});
