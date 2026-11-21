// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.features: the standard methods, the errors, the refusals, the transactions
 * of the Many methods, move and the geometry verbs
 */

import type { Polygon } from 'geojson';
import { beforeEach, describe, expect, it } from 'vitest';
import type { InstanceDocument } from '../../store/document-access.js';
import type { StoreChange } from '../../store/types.js';
import {
  createResourceDeps,
  createTestDocument,
  createTestEdits,
  testFeatureBulk,
} from '../../test-utils.js';
import { DrawError } from '../errors.js';
import type { FeaturesCollection } from '../features.js';
import type { FeatureInput } from '../model.js';
import { createFeatures } from './features.js';

let store: InstanceDocument;
let features: FeaturesCollection;
let notifications: StoreChange[];

function layer(id: string, extra: { locked?: boolean; visible?: boolean } = {}) {
  store.createLayer({
    id,
    name: id,
    visible: extra.visible ?? true,
    locked: extra.locked ?? false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
}

function square(minX: number, minY: number, maxX: number, maxY: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
        [minX, minY],
      ],
    ],
  };
}

function point(id: string, extra: Partial<FeatureInput> = {}): FeatureInput {
  return { id, type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] }, ...extra };
}

function area(id: string, bounds: [number, number, number, number], extra = {}): FeatureInput {
  return { id, type: 'Polygon', geometry: square(...bounds), ...extra };
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

/** The IDs of the items of a layer */
function itemsOf(layerId: string): readonly string[] {
  return store.getLayer(layerId)?.items ?? [];
}

beforeEach(() => {
  // The layer over a built-in Store, with the bulk edits the deletions are written with
  const made = createTestEdits();
  store = made.store;
  layer('l1');
  layer('l2');
  features = createFeatures(createResourceDeps(store), testFeatureBulk(made.edits));
  notifications = [];
  store.subscribe((changes) => notifications.push(changes));
});

describe('reading', () => {
  beforeEach(() => {
    features.createMany([
      point('a'),
      point('b', { layerId: 'l2', visible: false }),
      area('c', [0, 0, 1, 1], { locked: true }),
    ]);
  });

  it('gets one feature, several and whether one exists', () => {
    expect(features.get('a')?.id).toBe('a');
    expect(features.get('x')).toBeUndefined();
    expect(features.getMany(['c', 'x', 'a']).map((f) => f?.id)).toEqual(['c', undefined, 'a']);
    expect(features.has('b')).toBe(true);
    expect(features.has('x')).toBe(false);
  });

  it('lists in stacking order and filters with every key given', () => {
    expect(features.list().map((f) => f.id)).toEqual(['a', 'c', 'b']);
    expect(features.list({ layerId: 'l1' }).map((f) => f.id)).toEqual(['a', 'c']);
    expect(features.list({ visible: false }).map((f) => f.id)).toEqual(['b']);
    expect(features.list({ type: 'Polygon', locked: true }).map((f) => f.id)).toEqual(['c']);
    expect(features.count()).toBe(3);
    expect(features.count({ layerId: 'l2' })).toBe(1);
  });

  it('throws invalidInput for a filter with an unknown key', () => {
    expect(codeOf(() => features.list({ name: 'x' } as never))).toBe('invalidInput');
  });

  it('keeps the features shown by themselves, their group and their layer with shown', () => {
    layer('l3', { visible: false });
    features.createMany([point('d', { layerId: 'l3' }), point('e'), point('f')]);
    store.createGroup({
      id: 'g',
      layerId: 'l1',
      name: 'g',
      featureIds: ['e'],
      visible: false,
      locked: false,
    });
    // f is hidden on this client only, which shown does not consult
    store.setLocallyHidden('f', true);
    expect(features.list({ shown: true }).map((f) => f.id)).toEqual(['a', 'c', 'f']);
    expect(features.list({ shown: false }).map((f) => f.id)).toEqual(['e', 'b', 'd']);
    // visible stays the feature's own flag
    expect(features.list({ visible: true, shown: false }).map((f) => f.id)).toEqual(['e', 'd']);
    expect(features.count({ shown: true })).toBe(3);
    expect(codeOf(() => features.list({ shown: 'yes' } as never))).toBe('invalidInput');
  });
});

describe('create', () => {
  it('creates in the active layer with the defaults and returns the stored feature', () => {
    const created = features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 2] },
    });
    expect(created).toEqual({
      id: 'id-1',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 2] },
      layerId: 'l1',
      groupId: undefined,
      properties: {},
      style: {},
      visible: true,
      locked: false,
    });
    expect(created).toBe(store.getFeature('id-1'));
  });

  it('puts a feature into a group and its layer', () => {
    features.create(point('m', { layerId: 'l2' }));
    store.createGroup({
      id: 'g',
      layerId: 'l2',
      name: 'g',
      featureIds: ['m'],
      visible: true,
      locked: false,
    });
    const created = features.create(point('n', { groupId: 'g' }));
    expect(created?.layerId).toBe('l2');
    expect(store.getGroup('g')?.featureIds).toEqual(['m', 'n']);
  });

  it('throws the codes of the contract and stores nothing', () => {
    features.create(point('a'));
    expect(codeOf(() => features.create(point('a')))).toBe('alreadyExists');
    expect(codeOf(() => features.create(point('l1')))).toBe('alreadyExists');
    expect(codeOf(() => features.create(point('b', { layerId: 'none' })))).toBe('notFound');
    expect(codeOf(() => features.create(point('b', { groupId: 'none' })))).toBe('notFound');
    expect(codeOf(() => features.create({ ...point('b'), type: '' }))).toBe('invalidInput');
    expect(codeOf(() => features.create({ ...point('b'), geometry: square(0, 0, 1, 1) }))).toBe(
      'invalidInput',
    );
    expect(codeOf(() => features.create(point('b', { style: { fillOpacity: 5 } })))).toBe(
      'invalidInput',
    );
    expect(codeOf(() => features.create({ ...point('b'), extra: 1 } as never))).toBe(
      'invalidInput',
    );
    expect(codeOf(() => features.create(null as never))).toBe('invalidInput');
    expect(features.count()).toBe(1);
  });

  it('throws invalidInput when the group is not in the layer given', () => {
    features.create(point('m'));
    store.createGroup({
      id: 'g',
      layerId: 'l1',
      name: 'g',
      featureIds: ['m'],
      visible: true,
      locked: false,
    });
    expect(codeOf(() => features.create(point('n', { groupId: 'g', layerId: 'l2' })))).toBe(
      'invalidInput',
    );
  });

  it('throws invalidState when there is no layer to put it in', () => {
    const empty = createTestDocument();
    const collection = createFeatures(createResourceDeps(empty));
    expect(codeOf(() => collection.create(point('a')))).toBe('invalidState');
  });

  it('returns null while read-only and stores nothing', () => {
    store.setReadOnly(true);
    expect(features.create(point('a'))).toBeNull();
    expect(features.has('a')).toBe(false);
  });
});

describe('createMany', () => {
  it('creates in one notification and returns the features in the order of the inputs', () => {
    notifications.length = 0;
    const created = features.createMany([point('a'), point('b')]);
    expect(created?.map((f) => f.id)).toEqual(['a', 'b']);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].features?.created).toHaveLength(2);
  });

  it('creates none when one input is wrong', () => {
    expect(codeOf(() => features.createMany([point('a'), point('b', { layerId: 'x' })]))).toBe(
      'notFound',
    );
    expect(codeOf(() => features.createMany([point('a'), point('a')]))).toBe('alreadyExists');
    expect(features.count()).toBe(0);
  });

  it('returns null while read-only', () => {
    store.setReadOnly(true);
    expect(features.createMany([point('a')])).toBeNull();
    expect(features.count()).toBe(0);
  });
});

describe('update', () => {
  beforeEach(() => {
    features.create(
      point('a', { properties: { name: 'A', kind: 1 }, style: { pointColor: '#ff0000' } }),
    );
  });

  it('merges properties and style key by key, and removes a key given as undefined', () => {
    const updated = features.update('a', {
      properties: { kind: undefined, size: 3 },
      style: { pointRadius: 4 },
      visible: false,
    });
    expect(updated?.properties).toEqual({ name: 'A', size: 3 });
    expect(updated?.style).toEqual({ pointColor: '#ff0000', pointRadius: 4 });
    expect(updated?.visible).toBe(false);
    expect(updated).toBe(store.getFeature('a'));
  });

  it('changes the geometry', () => {
    const updated = features.update('a', { geometry: { type: 'Point', coordinates: [5, 5] } });
    expect(updated?.geometry).toEqual({ type: 'Point', coordinates: [5, 5] });
  });

  it('throws notFound and invalidInput, changing nothing', () => {
    expect(codeOf(() => features.update('x', { visible: false }))).toBe('notFound');
    expect(codeOf(() => features.update('a', { layerId: 'l2' } as never))).toBe('invalidInput');
    // The type of a feature cannot change
    expect(codeOf(() => features.update('a', { type: 'Circle' } as never))).toBe('invalidInput');
    expect(codeOf(() => features.update('a', { geometry: square(0, 0, 1, 1) }))).toBe(
      'invalidInput',
    );
    expect(codeOf(() => features.update('a', { visible: 'no' } as never))).toBe('invalidInput');
    expect(features.get('a')?.visible).toBe(true);
  });

  it('refuses a change of a locked feature but lets its lock and visibility change', () => {
    store.updateLayer('l1', { locked: true });
    expect(features.update('a', { properties: { name: 'B' } })).toBeNull();
    expect(features.get('a')?.properties.name).toBe('A');
    expect(features.update('a', { visible: false })?.visible).toBe(false);
  });

  it('returns null while read-only', () => {
    store.setReadOnly(true);
    expect(features.update('a', { visible: false })).toBeNull();
  });
});

describe('updateMany', () => {
  beforeEach(() => {
    features.createMany([point('a'), point('b')]);
    notifications.length = 0;
  });

  it('changes every feature in one notification', () => {
    const updated = features.updateMany([
      { id: 'a', patch: { visible: false } },
      { id: 'b', patch: { properties: { n: 1 } } },
    ]);
    expect(updated?.map((f) => f.id)).toEqual(['a', 'b']);
    expect(notifications).toHaveLength(1);
  });

  it('changes nothing when one patch is wrong or one feature is locked', () => {
    expect(
      codeOf(() =>
        features.updateMany([
          { id: 'a', patch: { visible: false } },
          { id: 'x', patch: { visible: false } },
        ]),
      ),
    ).toBe('notFound');
    store.updateFeature('b', { locked: true });
    notifications.length = 0;
    expect(
      features.updateMany([
        { id: 'a', patch: { visible: false } },
        { id: 'b', patch: { properties: { n: 1 } } },
      ]),
    ).toBeNull();
    expect(features.get('a')?.visible).toBe(true);
    expect(notifications).toHaveLength(0);
  });
});

describe('delete and deleteMany', () => {
  beforeEach(() => {
    features.createMany([point('a'), point('b'), point('c', { locked: true })]);
  });

  it('deletes a feature', () => {
    expect(features.delete('a')).toBe(true);
    expect(features.has('a')).toBe(false);
  });

  it('throws notFound, and refuses a locked feature and read-only', () => {
    expect(codeOf(() => features.delete('x'))).toBe('notFound');
    expect(features.delete('c')).toBe(false);
    store.setReadOnly(true);
    expect(features.delete('a')).toBe(false);
    expect(features.count()).toBe(3);
  });

  it('deletes several in one notification, leaving the locked ones and counting the IDs that name nothing', async () => {
    expect(await features.deleteMany(['x'])).toEqual(
      expect.objectContaining({ changedCount: 0, missingCount: 1 }),
    );
    expect(await features.deleteMany(['c'])).toBeNull();
    expect(features.count()).toBe(3);
    notifications.length = 0;
    expect(await features.deleteMany(['a', 'b', 'c'])).toEqual(
      expect.objectContaining({ changedCount: 2, lockedCount: 1 }),
    );
    expect(features.list().map((f) => f.id)).toEqual(['c']);
    expect(notifications).toHaveLength(1);
  });
});

describe('move and moveMany', () => {
  beforeEach(() => {
    features.createMany([point('a'), point('b'), point('c'), point('d', { layerId: 'l2' })]);
    store.createGroup({
      id: 'g',
      layerId: 'l1',
      name: 'g',
      featureIds: ['b', 'c'],
      visible: true,
      locked: false,
    });
  });

  it('moves a feature to another layer, at the index or at the front', () => {
    expect(features.move('a', { layerId: 'l2', index: 0 })).toBe(true);
    expect(itemsOf('l2')).toEqual(['a', 'd']);
    expect(features.get('a')?.layerId).toBe('l2');
    features.move('a', { layerId: 'l2' });
    expect(itemsOf('l2')).toEqual(['d', 'a']);
  });

  it('moves a feature out of its group into a layer', () => {
    features.move('b', { layerId: 'l2' });
    expect(features.get('b')?.groupId).toBeUndefined();
    expect(store.getGroup('g')?.featureIds).toEqual(['c']);
    expect(itemsOf('l2')).toEqual(['d', 'b']);
  });

  it('moves a feature into a group at the index', () => {
    features.move('d', { groupId: 'g', index: 1 });
    expect(store.getGroup('g')?.featureIds).toEqual(['b', 'd', 'c']);
    expect(features.get('d')).toMatchObject({ groupId: 'g', layerId: 'l1' });
    expect(itemsOf('l2')).toEqual([]);
  });

  it('takes a feature out of its group just in front of the group', () => {
    features.move('b', { groupId: null });
    expect(itemsOf('l1')).toEqual(['a', 'g', 'b']);
    expect(features.get('b')?.groupId).toBeUndefined();
  });

  it('puts the features in the place of a group they leave empty', () => {
    features.moveMany(['c', 'b'], { groupId: null });
    expect(store.getGroup('g')).toBeUndefined();
    expect(itemsOf('l1')).toEqual(['a', 'b', 'c']);
  });

  it('keeps the stacking order of the features it moves', () => {
    expect(features.moveMany(['c', 'a', 'b'], { layerId: 'l2', index: 0 })).toBe(true);
    expect(itemsOf('l2')).toEqual(['a', 'b', 'c', 'd']);
    expect(store.getGroup('g')).toBeUndefined();
  });

  it('moves several in one notification', () => {
    notifications.length = 0;
    features.moveMany(['a', 'd'], { groupId: 'g' });
    expect(notifications).toHaveLength(1);
    expect(store.getGroup('g')?.featureIds).toEqual(['b', 'c', 'a', 'd']);
  });

  it('throws for a missing feature or target and a wrong target, moving nothing', () => {
    expect(codeOf(() => features.move('x', { layerId: 'l2' }))).toBe('notFound');
    expect(codeOf(() => features.moveMany(['a', 'x'], { layerId: 'l2' }))).toBe('notFound');
    expect(codeOf(() => features.move('a', { layerId: 'x' }))).toBe('notFound');
    expect(codeOf(() => features.move('a', { groupId: 'x' }))).toBe('notFound');
    expect(codeOf(() => features.move('a', {} as never))).toBe('invalidInput');
    expect(codeOf(() => features.move('a', { layerId: 'l2', index: -1 }))).toBe('invalidInput');
    expect(features.get('a')?.layerId).toBe('l1');
  });

  it('refuses read-only, a locked feature and a locked destination', () => {
    store.updateLayer('l2', { locked: true });
    expect(features.move('a', { layerId: 'l2' })).toBe(false);
    store.updateFeature('a', { locked: true });
    expect(features.move('a', { groupId: 'g' })).toBe(false);
    store.setReadOnly(true);
    expect(features.move('c', { groupId: null })).toBe(false);
    expect(itemsOf('l1')).toEqual(['a', 'g']);
  });
});

describe('isEditable', () => {
  it('is false for a lock of the feature, its group or its layer, and while read-only', () => {
    features.createMany([point('a'), point('b', { locked: true }), point('c', { layerId: 'l2' })]);
    store.createGroup({
      id: 'g',
      layerId: 'l1',
      name: 'g',
      featureIds: [],
      visible: true,
      locked: false,
    });
    features.create(point('d', { groupId: 'g' }));
    expect(['a', 'b', 'c', 'd'].map((id) => features.isEditable(id))).toEqual([
      true,
      false,
      true,
      true,
    ]);
    store.updateGroup('g', { locked: true });
    expect(features.isEditable('d')).toBe(false);
    store.updateLayer('l2', { locked: true });
    expect(features.isEditable('c')).toBe(false);
    store.setReadOnly(true);
    expect(features.isEditable('a')).toBe(false);
    expect(codeOf(() => features.isEditable('x'))).toBe('notFound');
  });
});

describe('getAppliedStyle', () => {
  it('puts the defaults, the layer rule and the style of the feature on top of each other', () => {
    features.create(area('a', [0, 0, 1, 1], { properties: { kind: 'x' } }));
    const base = features.getAppliedStyle('a');
    expect(base).toMatchObject({
      fillColor: '#ff0077',
      fillOpacity: 0.25,
      strokeColor: '#ff0077',
      strokeWidth: 2,
      lineStyle: 'solid',
      pointOpacity: 1,
      pointStrokeColor: '#ffffff',
      pointStrokeWidth: 2,
      imageOpacity: 1,
    });
    store.updateLayer('l1', { styleRule: { kind: 'single', color: '#00ff00' } });
    expect(features.getAppliedStyle('a')?.fillColor).toBe('#00ff00');
    features.update('a', { style: { fillColor: '#0000ff', strokeWidth: 5 } });
    expect(features.getAppliedStyle('a')).toMatchObject({ fillColor: '#0000ff', strokeWidth: 5 });
    expect(features.getAppliedStyle('x')).toBeUndefined();
  });

  it('gives the outline of a point marker apart from the stroke of lines and areas', () => {
    const point = features.create({
      type: 'Point',
      layerId: 'l1',
      geometry: { type: 'Point', coordinates: [0, 0] },
      style: { pointStrokeColor: '#000080', pointStrokeWidth: 1 },
    });
    if (!point) throw new Error('not created');
    expect(features.getAppliedStyle(point.id)).toMatchObject({
      pointStrokeColor: '#000080',
      pointStrokeWidth: 1,
      strokeColor: '#ff0077',
      strokeWidth: 2,
    });
    expect(
      codeOf(() =>
        features.create({
          type: 'Point',
          layerId: 'l1',
          geometry: { type: 'Point', coordinates: [0, 0] },
          style: { pointStrokeWidth: -1 },
        }),
      ),
    ).toBe('invalidInput');
    expect(codeOf(() => features.update(point.id, { style: { pointStrokeColor: 'nope' } }))).toBe(
      'invalidInput',
    );
  });

  it('takes the defaults of the circles and the images when the options give them', () => {
    const deps = createResourceDeps(store);
    const withStyle = createFeatures({
      ...deps,
      getStyleOptions: () => ({
        circle: { fillColor: 'blue', strokeWidth: 4 },
        image: { imageOpacity: 0.5 },
      }),
    });
    const base = {
      layerId: 'l1',
      groupId: undefined,
      properties: {},
      style: {},
      visible: true,
      locked: false,
    };
    store.createFeature({
      ...base,
      id: 'c',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] },
    });
    store.createFeature({
      ...base,
      id: 'i',
      type: 'Image',
      geometry: { type: 'Point', coordinates: [0, 0] },
    });
    features.create(area('p', [0, 0, 1, 1]));
    expect(withStyle.getAppliedStyle('c')).toMatchObject({
      fillColor: 'blue',
      strokeWidth: 4,
    });
    expect(withStyle.getAppliedStyle('p')).toMatchObject({
      fillColor: '#ff0077',
      strokeWidth: 2,
    });
    expect(withStyle.getAppliedStyle('i')?.imageOpacity).toBe(0.5);
    expect(features.getAppliedStyle('i')?.imageOpacity).toBe(1);
  });
});

describe('the geometry verbs', () => {
  beforeEach(() => {
    features.createMany([
      area('a', [0, 0, 10, 10]),
      area('b', [5, 0, 15, 10]),
      area('far', [50, 50, 51, 51]),
      {
        id: 'cut',
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [5, -5],
            [5, 15],
          ],
        },
      },
    ]);
  });

  it('union replaces the areas with the joined one', () => {
    const result = features.union(['a', 'b']);
    expect(result?.type).toBe('Polygon');
    expect(features.has('a') || features.has('b')).toBe(false);
    expect(result).toBe(store.getFeature(result?.id ?? ''));
  });

  it('intersection replaces the areas with their overlap, and null when they do not overlap', () => {
    expect(features.intersection(['a', 'far'])).toBeNull();
    expect(features.has('a')).toBe(true);
    const result = features.intersection(['a', 'b']);
    expect(result?.type).toBe('Polygon');
    expect(features.has('a') || features.has('b')).toBe(false);
  });

  it('difference replaces only the area subtracted from', () => {
    const result = features.difference('a', ['b']);
    expect(result).not.toBeNull();
    expect(features.has('a')).toBe(false);
    expect(features.has('b')).toBe(true);
  });

  it('split replaces the area with the parts and keeps the line', () => {
    const parts = features.split('a', 'cut');
    expect(parts).toHaveLength(2);
    expect(features.has('a')).toBe(false);
    expect(features.has('cut')).toBe(true);
  });

  it('buffer creates new areas and keeps the inputs', () => {
    const results = features.buffer(['cut'], { distanceMeters: 100 });
    expect(results).toHaveLength(1);
    expect(results?.[0].type).toBe('Polygon');
    expect(features.has('cut')).toBe(true);
    expect(features.buffer(['cut'], { distanceMeters: 0 })).toEqual([]);
  });

  it('throws notFound and invalidInput', () => {
    expect(codeOf(() => features.union(['a', 'x']))).toBe('notFound');
    expect(codeOf(() => features.union(['a', 'cut']))).toBe('invalidInput');
    expect(codeOf(() => features.union(['a']))).toBe('invalidInput');
    expect(codeOf(() => features.union([]))).toBe('invalidInput');
    expect(codeOf(() => features.intersection(['a']))).toBe('invalidInput');
    expect(codeOf(() => features.difference('a', ['a']))).toBe('invalidInput');
    expect(codeOf(() => features.split('a', 'b'))).toBe('invalidInput');
    expect(codeOf(() => features.buffer(['a'], { distanceMeters: Number.NaN }))).toBe(
      'invalidInput',
    );
    expect(features.count()).toBe(4);
  });

  it('returns null while read-only or when an input is locked', () => {
    store.updateFeature('b', { locked: true });
    expect(features.union(['a', 'b'])).toBeNull();
    expect(features.split('b', 'cut')).toBeNull();
    store.setReadOnly(true);
    expect(features.intersection(['a', 'far'])).toBeNull();
    expect(features.difference('a', ['b'])).toBeNull();
    expect(features.buffer(['a'], { distanceMeters: 10 })).toBeNull();
    expect(features.count()).toBe(4);
  });
});
