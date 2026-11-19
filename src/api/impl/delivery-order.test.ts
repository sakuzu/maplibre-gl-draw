// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the order in which the changes of the document are told: in the order they were
 * written. What a listener writes is told once the change being told has reached every listener
 * and every subscriber; the write itself is done at once.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { Feature } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
  vi.useRealTimers();
});

/** An instance with the points `a` and `b`, whose attribute `n` is 0 */
function instance(): Draw {
  vi.useFakeTimers();
  const store = createStore();
  const engine = createEngine(createMapStub().map, { store }, { deferDefaultMode: true });
  const draw = createDrawOnEngine(engine, { store });
  engine.enterDefaultMode();
  draws.push(draw);
  for (const id of ['a', 'b']) {
    draw.features.create({
      id,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { n: 0 },
    });
  }
  return draw;
}

/** The attribute `n` of a feature */
const n = (feature: Feature | null | undefined): unknown => feature?.properties.n;

describe('a change a listener writes', () => {
  it('is told after the change being told, to the next listener and to the subscribers', () => {
    const draw = instance();
    const seen: Record<string, string[][]> = { second: [], subscriber: [] };
    let written = false;
    let read: { returned: unknown; got: unknown } | undefined;
    draw.on('document.changed', () => {
      if (written) return;
      written = true;
      const returned = n(draw.features.update('b', { properties: { n: 2 } }));
      read = { returned, got: n(draw.features.get('b')) };
    });
    draw.on('document.changed', (change) => {
      seen.second.push([...change.features.updated.iterate()]);
    });
    draw.document.subscribe((change) => {
      seen.subscriber.push([...change.features.updated.iterate()]);
    });
    const ops: number[] = [];
    draw.on('document.changed', (change) => ops.push(change.operationId));
    draw.features.update('a', { properties: { n: 1 } });
    // The write is done at once
    expect(read).toEqual({ returned: 2, got: 2 });
    expect(seen.subscriber).toEqual([['a'], ['b']]);
    expect(seen.second).toEqual([['a'], ['b']]);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toBeLessThan(ops[1]);
  });

  it('is told in the order the values were written to a listener of feature.updated', () => {
    const draw = instance();
    const ofB: unknown[] = [];
    let written = false;
    draw.on('feature.updated', ({ feature }) => {
      if (feature.id === 'a' && !written) {
        written = true;
        draw.features.update('b', { properties: { n: 9 } });
      }
    });
    draw.on('feature.updated', ({ feature, previous }) => {
      if (feature.id === 'b') ofB.push([n(previous), n(feature)]);
    });
    draw.features.updateMany([
      { id: 'a', patch: { properties: { n: 1 } } },
      { id: 'b', patch: { properties: { n: 1 } } },
    ]);
    expect(ofB).toEqual([
      [0, 1],
      [1, 9],
    ]);
    expect(n(draw.features.get('b'))).toBe(9);
  });

  it('is told in the order written, whatever the number of listeners that write in turn', () => {
    const draw = instance();
    const told: unknown[] = [];
    // Each change of `a` up to 3 writes the next one; the second listener writes `b` once
    draw.on('document.changed', (change) => {
      if (![...change.features.updated.iterate()].includes('a')) return;
      const value = n(draw.features.get('a')) as number;
      if (value < 4) draw.features.update('a', { properties: { n: value + 1 } });
    });
    let wroteB = false;
    draw.on('document.changed', () => {
      if (wroteB) return;
      wroteB = true;
      draw.features.update('b', { properties: { n: 'b' } });
    });
    const subscribed: string[][] = [];
    draw.document.subscribe((change) => subscribed.push([...change.features.updated.iterate()]));
    draw.on('feature.updated', ({ feature }) => told.push(`${feature.id}${n(feature)}`));
    draw.features.update('a', { properties: { n: 1 } });
    expect(told).toEqual(['a1', 'a2', 'bb', 'a3', 'a4']);
    expect(subscribed).toEqual([['a'], ['a'], ['b'], ['a'], ['a']]);
    expect(n(draw.features.get('a'))).toBe(4);
  });
});
