// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The exports of a Store of rows: every feature is made from its row one at
 * a time, in the order the rows are drawn, without listing the features; the layers and the
 * groups carry the items and the members read from the rows. What is exported loads into a Store
 * of objects as the same document. Emptying the document deletes the rows a layer at a time.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteFeaturesAndGroups, featuresInOrder } from '../../../store/feature-stream.js';
import { MemoryStore } from '../../../store/memory.js';
import type { Store } from '../../../store/store.js';
import { createTableStore } from '../../../store/table-memory.js';
import type { Data, Feature, Group, Layer } from '../../../store/types.js';
import { exportGeoJSON } from './geojson-export.js';
import { exportNative, prepareNative } from './native-format.js';

function tableLayer(id: string, extra: Partial<Layer> = {}): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
    ...extra,
  } as Layer;
}

function tableGroup(id: string, layerId: string, extra: Partial<Group> = {}): Group {
  return { id, layerId, name: id, visible: true, locked: false, kind: 'table', ...extra } as Group;
}

function point(id: string, x: number, extra: Partial<Feature> = {}): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [x, x / 2] },
    layerId: 'l1',
    groupId: undefined,
    properties: { name: `P ${x}` },
    style: {},
    visible: true,
    locked: false,
    ...extra,
  };
}

let store: Store;

beforeEach(() => {
  store = createTableStore().store;
  store.createLayer(tableLayer('l1'));
  store.createLayer(tableLayer('l2', { visible: false }));
  store.createGroup(tableGroup('g', 'l1'));
  store.createFeature(point('a', 0));
  store.createFeature(point('b', 1, { groupId: 'g' }));
  store.createFeature(point('c', 2, { visible: false }));
  store.createFeature(point('d', 3, { groupId: 'g' }));
  store.createFeature(point('e', 4, { layerId: 'l2' }));
  store.createFeature(point('f', 5));
});

/**
 * The native export of a Store as `document.toJSON` writes it: its features GeoJSON Features, as
 * a document of the version written is read
 */
function documentOf(from: Store): Data {
  return exportNative(from) as unknown as Data;
}

/** The ids of the features of a GeoJSON export, in its order */
const idsOf = (collection: { features: Array<{ id?: unknown }> }): unknown[] =>
  collection.features.map((feature) => feature.id);

describe('the features of a Store of rows read one at a time', () => {
  it('makes a feature of a row only when it is reached, and never lists the features', () => {
    const listFeatures = vi.spyOn(store, 'listFeatures');
    const listInOrder = vi.spyOn(store, 'listFeaturesInOrder');
    const getFeature = vi.spyOn(store, 'getFeature');
    const reader = featuresInOrder(store);
    expect(getFeature).not.toHaveBeenCalled();
    expect(reader.next().value?.id).toBe('a');
    expect(reader.next().value?.id).toBe('b');
    expect(getFeature).toHaveBeenCalledTimes(2);
    expect([...reader].map((feature) => feature.id)).toEqual(['d', 'c', 'f', 'e']);
    expect(getFeature).toHaveBeenCalledTimes(6);
    expect(listFeatures).not.toHaveBeenCalled();
    expect(listInOrder).not.toHaveBeenCalled();
  });

  it('gives each feature as the Store reads it, without a deleted one', () => {
    store.deleteFeature('d');
    store.updateFeature('a', { properties: { name: 'A' } });
    const features = [...featuresInOrder(store)];
    expect(features.map((feature) => feature.id)).toEqual(['a', 'b', 'c', 'f', 'e']);
    for (const feature of features) expect(feature).toEqual(store.getFeature(feature.id));
  });
});

describe('the GeoJSON export of a Store of rows', () => {
  it('writes the shown features in the order they are drawn, then the hidden ones', () => {
    const listFeatures = vi.spyOn(store, 'listFeatures');
    expect(idsOf(exportGeoJSON(store))).toEqual(['a', 'b', 'd', 'f', 'c', 'e']);
    expect(listFeatures).not.toHaveBeenCalled();
  });

  it('keeps only the features and the layers named', () => {
    expect(idsOf(exportGeoJSON(store, { featureIds: ['f', 'c', 'a'] }))).toEqual(['a', 'f', 'c']);
    expect(idsOf(exportGeoJSON(store, { layerIds: ['l2'] }))).toEqual(['e']);
    expect(idsOf(exportGeoJSON(store, { featureIds: ['a', 'e'], layerIds: ['l2'] }))).toEqual([
      'e',
    ]);
  });

  it('writes what the export of the same document held as objects writes', async () => {
    const objects = new MemoryStore();
    const { write } = await prepareNative(documentOf(store), { store: objects });
    objects.transact(() => write());
    expect(exportGeoJSON(store)).toEqual(exportGeoJSON(objects));
    expect(exportGeoJSON(store, { layerIds: ['l1'] })).toEqual(
      exportGeoJSON(objects, { layerIds: ['l1'] }),
    );
  });
});

describe('the native export of a Store of rows', () => {
  it('writes the features in the order they are drawn, and the items and members read from the rows', () => {
    const data = exportNative(store);
    expect(data.features.map((feature) => feature.id)).toEqual(['a', 'b', 'd', 'c', 'f', 'e']);
    const layers = data.layers ?? [];
    const groups = data.groups ?? [];
    const l1 = layers.find((layer) => layer.id === 'l1');
    expect(l1 && 'items' in l1 ? l1.items : undefined).toEqual(['a', 'g', 'c', 'f']);
    const g = groups.find((group) => group.id === 'g');
    expect(g && 'featureIds' in g ? g.featureIds : undefined).toEqual(['b', 'd']);
    for (const layer of layers) expect('kind' in layer).toBe(false);
    for (const group of groups) expect('kind' in group).toBe(false);
  });

  it('loads into a Store of objects as the same document', async () => {
    const objects = new MemoryStore();
    const { write } = await prepareNative(documentOf(store), { store: objects });
    objects.transact(() => write());
    expect(objects.listFeaturesInOrder().map((feature) => feature.id)).toEqual([
      'a',
      'b',
      'd',
      'c',
      'f',
      'e',
    ]);
    for (const feature of objects.listFeatures()) {
      expect(feature).toEqual(store.getFeature(feature.id));
    }
  });
});

describe('emptying a Store of rows', () => {
  it('deletes the rows of each layer in one write and every group, keeping the layers', () => {
    const restoreRows = vi.spyOn(store, 'restoreRows');
    store.transact(() => deleteFeaturesAndGroups(store));
    expect(restoreRows).toHaveBeenCalledTimes(2);
    expect([...featuresInOrder(store)]).toEqual([]);
    expect(store.listGroups()).toEqual([]);
    expect(store.listLayers().map((layer) => layer.id)).toEqual(['l1', 'l2']);
    expect(exportGeoJSON(store).features).toEqual([]);
  });
});
