// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for a Store of the application that holds features before the instance is created,
 * replaces its document from elsewhere (`reset: true`) or receives features written from
 * outside the instance: every feature it holds is hit by a click and by a box selection, as a
 * feature drawn through the instance is. The Store gives the optional fields as `null`, as a
 * Store that keeps its document in a shared structure does; the instance reads them as
 * `undefined`.
 *
 * The Store of the application is the built-in Store spread into an object of its own, written
 * with rows of the source `'remote'`; it replaces its document with `clear`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DragNormalizedEvent } from '../../dispatcher/types.js';
import { createStore } from '../../store/built-in/create-store.js';
import type { Store } from '../../store/built-in/types.js';
import { createMapStub, createSyntheticInput, rowWrites } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { Feature, Layer } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

/** A layer whose optional fields are `null` */
const LAYER = {
  id: 'remote-layer',
  name: 'Remote',
  visible: true,
  locked: false,
  opacity: 1,
  styleRule: null,
  metadata: null,
} as unknown as Layer;

/** A feature whose optional field (`groupId`) is `null` */
function feature(id: string, geometry: Feature['geometry']): Feature {
  return {
    id,
    type: geometry.type as Feature['type'],
    geometry,
    properties: {},
    layerId: LAYER.id,
    groupId: null,
    style: {},
    visible: true,
    locked: false,
  } as unknown as Feature;
}

const POINT = feature('p1', { type: 'Point', coordinates: [0.5, 0.5] });
const LINE = feature('l1', {
  type: 'LineString',
  coordinates: [
    [-1.5, -0.5],
    [-0.5, -0.5],
  ],
});
const POLYGON = feature('g1', {
  type: 'Polygon',
  coordinates: [
    [
      [1, 1],
      [2, 1],
      [2, 2],
      [1, 2],
      [1, 1],
    ],
  ],
});

/** The writes of the layer and the three features, as rows */
function writeDocument(store: Store): void {
  const rows = rowWrites(store);
  store.createLayer(LAYER);
  rows.createFeature(POINT);
  rows.createFeature(LINE);
  rows.createFeature(POLYGON);
}

/** Writes the layer and the three features into a Store, as a write from elsewhere */
function populate(store: Store): void {
  store.transact(() => writeDocument(store), 'remote');
}

/** A Store of the application: the built-in Store spread into an object of its own */
function applicationStore(): Store {
  return { ...createStore() };
}

/**
 * Replaces the whole document of a Store with the layer and the three features, from elsewhere:
 * `clear` and the writes in one transaction. `bare` writes them in two parts of one operation,
 * so that the change with `reset: true` lists nothing
 */
function replace(store: Store, bare = false): void {
  if (!bare) {
    store.transact(() => {
      store.clear();
      writeDocument(store);
    }, 'remote');
    return;
  }
  const operationId = store.newOperationId();
  store.transact(() => store.clear(), 'remote', { operationId, hasMoreParts: true });
  store.transact(() => writeDocument(store), 'remote', { operationId });
}

let engine: Engine | null = null;
let draw: Draw | null = null;

function create(store: Store): { engine: Engine; draw: Draw } {
  vi.useFakeTimers();
  engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  return { engine, draw };
}

afterEach(() => {
  draw?.destroy();
  draw = null;
  engine = null;
  vi.useRealTimers();
});

/** A Shift-drag from one position to the other, through the input router */
function boxSelect(target: Engine, from: [number, number], to: [number, number]): void {
  const at = (type: DragNormalizedEvent['type'], lngLat: [number, number]) => {
    const point = target.map.project(lngLat);
    const start = target.map.project(from);
    const event: DragNormalizedEvent = {
      type,
      point: { x: point.x, y: point.y },
      lngLat: { lng: lngLat[0], lat: lngLat[1] },
      originalEvent: {} as MouseEvent,
      modifiers: { shift: true, ctrl: false, alt: false, meta: false },
      dragStartPoint: { x: start.x, y: start.y },
      dragStartLngLat: { lng: from[0], lat: from[1] },
    };
    target.inputRouter.dispatch(event);
  };
  at('dragstart', from);
  at('dragmove', to);
  at('dragend', to);
}

/** Every feature of the Store is hit by a click and by a box selection */
function expectEveryFeatureSelectable(target: { engine: Engine; draw: Draw }): void {
  const input = createSyntheticInput(target.engine);
  input.click([0.5, 0.5]);
  expect(target.draw.selection.get().ids.toArray()).toEqual([POINT.id]);
  input.click([-1, -0.5]);
  expect(target.draw.selection.get().ids.toArray()).toEqual([LINE.id]);
  input.click([1.5, 1.5]);
  expect(target.draw.selection.get().ids.toArray()).toEqual([POLYGON.id]);

  target.draw.selection.clear();
  boxSelect(target.engine, [-2, -1], [2.5, 2.5]);
  expect(target.draw.selection.get().ids.toArray().sort()).toEqual(
    [POINT.id, LINE.id, POLYGON.id].sort(),
  );
}

describe('a Store of the application with features the instance did not write', () => {
  it('reads the optional fields it gives as null as undefined', () => {
    const contract = applicationStore();
    populate(contract);
    const target = create(contract);
    const read = target.draw.features.get(POINT.id);
    expect(read).toBeDefined();
    expect(read?.groupId).toBeUndefined();
    expect(target.draw.features.list().every((f) => f.groupId === undefined)).toBe(true);
    const layer = target.draw.layers.get(LAYER.id);
    expect(layer?.metadata).toBeUndefined();
    expect(layer?.styleRule).toBeUndefined();
    // The same object of the Store reads as the same object
    expect(target.engine.context.store.getFeature(POINT.id)).toBe(
      target.engine.context.store.getFeature(POINT.id),
    );

    const created: unknown[] = [];
    target.draw.on('feature.created', ({ feature }) => created.push(feature.groupId));
    contract.transact(
      () => rowWrites(contract).createFeature(feature('p2', POINT.geometry)),
      'remote',
    );
    expect(created).toEqual([undefined]);
  });

  it('hits the features it held before the instance was created', () => {
    const contract = applicationStore();
    populate(contract);
    const target = create(contract);
    expect(target.draw.features.list()).toHaveLength(3);
    expectEveryFeatureSelectable(target);
  });

  it('hits the features of a document that replaced the one it held', () => {
    const replaceable = applicationStore();
    const target = create(replaceable);
    replace(replaceable);
    expect(target.draw.features.list()).toHaveLength(3);
    expectEveryFeatureSelectable(target);
  });

  it('hits the features of a replacing document whose notification lists nothing', () => {
    const replaceable = applicationStore();
    replaceable.transact(() => replaceable.createLayer(LAYER), 'remote');
    const target = create(replaceable);
    replace(replaceable, true);
    expectEveryFeatureSelectable(target);
  });

  it('hits them in front of a dataset on the stacking order', () => {
    const contract = applicationStore();
    populate(contract);
    const target = create(contract);
    target.draw.datasets.add({ id: 'behind', rows: [], order: 'layerOrder' });
    expect(target.draw.layers.reorder(['behind', LAYER.id])).toBe(true);
    expectEveryFeatureSelectable(target);
  });

  it('hits the features written into it from outside the instance', () => {
    const contract = applicationStore();
    const target = create(contract);
    populate(contract);
    expect(target.draw.features.list()).toHaveLength(3);
    expectEveryFeatureSelectable(target);
  });
});
