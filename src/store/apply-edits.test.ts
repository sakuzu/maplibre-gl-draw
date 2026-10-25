// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edits of features a Store applies (`applyEdits`), in the in-memory Store and the Store of
 * rows alike
 *
 * - `set` merges `properties` and `style` key by key and writes the other fields whole
 * - `vertex-move`, `vertex-insert` and `vertex-delete` change the vertices named by their places,
 *   the two ends of a closed ring as one vertex
 * - The edits apply in their order, as one transaction, all of them or none; an edit of a feature
 *   that is not there is left out and counted
 * - Read-only refuses them with null; an edit that cannot apply throws invalid-input
 * - The notification is the one of the same writes made with `updateFeature`
 */

import { describe, expect, it } from 'vitest';
import type { FeatureEdit } from '../api/model.js';
import { DrawError } from '../shared/draw-error.js';
import { MemoryStore } from './memory.js';
import type { Store } from './store.js';
import { createTableStore } from './table-memory.js';
import type { Feature, StoreChange } from './types.js';

const RING = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
  [0, 0],
];

/** The features of the tests */
function features(): Feature[] {
  const base = {
    layerId: 'layer',
    groupId: undefined,
    style: {},
    visible: true,
    locked: false,
  };
  return [
    {
      ...base,
      id: 'point',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { name: 'P', kind: 1 },
      style: { pointColor: '#ff0000' },
    },
    {
      ...base,
      id: 'line',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
      },
      properties: {},
    },
    {
      ...base,
      id: 'area',
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [RING] },
      properties: {},
    },
    {
      ...base,
      id: 'points',
      type: 'MultiPoint',
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      properties: {},
    },
  ] as Feature[];
}

/** A Store with a layer and the features of the tests */
function filled(store: Store): Store {
  store.createLayer({
    id: 'layer',
    name: 'Layer',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    metadata: undefined,
    styleRule: undefined,
  });
  for (const feature of features()) store.createFeature(feature);
  return store;
}

const STORES: ReadonlyArray<[string, () => Store]> = [
  ['the in-memory Store', () => filled(new MemoryStore())],
  ['the Store of rows', () => filled(createTableStore().store)],
];

/** The Store and the notifications it gives from now on */
function watched(make: () => Store): { store: Store; notified: StoreChange[] } {
  const store = make();
  const notified: StoreChange[] = [];
  store.subscribe((change) => notified.push(change));
  return { store, notified };
}

/** The coordinates of a feature */
function coordinatesOf(store: Store, id: string): unknown {
  return (store.getFeature(id)?.geometry as { coordinates: unknown } | undefined)?.coordinates;
}

/** Runs fn and returns the code of the DrawError it throws */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DrawError) return error.code;
    throw error;
  }
  return undefined;
}

describe.each(STORES)('applyEdits of %s', (_name, make) => {
  it('sets the keys of properties and style one by one, and the other fields whole', () => {
    const { store } = watched(make);
    const result = store.applyEdits([
      {
        kind: 'set',
        featureId: 'point',
        patch: {
          properties: { kind: undefined, size: 3 },
          style: { pointRadius: 4 },
          visible: false,
          geometry: { type: 'Point', coordinates: [5, 5] },
        },
      },
    ]);
    expect(result).toEqual({ dropped: 0 });
    const point = store.getFeature('point');
    expect(point?.properties).toEqual({ name: 'P', size: 3 });
    expect(point?.style).toEqual({ pointColor: '#ff0000', pointRadius: 4 });
    expect(point?.visible).toBe(false);
    expect(point?.geometry).toEqual({ type: 'Point', coordinates: [5, 5] });
  });

  it('moves vertices to their positions, both ends of a closed ring together', () => {
    const { store } = watched(make);
    store.applyEdits([
      {
        kind: 'vertex-move',
        featureId: 'point',
        vertices: [{ ring: 0, index: 0 }],
        positions: [[3, 3]],
      },
      {
        kind: 'vertex-move',
        featureId: 'line',
        vertices: [
          { ring: 0, index: 1 },
          { ring: 0, index: 2 },
        ],
        positions: [
          [1, 5],
          [2, 6],
        ],
      },
      {
        kind: 'vertex-move',
        featureId: 'area',
        vertices: [{ ring: 0, index: 4 }],
        positions: [[-1, -1]],
      },
      {
        kind: 'vertex-move',
        featureId: 'points',
        vertices: [{ part: 1, ring: 0, index: 0 }],
        positions: [[7, 7]],
      },
    ]);
    expect(coordinatesOf(store, 'point')).toEqual([3, 3]);
    expect(coordinatesOf(store, 'line')).toEqual([
      [0, 0],
      [1, 5],
      [2, 6],
    ]);
    expect(coordinatesOf(store, 'area')).toEqual([
      [
        [-1, -1],
        [4, 0],
        [4, 4],
        [0, 4],
        [-1, -1],
      ],
    ]);
    expect(coordinatesOf(store, 'points')).toEqual([
      [0, 0],
      [7, 7],
    ]);
  });

  it('inserts a vertex after or before another, between the ends of a closed ring', () => {
    const { store } = watched(make);
    store.applyEdits([
      {
        kind: 'vertex-insert',
        featureId: 'line',
        after: { ring: 0, index: 0 },
        position: [0.5, 0],
      },
      {
        kind: 'vertex-insert',
        featureId: 'line',
        before: { ring: 0, index: 0 },
        position: [-1, 0],
      },
      {
        kind: 'vertex-insert',
        featureId: 'area',
        before: { ring: 0, index: 0 },
        position: [-1, 2],
      },
    ]);
    expect(coordinatesOf(store, 'line')).toEqual([
      [-1, 0],
      [0, 0],
      [0.5, 0],
      [1, 0],
      [2, 0],
    ]);
    expect(coordinatesOf(store, 'area')).toEqual([[...RING.slice(0, 4), [-1, 2], [0, 0]]]);

    const { store: other } = watched(make);
    other.applyEdits([
      { kind: 'vertex-insert', featureId: 'area', after: { ring: 0, index: 4 }, position: [2, -1] },
    ]);
    expect(coordinatesOf(other, 'area')).toEqual([
      [
        [0, 0],
        [2, -1],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
    ]);
  });

  it('deletes vertices, the first of a closed ring with its last position', () => {
    const { store } = watched(make);
    store.applyEdits([
      { kind: 'vertex-insert', featureId: 'area', after: { ring: 0, index: 1 }, position: [5, 2] },
      // The last position of the ring is its first vertex
      {
        kind: 'vertex-delete',
        featureId: 'area',
        vertices: [
          { ring: 0, index: 5 },
          { ring: 0, index: 2 },
        ],
      },
      { kind: 'vertex-delete', featureId: 'line', vertices: [{ ring: 0, index: 1 }] },
      { kind: 'vertex-delete', featureId: 'points', vertices: [{ part: 0, ring: 0, index: 0 }] },
    ]);
    expect(coordinatesOf(store, 'area')).toEqual([
      [
        [4, 0],
        [4, 4],
        [0, 4],
        [4, 0],
      ],
    ]);
    expect(coordinatesOf(store, 'line')).toEqual([
      [0, 0],
      [2, 0],
    ]);
    expect(coordinatesOf(store, 'points')).toEqual([[1, 1]]);
  });

  it('applies the edits in their order, in one notification', () => {
    const { store, notified } = watched(make);
    store.applyEdits([
      { kind: 'vertex-insert', featureId: 'line', after: { ring: 0, index: 2 }, position: [3, 0] },
      {
        kind: 'vertex-move',
        featureId: 'line',
        vertices: [{ ring: 0, index: 3 }],
        positions: [[3, 1]],
      },
      { kind: 'set', featureId: 'point', patch: { properties: { name: 'Q' } } },
      { kind: 'set', featureId: 'point', patch: { properties: { kind: 2 } } },
    ]);
    expect(coordinatesOf(store, 'line')).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 1],
    ]);
    expect(store.getFeature('point')?.properties).toEqual({ name: 'Q', kind: 2 });
    expect(notified).toHaveLength(1);
  });

  it('leaves out and counts the edits of a feature that is not there', () => {
    const { store } = watched(make);
    store.deleteFeature('line');
    const result = store.applyEdits([
      { kind: 'set', featureId: 'line', patch: { visible: false } },
      { kind: 'vertex-delete', featureId: 'missing', vertices: [{ ring: 0, index: 0 }] },
      { kind: 'set', featureId: 'point', patch: { visible: false } },
    ]);
    expect(result).toEqual({ dropped: 2 });
    expect(store.getFeature('point')?.visible).toBe(false);
    expect(store.getFeature('line')).toBeUndefined();
  });

  it('returns null while read-only, changing nothing', () => {
    const { store, notified } = watched(make);
    store.setReadOnly(true);
    notified.length = 0;
    expect(store.applyEdits([{ kind: 'set', featureId: 'point', patch: { visible: false } }])).toBe(
      null,
    );
    expect(store.getFeature('point')?.visible).toBe(true);
    expect(notified).toHaveLength(0);
  });

  it('throws invalid-input for an edit that cannot apply, writing none of the edits', () => {
    const wrong: Array<[string, FeatureEdit]> = [
      ['a vertex by its id', { kind: 'vertex-delete', featureId: 'line', vertices: ['v1'] }],
      [
        'a vertex out of range',
        {
          kind: 'vertex-move',
          featureId: 'line',
          vertices: [{ ring: 0, index: 3 }],
          positions: [[0, 0]],
        },
      ],
      [
        'a ring the feature does not have',
        { kind: 'vertex-delete', featureId: 'area', vertices: [{ ring: 1, index: 0 }] },
      ],
      [
        'positions that do not match the vertices',
        {
          kind: 'vertex-move',
          featureId: 'line',
          vertices: [{ ring: 0, index: 0 }],
          positions: [],
        },
      ],
      [
        'both after and before',
        {
          kind: 'vertex-insert',
          featureId: 'line',
          after: { ring: 0, index: 0 },
          before: { ring: 0, index: 1 },
          position: [0, 0],
        },
      ],
      ['neither after nor before', { kind: 'vertex-insert', featureId: 'line', position: [0, 0] }],
      [
        'a vertex inserted into a point',
        {
          kind: 'vertex-insert',
          featureId: 'point',
          after: { ring: 0, index: 0 },
          position: [0, 0],
        },
      ],
      [
        'a line left with one position',
        {
          kind: 'vertex-delete',
          featureId: 'line',
          vertices: [
            { ring: 0, index: 0 },
            { ring: 0, index: 1 },
          ],
        },
      ],
      [
        'a ring left with too few positions',
        {
          kind: 'vertex-delete',
          featureId: 'area',
          vertices: [
            { ring: 0, index: 1 },
            { ring: 0, index: 2 },
          ],
        },
      ],
      [
        'the last point of a MultiPoint',
        {
          kind: 'vertex-delete',
          featureId: 'points',
          vertices: [
            { part: 0, ring: 0, index: 0 },
            { part: 1, ring: 0, index: 0 },
          ],
        },
      ],
      [
        'a vertex given two positions',
        {
          kind: 'vertex-move',
          featureId: 'area',
          vertices: [
            { ring: 0, index: 0 },
            { ring: 0, index: 4 },
          ],
          positions: [
            [1, 1],
            [2, 2],
          ],
        },
      ],
      [
        'a position of three numbers',
        {
          kind: 'vertex-move',
          featureId: 'line',
          vertices: [{ ring: 0, index: 0 }],
          positions: [[0, 0, 1]],
        },
      ],
      [
        'a patch of the wrong shape',
        { kind: 'set', featureId: 'point', patch: { type: 'Circle' } as never },
      ],
      [
        'a geometry of another kind',
        {
          kind: 'set',
          featureId: 'point',
          patch: { geometry: { type: 'LineString', coordinates: [] } },
        },
      ],
      ['an unknown kind', { kind: 'transform', featureId: 'point' } as never],
    ];
    for (const [what, edit] of wrong) {
      const { store, notified } = watched(make);
      const before = store.getFeature('point');
      const edits: FeatureEdit[] = [
        { kind: 'set', featureId: 'point', patch: { visible: false } },
        edit,
      ];
      expect(
        codeOf(() => store.applyEdits(edits)),
        what,
      ).toBe('invalid-input');
      expect(store.getFeature('point')?.visible, what).toBe(true);
      expect(store.getFeature('point')?.properties, what).toEqual(before?.properties);
      expect(notified, what).toHaveLength(0);
    }
  });

  it('notifies as the same writes made with updateFeature do', () => {
    const edited = watched(make);
    edited.store.applyEdits([
      { kind: 'set', featureId: 'point', patch: { properties: { kind: undefined } } },
      {
        kind: 'vertex-move',
        featureId: 'line',
        vertices: [{ ring: 0, index: 1 }],
        positions: [[1, 5]],
      },
    ]);
    const updated = watched(make);
    updated.store.transact(() => {
      updated.store.updateFeature('point', { properties: { name: 'P' } });
      updated.store.updateFeature('line', {
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 5],
            [2, 0],
          ],
        },
      });
    });
    expect(edited.notified).toHaveLength(1);
    expect(edited.notified).toEqual(updated.notified);
  });

  it('notifies the selected features it edits as features updated', () => {
    const edited = watched(make);
    edited.store.setSelection('feature', ['point']);
    edited.notified.length = 0;
    edited.store.applyEdits([{ kind: 'set', featureId: 'point', patch: { properties: { n: 1 } } }]);
    const updated = watched(make);
    updated.store.setSelection('feature', ['point']);
    updated.notified.length = 0;
    updated.store.updateFeature('point', { properties: { name: 'P', kind: 1, n: 1 } });
    expect(edited.notified).toEqual(updated.notified);
    expect(edited.notified[0]?.features?.updated?.map((entry) => entry.id)).toEqual(['point']);
  });
});
