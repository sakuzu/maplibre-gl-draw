// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work of one hit, one small box, one read of the snapping candidates and of the spatial
 * index itself, whose candidates come from the spatial index of the Store: it does not grow with
 * the number of features
 *
 * Each scene runs over 1,000 and over 10,000 points, in two documents: the points spread at the
 * same distance from each other (the area grows with them, the points around the click stay as
 * many), and the same points around the click with the others far away. What it counts (the
 * marks of the Store and of the instance, and what goes through the Store the instance was
 * given) must grow less than twice. The features the hit test is given are listed before it is
 * counted: listing them is the work of whoever calls it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { EngineModeContext } from '../../modes/handler.js';
import { queryFeaturesInBox } from '../../modes/select/box-selection.js';
import type { WorkCounts } from '../../shared/work-counts.js';
import { createStore } from '../../store/built-in/create-store.js';
import type { InstanceDocument } from '../../store/document-access.js';
import { StoreSpatialIndex } from '../../store/spatial/store-spatial-index.js';
import type { BoxSelection } from '../../store/types.js';
import {
  countsOf,
  createCountedInstance,
  createCountingStore,
  expectNotProportional,
  storeWorkDuring,
  workDuring,
} from '../../test-utils.js';
import type { FeatureInput } from '../model.js';
import { createDocumentAccess } from './document-access.js';

const instances: ReturnType<typeof createCountedInstance>[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

type Instance = ReturnType<typeof createCountedInstance>;

/** Where the scenes click, box and snap */
const AT: [number, number] = [0.5, 0.5];

/** A point at a position */
function pointAt(x: number, y: number): FeatureInput {
  return { type: 'Point', geometry: { type: 'Point', coordinates: [x, y] } };
}

/** `count` points 0.05 degrees apart on a square grid from the origin */
function spread(count: number): FeatureInput[] {
  const side = Math.ceil(Math.sqrt(count));
  return Array.from({ length: count }, (_, i) =>
    pointAt((i % side) * 0.05, Math.floor(i / side) * 0.05),
  );
}

/** 400 points 0.05 degrees apart around the place of the scenes, the others 100 degrees away */
function elsewhere(count: number): FeatureInput[] {
  return Array.from({ length: count }, (_, i) =>
    i < 400
      ? pointAt((i % 20) * 0.05, Math.floor(i / 20) * 0.05)
      : pointAt(100 + (i % 100) * 0.05, Math.floor(i / 100) * 0.05),
  );
}

const DOCUMENTS: ReadonlyArray<[string, (count: number) => FeatureInput[]]> = [
  ['the points spread at the same distance', spread],
  ['the points around the place, the others far away', elsewhere],
];

/** What the marks counted and what went through the Store while `fn` ran */
function workOf(
  instance: Instance,
  fn: () => void,
): WorkCounts & { featuresRead: number; featuresWritten: number } {
  let counted: WorkCounts | undefined;
  const through = storeWorkDuring(instance.storeWork, () => {
    counted = workDuring(instance.counts, fn);
  });
  return { ...(counted as WorkCounts), ...through };
}

/** What a scene measured, built once per size */
function measured<T>(measure: (size: number) => T): (size: number) => T {
  const results = new Map<number, T>();
  return (size) => {
    let result = results.get(size);
    if (result === undefined) {
      result = measure(size);
      results.set(size, result);
    }
    return result;
  };
}

/**
 * An instance over the points, then 1,024 points more far away in a layer in front of theirs: the
 * features the instance keeps made are then those of the 1,024, so that the points of the
 * document are read from their rows at both sizes
 */
function instanceOf(inputs: FeatureInput[]): Instance {
  const instance = createCountedInstance();
  instances.push(instance);
  const { draw } = instance;
  if (!draw.features.createMany(inputs)) throw new Error('not created');
  const front = draw.layers.create({ name: 'Front' });
  if (!front) throw new Error('no layer');
  const far = Array.from({ length: 1_024 }, (_, i) => ({
    ...pointAt(-100 - (i % 32) * 0.05, Math.floor(i / 32) * 0.05),
    layerId: front.id,
  }));
  if (!draw.features.createMany(far)) throw new Error('not created');
  return instance;
}

describe.each(DOCUMENTS)('over %s', (_name, documentOf) => {
  describe('one hit of a point', () => {
    const scene = measured((size) => {
      const instance = instanceOf(documentOf(size));
      const { engine } = instance;
      const point = engine.map.project(AT);
      let hit: unknown;
      const work = workOf(instance, () => {
        hit = engine.context.hitTestService.hitTest(point, (p) => engine.map.unproject([p.x, p.y]));
      });
      return { ...work, hit };
    });

    it('hits a point', () => {
      expect(scene(1_000).hit).not.toBeNull();
      expect(scene(10_000).hit).not.toBeNull();
    });

    it('touches as many rows', () => {
      expectNotProportional((size) => scene(size).rowsTouched + scene(size).featuresRead, 'rows');
    });

    it('makes as many features', () => {
      expectNotProportional((size) => scene(size).objectsCreated, 'the objects made', {
        zero: true,
      });
    });
  });

  describe('one selection by a small box', () => {
    const scene = measured((size) => {
      const instance = instanceOf(documentOf(size));
      const { engine } = instance;
      const box = {
        startPoint: [AT[0] - 0.07, AT[1] - 0.07],
        endPoint: [AT[0] + 0.07, AT[1] + 0.07],
        previousSelection: [],
      } as unknown as BoxSelection;
      let ids: string[] = [];
      const work = workOf(instance, () => {
        ids = queryFeaturesInBox(box, engine.context as unknown as EngineModeContext);
      });
      return { ...work, ids };
    });

    it('selects about ten points', () => {
      expect(scene(1_000).ids.length).toBe(9);
      expect(scene(10_000).ids.length).toBe(9);
    });

    it('touches as many rows', () => {
      expectNotProportional((size) => scene(size).rowsTouched + scene(size).featuresRead, 'rows');
    });
  });

  describe('one read of the snapping candidates', () => {
    const scene = measured((size) => {
      const instance = instanceOf(documentOf(size));
      const { engine } = instance;
      const lngLat = { lng: AT[0] + 0.001, lat: AT[1] + 0.001 };
      const point = engine.map.project([lngLat.lng, lngLat.lat]);
      let snapped: unknown;
      const work = workOf(instance, () => {
        snapped = engine.context.snapService.resolve(lngLat, point, {
          zoom: 10,
          modifiers: { shift: false, ctrl: false, alt: false, meta: false },
        }).target;
      });
      return { ...work, snapped };
    });

    it('snaps to a point', () => {
      expect(scene(1_000).snapped).toBeDefined();
      expect(scene(10_000).snapped).toBeDefined();
    });

    it('touches as many rows', () => {
      expectNotProportional((size) => scene(size).rowsTouched + scene(size).featuresRead, 'rows');
    });
  });
});

/**
 * The layer over a built-in Store of `size` points, the Store given to it wrapped to count what
 * goes through it, and a wrapper of the layer that counts the calls of its members
 */
function layerOf(size: number) {
  const store = createStore();
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  });
  const counting = createCountingStore(store);
  const layer = createDocumentAccess(counting.store);
  layer.createFeatures(
    spread(size).map((input, i) => ({
      id: `p${i}`,
      type: 'Point',
      geometry: input.geometry as GeoJSON.Point,
      layerId: 'l',
      groupId: undefined,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    })),
  );
  let calls = 0;
  const counted = new Proxy(layer, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as InstanceDocument;
  return { store, layer, counted, counting, calls: () => calls };
}

describe('the spatial index of an instance', () => {
  const made = measured((size) => {
    const { store, counted, counting, calls } = layerOf(size);
    let index: StoreSpatialIndex | undefined;
    let subscribed = 0;
    const subscribing = new Proxy(counted, {
      get(target, key) {
        if (key === 'subscribe') subscribed += 1;
        return Reflect.get(target, key, target);
      },
    });
    let counted0: WorkCounts | undefined;
    const through = storeWorkDuring(counting.work, () => {
      counted0 = workDuring(countsOf(store), () => {
        index = new StoreSpatialIndex(subscribing);
      });
    });
    return { ...(counted0 as WorkCounts), ...through, subscribed, calls: calls(), index };
  });

  it('reads no row when it is made, and does not subscribe', () => {
    expectNotProportional((size) => made(size).rowsTouched + made(size).featuresRead, 'rows', {
      zero: true,
    });
    expect(made(1_000).subscribed).toBe(0);
    expect(made(10_000).subscribed).toBe(0);
  });

  const written = measured((size) => {
    const { layer, counted, store, calls } = layerOf(size);
    const index = new StoreSpatialIndex(counted);
    const before = calls();
    // A write of the instance, then one to the Store directly
    layer.updateFeature('p0', { geometry: { type: 'Point', coordinates: [-1, -1] } });
    const ref = store.tables.getRowRef('p1') as number;
    store.transact(() => {
      store.writeRows({ rows: Int32Array.of(ref), fields: new Map(), deleted: Uint8Array.of(1) });
    }, 'remote');
    const after = calls();
    return { reads: after - before, found: index.findNear([-1, -1], 0) };
  });

  it('reads nothing for itself after a row is written', () => {
    expectNotProportional((size) => written(size).reads, 'the reads of the index', {
      zero: true,
    });
    expect(written(1_000).found).toEqual(['p0']);
    expect(written(10_000).found).toEqual(['p0']);
  });
});
