// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for group / layer deletion in handleDeleteShortcut
 *
 * The Delete key deletes a feature / group / layer according to the selection type.
 * For a group, the contents are deleted and the emptied group is deleted automatically; for a
 * layer, everything under it is deleted and at least one layer is kept. The spatial index,
 * derived from the Store, follows.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { tableGroupMemberIds } from '../../feature-table/item-ids.js';
import { groupSelection } from '../../operations/layer-operations.js';
import { deleteSelection } from '../../operations/selection-operations.js';
import type { ObjectGroup, ObjectLayer } from '../../shared/types/model.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { AutoNameGenerator } from '../../shared/utils/name-generator.js';
import { StoreSpatialIndex } from '../../store/spatial/store-spatial-index.js';
import type { Store } from '../../store/store.js';
import type { Feature } from '../../store/types.js';
import { STORE_KINDS } from '../../test-utils.js';
import type { EngineModeContext } from '../handler.js';
import { handleDeleteShortcut, handleGroupShortcut } from './shortcut-handler.js';

describe.each(STORE_KINDS)('on %s', (_kind, createStore) => {
  /**
   * Records the ids the Store reported as deleted (the spatial index drops exactly those): the
   * features deleted, and the rows deleted of a Store of rows
   */
  class DeletionLog {
    removed: string[] = [];
    constructor(store: Store) {
      store.subscribe((changes) => {
        for (const deleted of changes.features?.deleted ?? []) this.removed.push(deleted.id);
        for (const change of changes.rows?.layers.values() ?? []) {
          for (const handle of change.deleted) {
            this.removed.push(store.tables?.getRowId(handle) as string);
          }
        }
      });
    }
  }

  /** The ids of the features of a group (read from the rows of a group held as rows) */
  function membersOf(id: string): readonly string[] | undefined {
    const group = store.getGroup(id);
    if (!group) return undefined;
    return group.kind === 'table' ? tableGroupMemberIds(store.tables, group) : group.featureIds;
  }

  /** Whether the Store holds its features as rows (it groups features by their keys later) */
  const rows = createStore().tables !== undefined;

  function feature(id: string, layerId: string): Feature {
    return {
      groupId: undefined,
      id,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
  }

  let store: Store;
  let spatial: DeletionLog;
  let index: StoreSpatialIndex;
  let context: EngineModeContext;

  beforeEach(() => {
    store = createStore();
    spatial = new DeletionLog(store);
    index = new StoreSpatialIndex(store);
    context = { store, spatialIndex: index } as unknown as EngineModeContext;
  });

  describe('handleDeleteShortcut with a group selection', () => {
    it('Delete on a group selection deletes its contents and the emptied group', () => {
      store.createLayer({
        id: 'l1',
        name: 'l1',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
      store.createFeature(feature('f1', 'l1'));
      store.createFeature(feature('f2', 'l1'));
      store.createGroup({
        id: 'g1',
        layerId: 'l1',
        name: 'g',
        featureIds: ['f1', 'f2'],
        locked: false,
        visible: true,
      });

      store.setSelection('group', ['g1']);
      handleDeleteShortcut(context);

      expect(store.getFeature('f1')).toBeUndefined();
      expect(store.getFeature('f2')).toBeUndefined();
      expect(store.getGroup('g1')).toBeUndefined();
      expect(spatial.removed).toEqual(expect.arrayContaining(['f1', 'f2']));
      expect(index.findNear([0, 0], 0)).toEqual([]);
    });
  });

  describe('handleDeleteShortcut with a layer selection', () => {
    it('Delete on a layer selection deletes everything under it and cleans the index', () => {
      store.createLayer({
        id: 'l1',
        name: 'l1',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
      store.createLayer({
        id: 'l2',
        name: 'l2',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
      store.createFeature(feature('f1', 'l1'));
      store.createFeature(feature('f2', 'l1'));

      store.setSelection('layer', ['l1']);
      handleDeleteShortcut(context);

      expect(store.getLayer('l1')).toBeUndefined();
      expect(store.getFeature('f1')).toBeUndefined();
      expect(store.getFeature('f2')).toBeUndefined();
      expect(spatial.removed).toEqual(expect.arrayContaining(['f1', 'f2']));
      expect(index.findNear([0, 0], 0)).toEqual([]);
    });

    it('the last remaining layer is not deleted', () => {
      store.createLayer({
        id: 'l1',
        name: 'l1',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });

      store.setSelection('layer', ['l1']);
      handleDeleteShortcut(context);

      expect(store.getLayer('l1')).toBeDefined();
    });
  });

  describe('suppression of handleDeleteShortcut (interaction lock / readOnly)', () => {
    function setupTwoLayersWithFeatures(): void {
      store.createLayer({
        id: 'l1',
        name: 'l1',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
      store.createLayer({
        id: 'l2',
        name: 'l2',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
      store.createFeature(feature('f1', 'l1'));
      store.createFeature(feature('f2', 'l1'));
    }

    it('nothing is deleted while the interaction lock is on (the index keeps them)', () => {
      setupTwoLayersWithFeatures();
      store.setSelection('feature', ['f1', 'f2']);
      store.setInteractionLock(true);

      handleDeleteShortcut(context);

      expect(store.getFeature('f1')).toBeDefined();
      expect(store.getFeature('f2')).toBeDefined();
      expect(spatial.removed).toEqual([]);
    });

    it('nothing is deleted while readOnly (the index keeps them)', () => {
      setupTwoLayersWithFeatures();
      store.setSelection('feature', ['f1', 'f2']);
      store.setReadOnly(true);

      handleDeleteShortcut(context);

      expect(store.getFeature('f1')).toBeDefined();
      expect(store.getFeature('f2')).toBeDefined();
      // The index follows the Store, which kept both features (a Store of rows has its rows
      // in the index of its tables, and none here)
      expect(spatial.removed).toEqual([]);
      expect(index.findNear([0, 0], 0).sort()).toEqual(store.tables ? [] : ['f1', 'f2']);
    });

    it('deleting a layer selection is suppressed while the interaction lock is on too', () => {
      setupTwoLayersWithFeatures();
      store.setSelection('layer', ['l1']);
      store.setInteractionLock(true);

      handleDeleteShortcut(context);

      expect(store.getLayer('l1')).toBeDefined();
      expect(spatial.removed).toEqual([]);
    });
  });

  describe('handleDeleteShortcut never removes a locked feature', () => {
    beforeEach(() => {
      for (const id of ['l1', 'l2']) {
        store.createLayer({
          id,
          name: id,
          visible: true,
          locked: false,
          opacity: 1,
          items: [],
          styleRule: undefined,
          metadata: undefined,
        });
      }
    });

    it('a group loses only its unlocked members and stays with the locked one', () => {
      store.createFeature(feature('f1', 'l1'));
      store.createFeature({ ...feature('f2', 'l1'), locked: true });
      store.createGroup({
        id: 'g1',
        layerId: 'l1',
        name: 'g',
        featureIds: ['f1', 'f2'],
        locked: false,
        visible: true,
      });

      store.setSelection('group', ['g1']);
      handleDeleteShortcut(context);

      expect(store.getFeature('f1')).toBeUndefined();
      expect(store.getFeature('f2')).toBeDefined();
      expect(membersOf('g1')).toEqual(['f2']);
    });

    it('a layer holding a locked feature or a locked group is not deleted', () => {
      store.createFeature({ ...feature('f1', 'l1'), locked: true });
      store.createFeature(feature('f2', 'l2'));
      store.createGroup({
        id: 'g2',
        layerId: 'l1',
        name: 'g',
        featureIds: ['f2'],
        locked: true,
        visible: true,
      });

      store.setSelection('layer', ['l1']);
      handleDeleteShortcut(context);
      store.setSelection('layer', ['l2']);
      handleDeleteShortcut(context);

      expect(store.getLayer('l1')).toBeDefined();
      expect(store.getFeature('f1')).toBeDefined();
      expect(store.getLayer('l2')).toBeDefined();
      expect(store.getFeature('f2')).toBeDefined();
    });
  });

  describe('deleteSelection runs the same deletion as the Delete key', () => {
    /** Builds a store, selects, runs the deletion and returns the state and the notifications */
    function run(deleteWith: (s: Store) => boolean | undefined) {
      const s = createStore();
      for (const id of ['l1', 'l2']) {
        s.createLayer({
          id,
          name: id,
          visible: true,
          locked: false,
          opacity: 1,
          items: [],
          styleRule: undefined,
          metadata: undefined,
        });
      }
      s.createFeature(feature('f1', 'l1'));
      s.createFeature({ ...feature('f2', 'l1'), locked: true });
      s.createFeature(feature('f3', 'l2'));
      s.setSelection('feature', ['f1', 'f2', 'f3']);
      let notifications = 0;
      s.subscribe((changes) => {
        // A Store of rows notifies the rows deleted that are no longer held as rows
        if (changes.features || changes.rows) notifications++;
      });
      const result = deleteWith(s);
      return {
        result,
        notifications,
        features: ['f1', 'f2', 'f3'].filter((id) => s.getFeature(id) !== undefined),
        selection: s.getSelection().ids,
      };
    }

    it('deletes the unlocked features in one change and returns true', () => {
      const viaApi = run((s) => deleteSelection(s));
      const viaKey = run((s) => {
        handleDeleteShortcut({ store: s } as unknown as EngineModeContext);
        return undefined;
      });

      expect(viaApi.result).toBe(true);
      expect(viaApi.features).toEqual(['f2']);
      // One transaction: one notification, so one step for a subscriber that records changes
      expect(viaApi.notifications).toBe(1);
      expect(viaApi.selection).toEqual([]);
      expect({ ...viaKey, result: true }).toEqual(viaApi);
    });

    it('deletes the selected vertices first, as one change', () => {
      store.createLayer({
        id: 'l1',
        name: 'l1',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
      store.createFeature({
        ...feature('line', 'l1'),
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
        },
      });
      store.setSelection('feature', ['line']);
      store.setSelectedVertices({ featureId: 'line', vertices: [{ ring: 0, index: 1 }] });

      expect(deleteSelection(store)).toBe(true);
      expect(coordinatesOf(store.getFeature('line'))).toEqual([
        [0, 0],
        [2, 0],
      ]);
      expect(store.getVertexSelection()).toBeNull();
    });

    it('returns false and deletes nothing while read-only, locked or with nothing to delete', () => {
      store.createLayer({
        id: 'l1',
        name: 'l1',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
      store.createFeature(feature('f1', 'l1'));
      store.createFeature({ ...feature('f2', 'l1'), locked: true });

      expect(deleteSelection(store)).toBe(false);

      store.setSelection('feature', ['f2']);
      expect(deleteSelection(store)).toBe(false);

      store.setSelection('feature', ['f1']);
      store.setReadOnly(true);
      expect(deleteSelection(store)).toBe(false);
      store.setReadOnly(false);
      store.setInteractionLock(true);
      expect(deleteSelection(store)).toBe(false);
      expect(store.getFeature('f1')).toBeDefined();

      // The last layer is kept, so deleting it deletes nothing
      store.setInteractionLock(false);
      store.setSelection('layer', ['l1']);
      expect(deleteSelection(store)).toBe(false);
      expect(store.getLayer('l1')).toBeDefined();
    });
  });

  describe('the group shortcut places the group where groupSelection does', () => {
    function build(): Store {
      const s = createStore();
      s.createLayer({
        id: 'l1',
        name: 'l1',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
      for (const id of ['a', 'b', 'c', 'd']) s.createFeature(feature(id, 'l1'));
      s.setSelection('feature', ['a', 'c']);
      return s;
    }

    it.skipIf(rows)('leaves the same layer order for the key and the API', () => {
      const viaKey = build();
      handleGroupShortcut({
        store: viaKey,
        autoNameGenerator: new AutoNameGenerator(viaKey),
        generateFeatureId: () => 'g',
      } as unknown as EngineModeContext);

      const viaApi = build();
      groupSelection(viaApi, () => 'g', new AutoNameGenerator(viaApi));

      expect((viaKey.getLayer('l1') as ObjectLayer | undefined)?.items).toEqual(
        (viaApi.getLayer('l1') as ObjectLayer | undefined)?.items,
      );
      expect((viaKey.getGroup('g') as ObjectGroup | undefined)?.featureIds).toEqual(
        (viaApi.getGroup('g') as ObjectGroup | undefined)?.featureIds,
      );
    });
  });
});
