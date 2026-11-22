// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the reads of the place of one item and of the order of groups, and for the write that
 * makes a group with its features, of the layer over the Store
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { InstanceDocument } from '../../store/document-access.js';
import type { Feature, StoreChange } from '../../store/types.js';
import { createTestDocument } from '../../test-utils.js';

let doc: InstanceDocument;

function layer(id: string): void {
  doc.createLayer({
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

function point(id: string, layerId = 'l1', groupId?: string): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId,
    groupId,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}

function group(id: string, layerId = 'l1') {
  return { id, layerId, name: id, featureIds: [], visible: true, locked: false };
}

/** The items of a layer, from the back, with the features of each group after it in brackets */
function itemsOf(layerId = 'l1'): string[] {
  return doc
    .listItemIds(layerId, 0, doc.countItems(layerId))
    .map((id) =>
      doc.getGroup(id)
        ? `${id}[${doc.listGroupFeatureIds(id, 0, doc.countGroupFeatures(id)).join(',')}]`
        : id,
    );
}

beforeEach(() => {
  doc = createTestDocument();
  layer('l1');
  layer('l2');
  for (const id of ['a', 'b', 'c', 'd', 'e']) doc.createFeature(point(id));
  doc.createFeature(point('f', 'l2'));
});

describe('getItemPosition', () => {
  it('reads a feature in its layer, a feature in its group and a group in its layer', () => {
    expect(doc.createGroupWith(group('g'), ['b', 'c'])).toBe(true);
    expect(itemsOf()).toEqual(['a', 'g[b,c]', 'd', 'e']);
    expect(doc.getItemPosition('a')).toEqual({ containerId: 'l1', index: 0 });
    expect(doc.getItemPosition('e')).toEqual({ containerId: 'l1', index: 3 });
    expect(doc.getItemPosition('g')).toEqual({ containerId: 'l1', index: 1 });
    expect(doc.getItemPosition('c')).toEqual({ containerId: 'g', index: 1 });
    expect(doc.getItemPosition('f')).toEqual({ containerId: 'l2', index: 0 });
  });

  it('is undefined for an ID that names nothing, and for a group with no feature', () => {
    doc.createGroup(group('empty'));
    expect(doc.getItemPosition('nothing')).toBeUndefined();
    expect(doc.getItemPosition('empty')).toBeUndefined();
    expect(doc.getItemPosition('l1')).toBeUndefined();
  });
});

describe('sortGroupsInStackingOrder', () => {
  it('sorts by the stacking order of the layers, then the places in them', () => {
    doc.createGroupWith(group('back'), ['a']);
    doc.createGroupWith(group('front'), ['e']);
    doc.createGroupWith(group('other', 'l2'), ['f']);
    doc.createGroup(group('empty'));
    expect(doc.getLayerOrder()).toEqual(['l1', 'l2']);
    expect(doc.sortGroupsInStackingOrder(['empty', 'other', 'front', 'nothing', 'back'])).toEqual([
      'back',
      'front',
      'other',
      'empty',
    ]);
  });
});

describe('createGroupWith', () => {
  it('stands where the frontmost feature stood, its features in stacking order', () => {
    expect(doc.createGroupWith(group('g'), ['d', 'a', 'c'])).toBe(true);
    expect(itemsOf()).toEqual(['b', 'g[a,c,d]', 'e']);
    expect(doc.getFeature('a')?.groupId).toBe('g');
  });

  it('takes features out of another group, which goes once it is empty', () => {
    doc.createGroupWith(group('g'), ['b', 'c']);
    expect(doc.createGroupWith(group('h'), ['a', 'c'])).toBe(true);
    expect(itemsOf()).toEqual(['h[a,c]', 'g[b]', 'd', 'e']);
    expect(doc.createGroupWith(group('k'), ['b'])).toBe(true);
    expect(itemsOf()).toEqual(['h[a,c]', 'd', 'e', 'k[b]']);
    expect(doc.getGroup('g')).toBeUndefined();
  });

  it('with no feature, makes a group with none at the front of its layer', () => {
    expect(doc.createGroupWith(group('g'), [])).toBe(true);
    expect(doc.getGroup('g')?.layerId).toBe('l1');
    expect(doc.countGroupFeatures('g')).toBe(0);
    expect(itemsOf()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('is one change, and writes nothing while read-only', () => {
    const changes: StoreChange[] = [];
    doc.subscribe((change) => changes.push(change));
    doc.createGroupWith(group('g'), ['a', 'b']);
    expect(changes).toHaveLength(1);
    expect(changes[0].groups?.created?.map((created) => created.id)).toEqual(['g']);
    doc.setReadOnly(true);
    expect(doc.createGroupWith(group('h'), ['c'])).toBe(false);
    expect(doc.getGroup('h')).toBeUndefined();
  });
});
