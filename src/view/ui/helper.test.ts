// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import type { Store } from '../../store/store.js';
import { getSelectedFeatureIds } from './helper.js';

// getSelectedFeatureIds uses only getSelection / getGroup / getLayer / getFeature, so it is
// verified with a minimal stub that has those.
function makeStore(opts: {
  selection: { type: 'feature' | 'group' | 'layer' | null; ids: string[] };
  groups?: Record<string, { featureIds: string[] }>;
  layers?: Record<string, { order: string[] }>;
  features?: string[];
}): Store {
  return {
    getSelection: () => opts.selection,
    getGroup: (id: string) => (opts.groups?.[id] ? { id, ...opts.groups[id] } : undefined),
    getLayer: (id: string) => (opts.layers?.[id] ? { id, ...opts.layers[id] } : undefined),
    getFeature: (id: string) => (opts.features?.includes(id) ? { id } : undefined),
  } as unknown as Store;
}

describe('getSelectedFeatureIds', () => {
  it('returns a feature selection as is', () => {
    const store = makeStore({ selection: { type: 'feature', ids: ['f1', 'f2'] } });
    expect(getSelectedFeatureIds(store)).toEqual(['f1', 'f2']);
  });

  it('resolves a group selection into the member featureIds', () => {
    const store = makeStore({
      selection: { type: 'group', ids: ['g1'] },
      groups: { g1: { featureIds: ['f1', 'f2'] } },
    });
    expect(getSelectedFeatureIds(store)).toEqual(['f1', 'f2']);
  });

  it('resolves a layer selection into the features in order + the group members', () => {
    const store = makeStore({
      selection: { type: 'layer', ids: ['L1'] },
      layers: { L1: { order: ['f1', 'g1'] } }, // f1=feature, g1=group
      groups: { g1: { featureIds: ['f2', 'f3'] } },
      features: ['f1', 'f2', 'f3'],
    });
    expect(getSelectedFeatureIds(store)).toEqual(['f1', 'f2', 'f3']);
  });

  it('returns empty for a nonexistent group and for no selection', () => {
    expect(getSelectedFeatureIds(makeStore({ selection: { type: 'group', ids: ['x'] } }))).toEqual(
      [],
    );
    expect(getSelectedFeatureIds(makeStore({ selection: { type: null, ids: [] } }))).toEqual([]);
  });
});
