// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edits that move, rotate and scale features (`translate`, `rotate`, `scale`), as a Store
 * applies them (`applyEdits`), in the in-memory Store and the Store of rows alike
 *
 * - The geometry is the one the computation gives (the library's when the Store gives none), and
 *   the fields of the roles change with it: a rotation within [0, 360), a size multiplied, a
 *   field not there yet started from 0 or 1, a feature that keeps its shape moved by the factor
 *   of its size
 * - A feature that is not there is left out and counted; a locked one is edited, as `set` edits
 *   it
 * - The edits apply in their order, all of them or none: an edit whose values the computation
 *   does not take throws invalid-input, and nothing is written
 * - A Store that gives its computation (`transforms`) has its edits computed by it
 * - The instance makes the selection (`{ selection: true }`) the IDs of the features selected;
 *   a Store given it throws
 * - The notification is the one of the same writes made with `updateFeature`
 */

import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { FeatureEdit } from '../api/model.js';
import { applyEnuEdit, type EnuEdit } from '../geometry/enu-transforms.js';
import { DrawError } from '../shared/draw-error.js';
import { DRAW_PROPERTY_KEYS } from '../shared/properties.js';
import { DrawStore } from './draw-store.js';
import { MemoryContractStore } from './memory.js';
import type { GeometryTransforms, Store, StoreContract, TransformEdit } from './store.js';
import { TableContractStore } from './table-memory.js';
import type { Feature, StoreChange } from './types.js';

type Translate = Extract<TransformEdit, { kind: 'translate' }>;
type Rotate = Extract<TransformEdit, { kind: 'rotate' }>;
type Scale = Extract<TransformEdit, { kind: 'scale' }>;

const ROTATION = DRAW_PROPERTY_KEYS.rotation;
const SCALE = DRAW_PROPERTY_KEYS.scale;
const RADIUS = DRAW_PROPERTY_KEYS.radiusMeters;

const RING = [
  [139.7, 35.6],
  [139.71, 35.6],
  [139.71, 35.61],
  [139.7, 35.61],
  [139.7, 35.6],
];

/** The features of the tests */
function features(): Feature[] {
  const base = { layerId: 'layer', groupId: undefined, style: {}, visible: true, locked: false };
  const at = (lng: number, lat: number): Geometry => ({ type: 'Point', coordinates: [lng, lat] });
  return [
    { ...base, id: 'point', type: 'Point', geometry: at(139.7, 35.6), properties: { name: 'P' } },
    {
      ...base,
      id: 'line',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [139.7, 35.6],
          [139.72, 35.62],
        ],
      },
      properties: {},
    },
    {
      ...base,
      id: 'area',
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [RING] },
      properties: { [ROTATION]: 350 },
      locked: true,
    },
    {
      ...base,
      id: 'image',
      type: 'Image',
      geometry: at(139.71, 35.61),
      properties: { [ROTATION]: 350, [SCALE]: 2, [DRAW_PROPERTY_KEYS.imageFileId]: 'file' },
    },
    {
      ...base,
      id: 'bare-image',
      type: 'Image',
      geometry: at(139.72, 35.6),
      properties: {},
    },
    {
      ...base,
      id: 'circle',
      type: 'Circle',
      geometry: at(139.69, 35.59),
      properties: { [RADIUS]: 100 },
    },
  ] as Feature[];
}

/** Fills a Store with a layer and the features of the tests */
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

type MakeContract = (transforms?: GeometryTransforms) => StoreContract;

const CONTRACTS: ReadonlyArray<[string, MakeContract]> = [
  [
    'the in-memory Store',
    (transforms) => new MemoryContractStore(transforms ? { transforms } : {}),
  ],
  ['the Store of rows', (transforms) => new TableContractStore({}, transforms)],
];

/** The Store of core over a contract, filled, and the notifications it gives from now on */
function watched(
  make: MakeContract,
  transforms?: GeometryTransforms,
  holdLimit?: number,
): { store: DrawStore; notified: StoreChange[] } {
  const store = new DrawStore(make(transforms), holdLimit === undefined ? {} : { holdLimit });
  filled(store);
  const notified: StoreChange[] = [];
  store.subscribe((change) => notified.push(change));
  return { store, notified };
}

/** The geometry of a feature */
function geometryOf(store: Store, id: string): Geometry | undefined {
  return store.getFeature(id)?.geometry;
}

/** The geometry the computation of the library gives a feature of the tests */
function expected(edit: EnuEdit, id: string, uniformScale = false): Geometry {
  const feature = features().find((f) => f.id === id) as Feature;
  return applyEnuEdit(edit, { geometry: feature.geometry, ...(uniformScale && { uniformScale }) })
    .geometry;
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

describe.each(CONTRACTS)('the edits that move, rotate and scale features of %s', (_name, make) => {
  it('moves features from a point to another, as the computation of the library does', () => {
    const { store } = watched(make);
    const edit: Translate = { kind: 'translate', from: [139.7, 35.6], to: [141.35, 43.06] };
    const result = store.applyEdits([
      { ...edit, target: { featureIds: ['point', 'line', 'area', 'missing'] } },
    ]);
    expect(result).toEqual({ dropped: 1 });
    for (const id of ['point', 'line', 'area'])
      expect(geometryOf(store, id)).toEqual(expected(edit, id));
    const point = (geometryOf(store, 'point') as { coordinates: number[] }).coordinates;
    expect(point[0]).toBeCloseTo(141.35, 9);
    expect(point[1]).toBeCloseTo(43.06, 9);
    // A move changes no field, and the features not named stay
    expect(store.getFeature('area')?.properties).toEqual({ [ROTATION]: 350 });
    expect(geometryOf(store, 'image')).toEqual(features()[3]?.geometry);
  });

  it('rotates features and adds the angle to their rotation, within [0, 360)', () => {
    const { store } = watched(make);
    const edit: Rotate = { kind: 'rotate', center: [139.705, 35.605], angleDegrees: 30 };
    store.applyEdits([
      { ...edit, target: { featureIds: ['line', 'area', 'image', 'bare-image', 'circle'] } },
    ]);
    expect(geometryOf(store, 'line')).toEqual(expected(edit, 'line'));
    expect(geometryOf(store, 'image')).toEqual(expected(edit, 'image'));
    expect(store.getFeature('area')?.properties[ROTATION]).toBeCloseTo(20, 9);
    expect(store.getFeature('image')?.properties).toEqual({
      [ROTATION]: expect.closeTo(20, 9),
      [SCALE]: 2,
      [DRAW_PROPERTY_KEYS.imageFileId]: 'file',
    });
    // A rotation not there yet starts from 0; a circle has none
    expect(store.getFeature('bare-image')?.properties).toEqual({ [ROTATION]: 30 });
    expect(store.getFeature('circle')?.properties).toEqual({ [RADIUS]: 100 });
  });

  it('scales features, multiplies their size, and moves the ones that keep their shape uniformly', () => {
    const { store } = watched(make);
    const edit: Scale = {
      kind: 'scale',
      center: [139.7, 35.6],
      eastFactor: 2,
      northFactor: 1,
      sizeFactor: 1.5,
    };
    store.applyEdits([
      { ...edit, target: { featureIds: ['area', 'image', 'bare-image', 'circle'] } },
    ]);
    expect(geometryOf(store, 'area')).toEqual(expected(edit, 'area'));
    expect(geometryOf(store, 'image')).toEqual(expected(edit, 'image', true));
    expect(geometryOf(store, 'circle')).toEqual(expected(edit, 'circle', true));
    expect(geometryOf(store, 'image')).not.toEqual(expected(edit, 'image'));
    expect(store.getFeature('image')?.properties[SCALE]).toBe(3);
    expect(store.getFeature('image')?.properties[ROTATION]).toBe(350);
    expect(store.getFeature('bare-image')?.properties).toEqual({ [SCALE]: 1.5 });
    expect(store.getFeature('circle')?.properties).toEqual({ [RADIUS]: 150 });
    // A feature whose size is not among its fields keeps them
    expect(store.getFeature('area')?.properties).toEqual({ [ROTATION]: 350 });
  });

  it('applies the edits in their order, with the edits of one feature, in one notification', () => {
    const { store, notified } = watched(make);
    const move: Translate = { kind: 'translate', from: [139.7, 35.6], to: [139.8, 35.7] };
    store.applyEdits([
      { ...move, target: { featureIds: ['point', 'line'] } },
      { kind: 'set', featureId: 'point', patch: { properties: { name: 'Q' } } },
      { ...move, target: { featureIds: ['point'] } },
      {
        kind: 'vertex-move',
        featureId: 'line',
        vertices: [{ ring: 0, index: 0 }],
        positions: [[0, 0]],
      },
      { kind: 'rotate', center: [0, 0], angleDegrees: 90, target: { featureIds: ['image'] } },
      { kind: 'rotate', center: [0, 0], angleDegrees: 90, target: { featureIds: ['image'] } },
    ]);
    const once = expected(move, 'point');
    const twice = applyEnuEdit(move, { geometry: once }).geometry;
    expect(geometryOf(store, 'point')).toEqual(twice);
    expect(store.getFeature('point')?.properties).toEqual({ name: 'Q' });
    const line = (geometryOf(store, 'line') as { coordinates: number[][] }).coordinates;
    expect(line[0]).toEqual([0, 0]);
    expect(line[1]).toEqual((expected(move, 'line') as { coordinates: number[][] }).coordinates[1]);
    expect(store.getFeature('image')?.properties[ROTATION]).toBeCloseTo(170, 9);
    expect(notified).toHaveLength(1);
  });

  it('writes none of the edits when the computation does not take one', () => {
    const wrong: Array<[string, FeatureEdit]> = [
      [
        'a latitude out of range',
        { kind: 'translate', from: [0, 91], to: [0, 0], target: { featureIds: ['line'] } },
      ],
      [
        'an angle out of range',
        { kind: 'rotate', center: [0, 0], angleDegrees: -180, target: { featureIds: ['line'] } },
      ],
      [
        'a factor of 0',
        {
          kind: 'scale',
          center: [0, 0],
          eastFactor: 0,
          northFactor: 1,
          sizeFactor: 1,
          target: { featureIds: ['line'] },
        },
      ],
      [
        'a factor that is not finite',
        {
          kind: 'scale',
          center: [0, 0],
          eastFactor: 1,
          northFactor: 1,
          sizeFactor: Number.POSITIVE_INFINITY,
          target: { featureIds: ['line'] },
        },
      ],
      [
        'a factor left out',
        {
          kind: 'scale',
          center: [0, 0],
          eastFactor: 1,
          northFactor: 1,
          target: { featureIds: ['line'] },
        } as never,
      ],
      [
        'a point of one number',
        { kind: 'translate', from: [0], to: [0, 0], target: { featureIds: ['line'] } },
      ],
      [
        'a feature named twice',
        {
          kind: 'translate',
          from: [0, 0],
          to: [1, 1],
          target: { featureIds: ['line', 'line'] },
        },
      ],
      [
        'a target of the wrong shape',
        { kind: 'translate', from: [0, 0], to: [1, 1], target: { ids: ['line'] } as never },
      ],
      [
        'a featureId in place of the target',
        { kind: 'translate', from: [0, 0], to: [1, 1], featureId: 'line' } as never,
      ],
    ];
    for (const [what, edit] of wrong) {
      const { store, notified } = watched(make);
      const before = geometryOf(store, 'point');
      expect(
        codeOf(() =>
          store.applyEdits([
            {
              kind: 'translate',
              from: [0, 0],
              to: [1, 1],
              target: { featureIds: ['point'] },
            },
            edit,
          ]),
        ),
        what,
      ).toBe('invalid-input');
      expect(geometryOf(store, 'point'), what).toEqual(before);
      expect(notified, what).toHaveLength(0);
    }
  });

  it('computes the edits by the computation the Store gives', () => {
    const calls: string[] = [];
    const transforms: GeometryTransforms = {
      accepts: (edit) => edit.kind !== 'rotate' || edit.angleDegrees !== 45,
      apply: (edit, values) => {
        calls.push(edit.kind);
        const [lng, lat] = (values.geometry as { coordinates: number[] }).coordinates as [
          number,
          number,
        ];
        return {
          ...values,
          geometry: { type: 'Point', coordinates: [lng + 1, lat] },
          ...('angle' in values && { angle: 7 }),
        };
      },
    };
    const { store } = watched(make, transforms);
    expect(store.transforms).toBe(transforms);
    store.applyEdits([
      {
        kind: 'rotate',
        center: [0, 0],
        angleDegrees: 30,
        target: { featureIds: ['point', 'image'] },
      },
    ]);
    expect(calls).toEqual(['rotate', 'rotate']);
    expect(geometryOf(store, 'point')).toEqual({ type: 'Point', coordinates: [140.7, 35.6] });
    expect(store.getFeature('image')?.properties[ROTATION]).toBe(7);
    expect(
      codeOf(() =>
        store.applyEdits([
          { kind: 'rotate', center: [0, 0], angleDegrees: 45, target: { featureIds: ['point'] } },
        ]),
      ),
    ).toBe('invalid-input');
    expect(geometryOf(store, 'point')).toEqual({ type: 'Point', coordinates: [140.7, 35.6] });
    // A geometry the feature cannot have is not written
    const wrong: GeometryTransforms = {
      accepts: () => true,
      apply: (_edit, values) => ({ ...values, geometry: { type: 'LineString', coordinates: [] } }),
    };
    const other = watched(make, wrong);
    expect(
      codeOf(() =>
        other.store.applyEdits([
          { kind: 'translate', from: [0, 0], to: [1, 1], target: { featureIds: ['point'] } },
        ]),
      ),
    ).toBe('invalid-input');
    expect(geometryOf(other.store, 'point')).toEqual(features()[0]?.geometry);
  });

  it('makes the selection the features selected, and a Store given it throws', () => {
    const edit: Translate = { kind: 'translate', from: [139.7, 35.6], to: [139.8, 35.6] };
    const { store } = watched(make);
    store.setSelection('feature', ['point', 'line']);
    expect(store.applyEdits([{ ...edit, target: { selection: true } }])).toEqual({ dropped: 0 });
    expect(geometryOf(store, 'point')).toEqual(expected(edit, 'point'));
    expect(geometryOf(store, 'line')).toEqual(expected(edit, 'line'));
    expect(geometryOf(store, 'area')).toEqual(features()[2]?.geometry);
    // The features of a layer selected
    const layer = watched(make);
    layer.store.setSelection('layer', ['layer']);
    layer.store.applyEdits([{ ...edit, target: { selection: true } }]);
    for (const feature of features()) {
      expect(geometryOf(layer.store, feature.id), feature.id).toEqual(
        expected(edit, feature.id, feature.type === 'Image' || feature.type === 'Circle'),
      );
    }
    // Nothing selected: nothing moves
    const none = watched(make);
    expect(none.store.applyEdits([{ ...edit, target: { selection: true } }])).toEqual({
      dropped: 0,
    });
    expect(geometryOf(none.store, 'point')).toEqual(features()[0]?.geometry);
    // The Store itself takes the features by their IDs only
    const contract = make();
    filled(new DrawStore(contract));
    expect(codeOf(() => contract.applyEdits([{ ...edit, target: { selection: true } }]))).toBe(
      'invalid-input',
    );
  });

  it('notifies as the same writes made with updateFeature do', () => {
    const edit: Rotate = { kind: 'rotate', center: [139.705, 35.605], angleDegrees: 30 };
    const edited = watched(make);
    edited.store.applyEdits([{ ...edit, target: { featureIds: ['line', 'image'] } }]);
    const updated = watched(make);
    updated.store.transact(() => {
      updated.store.updateFeature('line', { geometry: expected(edit, 'line') });
      updated.store.updateFeature('image', {
        geometry: expected(edit, 'image'),
        properties: {
          ...(features()[3]?.properties as Record<string, never>),
          [ROTATION]: (edited.store.getFeature('image')?.properties[ROTATION] as number) ?? 0,
        },
      });
    });
    expect(edited.notified).toHaveLength(1);
    expect(edited.notified).toEqual(updated.notified);
  });
});

describe('the edits that move, rotate and scale features of the Store of rows', () => {
  it('makes the features selected in bulk the selection', () => {
    const edit: Translate = { kind: 'translate', from: [139.7, 35.6], to: [139.8, 35.6] };
    const { store } = watched(CONTRACTS[1]?.[1] as MakeContract, undefined, 2);
    store.setSelection('feature', ['point', 'line', 'area']);
    expect(store.getSelection().bulk?.count).toBe(3);
    store.applyEdits([{ ...edit, target: { selection: true } }]);
    for (const id of ['point', 'line', 'area'])
      expect(geometryOf(store, id)).toEqual(expected(edit, id));
    expect(geometryOf(store, 'image')).toEqual(features()[3]?.geometry);
  });

  it('edits the rows held as features as features', () => {
    const edit: Scale = {
      kind: 'scale',
      center: [139.7, 35.6],
      eastFactor: 2,
      northFactor: 2,
      sizeFactor: 2,
    };
    const { store } = watched(CONTRACTS[1]?.[1] as MakeContract);
    store.setSelection('feature', ['image']);
    store.applyEdits([{ ...edit, target: { featureIds: ['image', 'point', 'line'] } }]);
    expect(geometryOf(store, 'image')).toEqual(expected(edit, 'image', true));
    expect(store.getFeature('image')?.properties[SCALE]).toBe(4);
    expect(geometryOf(store, 'line')).toEqual(expected(edit, 'line'));
    expect(geometryOf(store, 'point')).toEqual(expected(edit, 'point'));
  });
});
