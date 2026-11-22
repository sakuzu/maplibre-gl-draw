// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { createIdSet } from '../../api/model.js';
import { getSelectedFeatureIds, type SelectionDocument } from './helper.js';

// getSelectedFeatureIds uses only getSelection / getGroup / getLayer / getFeature and the reads of
// the features of a group and of a layer, so it is verified with a minimal stub that has those.
function makeStore(opts: {
  selection: { type: 'feature' | 'group' | 'layer' | null; ids: string[] };
  groups?: Record<string, { featureIds: string[] }>;
  layers?: Record<string, { items: string[] }>;
  features?: string[];
}): SelectionDocument {
  const membersOf = (id: string) => opts.groups?.[id]?.featureIds ?? [];
  return {
    getSelection: () => ({ type: opts.selection.type, ids: createIdSet(opts.selection.ids) }),
    getGroup: (id: string) => (opts.groups?.[id] ? { id } : undefined),
    getLayer: (id: string) => (opts.layers?.[id] ? { id } : undefined),
    getFeature: (id: string) => (opts.features?.includes(id) ? { id } : undefined),
    countGroupFeatures: (id: string) => membersOf(id).length,
    listGroupFeatureIds: (id: string, start: number, end: number) =>
      membersOf(id).slice(start, end),
    iterateFeatures: ({ layerId }: { layerId: string }) =>
      (opts.layers?.[layerId]?.items ?? [])
        .flatMap((id) => (opts.groups?.[id] ? membersOf(id) : [id]))
        .map((id) => ({ id }))
        [Symbol.iterator](),
  } as unknown as SelectionDocument;
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
      layers: { L1: { items: ['f1', 'g1'] } }, // f1=feature, g1=group
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
