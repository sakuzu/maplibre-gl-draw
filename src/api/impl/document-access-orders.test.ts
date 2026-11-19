// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The orders the layer over the Store gives with its layers and groups (`Layer.items`,
 * `Group.featureIds`) are those its reads of positions give (`listItemIds`,
 * `listGroupFeatureIds`) after every write that changes what a container holds, the writes made
 * to the Store directly included.
 */

import { describe, expect, it } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { Store } from '../../store/built-in/types.js';
import type { InstanceDocument } from '../../store/document-access.js';
import type { Feature, Group, Layer } from '../../store/types.js';
import { rowWrites } from '../../test-utils.js';
import { createDocumentAccess } from './document-access.js';

const layer = (id: string): Layer => ({
  id,
  name: id,
  visible: true,
  locked: false,
  opacity: 1,
  items: [],
  styleRule: undefined,
  metadata: undefined,
});

const group = (id: string, layerId: string, featureIds: string[] = []): Group => ({
  id,
  layerId,
  name: id,
  featureIds,
  visible: true,
  locked: false,
});

const feature = (id: string, layerId: string, groupId?: string): Feature => ({
  id,
  type: 'Point',
  geometry: { type: 'Point', coordinates: [0, 0] },
  layerId,
  groupId,
  properties: {},
  style: {},
  visible: true,
  locked: false,
});

/** The orders the layers and the groups give, and those the reads of positions give */
function orders(doc: InstanceDocument) {
  const layers = doc.listLayers();
  const groups = doc.listGroups();
  return {
    given: {
      layers: layers.map((l) => [l.id, [...l.items]]),
      groups: groups.map((g) => [g.id, [...g.featureIds]]),
    },
    read: {
      layers: layers.map((l) => [l.id, doc.listItemIds(l.id, 0, doc.countItems(l.id))]),
      groups: groups.map((g) => [
        g.id,
        doc.listGroupFeatureIds(g.id, 0, doc.countGroupFeatures(g.id)),
      ]),
    },
  };
}

describe('the orders of the layers and the groups', () => {
  it('are those of the reads of positions after every write that changes a container', () => {
    const store: Store = createStore();
    const doc = createDocumentAccess(store);
    const rows = rowWrites(store);
    /** Writes a change to the Store directly, as one made outside the instance */
    const remote = (fn: () => void) => () => store.transact(fn, 'remote');
    const steps: [string, () => void][] = [
      ['an empty group is created', () => doc.createGroup(group('g1', 'l1'))],
      ['a feature is created in it', () => doc.createFeature(feature('f1', 'l1', 'g1'))],
      ['its last feature is deleted', () => doc.deleteFeature('f1')],
      ['an empty group is created again', () => doc.createGroup(group('g1', 'l1'))],
      ['a feature is written into it', () => doc.updateFeature('b', { groupId: 'g1' })],
      ['another empty group is created', () => doc.createGroup(group('g4', 'l1'))],
      [
        'a feature is moved into it',
        () => doc.moveFeatures(['c'], { kind: 'group', groupId: 'g4' }),
      ],
      [
        'a feature is created in a group that holds one',
        () => doc.createFeature(feature('d', 'l1', 'g4')),
      ],
      ['an empty group is created in another layer', () => doc.createGroup(group('g6', 'l2'))],
      [
        'a feature of a group that keeps another is written into it',
        () => doc.updateFeature('d', { layerId: 'l2', groupId: 'g6' }),
      ],
      [
        'the feature is written out of its group, which it leaves empty',
        () => doc.updateFeature('d', { groupId: undefined }),
      ],
      ['a group moves to another layer', () => doc.moveGroups(['g1'], 'l2', undefined)],
      ['an empty group is created for the Store', () => doc.createGroup(group('g5', 'l1'))],
      [
        'a row is created in it in the Store',
        remote(() => rows.createFeature(feature('r1', 'l1', 'g5'))),
      ],
      [
        'the parent of the row is written out of the group in the Store',
        remote(() => rows.updateFeature('r1', { groupId: undefined })),
      ],
      [
        'the parent of the row is written into the group again in the Store',
        remote(() => rows.updateFeature('r1', { groupId: 'g5' })),
      ],
      [
        'the parent of the row is written into a group of another layer in the Store',
        remote(() => rows.updateFeature('r1', { layerId: 'l2', groupId: 'g1' })),
      ],
      ['the row is deleted in the Store', remote(() => rows.deleteFeature('r1'))],
      [
        'a row is created in the empty group in the Store',
        remote(() => rows.createFeature(feature('r2', 'l1', 'g5'))),
      ],
      ['the last row of the group is deleted in the Store', remote(() => rows.deleteFeature('r2'))],
    ];
    doc.createLayer(layer('l1'));
    doc.createLayer(layer('l2'));
    doc.createFeature(feature('a', 'l1'));
    doc.createFeature(feature('b', 'l1'));
    doc.createGroup(group('g2', 'l1', ['b']));
    doc.createFeature(feature('c', 'l1'));
    doc.createGroup(group('g3', 'l1', ['c']));
    const before = orders(doc);
    expect(before.given).toEqual(before.read);
    for (const [name, step] of steps) {
      step();
      const after = orders(doc);
      expect({ step: name, ...after.given }).toEqual({ step: name, ...after.read });
    }
  });
});
