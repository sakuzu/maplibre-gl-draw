// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work of a feature created after a feature was deleted, which does not grow with the number
 * of features: the layer over the Store keeps the keys of the ends of a layer while the features
 * deleted are not at an end, so the feature created at the front does not read the order
 *
 * The rows read are those the instance reads through the Store, counted by a wrapper of its
 * tables: the rows of the values read and of the lists of rows and items, and every item of a
 * layer when its number of items is read, as the tables count the items again from every row
 * after a write.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { Store } from '../../store/built-in/types.js';
import { createMapStub, expectNotProportional, gridPoints, rowWrites } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { Feature } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
  vi.useRealTimers();
});

/** The methods of a view of a layer that list rows or items, by the place of their count */
const LISTS: ReadonlyMap<string, number> = new Map([
  ['listRowRefs', 1],
  ['listItemRefs', 1],
  ['listGroupMembers', 2],
]);

/** A Store whose tables count the rows the instance reads through them */
function countingStore() {
  const base = createStore();
  const work = { rows: 0 };
  const views = new WeakMap<object, object>();
  const view = (target: object): object => {
    const known = views.get(target);
    if (known) return known;
    const proxy = new Proxy(target, {
      get(t, prop) {
        const value: unknown = Reflect.get(t, prop, t);
        if (prop === 'itemCount') work.rows += value as number;
        if (typeof value !== 'function' || typeof prop !== 'string') return value;
        return (...args: unknown[]) => {
          const at = LISTS.get(prop);
          if (at !== undefined) work.rows += Number(args[at] ?? 0);
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
    views.set(target, proxy);
    return proxy;
  };
  const tables = new Proxy(base.tables, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        if (prop === 'readValues') work.rows += (args[0] as Int32Array).length;
        const result = (value as (...a: unknown[]) => unknown).apply(t, args);
        return prop === 'get' && typeof result === 'object' && result !== null
          ? view(result)
          : result;
      };
    },
  });
  const store = { ...base, tables } as Store;
  return { base, store, work };
}

/** An instance over a counting Store */
function instance() {
  vi.useFakeTimers();
  const host = countingStore();
  const engine = createEngine(
    createMapStub().map,
    { store: host.store },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store: host.store });
  engine.enterDefaultMode();
  draws.push(draw);
  return { ...host, draw };
}

/** A point */
function point(x: number) {
  return { type: 'Point', geometry: { type: 'Point' as const, coordinates: [x, 0.5] } };
}

/** The IDs of the items of the default layer, in order */
function items(draw: Draw): string[] {
  const id = draw.layers.getActive()?.id as string;
  return [...draw.layers.listItemIds(id, { start: 0, end: draw.layers.countItems(id) })];
}

describe('a feature created after a feature was deleted', () => {
  it('does not read the order while the features deleted are not at an end', () => {
    expectNotProportional((size) => {
      const { draw, work } = instance();
      const ids = (draw.features.createMany(gridPoints(size)) as Feature[]).map((f) => f.id);
      const pairs = 10;
      // One pair first, so that the ends of the layer are read once; the features deleted are
      // read before, at both sizes (the instance keeps up to 1,024 of them made)
      draw.features.create(point(0));
      draw.features.delete(ids[size >> 1]);
      for (let i = 1; i <= pairs; i++) draw.features.get(ids[(size >> 1) + i]);
      work.rows = 0;
      for (let i = 1; i <= pairs; i++) {
        draw.features.create(point(i * 1e-3));
        draw.features.delete(ids[(size >> 1) + i]);
      }
      return work.rows / pairs;
    }, 'the rows read per pair of a creation and a deletion');
  });

  it('is created at the front after a feature at an end was deleted', () => {
    const { draw } = instance();
    const ids = (draw.features.createMany(gridPoints(5)) as Feature[]).map((f) => f.id);
    // The front
    const front = draw.features.create(point(1)) as Feature;
    draw.features.delete(front.id);
    const afterFront = draw.features.create(point(2)) as Feature;
    expect(items(draw)).toEqual([...ids, afterFront.id]);
    // The back
    draw.features.delete(ids[0]);
    const afterBack = draw.features.create(point(3)) as Feature;
    expect(items(draw)).toEqual([...ids.slice(1), afterFront.id, afterBack.id]);
    // One in the middle
    draw.features.delete(ids[2]);
    const afterMiddle = draw.features.create(point(4)) as Feature;
    expect(items(draw)).toEqual([
      ids[1],
      ids[3],
      ids[4],
      afterFront.id,
      afterBack.id,
      afterMiddle.id,
    ]);
  });

  it('is created at the front after features were deleted in the Store directly', () => {
    const { draw, base } = instance();
    const ids = (draw.features.createMany(gridPoints(5)) as Feature[]).map((f) => f.id);
    const rows = rowWrites(base);
    rows.deleteFeature(ids[2]);
    const one = draw.features.create(point(1)) as Feature;
    rows.deleteFeature(one.id);
    const two = draw.features.create(point(2)) as Feature;
    rows.deleteFeature(ids[0]);
    const three = draw.features.create(point(3)) as Feature;
    expect(items(draw)).toEqual([ids[1], ids[3], ids[4], two.id, three.id]);
  });
});
