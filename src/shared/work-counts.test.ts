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
import { MemoryContractStore, MemoryStore } from '../store/memory.js';
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
function instance(): { draw: Draw; store: MemoryStore } {
  const store = new MemoryStore();
  const draw = createDraw(createMapStub().map, { store });
  draws.push(draw);
  return { draw, store };
}

function point(lng: number) {
  return { type: 'Point' as const, geometry: { type: 'Point' as const, coordinates: [lng, 0] } };
}

describe('the work counts of a Store', () => {
  it('are held by each Store, starting from zero', () => {
    const a = new MemoryStore();
    const b = new MemoryStore();
    const countsA = workCountsOf(a);
    const countsB = workCountsOf(b);
    expect(countsA).toEqual(createWorkCounts());
    expect(countsA).not.toBe(countsB);
  });

  it('count the features the Store makes and the notifications its listeners get', () => {
    const { draw, store } = instance();
    const counts = workCountsOf(store);
    if (!counts) throw new Error('no counts');
    const before = { ...counts };

    draw.features.create(point(0));
    expect(counts.objectsCreated - before.objectsCreated).toBe(1);
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
    const store = new MemoryStore();
    expect(Object.keys(store)).toEqual([]);
    expect(JSON.stringify(store)).toBe('{}');
    expect({ ...store }).toEqual({});
  });

  it('are counted by nothing for an object that holds none', () => {
    expect(workCountsOf({})).toBeUndefined();
    expect(workCountsOf(null)).toBeUndefined();
    expect(() => countWork(undefined, 'objectsCreated')).not.toThrow();

    // A contract the host gives gets a Store of core around it, which counts the notifications;
    // the features the contract makes are not counted
    const contract = new MemoryContractStore();
    const draw = createDraw(createMapStub().map, { store: contract });
    draws.push(draw);
    const counts = workCountsOf(draw.getStore());
    if (!counts) throw new Error('no counts');
    const before = { ...counts };
    draw.features.create(point(0));
    expect(counts.objectsCreated).toBe(before.objectsCreated);
    expect(counts.notifications - before.notifications).toBe(1);
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
