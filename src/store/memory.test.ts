// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MemoryStore tests
 *
 * Comprehensive tests based on the test design document
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import { MemoryStore } from './memory.js';
import type { Feature, Group, Layer, StateChanges, StyleRule } from './types.js';

// Test helper functions
function createTestLayer(overrides?: Partial<Layer>): Layer {
  return {
    id: 'layer-1',
    name: 'Test Layer',
    visible: true,
    locked: false,
    opacity: 1.0,
    items: [],
    styleRule: undefined,
    metadata: undefined,
    ...overrides,
  };
}

function createTestFeature(id: string, overrides?: Partial<Feature>): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId: 'layer-1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
    ...overrides,
  };
}

function createTestGroup(overrides?: Partial<Group>): Group {
  return {
    id: 'group-1',
    layerId: 'layer-1',
    name: 'Test Group',
    featureIds: [],
    locked: false,
    visible: true,
    ...overrides,
  };
}

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  // ============================================================
  // Feature CRUD operations
  // ============================================================

  describe('Feature CRUD', () => {
    beforeEach(() => {
      store.createLayer(createTestLayer());
    });

    describe('createFeature', () => {
      it('creates a feature', () => {
        const feature = createTestFeature('feature-1');
        store.createFeature(feature);

        expect(store.getFeature('feature-1')).toMatchObject({
          id: 'feature-1',
          type: 'Point',
        });
      });

      it('throws an error for a duplicate ID', () => {
        const feature = createTestFeature('feature-1');
        store.createFeature(feature);

        expect(() => store.createFeature(feature)).toThrow(
          'Feature with id "feature-1" already exists',
        );
      });

      it('is added to the order of the layer automatically on creation', () => {
        const feature = createTestFeature('feature-1');
        store.createFeature(feature);

        expect(store.getLayer('layer-1')?.items).toContain('feature-1');
      });

      it('a feature belonging to a group is added to group.featureIds', () => {
        const group = createTestGroup({ featureIds: [] });
        store.createGroup(group);

        const feature = createTestFeature('feature-1', { groupId: 'group-1' });
        store.createFeature(feature);

        expect(store.getGroup('group-1')?.featureIds).toContain('feature-1');
      });

      it('notifies the listener with the correct StateChanges', () => {
        const listener = vi.fn();
        store.subscribe(listener);

        // Use a transaction to combine them into a single notification
        store.transact(() => {
          const feature = createTestFeature('feature-1');
          store.createFeature(feature);
        });

        expect(listener).toHaveBeenCalledTimes(1);
        const changes: StateChanges = listener.mock.calls[0][0];
        expect(changes.features?.created).toHaveLength(1);
        expect(changes.features?.created?.[0].id).toBe('feature-1');
      });
    });

    describe('updateFeature', () => {
      beforeEach(() => {
        store.createFeature(createTestFeature('feature-1'));
      });

      it('updates a feature', () => {
        store.updateFeature('feature-1', { geometry: { type: 'Point', coordinates: [1, 1] } });

        expect(coordinatesOf(store.getFeature('feature-1'))).toEqual([1, 1]);
      });

      it('throws an error for an ID that does not exist', () => {
        expect(() => store.updateFeature('non-existent', {})).toThrow(
          'Feature with id "non-existent" not found',
        );
      });

      it('applies a partial update correctly', () => {
        store.updateFeature('feature-1', { properties: { name: 'Updated' } });

        const feature = store.getFeature('feature-1');
        expect(feature?.properties.name).toBe('Updated');
        expect(coordinatesOf(feature)).toEqual([0, 0]); // the other properties are kept
      });

      it('changing groupId moves it between groups (an emptied group is auto-deleted)', () => {
        const group1 = createTestGroup({ id: 'group-1', featureIds: ['feature-1'] });
        const group2 = createTestGroup({ id: 'group-2', featureIds: [] });
        store.createGroup(group1);
        store.createGroup(group2);

        store.updateFeature('feature-1', { groupId: 'group-2' });

        // group-1 became empty when its last feature left, so it is deleted automatically
        expect(store.getGroup('group-1')).toBeUndefined();
        expect(store.getGroup('group-2')?.featureIds).toContain('feature-1');
      });

      it('notifies the listener with the states before and after', () => {
        const listener = vi.fn();
        store.subscribe(listener);

        store.updateFeature('feature-1', { geometry: { type: 'Point', coordinates: [5, 5] } });

        const changes: StateChanges = listener.mock.calls[0][0];
        expect(coordinatesOf(changes.features?.updated?.[0].previous)).toEqual([0, 0]);
        expect(coordinatesOf(changes.features?.updated?.[0].feature)).toEqual([5, 5]);
      });

      it('is applied as usual even with isIntermediate', () => {
        store.updateFeature(
          'feature-1',
          { geometry: { type: 'Point', coordinates: [5, 5] } },
          { isIntermediate: true },
        );

        expect(coordinatesOf(store.getFeature('feature-1'))).toEqual([5, 5]);
      });

      it('isIntermediate is passed through to StateChanges', () => {
        const listener = vi.fn();
        store.subscribe(listener);

        store.updateFeature(
          'feature-1',
          { geometry: { type: 'Point', coordinates: [5, 5] } },
          { isIntermediate: true },
        );

        const changes: StateChanges = listener.mock.calls[0][0];
        expect(changes.features?.updated?.[0].isIntermediate).toBe(true);
      });

      it('adds no key when there are no options or isIntermediate is false', () => {
        const listener = vi.fn();
        store.subscribe(listener);

        store.updateFeature('feature-1', { geometry: { type: 'Point', coordinates: [5, 5] } });
        store.updateFeature('feature-1', { geometry: { type: 'Point', coordinates: [6, 6] } }, {});
        store.updateFeature(
          'feature-1',
          { geometry: { type: 'Point', coordinates: [7, 7] } },
          { isIntermediate: false },
        );

        for (const call of listener.mock.calls) {
          const changes: StateChanges = call[0];
          expect(changes.features?.updated?.[0]).not.toHaveProperty('isIntermediate');
        }
      });
    });

    describe('deleteFeature', () => {
      beforeEach(() => {
        store.createFeature(createTestFeature('feature-1'));
      });

      it('deletes a feature', () => {
        store.deleteFeature('feature-1');

        expect(store.getFeature('feature-1')).toBeUndefined();
      });

      it('is removed from the order of the layer automatically on deletion', () => {
        store.deleteFeature('feature-1');

        expect(store.getLayer('layer-1')?.items).not.toContain('feature-1');
      });

      it('is removed from group.featureIds on deletion (an emptied group is deleted)', () => {
        const group = createTestGroup({ featureIds: ['feature-1'] });
        store.createGroup(group);
        store.updateFeature('feature-1', { groupId: 'group-1' });

        store.deleteFeature('feature-1');

        // The last feature was removed, so the group is deleted automatically as well
        expect(store.getGroup('group-1')).toBeUndefined();
      });

      it('is removed from the selection state automatically as well', () => {
        store.setSelection('feature', ['feature-1']);
        expect(store.getSelection().ids).toContain('feature-1');

        store.deleteFeature('feature-1');

        expect(store.getSelection().ids).not.toContain('feature-1');
      });

      it('is removed from the editing state automatically as well', () => {
        store.startEditing(['feature-1']);
        expect(store.getEditingIds()).toContain('feature-1');

        store.deleteFeature('feature-1');

        expect(store.getEditingIds()).not.toContain('feature-1');
      });

      it('throws an error for an ID that does not exist', () => {
        expect(() => store.deleteFeature('non-existent')).toThrow(
          'Feature with id "non-existent" not found',
        );
      });
    });
  });

  // ============================================================
  // Layer CRUD operations
  // ============================================================

  describe('Layer CRUD', () => {
    describe('createLayer', () => {
      it('creates a layer', () => {
        const layer = createTestLayer();
        store.createLayer(layer);

        expect(store.getLayer('layer-1')).toEqual(layer);
      });

      it('throws an error for a duplicate ID', () => {
        const layer = createTestLayer();
        store.createLayer(layer);

        expect(() => store.createLayer(layer)).toThrow('Layer with id "layer-1" already exists');
      });

      it('is added to layerOrder automatically on creation', () => {
        store.createLayer(createTestLayer());

        expect(store.getLayerOrder()).toContain('layer-1');
      });
    });

    describe('updateLayer', () => {
      beforeEach(() => {
        store.createLayer(createTestLayer());
      });

      it('updates a layer', () => {
        store.updateLayer('layer-1', { name: 'Updated Layer' });

        expect(store.getLayer('layer-1')?.name).toBe('Updated Layer');
      });

      it('applies a partial update correctly', () => {
        store.updateLayer('layer-1', { locked: true });

        const layer = store.getLayer('layer-1');
        expect(layer?.locked).toBe(true);
        expect(layer?.visible).toBe(true); // the other properties are kept
      });

      it('a change of visible is reflected', () => {
        store.updateLayer('layer-1', { visible: false });

        expect(store.getLayer('layer-1')?.visible).toBe(false);
      });

      it('a change of locked is reflected', () => {
        store.updateLayer('layer-1', { locked: true });

        expect(store.getLayer('layer-1')?.locked).toBe(true);
      });

      it('throws an error for an ID that does not exist', () => {
        expect(() => store.updateLayer('non-existent', {})).toThrow(
          'Layer with id "non-existent" not found',
        );
      });

      it('sets, changes and clears styleRule', () => {
        const rule: StyleRule = {
          kind: 'categorical',
          property: 'type',
          map: { a: '#ff0000' },
          other: '#888888',
        };
        store.updateLayer('layer-1', { styleRule: rule });
        expect(store.getLayer('layer-1')?.styleRule).toEqual(rule);

        // The rule is kept when other properties are updated
        store.updateLayer('layer-1', { name: 'Renamed' });
        expect(store.getLayer('layer-1')?.styleRule).toEqual(rule);

        store.updateLayer('layer-1', { styleRule: undefined });
        expect(store.getLayer('layer-1')?.styleRule).toBeUndefined();
      });

      it('a change of styleRule appears in layers.updated of StateChanges', () => {
        const rule: StyleRule = { kind: 'single', color: '#ff0000' };
        const changes: StateChanges[] = [];
        store.subscribe((c) => changes.push(c));

        store.updateLayer('layer-1', { styleRule: rule });

        const updated = changes[changes.length - 1]?.layers?.updated?.[0];
        expect(updated?.layer.styleRule).toEqual(rule);
        expect(updated?.previous.styleRule).toBeUndefined();
      });
    });

    describe('deleteLayer', () => {
      beforeEach(() => {
        store.createLayer(createTestLayer());
      });

      it('deletes a layer', () => {
        store.deleteLayer('layer-1');

        expect(store.getLayer('layer-1')).toBeUndefined();
      });

      it('is removed from layerOrder automatically on deletion', () => {
        store.deleteLayer('layer-1');

        expect(store.getLayerOrder()).not.toContain('layer-1');
      });

      it('the features in the layer are deleted as well', () => {
        store.createFeature(createTestFeature('feature-1'));
        store.createFeature(createTestFeature('feature-2'));

        store.deleteLayer('layer-1');

        expect(store.getFeature('feature-1')).toBeUndefined();
        expect(store.getFeature('feature-2')).toBeUndefined();
      });

      it('the groups in the layer are deleted as well', () => {
        store.createFeature(createTestFeature('feature-1'));
        store.createGroup(createTestGroup({ featureIds: ['feature-1'] }));
        // Add the group to the order of the layer (the actual usage pattern)
        store.updateLayer('layer-1', {
          items: ['group-1'],
        });

        store.deleteLayer('layer-1');

        expect(store.getGroup('group-1')).toBeUndefined();
      });

      it('throws an error for an ID that does not exist', () => {
        expect(() => store.deleteLayer('non-existent')).toThrow(
          'Layer with id "non-existent" not found',
        );
      });
    });

    describe('setLayerOrder', () => {
      beforeEach(() => {
        store.createLayer(createTestLayer({ id: 'layer-1' }));
        store.createLayer(createTestLayer({ id: 'layer-2' }));
        store.createLayer(createTestLayer({ id: 'layer-3' }));
      });

      it('changes the layer order', () => {
        store.setLayerOrder(['layer-3', 'layer-1', 'layer-2']);

        expect(store.getLayerOrder()).toEqual(['layer-3', 'layer-1', 'layer-2']);
      });

      it('keeps an ID that is not a layer (a dataset taking part)', () => {
        // The stacking order also contains datasets (order: 'layer-order').
        // Removing an ID that cannot be resolved as a layer would make the position of the
        // dataset disappear from the sequence, so it is kept as it is.
        store.setLayerOrder(['layer-1', 'dataset-a', 'layer-2', 'layer-3']);

        expect(store.getLayerOrder()).toEqual(['layer-1', 'dataset-a', 'layer-2', 'layer-3']);
      });

      it('drops the elements that are not strings', () => {
        store.setLayerOrder(['layer-1', undefined as unknown as string, 'layer-2']);

        expect(store.getLayerOrder()).toEqual(['layer-1', 'layer-2']);
      });

      it('drops empty entries and keeps a repeated entry at its first position', () => {
        store.setLayerOrder(['layer-1', '', 'layer-2', 'layer-1', 'sep', 'layer-3', 'sep']);

        expect(store.getLayerOrder()).toEqual(['layer-1', 'layer-2', 'sep', 'layer-3']);
      });

      it('keeps the position of an id placed on the order before its layer is created', () => {
        store.setLayerOrder(['layer-4', 'layer-1', 'layer-2', 'layer-3']);

        store.createLayer(createTestLayer({ id: 'layer-4' }));

        expect(store.getLayerOrder()).toEqual(['layer-4', 'layer-1', 'layer-2', 'layer-3']);
      });

      it('takes only the deleted layer out of the order and keeps the other entries', () => {
        store.setLayerOrder(['layer-1', 'dataset-a', 'layer-2', 'sep', 'layer-3']);

        store.deleteLayer('layer-2');

        expect(store.getLayerOrder()).toEqual(['layer-1', 'dataset-a', 'sep', 'layer-3']);
      });

      it('notifies the listener with orderChanged', () => {
        const listener = vi.fn();
        store.subscribe(listener);

        store.setLayerOrder(['layer-2', 'layer-1', 'layer-3']);

        const changes: StateChanges = listener.mock.calls[0][0];
        expect(changes.layers?.orderChanged?.order).toEqual(['layer-2', 'layer-1', 'layer-3']);
        expect(changes.layers?.orderChanged?.previous).toEqual(['layer-1', 'layer-2', 'layer-3']);
      });
    });

    describe('reorderInLayer', () => {
      beforeEach(() => {
        store.createLayer(createTestLayer());
        store.createFeature(createTestFeature('feature-1'));
        store.createFeature(createTestFeature('feature-2'));
        store.createFeature(createTestFeature('feature-3'));
      });

      it('changes the order of the items in a layer', () => {
        store.reorderInLayer('feature-3', 'layer-1', 0);

        expect(store.getLayer('layer-1')?.items).toEqual(['feature-3', 'feature-1', 'feature-2']);
      });

      it('throws an error for an item ID that does not exist', () => {
        expect(() => store.reorderInLayer('non-existent', 'layer-1', 0)).toThrow(
          'Item "non-existent" not found in layer "layer-1"',
        );
      });

      it('throws an error for a layer ID that does not exist', () => {
        expect(() => store.reorderInLayer('feature-1', 'non-existent', 0)).toThrow(
          'Layer with id "non-existent" not found',
        );
      });
    });
  });

  // ============================================================
  // Group CRUD operations
  // ============================================================

  describe('Group CRUD', () => {
    beforeEach(() => {
      store.createLayer(createTestLayer());
      store.createFeature(createTestFeature('feature-1'));
      store.createFeature(createTestFeature('feature-2'));
    });

    describe('createGroup', () => {
      it('creates a group', () => {
        const group = createTestGroup({ featureIds: ['feature-1', 'feature-2'] });
        store.createGroup(group);

        expect(store.getGroup('group-1')).toMatchObject({
          id: 'group-1',
          name: 'Test Group',
        });
      });

      it('throws an error for a duplicate ID', () => {
        const group = createTestGroup();
        store.createGroup(group);

        expect(() => store.createGroup(group)).toThrow('Group with id "group-1" already exists');
      });

      it('the groupId of the features is updated on creation', () => {
        const group = createTestGroup({ featureIds: ['feature-1', 'feature-2'] });
        store.createGroup(group);

        expect(store.getFeature('feature-1')?.groupId).toBe('group-1');
        expect(store.getFeature('feature-2')?.groupId).toBe('group-1');
      });
    });

    describe('the layer of a group (layerId)', () => {
      beforeEach(() => {
        store.createLayer(createTestLayer({ id: 'layer-2', name: 'Layer 2' }));
      });

      it('takes the layer of its first member when no layer lists it', () => {
        store.createGroup(
          createTestGroup({ layerId: 'layer-2', featureIds: ['feature-1', 'feature-2'] }),
        );

        expect(store.getGroup('group-1')?.layerId).toBe('layer-1');
        expect(store.getLayer('layer-1')?.items).toContain('group-1');
      });

      it('takes the layer that lists it when it is created', () => {
        store.transact(() => {
          store.updateLayer('layer-2', { items: ['group-1'] });
          store.createGroup(createTestGroup({ layerId: 'layer-1', featureIds: [] }));
        });

        expect(store.getGroup('group-1')?.layerId).toBe('layer-2');
      });

      it('follows a write that lists it in another layer, as a group update', () => {
        store.createGroup(createTestGroup({ featureIds: ['feature-1'] }));
        const listener = vi.fn();
        store.subscribe(listener);

        store.transact(() => {
          const from = store.getLayer('layer-1')?.items ?? [];
          store.updateLayer('layer-1', { items: from.filter((id) => id !== 'group-1') });
          store.updateLayer('layer-2', { items: ['group-1'] });
        });

        expect(store.getGroup('group-1')?.layerId).toBe('layer-2');
        const changes: StateChanges = listener.mock.calls[0][0];
        expect(changes.groups?.updated).toEqual([
          {
            id: 'group-1',
            group: expect.objectContaining({ layerId: 'layer-2' }),
            previous: expect.objectContaining({ layerId: 'layer-1' }),
          },
        ]);
      });

      it('leaves a group alone when a write lists it in its own layer again', () => {
        store.createGroup(createTestGroup({ featureIds: ['feature-1'] }));
        const listener = vi.fn();
        store.subscribe(listener);

        store.updateLayer('layer-1', { items: [...(store.getLayer('layer-1')?.items ?? [])] });

        const changes: StateChanges = listener.mock.calls[0][0];
        expect(changes.groups).toBeUndefined();
      });
    });

    describe('updateGroup', () => {
      beforeEach(() => {
        store.createGroup(createTestGroup({ featureIds: ['feature-1'] }));
      });

      it('updates a group', () => {
        store.updateGroup('group-1', { name: 'Updated Group' });

        expect(store.getGroup('group-1')?.name).toBe('Updated Group');
      });

      it('throws an error for an ID that does not exist', () => {
        expect(() => store.updateGroup('non-existent', {})).toThrow(
          'Group with id "non-existent" not found',
        );
      });
    });

    describe('deleteGroup', () => {
      beforeEach(() => {
        store.createGroup(createTestGroup({ featureIds: ['feature-1', 'feature-2'] }));
      });

      it('deletes a group', () => {
        store.deleteGroup('group-1');

        expect(store.getGroup('group-1')).toBeUndefined();
      });

      it('the groupId of the features is cleared on deletion', () => {
        store.deleteGroup('group-1');

        expect(store.getFeature('feature-1')?.groupId).toBeUndefined();
        expect(store.getFeature('feature-2')?.groupId).toBeUndefined();
      });

      it('throws an error for an ID that does not exist', () => {
        expect(() => store.deleteGroup('non-existent')).toThrow(
          'Group with id "non-existent" not found',
        );
      });

      it('the groupId of the features is cleared on deletion through transact too', () => {
        // The group has already been created in beforeEach
        expect(store.getFeature('feature-1')?.groupId).toBe('group-1');
        expect(store.getFeature('feature-2')?.groupId).toBe('group-1');

        store.transact(() => {
          store.deleteGroup('group-1');
        }, 'undo');

        expect(store.getFeature('feature-1')?.groupId).toBeUndefined();
        expect(store.getFeature('feature-2')?.groupId).toBeUndefined();
      });

      it('groups.deleted is emitted only once (no double emission with auto-deletion)', () => {
        const deletedIds: string[] = [];
        const unsubscribe = store.subscribe((changes) => {
          for (const g of changes.groups?.deleted ?? []) deletedIds.push(g.id);
        });

        store.deleteGroup('group-1');
        unsubscribe();

        // If the automatic deletion of an empty group ran recursively when the last member
        // left, groups.deleted for group-1 would be emitted twice. It must happen only once.
        expect(deletedIds).toEqual(['group-1']);
      });
    });

    describe('createGroup + deleteGroup transact', () => {
      // Tests that do not create a group in beforeEach
      it('createGroup then deleteGroup through transact clears the groupId of the features', () => {
        // A test that reproduces the behavior through a Command
        store.transact(() => {
          store.createGroup(createTestGroup({ featureIds: ['feature-1', 'feature-2'] }));
        }, 'redo');

        // Check the state after createGroup
        expect(store.getFeature('feature-1')?.groupId).toBe('group-1');
        expect(store.getFeature('feature-2')?.groupId).toBe('group-1');

        // Check group.featureIds as well
        const groupBeforeDelete = store.getGroup('group-1');
        expect(groupBeforeDelete?.featureIds).toEqual(['feature-1', 'feature-2']);

        store.transact(() => {
          store.deleteGroup('group-1');
        }, 'undo');

        expect(store.getFeature('feature-1')?.groupId).toBeUndefined();
        expect(store.getFeature('feature-2')?.groupId).toBeUndefined();
      });
    });

    describe('reorderInGroup', () => {
      beforeEach(() => {
        store.createFeature(createTestFeature('feature-3'));
        store.createGroup(createTestGroup({ featureIds: ['feature-1', 'feature-2', 'feature-3'] }));
      });

      it('changes the order of the features in a group', () => {
        store.reorderInGroup('feature-3', 'group-1', 0);

        expect(store.getGroup('group-1')?.featureIds).toEqual([
          'feature-3',
          'feature-1',
          'feature-2',
        ]);
      });

      it('throws an error for a feature ID that does not exist', () => {
        expect(() => store.reorderInGroup('non-existent', 'group-1', 0)).toThrow(
          'Feature "non-existent" not found in group "group-1"',
        );
      });

      it('throws an error for a group ID that does not exist', () => {
        expect(() => store.reorderInGroup('feature-1', 'non-existent', 0)).toThrow(
          'Group with id "non-existent" not found',
        );
      });
    });
  });

  // ============================================================
  // Selection / Editing state
  // ============================================================

  describe('Selection', () => {
    beforeEach(() => {
      store.createLayer(createTestLayer());
      store.createFeature(createTestFeature('feature-1'));
      store.createFeature(createTestFeature('feature-2'));
    });

    it('sets and gets the selection', () => {
      store.setSelection('feature', ['feature-1', 'feature-2']);

      expect(store.getSelection()).toEqual({ type: 'feature', ids: ['feature-1', 'feature-2'] });
    });

    it('clears the selection', () => {
      store.setSelection('feature', ['feature-1']);
      store.setSelection(null, []);

      expect(store.getSelection()).toEqual({ type: null, ids: [] });
    });

    it('a deleted feature is removed from the selection automatically', () => {
      store.setSelection('feature', ['feature-1', 'feature-2']);
      store.deleteFeature('feature-1');

      expect(store.getSelection().ids).toEqual(['feature-2']);
    });
  });

  describe('Editing', () => {
    beforeEach(() => {
      store.createLayer(createTestLayer());
      store.createFeature(createTestFeature('feature-1'));
      store.createFeature(createTestFeature('feature-2'));
    });

    it('starts the editing state', () => {
      store.startEditing(['feature-1']);

      expect(store.getEditingIds()).toContain('feature-1');
    });

    it('ends the editing state', () => {
      store.startEditing(['feature-1']);
      store.endEditing(['feature-1']);

      expect(store.getEditingIds()).not.toContain('feature-1');
    });

    it('a deleted feature is removed from the editing state automatically', () => {
      store.startEditing(['feature-1', 'feature-2']);
      store.deleteFeature('feature-1');

      expect(store.getEditingIds()).not.toContain('feature-1');
      expect(store.getEditingIds()).toContain('feature-2');
    });

    it('starting a feature that is already being edited again does not duplicate it', () => {
      store.startEditing(['feature-1']);
      store.startEditing(['feature-1']);

      expect(store.getEditingIds().filter((id) => id === 'feature-1')).toHaveLength(1);
    });
  });

  // ============================================================
  // Transactions
  // ============================================================

  describe('Transaction', () => {
    beforeEach(() => {
      store.createLayer(createTestLayer());
    });

    it('several changes are combined into a single StateChanges', () => {
      const listener = vi.fn();
      store.subscribe(listener);

      store.transact(() => {
        store.createFeature(createTestFeature('feature-1'));
        store.createFeature(createTestFeature('feature-2'));
      });

      expect(listener).toHaveBeenCalledTimes(1);
      const changes: StateChanges = listener.mock.calls[0][0];
      expect(changes.features?.created).toHaveLength(2);
    });

    it('each entry keeps its assertion when intermediate and final updates are mixed', () => {
      store.createFeature(createTestFeature('feature-1'));
      const listener = vi.fn();
      store.subscribe(listener);

      store.transact(() => {
        store.updateFeature(
          'feature-1',
          { geometry: { type: 'Point', coordinates: [1, 1] } },
          { isIntermediate: true },
        );
        store.updateFeature('feature-1', { geometry: { type: 'Point', coordinates: [2, 2] } });
      });

      const changes: StateChanges = listener.mock.calls[0][0];
      const updated = changes.features?.updated ?? [];
      expect(updated).toHaveLength(2);
      expect(updated[0].isIntermediate).toBe(true);
      // The last (final) entry carries no flag, and its value is the final value
      expect(updated[1]).not.toHaveProperty('isIntermediate');
      expect(coordinatesOf(updated[1].feature)).toEqual([2, 2]);
    });

    it('a nested transaction works correctly', () => {
      const listener = vi.fn();
      store.subscribe(listener);

      store.transact(() => {
        store.createFeature(createTestFeature('feature-1'));
        store.transact(() => {
          store.createFeature(createTestFeature('feature-2'));
        });
        store.createFeature(createTestFeature('feature-3'));
      });

      // Notified only once, when the outermost transaction ends
      expect(listener).toHaveBeenCalledTimes(1);
      const changes: StateChanges = listener.mock.calls[0][0];
      expect(changes.features?.created).toHaveLength(3);
    });

    it('source is propagated correctly', () => {
      const listener = vi.fn();
      store.subscribe(listener);

      store.transact(() => {
        store.createFeature(createTestFeature('feature-1'));
      }, 'undo');

      const changes: StateChanges = listener.mock.calls[0][0];
      expect(changes.source).toBe('undo');
    });

    it('source becomes silent for the silent source', () => {
      const listener = vi.fn();
      store.subscribe(listener);

      store.transact(() => {
        store.createFeature(createTestFeature('feature-1'));
      }, 'silent');

      expect(listener).toHaveBeenCalledTimes(1);
      const changes: StateChanges = listener.mock.calls[0][0];
      expect(changes.source).toBe('silent');
    });

    it('layers.updated for the same layer is folded into one entry', () => {
      const listener = vi.fn();
      store.subscribe(listener);

      store.transact(() => {
        store.createFeature(createTestFeature('feature-1'));
        store.createFeature(createTestFeature('feature-2'));
        store.createFeature(createTestFeature('feature-3'));
      });

      const changes: StateChanges = listener.mock.calls[0][0];
      const updated = changes.layers?.updated ?? [];
      expect(updated).toHaveLength(1);
      // previous is the first state and layer is the last state
      expect(updated[0].previous.items).toEqual([]);
      expect(updated[0].layer.items).toEqual(['feature-1', 'feature-2', 'feature-3']);
    });

    it('with several layers, folding is independent for each layer', () => {
      store.createLayer(createTestLayer({ id: 'layer-2' }));
      const listener = vi.fn();
      store.subscribe(listener);

      store.transact(() => {
        store.createFeature(createTestFeature('feature-1'));
        store.createFeature(createTestFeature('feature-2', { layerId: 'layer-2' }));
        store.createFeature(createTestFeature('feature-3'));
      });

      const changes: StateChanges = listener.mock.calls[0][0];
      const updated = changes.layers?.updated ?? [];
      expect(updated.map((u) => u.id)).toEqual(['layer-1', 'layer-2']);
      expect(updated[0].layer.items).toEqual(['feature-1', 'feature-3']);
      expect(updated[1].layer.items).toEqual(['feature-2']);
    });

    it('groups.updated for the same group is folded into one entry', () => {
      store.createFeature(createTestFeature('feature-1'));
      store.createFeature(createTestFeature('feature-2'));
      store.createGroup(createTestGroup());
      const listener = vi.fn();
      store.subscribe(listener);

      store.transact(() => {
        store.updateFeature('feature-1', { groupId: 'group-1' });
        store.updateFeature('feature-2', { groupId: 'group-1' });
      });

      const changes: StateChanges = listener.mock.calls[0][0];
      const updated = changes.groups?.updated ?? [];
      expect(updated).toHaveLength(1);
      expect(updated[0].previous.featureIds).toEqual([]);
      expect(updated[0].group.featureIds).toEqual(['feature-1', 'feature-2']);
    });

    it('the order snapshots retained by a bulk creation are not quadratic', () => {
      const listener = vi.fn();
      store.subscribe(listener);

      const count = 400;
      store.transact(() => {
        for (let i = 0; i < count; i++) {
          store.createFeature(createTestFeature(`feature-${i}`));
        }
      }, 'silent');

      const changes: StateChanges = listener.mock.calls[0][0];
      const updated = changes.layers?.updated ?? [];
      // Before folding, each entry held two copies of the whole order, so the total was O(N^2).
      const retainedEntries = updated.reduce(
        (sum, u) => sum + u.layer.items.length + u.previous.items.length,
        0,
      );
      expect(retainedEntries).toBeLessThanOrEqual(count * 2);
    });
  });

  // ============================================================
  // listFeaturesInOrder
  // ============================================================

  describe('listFeaturesInOrder', () => {
    beforeEach(() => {
      store.createLayer(createTestLayer({ id: 'layer-1' }));
      store.createLayer(createTestLayer({ id: 'layer-2' }));
    });

    it('returns the features in layer order, then in the order within the layer', () => {
      store.createFeature(createTestFeature('f1', { layerId: 'layer-1' }));
      store.createFeature(createTestFeature('f2', { layerId: 'layer-1' }));
      store.createFeature(createTestFeature('f3', { layerId: 'layer-2' }));

      const ordered = store.listFeaturesInOrder();

      expect(ordered.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
    });

    it('includes invisible features', () => {
      store.createFeature(createTestFeature('f1', { visible: true }));
      store.createFeature(createTestFeature('f2', { visible: false }));

      const ordered = store.listFeaturesInOrder();

      expect(ordered.map((f) => f.id)).toEqual(['f1', 'f2']);
    });

    it('includes the features of an invisible layer', () => {
      store.createFeature(createTestFeature('f1', { layerId: 'layer-1' }));
      store.createFeature(createTestFeature('f2', { layerId: 'layer-2' }));
      store.updateLayer('layer-2', { visible: false });

      const ordered = store.listFeaturesInOrder();

      expect(ordered.map((f) => f.id)).toEqual(['f1', 'f2']);
    });

    it('includes the features of an invisible group', () => {
      store.createFeature(createTestFeature('f1'));
      store.createFeature(createTestFeature('f2'));
      store.createGroup(createTestGroup({ featureIds: ['f2'], visible: false }));
      store.updateLayer('layer-1', { items: ['f1', 'group-1'] });

      const ordered = store.listFeaturesInOrder();

      expect(ordered.map((f) => f.id)).toEqual(['f1', 'f2']);
    });

    it('the features in a group are inserted at the position of the group', () => {
      store.createFeature(createTestFeature('f1'));
      store.createFeature(createTestFeature('f2'));
      store.createFeature(createTestFeature('f3'));
      // Create a group: f2 and f3 are grouped
      // The order of the layer becomes [f1, group-1], and the group contains [f2, f3]
      store.createGroup(createTestGroup({ featureIds: ['f2', 'f3'] }));

      const ordered = store.listFeaturesInOrder();

      // f1 comes first, then f2 and f3 from inside the group
      expect(ordered.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
    });
  });

  // ============================================================
  // subscribe
  // ============================================================

  describe('subscribe', () => {
    it('registers and unregisters a listener', () => {
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);

      store.createLayer(createTestLayer());
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      store.createLayer(createTestLayer({ id: 'layer-2' }));
      expect(listener).toHaveBeenCalledTimes(1); // not called after unregistering
    });

    it('all of several listeners are called', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      store.subscribe(listener1);
      store.subscribe(listener2);

      store.createLayer(createTestLayer());

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // Mode operations
  // ============================================================

  describe('Mode', () => {
    it('sets and gets the mode', () => {
      expect(store.getMode()).toBe('select');

      store.setMode('draw_point');

      expect(store.getMode()).toBe('draw_point');
    });

    it('setting the same mode does not notify a change', () => {
      const listener = vi.fn();
      store.subscribe(listener);

      store.setMode('select'); // the same as the initial value

      expect(listener).not.toHaveBeenCalled();
    });

    it('the listener is notified when the mode changes', () => {
      const listener = vi.fn();
      store.subscribe(listener);

      store.setMode('draw_polygon');

      const changes: StateChanges = listener.mock.calls[0][0];
      expect(changes.mode?.mode).toBe('draw_polygon');
      expect(changes.mode?.previous).toBe('select');
    });
  });

  // ============================================================
  // Tentative/BoxSelection/DragState
  // ============================================================

  describe('Tentative', () => {
    it('sets and gets the tentative state', () => {
      const tentative = {
        type: 'Point' as const,
        coordinates: [0, 0] as [number, number],
        layerId: 'layer-1',
      };
      store.setTentative(tentative);

      expect(store.getTentative()).toMatchObject(tentative);
    });

    it('clears the tentative state', () => {
      store.setTentative({ type: 'Point', coordinates: [0, 0], layerId: 'layer-1' });
      store.setTentative(null);

      expect(store.getTentative()).toBeNull();
    });
  });

  describe('BoxSelection', () => {
    it('sets and gets the boxSelection state', () => {
      const box = {
        startPoint: [0, 0] as [number, number],
        endPoint: [100, 100] as [number, number],
        previousSelection: [],
      };
      store.setBoxSelection(box);

      expect(store.getBoxSelection()).toMatchObject(box);
    });

    it('clears the boxSelection state', () => {
      store.setBoxSelection({
        startPoint: [0, 0],
        endPoint: [100, 100],
        previousSelection: [],
      });
      store.setBoxSelection(null);

      expect(store.getBoxSelection()).toBeNull();
    });
  });

  describe('DragState', () => {
    it('sets and gets the dragState state', () => {
      const drag = {
        operation: 'move' as const,
        activeVertex: undefined,
        activeFeatureId: undefined,
        rotateInfo: undefined,
      };
      store.setDragState(drag);

      expect(store.getDragState()).toMatchObject(drag);
    });

    it('clears the dragState state', () => {
      store.setDragState({ operation: 'move' });
      store.setDragState(null);

      expect(store.getDragState()).toBeNull();
    });
  });

  // ============================================================
  // Metadata operations
  // ============================================================

  describe('Metadata', () => {
    it('sets and gets the metadata', () => {
      store.setMetadata({ description: 'satellite' });

      expect(store.getMetadata().description).toBe('satellite');
    });

    it('a partial update of the metadata works correctly', () => {
      store.setMetadata({ description: 'satellite' });
      store.setMetadata({ title: 'Test Map' });

      const metadata = store.getMetadata();
      expect(metadata.description).toBe('satellite');
      expect(metadata.title).toBe('Test Map');
    });

    it('deletes a key with an undefined value', () => {
      store.setMetadata({ description: 'satellite' });
      store.setMetadata({ description: undefined });

      expect(store.getMetadata().description).toBeUndefined();
    });
  });

  // ============================================================
  // File operations
  // ============================================================

  describe('File', () => {
    it('adds and gets a file', () => {
      const file = { id: 'file-1', mimeType: 'image/png', dataURL: 'data:image/png;base64,...' };
      store.createFile(file);

      expect(store.getFile('file-1')).toMatchObject(file);
    });

    it('throws an error for a duplicate ID', () => {
      const file = { id: 'file-1', mimeType: 'image/png', dataURL: 'data:image/png;base64,...' };
      store.createFile(file);

      expect(() => store.createFile(file)).toThrow('File with id "file-1" already exists');
    });

    it('deletes a file', () => {
      const file = { id: 'file-1', mimeType: 'image/png', dataURL: 'data:image/png;base64,...' };
      store.createFile(file);
      store.deleteFile('file-1');

      expect(store.getFile('file-1')).toBeUndefined();
    });

    it('throws an error when deleting a file that does not exist', () => {
      expect(() => store.deleteFile('non-existent')).toThrow(
        'File with id "non-existent" not found',
      );
    });

    it('gets all the files', () => {
      store.createFile({
        id: 'file-1',
        mimeType: 'image/png',
        dataURL: 'data:image/png;base64,...',
      });
      store.createFile({
        id: 'file-2',
        mimeType: 'image/png',
        dataURL: 'data:image/png;base64,...',
      });

      expect(store.listFiles()).toHaveLength(2);
    });
  });

  // ============================================================
  // Membership consistency of layer.order / group.featureIds
  // ============================================================

  /**
   * Membership is tested with an internal index (a Set), so a mismatch between the index and
   * the actual array always shows up as "added but not present", "present twice" or "deleted
   * but still there". The invariants are verified through that behavior, without peeking at
   * the index directly.
   */
  describe('membership consistency of order / featureIds', () => {
    function expectNoDuplicates(ids: readonly string[]): void {
      expect(new Set(ids).size).toBe(ids.length);
    }

    it('adding the same ID to a layer created with a populated order does not duplicate it', () => {
      // The load path: create the layer with its order, then create the features in it.
      store.createLayer(createTestLayer({ items: ['f-1', 'f-2'] }));
      store.createFeature(createTestFeature('f-1'));
      store.createFeature(createTestFeature('f-2'));
      store.createFeature(createTestFeature('f-3'));

      const order = store.getLayer('layer-1')?.items ?? [];
      expectNoDuplicates(order);
      expect(order).toEqual(['f-1', 'f-2', 'f-3']);
    });

    it('deletes a feature from a layer created with a populated order', () => {
      store.createLayer(createTestLayer({ items: ['f-1', 'f-2'] }));
      store.createFeature(createTestFeature('f-1'));
      store.createFeature(createTestFeature('f-2'));

      store.deleteFeature('f-1');

      expect(store.getLayer('layer-1')?.items).toEqual(['f-2']);
    });

    it('addition and deletion still work after replacing order with updateLayer', () => {
      store.createLayer(createTestLayer());
      store.createFeature(createTestFeature('f-1'));
      store.createFeature(createTestFeature('f-2'));

      // The replacement drops f-1 and puts f-9, which is not in the store yet, in the order.
      store.updateLayer('layer-1', { items: ['f-2', 'f-9'] });

      // f-9, put there by the replacement, is already in order, so it is not duplicated.
      store.createFeature(createTestFeature('f-9'));
      // f-1, dropped by the replacement, is not in order, so recreating it appends it once.
      store.createFeature(createTestFeature('f-1b'));

      const order = store.getLayer('layer-1')?.items ?? [];
      expectNoDuplicates(order);
      expect(order).toEqual(['f-2', 'f-9', 'f-1b']);

      // An ID put there by the replacement is also removed reliably by the deletion path.
      store.deleteFeature('f-9');
      expect(store.getLayer('layer-1')?.items).toEqual(['f-2', 'f-1b']);
    });

    it('addition and deletion still work after reorderInLayer (content is unchanged)', () => {
      store.createLayer(createTestLayer());
      store.createFeature(createTestFeature('f-1'));
      store.createFeature(createTestFeature('f-2'));
      store.createFeature(createTestFeature('f-3'));

      store.reorderInLayer('f-3', 'layer-1', 0);
      expect(store.getLayer('layer-1')?.items).toEqual(['f-3', 'f-1', 'f-2']);

      store.deleteFeature('f-1');
      expect(store.getLayer('layer-1')?.items).toEqual(['f-3', 'f-2']);

      store.createFeature(createTestFeature('f-4'));
      const order = store.getLayer('layer-1')?.items ?? [];
      expectNoDuplicates(order);
      expect(order).toEqual(['f-3', 'f-2', 'f-4']);
    });

    it('order and featureIds stay consistent through grouping and ungrouping round trips', () => {
      store.createLayer(createTestLayer());
      store.createFeature(createTestFeature('f-1'));
      store.createFeature(createTestFeature('f-2'));

      // Grouping (equivalent to the API: create a group and replace layer.order with its ID)
      store.createGroup(createTestGroup({ featureIds: ['f-1', 'f-2'] }));
      store.updateLayer('layer-1', { items: ['group-1'] });

      expectNoDuplicates(store.getGroup('group-1')?.featureIds ?? []);
      expect(store.getGroup('group-1')?.featureIds).toEqual(['f-1', 'f-2']);
      expect(store.getFeature('f-1')?.groupId).toBe('group-1');

      // Ungrouping: the members take the place of the group ID in the order of the layer
      store.deleteGroup('group-1');
      expect(store.getGroup('group-1')).toBeUndefined();
      expect(store.getLayer('layer-1')?.items).toEqual(['f-1', 'f-2']);
      expect(store.getFeature('f-1')?.groupId).toBeUndefined();

      // After ungrouping, put the members back into order and recreate the group with the
      // same ID
      store.updateLayer('layer-1', { items: ['f-1', 'f-2'] });
      store.createGroup(createTestGroup({ featureIds: ['f-1'] }));
      store.updateLayer('layer-1', { items: ['group-1', 'f-2'] });

      expect(store.getGroup('group-1')?.featureIds).toEqual(['f-1']);

      // An addition to the recreated group also happens only once
      store.updateFeature('f-2', { groupId: 'group-1' });
      const featureIds = store.getGroup('group-1')?.featureIds ?? [];
      expectNoDuplicates(featureIds);
      expect(featureIds).toEqual(['f-1', 'f-2']);

      // What was added can be removed through the same path
      store.updateFeature('f-2', { groupId: undefined });
      expect(store.getGroup('group-1')?.featureIds).toEqual(['f-1']);
    });

    it('adding the same ID to a group made with populated featureIds does not duplicate', () => {
      // The load path: create the group with its featureIds, then create the member features.
      store.createLayer(createTestLayer({ items: ['group-1'] }));
      store.createGroup(createTestGroup({ featureIds: ['f-1', 'f-2'] }));
      store.createFeature(createTestFeature('f-1', { groupId: 'group-1' }));
      store.createFeature(createTestFeature('f-2', { groupId: 'group-1' }));

      const featureIds = store.getGroup('group-1')?.featureIds ?? [];
      expectNoDuplicates(featureIds);
      expect(featureIds).toEqual(['f-1', 'f-2']);
      // A feature belonging to a group is not listed in the order of the layer
      expect(store.getLayer('layer-1')?.items).toEqual(['group-1']);
    });

    it('addition and deletion still work after replacing featureIds with updateGroup', () => {
      store.createLayer(createTestLayer());
      store.createFeature(createTestFeature('f-1'));
      store.createFeature(createTestFeature('f-2'));
      store.createGroup(createTestGroup({ featureIds: ['f-1'] }));

      store.updateGroup('group-1', { featureIds: ['f-1', 'f-2'] });

      // Setting groupId on f-2, put there by the replacement, does not duplicate it
      store.updateFeature('f-2', { groupId: 'group-1' });
      const featureIds = store.getGroup('group-1')?.featureIds ?? [];
      expectNoDuplicates(featureIds);
      expect(featureIds).toEqual(['f-1', 'f-2']);

      // An ID put there by the replacement is also removed reliably by the deletion path
      store.updateFeature('f-2', { groupId: undefined });
      expect(store.getGroup('group-1')?.featureIds).toEqual(['f-1']);
    });

    it('deleting a group makes the group ID disappear entirely from the order of the layer', () => {
      store.createLayer(createTestLayer());
      store.createFeature(createTestFeature('f-1'));
      store.createGroup(createTestGroup({ id: 'x', featureIds: ['f-1'] }));
      store.updateLayer('layer-1', { items: ['x'] });

      store.deleteGroup('x');
      expect(store.getLayer('layer-1')?.items).toEqual(['f-1']);

      // "x" is a released ID. An item with the same ID can be added to order (no leftover
      // rejects it).
      store.createFeature(createTestFeature('x'));
      expect(store.getLayer('layer-1')?.items).toEqual(['f-1', 'x']);
    });

    it('an ID removed from order / featureIds can be put back into the same container', () => {
      store.createLayer(createTestLayer());
      store.createFeature(createTestFeature('f-1'));
      store.createFeature(createTestFeature('f-2'));
      store.createGroup(createTestGroup({ featureIds: ['f-1'] }));

      // Layer: delete, then recreate with the same ID (the group took the place of f-1)
      store.deleteFeature('f-2');
      expect(store.getLayer('layer-1')?.items).toEqual(['group-1']);
      store.createFeature(createTestFeature('f-2'));
      const order = store.getLayer('layer-1')?.items ?? [];
      expectNoDuplicates(order);
      expect(order).toEqual(['group-1', 'f-2']);

      // Group: remove, then put back (removing the last one auto-deletes the empty group, so
      // start from a state with two members)
      store.updateFeature('f-2', { groupId: 'group-1' });
      store.updateFeature('f-1', { groupId: undefined });
      expect(store.getGroup('group-1')?.featureIds).toEqual(['f-2']);
      store.updateFeature('f-1', { groupId: 'group-1' });
      const featureIds = store.getGroup('group-1')?.featureIds ?? [];
      expectNoDuplicates(featureIds);
      expect(featureIds).toEqual(['f-2', 'f-1']);
    });

    it('recreating a deleted layer with the same ID gives the order it was created with', () => {
      store.createLayer(createTestLayer({ items: ['f-1'] }));
      store.createFeature(createTestFeature('f-1'));
      store.deleteLayer('layer-1');

      store.createLayer(createTestLayer());
      expect(store.getLayer('layer-1')?.items).toEqual([]);

      // A leftover from the deleted layer must not suppress the addition
      store.createFeature(createTestFeature('f-1'));
      expect(store.getLayer('layer-1')?.items).toEqual(['f-1']);
    });
  });

  describe('container references of features', () => {
    beforeEach(() => {
      store.createLayer(createTestLayer({ id: 'layer-1' }));
      store.createLayer(createTestLayer({ id: 'layer-2' }));
    });

    it('createFeature throws for a layer that does not exist and stores nothing', () => {
      expect(() => store.createFeature(createTestFeature('f-1', { layerId: 'nolayer' }))).toThrow(
        'Layer with id "nolayer" not found',
      );
      expect(store.getFeature('f-1')).toBeUndefined();
      expect(store.listFeatures()).toHaveLength(0);
    });

    it('createFeature throws for an empty layerId', () => {
      expect(() => store.createFeature(createTestFeature('f-1', { layerId: '' }))).toThrow(
        'Layer with id "" not found',
      );
      expect(store.getFeature('f-1')).toBeUndefined();
    });

    it('createFeature throws for a group that does not exist and stores nothing', () => {
      expect(() => store.createFeature(createTestFeature('f-1', { groupId: 'nogroup' }))).toThrow(
        'Group with id "nogroup" not found',
      );
      expect(store.getFeature('f-1')).toBeUndefined();
    });

    it('every created feature is reachable from the ordered features', () => {
      store.createFeature(createTestFeature('f-1'));
      store.createFeature(createTestFeature('f-2', { layerId: 'layer-2' }));
      expect(store.listFeaturesInOrder().map((f) => f.id)).toEqual(['f-1', 'f-2']);
    });

    it('changing layerId moves a standalone feature between the layer orders', () => {
      store.createFeature(createTestFeature('f-1'));
      store.createFeature(createTestFeature('f-2'));

      store.updateFeature('f-1', { layerId: 'layer-2' });

      expect(store.getLayer('layer-1')?.items).toEqual(['f-2']);
      expect(store.getLayer('layer-2')?.items).toEqual(['f-1']);
      expect(store.listFeaturesInOrder().map((f) => f.id)).toEqual(['f-2', 'f-1']);

      // A later deletion removes it from the layer it is in, leaving no orphan ID behind
      store.deleteFeature('f-1');
      expect(store.getLayer('layer-1')?.items).toEqual(['f-2']);
      expect(store.getLayer('layer-2')?.items).toEqual([]);
    });

    it('updateFeature throws for a layer that does not exist and changes nothing', () => {
      store.createFeature(createTestFeature('f-1'));

      expect(() => store.updateFeature('f-1', { layerId: 'nolayer' })).toThrow(
        'Layer with id "nolayer" not found',
      );
      expect(store.getFeature('f-1')?.layerId).toBe('layer-1');
      expect(store.getLayer('layer-1')?.items).toEqual(['f-1']);
    });

    it('changing layerId of a grouped feature keeps it in its group', () => {
      store.createFeature(createTestFeature('f-1'));
      store.createGroup(createTestGroup({ featureIds: ['f-1'] }));
      store.updateLayer('layer-1', { items: ['group-1'] });

      store.updateFeature('f-1', { layerId: 'layer-2' });

      expect(store.getGroup('group-1')?.featureIds).toEqual(['f-1']);
      expect(store.getLayer('layer-2')?.items).toEqual([]);
    });

    it('setting groupId takes a standalone feature out of the layer order', () => {
      store.createFeature(createTestFeature('f-1'));
      store.createFeature(createTestFeature('f-2'));
      store.createGroup(createTestGroup({ featureIds: ['f-1'] }));
      store.updateLayer('layer-1', { items: ['group-1', 'f-2'] });

      store.updateFeature('f-2', { groupId: 'group-1' });

      expect(store.getLayer('layer-1')?.items).toEqual(['group-1']);
      expect(store.getGroup('group-1')?.featureIds).toEqual(['f-1', 'f-2']);
      expect(store.listFeaturesInOrder().map((f) => f.id)).toEqual(['f-1', 'f-2']);
    });

    it('clearing groupId puts the feature back into the order of its layer', () => {
      store.createFeature(createTestFeature('f-1'));
      store.createFeature(createTestFeature('f-2'));
      store.createGroup(createTestGroup({ featureIds: ['f-1', 'f-2'] }));
      store.updateLayer('layer-1', { items: ['group-1'] });

      store.updateFeature('f-2', { groupId: undefined });

      expect(store.getGroup('group-1')?.featureIds).toEqual(['f-1']);
      expect(store.getLayer('layer-1')?.items).toEqual(['group-1', 'f-2']);
      expect(store.listFeaturesInOrder().map((f) => f.id)).toEqual(['f-1', 'f-2']);
    });

    it('a caller that lists the moved feature itself within a transaction wins', () => {
      store.createFeature(createTestFeature('a'));
      store.createFeature(createTestFeature('b', { layerId: 'layer-2' }));
      store.createFeature(createTestFeature('f-1'));

      store.transact(() => {
        store.updateFeature('f-1', { layerId: 'layer-2' });
        const target = store.getLayer('layer-2');
        store.updateLayer('layer-2', { items: ['f-1', ...(target?.items ?? [])] });
      });

      expect(store.getLayer('layer-1')?.items).toEqual(['a']);
      expect(store.getLayer('layer-2')?.items).toEqual(['f-1', 'b']);
    });

    it('a group that no layer lists takes the place of its first member', () => {
      store.createFeature(createTestFeature('a'));
      store.createFeature(createTestFeature('f-1'));
      store.createFeature(createTestFeature('f-2'));

      store.createGroup(createTestGroup({ featureIds: ['f-1', 'f-2'] }));

      expect(store.getLayer('layer-1')?.items).toEqual(['a', 'group-1']);
      expect(store.listFeaturesInOrder().map((f) => f.id)).toEqual(['a', 'f-1', 'f-2']);
    });

    it('deleting a group puts its members where the group was', () => {
      store.createFeature(createTestFeature('a'));
      store.createFeature(createTestFeature('f-1'));
      store.createFeature(createTestFeature('f-2'));
      store.createFeature(createTestFeature('b'));
      store.createGroup(createTestGroup({ featureIds: ['f-1', 'f-2'] }));
      store.updateLayer('layer-1', { items: ['a', 'group-1', 'b'] });

      store.deleteGroup('group-1');

      expect(store.getLayer('layer-1')?.items).toEqual(['a', 'f-1', 'f-2', 'b']);
      expect(store.listFeaturesInOrder().map((f) => f.id)).toEqual(['a', 'f-1', 'f-2', 'b']);
    });
  });
});
