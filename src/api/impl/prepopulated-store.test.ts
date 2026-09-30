// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for a Store of the application that holds features before the instance is created,
 * replaces its document from elsewhere (`reset: true`) or receives features written from
 * outside the instance: every feature it holds is hit by a click and by a box selection, as a
 * feature drawn through the instance is. The Store gives the optional fields as `null`, as a
 * Store that keeps its document in a shared structure does; the instance reads them as
 * `undefined`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DragNormalizedEvent } from '../../dispatcher/types.js';
import { MemoryContractStore } from '../../store/memory.js';
import { createMapStub, createSyntheticInput } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DocumentChange } from '../events.js';
import type { Store } from '../extension/store.js';
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
  items: [],
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

/** Writes the layer and the three features into a contract, as a write from elsewhere */
function populate(contract: MemoryContractStore): void {
  contract.transact(() => {
    contract.createLayer(LAYER);
    contract.createFeature(POINT);
    contract.createFeature(LINE);
    contract.createFeature(POLYGON);
  }, 'remote');
}

/**
 * A Store of the application whose whole document can be replaced from elsewhere: it swaps the
 * contract it reads and notifies one change with `reset: true` listing what was replaced
 */
class ReplaceableStore {
  #inner = new MemoryContractStore();
  #unsubscribe: () => void;
  readonly #listeners = new Set<(changes: DocumentChange) => void>();
  readonly store: Store;

  constructor() {
    this.#unsubscribe = this.#inner.subscribe((changes) => this.#notify(changes));
    this.store = new Proxy({} as Store, {
      get: (_target, key) => {
        if (key === 'subscribe') {
          return (listener: (changes: DocumentChange) => void) => {
            this.#listeners.add(listener);
            return () => this.#listeners.delete(listener);
          };
        }
        const value = Reflect.get(this.#inner, key, this.#inner) as unknown;
        return typeof value === 'function' ? value.bind(this.#inner) : value;
      },
    });
  }

  get inner(): MemoryContractStore {
    return this.#inner;
  }

  /**
   * Replaces the document with the one of `next` in one step. `bare` sends `reset: true` alone,
   * listing nothing
   */
  replace(next: MemoryContractStore, bare = false): void {
    const previous = this.#inner;
    const before = previous.listFeatures();
    const layersBefore = previous.listLayers();
    this.#unsubscribe();
    this.#inner = next;
    this.#unsubscribe = next.subscribe((changes) => this.#notify(changes));
    if (bare) {
      this.#notify({ source: 'remote', reset: true });
      return;
    }
    this.#notify({
      source: 'remote',
      reset: true,
      features: { created: next.listFeatures(), deleted: before },
      layers: {
        created: next.listLayers(),
        deleted: layersBefore,
        orderChanged: { order: [...next.getLayerOrder()], previous: [...previous.getLayerOrder()] },
      },
    });
  }

  #notify(changes: DocumentChange): void {
    for (const listener of this.#listeners) listener(changes);
  }
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
  expect(target.draw.selection.get().ids).toEqual([POINT.id]);
  input.click([-1, -0.5]);
  expect(target.draw.selection.get().ids).toEqual([LINE.id]);
  input.click([1.5, 1.5]);
  expect(target.draw.selection.get().ids).toEqual([POLYGON.id]);

  target.draw.selection.clear();
  boxSelect(target.engine, [-2, -1], [2.5, 2.5]);
  expect([...target.draw.selection.get().ids].sort()).toEqual(
    [POINT.id, LINE.id, POLYGON.id].sort(),
  );
}

describe('a Store of the application with features the instance did not write', () => {
  it('reads the optional fields it gives as null as undefined', () => {
    const contract = new MemoryContractStore();
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
    contract.transact(() => contract.createFeature(feature('p2', POINT.geometry)), 'remote');
    expect(created).toEqual([undefined]);
  });

  it('hits the features it held before the instance was created', () => {
    const contract = new MemoryContractStore();
    populate(contract);
    const target = create(contract);
    expect(target.draw.features.list()).toHaveLength(3);
    expectEveryFeatureSelectable(target);
  });

  it('hits the features of a document that replaced the one it held', () => {
    const replaceable = new ReplaceableStore();
    const target = create(replaceable.store);
    const next = new MemoryContractStore();
    populate(next);
    replaceable.replace(next);
    expect(target.draw.features.list()).toHaveLength(3);
    expectEveryFeatureSelectable(target);
  });

  it('hits the features of a replacing document whose notification lists nothing', () => {
    const replaceable = new ReplaceableStore();
    const before = new MemoryContractStore();
    before.createLayer(LAYER);
    replaceable.replace(before);
    const target = create(replaceable.store);
    const next = new MemoryContractStore();
    populate(next);
    replaceable.replace(next, true);
    expectEveryFeatureSelectable(target);
  });

  it('hits them in front of a dataset on the stacking order', () => {
    const contract = new MemoryContractStore();
    populate(contract);
    const target = create(contract);
    target.draw.datasets.add({ id: 'behind', rows: [], order: 'layer-order' });
    expect(target.draw.layers.reorder(['behind', LAYER.id])).toBe(true);
    expectEveryFeatureSelectable(target);
  });

  it('hits the features written into it from outside the instance', () => {
    const contract = new MemoryContractStore();
    const target = create(contract);
    populate(contract);
    expect(target.draw.features.list()).toHaveLength(3);
    expectEveryFeatureSelectable(target);
  });
});
