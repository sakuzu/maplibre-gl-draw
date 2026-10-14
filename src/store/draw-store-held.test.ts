// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows the Store of core holds for the selection are read again only when what they are
 * read from may have changed: the writes of a drag of many features selected (one notification
 * per feature) do not read the selection again, so a frame of the drag is not quadratic in the
 * number of features selected. What is held still follows the selection, the deletions and what
 * is in a group or a layer selected.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureTables } from '../api/tables.js';
import { internalsOf } from '../test-utils.js';
import { DrawStore, RELEASE_DELAY_MS } from './draw-store.js';
import { TableContractStore } from './table-memory.js';
import type { Feature, Group, Layer } from './types.js';

function square(id: string, x: number, extra: Partial<Feature> = {}): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, 0],
          [x + 1, 0],
          [x + 1, 1],
          [x, 1],
          [x, 0],
        ],
      ],
    },
    layerId: 'l',
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
    ...extra,
  };
}

const LAYER = {
  id: 'l',
  name: 'l',
  visible: true,
  locked: false,
  opacity: 1,
  kind: 'table',
  styleRule: undefined,
  metadata: undefined,
} as Layer;

function setup(count: number) {
  const contract = new TableContractStore();
  const store = new DrawStore(contract);
  store.createLayer(LAYER);
  store.transact(() => {
    for (let i = 0; i < count; i++) store.createFeature(square(`f${i}`, i * 2));
  });
  return { contract, store, tables: store.tables as FeatureTables };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the rows held for the selection', () => {
  it('are not read again by the writes of a drag of the features selected', () => {
    for (const count of [50, 500]) {
      const { contract, store } = setup(count);
      const ids = Array.from({ length: count }, (_, i) => `f${i}`);
      store.setSelection('feature', ids);
      const selection = vi.spyOn(contract, 'getSelection');
      const editing = vi.spyOn(contract, 'getEditingIds');
      let writes = 0;
      for (let frame = 1; frame <= 3; frame++) {
        for (const [i, id] of ids.entries()) {
          store.updateFeature(
            id,
            { geometry: square(id, i * 2 + frame * 0.1).geometry },
            {
              isIntermediate: true,
            },
          );
          writes++;
        }
      }
      expect(writes).toBe(count * 3);
      // Neither the selection (a copy of its ids) nor the editing is read for a write
      expect(selection).not.toHaveBeenCalled();
      expect(editing).not.toHaveBeenCalled();
      selection.mockRestore();
      editing.mockRestore();
    }
  });

  it('follow the selection, a deletion and a write of the vertices selected', () => {
    vi.useFakeTimers();
    const { store, tables } = setup(5);
    store.setSelection('feature', ['f0', 'f1']);
    expect(internalsOf(tables).heldFeature('f1')).toBeDefined();
    store.deleteFeature('f1');
    expect(store.getSelection().ids).toEqual(['f0']);
    store.setSelection('feature', ['f2']);
    vi.advanceTimersByTime(RELEASE_DELAY_MS * 2);
    expect(internalsOf(tables).heldFeature('f0')).toBeUndefined();
    expect(internalsOf(tables).heldFeature('f2')).toBeDefined();
    store.setSelectedVertices({ featureId: 'f3', vertices: [] } as never);
    expect(internalsOf(tables).heldFeature('f3')).toBeDefined();
  });

  it('follow what is in a group or a layer selected', () => {
    vi.useFakeTimers();
    const { store, tables } = setup(4);
    store.createGroup({
      id: 'g',
      layerId: 'l',
      name: 'g',
      visible: true,
      locked: false,
      kind: 'table',
    } as Group);
    store.updateFeature('f0', { groupId: 'g' });
    store.updateFeature('f1', { groupId: 'g' });
    store.setSelection('group', ['g']);
    expect(internalsOf(tables).heldFeature('f0')).toBeDefined();
    expect(internalsOf(tables).heldFeature('f2')).toBeUndefined();
    // A row put in the group is held, one taken out is let go of
    store.updateFeature('f2', { groupId: 'g' });
    expect(internalsOf(tables).heldFeature('f2')).toBeDefined();
    store.updateFeature('f0', { groupId: undefined });
    vi.advanceTimersByTime(RELEASE_DELAY_MS * 2);
    expect(internalsOf(tables).heldFeature('f0')).toBeUndefined();
    // A layer selected: a row created in it is held
    store.setSelection('layer', ['l']);
    store.createFeature(square('new', 20));
    expect(internalsOf(tables).heldFeature('new')).toBeDefined();
  });
});
