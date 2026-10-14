// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The legend of a layer held as rows: the shape of its swatches read from the types of its rows,
// without listing its features (a Store of rows lists none)

import type { FeatureType, Layer } from '@sakuzu/maplibre-gl-draw';
import type { FeatureTables } from '@sakuzu/maplibre-gl-draw/kasane';
import { describe, expect, it } from 'vitest';
import { type LegendSource, legendBlocks } from '../src/layers/legend.js';
import { resolveMessages } from '../src/messages.js';

const en = resolveMessages('en');

/** A layer held as rows with a rule, its rows of these types */
function tableSource(types: Array<FeatureType | null>): LegendSource {
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
  const tables = {
    // Two batches, as a scan reads them
    scan: () => {
      const batches = [
        Int32Array.from(types.slice(0, 2).map((_, i) => i)),
        Int32Array.from(types.slice(2).map((_, i) => i + 2)),
      ];
      return { next: () => batches.shift() ?? null };
    },
    get: (layerId: string) =>
      layerId === 'rows' ? { getRowType: (handle: number) => types[handle] } : undefined,
  } as unknown as FeatureTables;
  return {
    layers: { get: (id) => (id === 'rows' ? layer : undefined), getOrder: () => ['rows'] },
    features: {
      list: () => {
        throw new Error('A Store of rows lists no feature');
      },
    },
    getStore: () => ({ tables }),
  };
}

describe('the legend of a layer held as rows', () => {
  it('reads the shape of its swatches from the types of its rows', () => {
    const shape = (types: Array<FeatureType | null>) =>
      legendBlocks(tableSource(types), en)[0].shape;
    expect(shape(['Polygon', 'Polygon', 'Circle'])).toBe('area');
    expect(shape(['Point', 'Point', 'Point'])).toBe('dot');
    expect(shape(['LineString', null, 'LineString'])).toBe('line');
    expect(shape(['Point', 'Polygon', 'Point'])).toBe('box');
    expect(shape([])).toBe('box');
    expect(legendBlocks(tableSource(['Point']), en)[0].entries).toEqual([
      { label: 'All', color: '#123456' },
    ]);
  });

  it('shows a box when the tables do not hold the layer', () => {
    const source = { ...tableSource(['Point']), getStore: () => ({}) };
    expect(legendBlocks(source, en)[0].shape).toBe('box');
  });
});
