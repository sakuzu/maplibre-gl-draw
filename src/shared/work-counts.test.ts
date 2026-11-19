// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the work counts of a Store: each Store holds its own numbers, the instance over it
 * counts into them, and no entry of the package reaches them
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Draw } from '../api/draw.js';
import { createDraw } from '../api/draw.js';
import * as geometryEntry from '../geometry/index.js';
import * as mainEntry from '../index.js';
import { createStore } from '../store/built-in/create-store.js';
import type { Store } from '../store/built-in/types.js';
import * as tableEntry from '../table/index.js';
import { createMapStub } from '../test-utils.js';
import * as webglEntry from '../webgl/index.js';
import * as workCounts from './work-counts.js';
import { countWork, createWorkCounts, holdWorkCounts, workCountsOf } from './work-counts.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

/** A draw instance over a Store of its own */
function instance(): { draw: Draw; store: Store } {
  const store = createStore();
  const draw = createDraw(createMapStub().map, { store });
  draws.push(draw);
  return { draw, store };
}

function point(lng: number) {
  return { type: 'Point' as const, geometry: { type: 'Point' as const, coordinates: [lng, 0] } };
}

describe('the work counts of a Store', () => {
  it('are held by each Store, starting from zero', () => {
    const a = createStore();
    const b = createStore();
    const countsA = workCountsOf(a);
    const countsB = workCountsOf(b);
    expect(countsA).toEqual(createWorkCounts());
    expect(countsA).not.toBe(countsB);
  });

  it('count the rows the Store writes and the notifications its listeners get', () => {
    // The Store holds the features as rows: the instance writes the row of a feature it changes
    const { draw, store } = instance();
    const counts = workCountsOf(store);
    if (!counts) throw new Error('no counts');
    const feature = draw.features.create(point(0));
    const before = { ...counts };

    draw.features.update(feature?.id ?? '', { properties: { a: 1 } });
    expect(counts.rowsWritten - before.rowsWritten).toBe(1);
    expect(counts.notifications - before.notifications).toBe(1);
  });

  it('of two instances never mix', () => {
    const first = instance();
    const second = instance();
    const countsOfFirst = workCountsOf(first.store);
    const countsOfSecond = workCountsOf(second.store);
    if (!countsOfFirst || !countsOfSecond) throw new Error('no counts');
    const secondBefore = { ...countsOfSecond };

    first.draw.features.createMany([point(0), point(0.1), point(0.2)]);
    first.draw.features.update(first.draw.features.list()[0].id, { properties: { a: 1 } });

    expect(countsOfFirst.objectsCreated).toBeGreaterThanOrEqual(4);
    expect(countsOfSecond).toEqual(secondBefore);
  });

  it('are held in a field that does not show on the Store', () => {
    // The members of the Store are its fields; the numbers are not one of them, and a Store
    // spread into an object of its own does not carry them
    const store = createStore();
    expect(Object.keys(store).filter((key) => /count/i.test(key))).toEqual([]);
    expect(workCountsOf({ ...store })).toBeUndefined();
  });

  it('are counted by nothing for an object that holds none', () => {
    expect(workCountsOf({})).toBeUndefined();
    expect(workCountsOf(null)).toBeUndefined();
    expect(() => countWork(undefined, 'objectsCreated')).not.toThrow();

    // A Store the host spreads from the built-in one holds no numbers: the instance over it
    // counts nothing, and writes as over the built-in Store
    const spread: Store = { ...createStore() };
    const draw = createDraw(createMapStub().map, { store: spread });
    draws.push(draw);
    expect(workCountsOf(draw.getStore())).toBeUndefined();
    expect(() => draw.features.create(point(0))).not.toThrow();
    expect(draw.features.count()).toBe(1);
  });

  it('given to an object are the numbers it reads back', () => {
    const holder = {};
    const counts = createWorkCounts();
    holdWorkCounts(holder, counts);
    countWork(workCountsOf(holder), 'rowsTouched', 3);
    expect(counts.rowsTouched).toBe(3);
  });
});

describe('the entries of the package', () => {
  const entries = {
    '.': mainEntry,
    './geometry': geometryEntry,
    './table': tableEntry,
    './webgl': webglEntry,
  };
  const functions = new Set<unknown>(Object.values(workCounts));

  for (const [name, entry] of Object.entries(entries)) {
    it(`do not reach the work counts (${name})`, () => {
      for (const [key, value] of Object.entries(entry)) {
        expect(functions.has(value), key).toBe(false);
        expect(/work.?counts?|countwork/i.test(key), key).toBe(false);
      }
    });
  }
});
