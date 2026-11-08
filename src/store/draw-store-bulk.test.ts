// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Features selected in bulk: a selection of more features of rows than are opened at once is
 * the set of their rows. It follows the rules of the selection (what is deleted or cannot be seen
 * leaves it), tells its summary, is put back from a summary kept, and gates its operations.
 */

import { describe, expect, it } from 'vitest';
import type { FeatureTables } from '../api/tables.js';
import { STATE_BULK } from '../feature-table/row-state.js';
import { TableSelection } from '../feature-table/selection.js';
import { internalsOf } from '../test-utils.js';
import { DrawStore } from './draw-store.js';
import { bulkSelectionValue, valueOfSelection } from './selection-value.js';
import { TableContractStore } from './table-memory.js';
import type { Feature, Layer, StoreChange } from './types.js';

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

function layer(id: string): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  } as Layer;
}

function setup(count: number, selectionIdsLimit = 3) {
  const contract = new TableContractStore();
  const store = new DrawStore(contract, { selectionIdsLimit });
  store.createLayer(layer('l'));
  store.transact(() => {
    for (let i = 0; i < count; i++) store.createFeature(square(`f${i}`, i * 2));
  });
  const tables = store.tables as FeatureTables;
  const changes: StoreChange[] = [];
  store.subscribe((change) => changes.push(change));
  const ids = Array.from({ length: count }, (_, i) => `f${i}`);
  const handleOf = (id: string) => tables.findRow(id) as number;
  return { contract, store, tables, changes, ids, handleOf };
}

/** Whether the row of an id is marked as selected in bulk */
function marked(tables: FeatureTables, id: string): boolean {
  const internals = internalsOf(tables);
  const place = internals.placeOf(tables.findRow(id) as number);
  return place !== undefined && (place.group.state[place.row] & STATE_BULK) !== 0;
}

describe('features selected in bulk', () => {
  it('are the set of their rows past the limit, not listed', () => {
    const { store, tables, ids } = setup(6);
    store.setSelection('feature', ids.slice(0, 5));
    const selection = store.getSelection();
    expect(selection.type).toBe('feature');
    expect(selection.ids).toEqual([]);
    expect(selection.bulk?.count).toBe(5);
    expect(selection.bulk?.layerIds).toEqual(['l']);
    expect(selection.bulk?.bbox).toEqual([0, 0, 9, 1]);
    expect(store.getSelectedRows()?.count).toBe(5);
    expect(marked(tables, 'f4')).toBe(true);
    expect(marked(tables, 'f5')).toBe(false);
  });

  it('are listed by their IDs up to the limit, the marks taken off', () => {
    const { store, tables, ids } = setup(6);
    store.setSelection('feature', ids.slice(0, 5));
    store.setSelection('feature', ids.slice(0, 2));
    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f0', 'f1'] });
    expect(store.getSelectedRows()).toBeNull();
    expect(marked(tables, 'f0')).toBe(false);
  });

  it('tell the summary now and before in the notification of the selection', () => {
    const { store, changes, ids } = setup(6);
    store.setSelection('feature', ids.slice(0, 4));
    const first = changes[changes.length - 1]?.selection;
    expect(first?.type).toBe('feature');
    expect(first?.bulk?.count).toBe(4);
    expect(first?.previousBulk).toBeUndefined();
    store.setSelection(null, []);
    const second = changes[changes.length - 1]?.selection;
    expect(second?.type).toBeNull();
    expect(second?.bulk).toBeUndefined();
    expect(second?.previousType).toBe('feature');
    expect(second?.previousBulk?.count).toBe(4);
  });

  it('select a layer and a group of many features in bulk, keeping their ids', () => {
    const { store, ids } = setup(6);
    store.setSelection('layer', ['l']);
    expect(store.getSelection()).toMatchObject({ type: 'layer', ids: ['l'] });
    expect(store.getSelection().bulk?.count).toBe(6);
    store.createGroup({
      id: 'g',
      layerId: 'l',
      name: 'g',
      visible: true,
      locked: false,
      featureIds: ids.slice(0, 4),
    } as never);
    store.setSelection('group', ['g']);
    expect(store.getSelection()).toMatchObject({ type: 'group', ids: ['g'] });
    expect(store.getSelection().bulk?.count).toBe(4);
  });

  it('lose what is deleted or hidden, and are opened once few enough', () => {
    const { store, tables, ids } = setup(7);
    store.setSelection('feature', ids.slice(0, 6));
    store.deleteFeature('f0');
    expect(store.getSelection().bulk?.count).toBe(5);
    store.updateFeature('f1', { visible: false });
    expect(store.getSelection().bulk?.count).toBe(4);
    store.setLocallyHidden('f2', true);
    expect(store.getSelection().ids).toEqual(['f3', 'f4', 'f5']);
    expect(store.getSelectedRows()).toBeNull();
    expect(marked(tables, 'f3')).toBe(false);
  });

  it('lose the rows of a layer hidden', () => {
    const { store, ids } = setup(6);
    store.createLayer(layer('m'));
    store.transact(() => {
      for (let i = 0; i < 4; i++) store.createFeature(square(`m${i}`, i * 2, { layerId: 'm' }));
    });
    store.setSelection('feature', [...ids, 'm0', 'm1']);
    expect(store.getSelection().bulk?.count).toBe(8);
    expect(store.getSelection().bulk?.layerIds).toEqual(['l', 'm']);
    store.updateLayer('l', { visible: false });
    expect(store.getSelection().ids).toEqual(['m0', 'm1']);
  });

  it('follow the members of a layer selected', () => {
    const { store } = setup(5);
    store.setSelection('layer', ['l']);
    store.createFeature(square('f9', 30));
    expect(store.getSelection().bulk?.count).toBe(6);
    store.transact(() => {
      store.deleteFeature('f0');
      store.deleteFeature('f1');
      store.deleteFeature('f2');
    });
    // Three left: the layer is selected with its features opened
    expect(store.getSelection()).toEqual({ type: 'layer', ids: ['l'] });
  });

  it('give their extent anew once they moved', () => {
    const { store, ids, handleOf } = setup(6);
    store.setSelection('feature', ids.slice(0, 4));
    const moved = store.getSelection().bulk;
    store.applyRows({
      patch: {
        handles: Int32Array.of(handleOf('f0')),
        fields: new Map([['geometry', [square('f0', -10).geometry]]]),
      },
      before: {
        handles: Int32Array.of(handleOf('f0')),
        fields: new Map([['geometry', [square('f0', 0).geometry]]]),
      },
    });
    expect(store.getSelection().bulk).not.toBe(moved);
    expect(store.getSelection().bulk?.bbox).toEqual([-10, 0, 7, 1]);
  });

  it('give a group read as features by a drag, and as the group by the selection, in any order', () => {
    for (const dragFirst of [true, false]) {
      const { store, ids } = setup(6);
      store.createGroup({
        id: 'g',
        layerId: 'l',
        name: 'g',
        visible: true,
        locked: false,
        featureIds: ids.slice(0, 5),
      } as never);
      store.setSelection('group', ['g']);
      // A member moved: the summary is made again, and no one read the selection since
      store.updateFeature('f0', { geometry: square('f0', -10).geometry });
      const selection = store.getSelection();
      const bulk = selection.bulk as NonNullable<typeof selection.bulk>;
      const read = () => valueOfSelection(store, store.getSelection());
      const selected = dragFirst ? null : read();
      // The value of a drag of the features (drag.started), with no IDs
      const dragged = bulkSelectionValue(bulk);
      expect(dragged).toMatchObject({ type: 'feature', count: 5, ids: null });
      expect(bulkSelectionValue(bulk)).toBe(dragged);
      expect(read()).toMatchObject({ type: 'group', count: 5, ids: ['g'] });
      expect(read()).toBe(selected ?? read());
      expect(read().bbox).toEqual([-10, 0, 9, 1]);
    }
  });

  it('are put back from a summary kept, without what is gone', () => {
    const { store, ids } = setup(7);
    store.setSelection('feature', ids.slice(0, 5));
    const kept = store.getSelection();
    store.setSelection(null, []);
    store.deleteFeature('f0');
    store.restoreSelection(kept);
    expect(store.getSelection().bulk?.count).toBe(4);
    store.deleteFeature('f1');
    store.setSelection(null, []);
    store.restoreSelection(kept);
    expect(store.getSelection().ids).toEqual(['f2', 'f3', 'f4']);
  });

  it('leave the selection at once when many of the rows listed are deleted from elsewhere', () => {
    const { contract, store, ids, handleOf } = setup(40, 50);
    store.setSelection('feature', ids.slice(0, 30));
    let set = 0;
    const setSelection = contract.setSelection.bind(contract);
    contract.setSelection = (type, list) => {
      set++;
      setSelection(type, list);
    };
    const handles = Int32Array.from(ids.slice(0, 20).map(handleOf));
    store.transact(
      () =>
        contract.writer.apply({
          handles,
          fields: new Map(),
          deleted: new Uint8Array(handles.length).fill(1),
        }),
      'remote',
    );
    expect(set).toBe(1);
    expect(store.getSelection().ids).toEqual(ids.slice(20, 30));
  });

  it('are selected by their rows, opened up to the limit', () => {
    const { store, ids, handleOf } = setup(6);
    store.selectRows(TableSelection.of(ids.slice(0, 5).map(handleOf)));
    expect(store.getSelection().bulk?.count).toBe(5);
    store.selectRows(TableSelection.of(['f3', 'f1'].map(handleOf)));
    expect(store.getSelection().ids).toEqual(['f1', 'f3']);
  });

  it('are written by an operation only through the gates of read-only and the lock', () => {
    const { store, ids } = setup(6);
    store.setSelection('feature', ids.slice(0, 5));
    store.setReadOnly(true);
    expect(store.applyBulk({ kind: 'delete' })).toBe(false);
    store.setReadOnly(false);
    store.setInteractionLock(true);
    expect(store.applyBulk({ kind: 'delete' })).toBe(false);
    store.setInteractionLock(false);
    expect(store.applyBulk({ kind: 'delete' })).toBe(true);
    expect(store.getFeature('f0')).toBeUndefined();
    expect(store.getFeature('f5')).toBeDefined();
    expect(store.getSelection()).toEqual({ type: null, ids: [] });
  });
});
