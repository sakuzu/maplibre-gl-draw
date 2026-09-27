// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ChangeMerger tests
 *
 * Tests the merging of StateChanges objects
 */

import { describe, expect, it } from 'vitest';
import { mergeChanges } from './change-merger.js';
import type { Feature, Layer, StateChanges } from './types.js';

// Test helpers
function createTestFeature(id: string): Feature {
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
  };
}

function createTestLayer(id: string): Layer {
  return {
    id,
    name: `Layer ${id}`,
    visible: true,
    locked: false,
    opacity: 1.0,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  };
}

describe('mergeChanges', () => {
  describe('concatenation of array fields', () => {
    it('concatenates features.created correctly', () => {
      const pending: StateChanges = {
        features: { created: [createTestFeature('f1')] },
      };
      const changes: StateChanges = {
        features: { created: [createTestFeature('f2')] },
      };

      const result = mergeChanges(pending, changes);

      expect(result.features?.created).toHaveLength(2);
      expect(result.features?.created?.map((f) => f.id)).toEqual(['f1', 'f2']);
    });

    it('concatenates features.updated correctly', () => {
      const f1 = createTestFeature('f1');
      const f2 = createTestFeature('f2');

      const pending: StateChanges = {
        features: { updated: [{ id: 'f1', feature: f1, previous: f1 }] },
      };
      const changes: StateChanges = {
        features: { updated: [{ id: 'f2', feature: f2, previous: f2 }] },
      };

      const result = mergeChanges(pending, changes);

      expect(result.features?.updated).toHaveLength(2);
      expect(result.features?.updated?.map((u) => u.id)).toEqual(['f1', 'f2']);
    });

    it('concatenates features.deleted correctly', () => {
      const pending: StateChanges = {
        features: { deleted: [createTestFeature('f1')] },
      };
      const changes: StateChanges = {
        features: { deleted: [createTestFeature('f2')] },
      };

      const result = mergeChanges(pending, changes);

      expect(result.features?.deleted).toHaveLength(2);
      expect(result.features?.deleted?.map((f) => f.id)).toEqual(['f1', 'f2']);
    });

    it('concatenates layers.created correctly', () => {
      const pending: StateChanges = {
        layers: { created: [createTestLayer('l1')] },
      };
      const changes: StateChanges = {
        layers: { created: [createTestLayer('l2')] },
      };

      const result = mergeChanges(pending, changes);

      expect(result.layers?.created).toHaveLength(2);
    });

    it('concatenates layers.updated correctly', () => {
      const l1 = createTestLayer('l1');
      const l2 = createTestLayer('l2');

      const pending: StateChanges = {
        layers: { updated: [{ id: 'l1', layer: l1, previous: l1 }] },
      };
      const changes: StateChanges = {
        layers: { updated: [{ id: 'l2', layer: l2, previous: l2 }] },
      };

      const result = mergeChanges(pending, changes);

      expect(result.layers?.updated).toHaveLength(2);
    });

    it('concatenates layers.deleted correctly', () => {
      const pending: StateChanges = {
        layers: { deleted: [createTestLayer('l1')] },
      };
      const changes: StateChanges = {
        layers: { deleted: [createTestLayer('l2')] },
      };

      const result = mergeChanges(pending, changes);

      expect(result.layers?.deleted).toHaveLength(2);
    });

    it('concatenates groups.created correctly', () => {
      const pending: StateChanges = {
        groups: {
          created: [
            {
              id: 'g1',
              layerId: 'layer-1',
              name: 'G1',
              featureIds: [],
              locked: false,
              visible: true,
            },
          ],
        },
      };
      const changes: StateChanges = {
        groups: {
          created: [
            {
              id: 'g2',
              layerId: 'layer-1',
              name: 'G2',
              featureIds: [],
              locked: false,
              visible: true,
            },
          ],
        },
      };

      const result = mergeChanges(pending, changes);

      expect(result.groups?.created).toHaveLength(2);
    });

    it('concatenates editing.started correctly', () => {
      const pending: StateChanges = {
        editing: { started: ['f1'] },
      };
      const changes: StateChanges = {
        editing: { started: ['f2'] },
      };

      const result = mergeChanges(pending, changes);

      expect(result.editing?.started).toEqual(['f1', 'f2']);
    });

    it('concatenates editing.ended correctly', () => {
      const pending: StateChanges = {
        editing: { ended: ['f1'] },
      };
      const changes: StateChanges = {
        editing: { ended: ['f2'] },
      };

      const result = mergeChanges(pending, changes);

      expect(result.editing?.ended).toEqual(['f1', 'f2']);
    });
  });

  describe('isIntermediate of features.updated', () => {
    // features.updated concatenates entries in order without folding them even for the
    // same ID, so for that feature "the last entry" holds the latest value. If a
    // committing update comes after an intermediate update, the last entry carries no flag.
    it('merging intermediate -> committed leaves the last entry not intermediate', () => {
      const f1 = createTestFeature('f1');
      const pending: StateChanges = {
        features: { updated: [{ id: 'f1', feature: f1, previous: f1, isIntermediate: true }] },
      };
      const changes: StateChanges = {
        features: { updated: [{ id: 'f1', feature: f1, previous: f1 }] },
      };

      const result = mergeChanges(pending, changes);

      const forF1 = (result.features?.updated ?? []).filter((u) => u.id === 'f1');
      expect(forF1).toHaveLength(2);
      expect(forF1[forF1.length - 1].isIntermediate).toBeUndefined();
    });

    it('keeps the flag when only intermediate updates are merged', () => {
      const f1 = createTestFeature('f1');
      const pending: StateChanges = {
        features: { updated: [{ id: 'f1', feature: f1, previous: f1, isIntermediate: true }] },
      };
      const changes: StateChanges = {
        features: { updated: [{ id: 'f1', feature: f1, previous: f1, isIntermediate: true }] },
      };

      const result = mergeChanges(pending, changes);

      const forF1 = (result.features?.updated ?? []).filter((u) => u.id === 'f1');
      expect(forF1.every((u) => u.isIntermediate === true)).toBe(true);
    });
  });

  describe('overwriting of scalar fields', () => {
    it('overwrites selection with the later value', () => {
      const pending: StateChanges = {
        selection: { type: 'feature', ids: ['f1'], previousType: null, previousIds: [] },
      };
      const changes: StateChanges = {
        selection: {
          type: 'feature',
          ids: ['f2', 'f3'],
          previousType: 'feature',
          previousIds: ['f1'],
        },
      };

      const result = mergeChanges(pending, changes);

      expect(result.selection?.ids).toEqual(['f2', 'f3']);
      expect(result.selection?.previousIds).toEqual(['f1']);
    });

    it('overwrites mode with the later value', () => {
      const pending: StateChanges = {
        mode: { mode: 'draw_point', previous: 'select' },
      };
      const changes: StateChanges = {
        mode: { mode: 'draw_polygon', previous: 'draw_point' },
      };

      const result = mergeChanges(pending, changes);

      expect(result.mode?.mode).toBe('draw_polygon');
      expect(result.mode?.previous).toBe('draw_point');
    });

    it('overwrites tentative with the later value', () => {
      const pending: StateChanges = {
        tentative: {
          state: { type: 'Point', coordinates: [0, 0], layerId: 'layer-1' },
          previous: null,
        },
      };
      const changes: StateChanges = {
        tentative: {
          state: {
            type: 'Polygon',
            coordinates: [
              [
                [1, 1],
                [2, 2],
              ],
            ],
            layerId: 'layer-1',
          },
          previous: { type: 'Point', coordinates: [0, 0], layerId: 'layer-1' },
        },
      };

      const result = mergeChanges(pending, changes);

      expect(result.tentative?.state?.type).toBe('Polygon');
      expect(result.tentative?.state?.coordinates).toEqual([
        [
          [1, 1],
          [2, 2],
        ],
      ]);
    });

    it('overwrites metadata with the later value', () => {
      const pending: StateChanges = {
        metadata: { metadata: { description: 'satellite' }, previous: {} },
      };
      const changes: StateChanges = {
        metadata: {
          metadata: { description: 'street', title: 'Test' },
          previous: { description: 'satellite' },
        },
      };

      const result = mergeChanges(pending, changes);

      expect(result.metadata?.metadata).toEqual({ description: 'street', title: 'Test' });
    });

    it('overwrites layers.orderChanged with the later value', () => {
      const pending: StateChanges = {
        layers: { orderChanged: { order: ['l1', 'l2'], previous: ['l2', 'l1'] } },
      };
      const changes: StateChanges = {
        layers: { orderChanged: { order: ['l2', 'l1', 'l3'], previous: ['l1', 'l2'] } },
      };

      const result = mergeChanges(pending, changes);

      expect(result.layers?.orderChanged?.order).toEqual(['l2', 'l1', 'l3']);
    });

    it('overwrites layerReorder with the later value', () => {
      const pending: StateChanges = {
        layerReorder: { layerId: 'l1', order: ['f1', 'f2'], previous: ['f2', 'f1'] },
      };
      const changes: StateChanges = {
        layerReorder: { layerId: 'l1', order: ['f2', 'f1', 'f3'], previous: ['f1', 'f2'] },
      };

      const result = mergeChanges(pending, changes);

      expect(result.layerReorder?.order).toEqual(['f2', 'f1', 'f3']);
    });

    it('overwrites groupReorder with the later value', () => {
      const pending: StateChanges = {
        groupReorder: { groupId: 'g1', featureIds: ['f1', 'f2'], previous: ['f2', 'f1'] },
      };
      const changes: StateChanges = {
        groupReorder: { groupId: 'g1', featureIds: ['f2', 'f1', 'f3'], previous: ['f1', 'f2'] },
      };

      const result = mergeChanges(pending, changes);

      expect(result.groupReorder?.featureIds).toEqual(['f2', 'f1', 'f3']);
    });
  });

  describe('uiStateChanged', () => {
    it('becomes true if either one is true', () => {
      const pending: StateChanges = { uiStateChanged: false };
      const changes: StateChanges = { uiStateChanged: true };

      const result = mergeChanges(pending, changes);

      expect(result.uiStateChanged).toBe(true);
    });

    it('stays false if both are false (in practice the key does not exist)', () => {
      const pending: StateChanges = {};
      const changes: StateChanges = {};

      const result = mergeChanges(pending, changes);

      expect(result.uiStateChanged).toBeUndefined();
    });

    it('keeps true when pending is true and changes has no uiStateChanged', () => {
      const pending: StateChanges = { uiStateChanged: true };
      const changes: StateChanges = { features: { created: [createTestFeature('f1')] } };

      const result = mergeChanges(pending, changes);

      expect(result.uiStateChanged).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('merges empty StateChanges objects', () => {
      const pending: StateChanges = {};
      const changes: StateChanges = {};

      const result = mergeChanges(pending, changes);

      expect(result).toEqual({});
    });

    it('when one side is empty (pending is empty)', () => {
      const pending: StateChanges = {};
      const changes: StateChanges = {
        features: { created: [createTestFeature('f1')] },
      };

      const result = mergeChanges(pending, changes);

      expect(result.features?.created).toHaveLength(1);
    });

    it('when one side is empty (changes is empty)', () => {
      const pending: StateChanges = {
        features: { created: [createTestFeature('f1')] },
      };
      const changes: StateChanges = {};

      const result = mergeChanges(pending, changes);

      expect(result.features?.created).toHaveLength(1);
    });

    it('when both sides have an update of the same feature (both are kept)', () => {
      const f1 = createTestFeature('f1');
      const f1Updated: Feature = { ...f1, geometry: { type: 'Point', coordinates: [1, 1] } };
      const f1Updated2: Feature = { ...f1, geometry: { type: 'Point', coordinates: [2, 2] } };

      const pending: StateChanges = {
        features: { updated: [{ id: 'f1', feature: f1Updated, previous: f1 }] },
      };
      const changes: StateChanges = {
        features: { updated: [{ id: 'f1', feature: f1Updated2, previous: f1Updated }] },
      };

      const result = mergeChanges(pending, changes);

      // Merging is a simple concatenation, so both entries are kept
      expect(result.features?.updated).toHaveLength(2);
    });

    it('when pending has no features and changes has created', () => {
      const pending: StateChanges = { uiStateChanged: true };
      const changes: StateChanges = {
        features: { created: [createTestFeature('f1')] },
      };

      const result = mergeChanges(pending, changes);

      expect(result.features?.created).toHaveLength(1);
      expect(result.uiStateChanged).toBe(true);
    });

    it('merges multiple fields at once', () => {
      const pending: StateChanges = {
        features: { created: [createTestFeature('f1')] },
        layers: { created: [createTestLayer('l1')] },
        selection: { type: 'feature', ids: ['f1'], previousType: null, previousIds: [] },
      };
      const changes: StateChanges = {
        features: { created: [createTestFeature('f2')] },
        mode: { mode: 'draw_point', previous: 'select' },
        uiStateChanged: true,
      };

      const result = mergeChanges(pending, changes);

      expect(result.features?.created).toHaveLength(2);
      expect(result.layers?.created).toHaveLength(1);
      expect(result.selection?.ids).toEqual(['f1']);
      expect(result.mode?.mode).toBe('draw_point');
      expect(result.uiStateChanged).toBe(true);
    });
  });
});
