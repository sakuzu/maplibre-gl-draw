// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the load of a document of the library with groups, on the Store in memory and on the
 * Store of rows: both give the same document
 */

import { describe, expect, it } from 'vitest';
import { featuresInOrder } from '../../store/feature-stream.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { nativeDocument } from '../../test-support/native-document.js';
import { createResourceDeps } from '../../test-utils.js';
import { createDocument } from './document.js';

type Json = Record<string, unknown>;

const layer = (id: string, items: string[]): Json => ({
  id,
  name: id,
  visible: true,
  locked: false,
  opacity: 1,
  items,
});

const group = (id: string, layerId: string, featureIds: string[]): Json => ({
  id,
  name: id,
  visible: true,
  locked: false,
  layerId,
  featureIds,
});

const point = (id: string, layerId: string, groupId?: string): Json => ({
  id,
  type: 'Point',
  geometry: { type: 'Point', coordinates: [1, 1] },
  layerId,
  ...(groupId !== undefined && { groupId }),
  properties: { name: id },
  style: {},
  visible: true,
  locked: false,
});

/**
 * Two layers: in the first a feature, a group of two and a feature; in the second a group of one
 * only. The features are in the order they are drawn, as a document of the library writes them
 */
const twoLayers = (): Json =>
  nativeDocument({
    version: '4.0.0',
    layers: [layer('n1', ['x1', 'g1', 'x2']), layer('n2', ['g2'])],
    layerOrder: ['n1', 'n2'],
    groups: [group('g1', 'n1', ['m1', 'm2']), group('g2', 'n2', ['m3'])],
    features: [
      point('x1', 'n1'),
      point('m1', 'n1', 'g1'),
      point('m2', 'n1', 'g1'),
      point('x2', 'n1'),
      point('m3', 'n2', 'g2'),
    ],
  });

/** What the document reads back after a load: the layers, groups and features in their order */
async function loaded(store: Store, data: Json): Promise<Json> {
  const doc = createDocument(createResourceDeps(store));
  await doc.load(data as never);
  const saved = doc.toJSON();
  return {
    layers: (saved.layers ?? []).map((l) => [l.id, 'items' in l ? l.items : null]),
    layerOrder: saved.layerOrder,
    groups: (saved.groups ?? []).map((g) => [
      g.id,
      g.layerId,
      'featureIds' in g ? g.featureIds : null,
    ]),
    features: [...featuresInOrder(store)].map((f) => [f.id, f.layerId, f.groupId ?? null]),
  };
}

const stores = [
  ['memory', (): Store => new MemoryStore()],
  ['rows', (): Store => createTableStore().store],
] as const;

describe.each(stores)('a native load with groups on the Store %s', (_name, make) => {
  it('creates the groups with their members, at the places the layers list them', async () => {
    expect(await loaded(make(), twoLayers())).toEqual({
      layers: [
        ['n1', ['x1', 'g1', 'x2']],
        ['n2', ['g2']],
      ],
      layerOrder: ['n1', 'n2'],
      groups: [
        ['g1', 'n1', ['m1', 'm2']],
        ['g2', 'n2', ['m3']],
      ],
      features: [
        ['x1', 'n1', null],
        ['m1', 'n1', 'g1'],
        ['m2', 'n1', 'g1'],
        ['x2', 'n1', null],
        ['m3', 'n2', 'g2'],
      ],
    });
  });

  it('loads over a document with the same layer, group and feature ids', async () => {
    const store = make();
    await loaded(store, twoLayers());
    const again = await loaded(store, twoLayers());
    expect(again).toEqual(await loaded(make(), twoLayers()));
    expect([...featuresInOrder(store)]).toHaveLength(5);
  });

  it('gives a group the features that name it, those it does not list after the others', async () => {
    const data = nativeDocument({
      version: '4.0.0',
      layers: [layer('n1', ['g1', 'x1'])],
      layerOrder: ['n1'],
      // m3 names g1 without being listed; x1 is listed but names no group; "gone" is no feature
      groups: [group('g1', 'n1', ['m2', 'gone', 'x1', 'm1'])],
      features: [
        point('m1', 'n1', 'g1'),
        point('m2', 'n1', 'g1'),
        point('m3', 'n1', 'g1'),
        point('x1', 'n1'),
      ],
    });
    const result = await loaded(make(), data);
    expect(result.groups).toEqual([['g1', 'n1', ['m2', 'm1', 'm3']]]);
    expect(result.features).toEqual([
      ['m2', 'n1', 'g1'],
      ['m1', 'n1', 'g1'],
      ['m3', 'n1', 'g1'],
      ['x1', 'n1', null],
    ]);
  });
});

describe('a native load with groups', () => {
  it('gives the same document on the Store in memory and on the Store of rows', async () => {
    const [memory, rows] = await Promise.all(stores.map(([, make]) => loaded(make(), twoLayers())));
    expect(rows).toEqual(memory);
  });
});
