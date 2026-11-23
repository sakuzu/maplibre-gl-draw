// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.restore` feature by feature, in the smallest lists of edits that tell it from a
 * writing back of a whole change, with a client elsewhere (another source) writing in between:
 *
 * - A key another feature of the same change wrote is not written back: an attribute, a key of
 *   the look, the visibility, the layer, the position, the deletion
 * - A geometry is taken back whole only when its own change wrote it whole
 * - The look is written back key by key; a change that wrote the whole look at once takes every
 *   key back
 * - A move within its layer wrote the position alone; a key written with the value it had was
 *   not written
 * - Where a vertex the change deleted comes back once the ring changed, and a feature the change
 *   deleted that is there again
 * - The change of a feature told from values before that hold keys of its look
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { FeatureRowField, Store } from '../../store/built-in/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DocumentChange } from '../events.js';
import type { Feature, FeatureValues } from '../model.js';
import { createDraw } from './create-draw.js';

let store: Store;
let draw: Draw;
let changes: DocumentChange[];
let L1: string;
let L2: string;

beforeEach(() => {
  store = createStore();
  draw = createDraw(createMapStub().map, { store });
  changes = [];
  draw.document.subscribe((c) => changes.push(c), { previousValues: true });
  L1 = draw.layers.list()[0].id;
  L2 = draw.layers.create({ name: 'second' })?.id as string;
});

afterEach(() => {
  draw.destroy();
});

const point = (id: string, x: number, more: Record<string, unknown> = {}) =>
  ({ id, type: 'Point', geometry: { type: 'Point', coordinates: [x, 0] }, ...more }) as never;

/** The values of the changes of a source since a mark */
const valuesSince = (mark: number, source = 'local'): FeatureValues[] =>
  changes
    .slice(mark)
    .filter((c) => c.source === source)
    .flatMap((c) => (c.previousValues ? [c.previousValues] : []));

/** An edit of a client elsewhere */
const elsewhere = <T>(fn: () => T): T => draw.transact(fn, { source: 'elsewhere' });

const get = (id: string): Feature => draw.features.get(id) as Feature;
const coordinatesOf = (id: string): number[][] =>
  (get(id).geometry as { coordinates: number[][] }).coordinates;

describe('a key other features of the change wrote', () => {
  it('leaves an attribute', async () => {
    draw.features.create(point('a', 0, { properties: { k1: 1, k2: 1 } }));
    draw.features.create(point('b', 1, { properties: { k1: 1, k2: 1 } }));
    const mark = changes.length;
    draw.transact(() => {
      draw.features.update('a', { properties: { k1: 2 } });
      draw.features.update('b', { properties: { k2: 2 } });
    });
    const values = valuesSince(mark);
    elsewhere(() => draw.features.update('a', { properties: { k2: 'elsewhere' } }));
    await draw.features.restore(values);
    expect(get('a').properties).toEqual({ k1: 1, k2: 'elsewhere' });
    expect(get('b').properties).toEqual({ k1: 1, k2: 1 });
  });

  it('leaves a key of the look', async () => {
    draw.features.create(point('a', 0));
    draw.features.create(point('b', 1));
    const mark = changes.length;
    draw.transact(() => {
      draw.features.update('a', { style: { pointColor: '#0000ff' } });
      draw.features.update('b', { properties: { k1: 2 } });
    });
    const values = valuesSince(mark);
    elsewhere(() => draw.features.update('b', { style: { strokeColor: '#ff0000' } }));
    await draw.features.restore(values);
    expect(get('b').style).toEqual({ strokeColor: '#ff0000' });
    expect(get('a').style).toEqual({});
  });

  it('leaves the visibility', async () => {
    draw.features.create(point('a', 0));
    draw.features.create(point('b', 1));
    const mark = changes.length;
    draw.transact(() => {
      draw.features.update('a', { visible: false });
      draw.features.update('b', { properties: { k1: 2 } });
    });
    const values = valuesSince(mark);
    elsewhere(() => draw.features.update('b', { visible: false }));
    await draw.features.restore(values);
    expect(get('b').visible).toBe(false);
    expect(get('a').visible).toBe(true);
  });

  it('leaves the layer', async () => {
    draw.features.create(point('a', 0, { layerId: L1 }));
    draw.features.create(point('b', 1, { layerId: L1 }));
    const mark = changes.length;
    draw.transact(() => {
      draw.features.move('a', { layerId: L2 });
      draw.features.update('b', { properties: { k1: 2 } });
    });
    const values = valuesSince(mark);
    elsewhere(() => draw.features.move('b', { layerId: L2 }));
    await draw.features.restore(values);
    expect(get('b').layerId).toBe(L2);
    expect(get('a').layerId).toBe(L1);
  });

  it('leaves the position', async () => {
    for (const id of ['a', 'b', 'c', 'd']) draw.features.create(point(id, 0, { layerId: L1 }));
    const mark = changes.length;
    draw.transact(() => {
      draw.features.move('a', { layerId: L1, index: 3 });
      draw.features.update('b', { properties: { k1: 2 } });
    });
    const values = valuesSince(mark);
    elsewhere(() => draw.features.move('b', { layerId: L1, index: 3 }));
    const others = () =>
      draw.layers.listItemIds(L1, { start: 0, end: 10 }).filter((id) => id !== 'a');
    const before = others();
    await draw.features.restore(values);
    expect(others()).toEqual(before);
  });

  it('leaves a feature deleted since deleted', async () => {
    draw.features.create(point('a', 0));
    draw.features.create(point('b', 1));
    const mark = changes.length;
    draw.transact(() => {
      draw.features.delete('a');
      draw.features.update('b', { properties: { k1: 2 } });
    });
    const values = valuesSince(mark);
    elsewhere(() => draw.features.delete('b'));
    await draw.features.restore(values);
    expect(draw.features.has('b')).toBe(false);
    expect(draw.features.has('a')).toBe(true);
  });

  it('leaves, made again, the key left as it is of a feature that was there', async () => {
    draw.features.create(point('a', 0, { properties: { text: 't1' } }));
    draw.features.create(point('b', 1, { properties: { text: 'b1' } }));
    let mark = changes.length;
    draw.transact(() => {
      draw.features.update('a', { properties: { text: 't2' } });
      draw.features.delete('b');
    });
    const values = valuesSince(mark);
    mark = changes.length;
    await draw.features.restore(values, { source: 'back', exceptProperties: ['text'] });
    const again = valuesSince(mark, 'back');
    elsewhere(() => draw.features.update('a', { properties: { text: 'typed' } }));
    await draw.features.restore(again, { source: 'again' });
    expect(get('a').properties.text).toBe('typed');
    expect(draw.features.has('b')).toBe(false);
  });
});

describe('the geometries of a change', () => {
  it('takes a geometry written vertex by vertex back so, written back with a feature that came back', async () => {
    draw.features.create({
      id: 'l',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 0.5],
          [2, 0],
          [3, 0.5],
        ],
      },
    } as never);
    draw.features.create(point('d', 5));
    let mark = changes.length;
    draw.transact(() => {
      draw.features.delete('d');
      draw.features.update('l', {
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 0.5],
            [1.5, 2],
            [2, 0],
            [3, 0.5],
          ],
        },
      });
    });
    const values = valuesSince(mark);
    mark = changes.length;
    await draw.features.restore(values, { source: 'back' });
    const back = valuesSince(mark, 'back');
    mark = changes.length;
    await draw.features.restore(back, { source: 'again' });
    const again = valuesSince(mark, 'again');
    await elsewhere(() => draw.features.translate(['l'], { from: [0, 0], to: [0, 1] }));
    const moved = coordinatesOf('l').filter((_, i) => i !== 2);
    await draw.features.restore(again, { source: 'back' });
    const after = coordinatesOf('l');
    expect(after).toHaveLength(4);
    after.forEach((q, i) => {
      expect(q[0]).toBeCloseTo(moved[i][0], 9);
      expect(q[1]).toBeCloseTo(moved[i][1], 9);
    });
  });

  it('takes back whole only the geometry its change wrote whole', async () => {
    draw.features.create(point('a', 0, { properties: { name: 'a1' } }));
    draw.features.create(point('b', 1, { properties: { name: 'b1' } }));
    let mark = changes.length;
    draw.features.update('a', { properties: { name: 'a2' } });
    const rename = valuesSince(mark);
    mark = changes.length;
    await draw.features.translate(['b'], { from: [0, 0], to: [0, 1] });
    const move = valuesSince(mark);
    mark = changes.length;
    await draw.features.restore([...rename, ...move], { source: 'back' });
    const back = valuesSince(mark, 'back');
    elsewhere(() => {
      draw.features.update('b', { properties: { name: 'elsewhere' } });
      draw.features.update('a', { geometry: { type: 'Point', coordinates: [7, 7] } });
    });
    await draw.features.restore(back, { source: 'again' });
    expect(get('a').geometry).toEqual({ type: 'Point', coordinates: [7, 7] });
    expect(get('a').properties.name).toBe('a2');
    expect(get('b').properties.name).toBe('elsewhere');
    expect((get('b').geometry as { coordinates: number[] }).coordinates[1]).toBeCloseTo(1, 3);
  });
});

describe('the geometries written back whole and vertex by vertex at once', () => {
  it('makes each geometry again as its own change wrote it', async () => {
    draw.features.create(point('a', 0));
    draw.features.create({
      id: 'l',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 0.5],
          [2, 0],
          [3, 0.5],
        ],
      },
    } as never);
    let mark = changes.length;
    await draw.features.translate(['a'], { from: [0, 0], to: [0, 1] });
    const move = valuesSince(mark);
    mark = changes.length;
    draw.features.update('l', {
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 2],
          [2, 0],
          [3, 0.5],
        ],
      },
    });
    const vertex = valuesSince(mark);
    // One writing back of both: a whole geometry and one vertex by vertex in one write
    mark = changes.length;
    await draw.features.restore([...move, ...vertex], { source: 'back' });
    const back = valuesSince(mark, 'back');
    expect(coordinatesOf('l')[1]).toEqual([1, 0.5]);
    // Another vertex of the line moved elsewhere stays when the line is made again
    elsewhere(() =>
      draw.features.update('l', {
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 0.5],
            [2, 0],
            [3, 9],
          ],
        },
      }),
    );
    await draw.features.restore(back, { source: 'again' });
    expect(coordinatesOf('l')).toEqual([
      [0, 0],
      [1, 2],
      [2, 0],
      [3, 9],
    ]);
    expect((get('a').geometry as { coordinates: number[] }).coordinates[1]).toBeCloseTo(1, 3);
  });
});

describe('the look, key by key', () => {
  it('leaves a key of the look the change did not write, on the same feature', async () => {
    draw.features.create(point('a', 0, { style: { pointColor: '#000000' } }));
    const mark = changes.length;
    draw.features.update('a', { style: { pointColor: '#0000ff' } });
    const values = valuesSince(mark);
    elsewhere(() => draw.features.update('a', { style: { strokeColor: '#ff0000' } }));
    await draw.features.restore(values);
    expect(get('a').style).toEqual({ pointColor: '#000000', strokeColor: '#ff0000' });
  });

  it('leaves a key of the look a bulk edit did not write', async () => {
    draw.features.create(point('a', 0));
    draw.features.create(point('b', 1));
    const mark = changes.length;
    await draw.features.updateAll(['a', 'b'], { style: { pointColor: '#0000ff' } });
    const values = valuesSince(mark);
    elsewhere(() => draw.features.update('a', { style: { strokeWidth: 5 } }));
    await draw.features.restore(values);
    expect(get('a').style).toEqual({ strokeWidth: 5 });
    expect(get('b').style).toEqual({});
  });

  it('takes every key back for a change that wrote the whole look at once', async () => {
    draw.features.create(point('a', 0, { style: { pointColor: '#000000' } }));
    draw.features.create(point('b', 1, { style: { pointColor: '#000000' } }));
    const mark = changes.length;
    // A write made to the Store directly with the whole look
    const ref = store.tables.getRowRef('a') as number;
    store.writeRows({
      rows: Int32Array.of(ref),
      fields: new Map<FeatureRowField, unknown[]>([['style', [{ strokeColor: '#00ff00' }]]]),
    });
    const whole = valuesSince(mark, 'remote');
    draw.features.update('b', { style: { pointRadius: 9 } });
    const keys = valuesSince(mark);
    draw.features.update('a', { style: { pointRadius: 3 } });
    // Written back together: the whole look of one, a key of the other, in one write
    await draw.features.restore([...whole, ...keys]);
    expect(get('a').style).toEqual({ pointColor: '#000000' });
    expect(get('b').style).toEqual({ pointColor: '#000000' });
  });
});

describe('the keys as the declaration reads them', () => {
  it('writes back the position alone of a move within the layer', async () => {
    for (const id of ['a', 'b', 'c']) draw.features.create(point(id, 0, { layerId: L1 }));
    const mark = changes.length;
    draw.features.move('a', { layerId: L1, index: 2 });
    const values = valuesSince(mark);
    elsewhere(() => draw.features.move('a', { layerId: L2 }));
    await draw.features.restore(values);
    expect(get('a').layerId).toBe(L2);
  });

  it('leaves a key the change took off that was not there', async () => {
    draw.features.create(point('a', 0, { properties: { k1: 1 } }));
    const mark = changes.length;
    draw.features.update('a', { properties: { k3: undefined, k1: 2 } });
    const values = valuesSince(mark);
    elsewhere(() => draw.features.update('a', { properties: { k3: 'elsewhere' } }));
    await draw.features.restore(values);
    expect(get('a').properties).toEqual({ k1: 1, k3: 'elsewhere' });
  });

  it('leaves a key the change wrote with the value it had', async () => {
    draw.features.create(point('a', 0, { properties: { k1: 1, k2: 1 } }));
    const mark = changes.length;
    draw.features.update('a', { properties: { k1: 1, k2: 2 } });
    const values = valuesSince(mark);
    elsewhere(() => draw.features.update('a', { properties: { k1: 'elsewhere' } }));
    await draw.features.restore(values);
    expect(get('a').properties).toEqual({ k1: 'elsewhere', k2: 1 });
  });
});

describe('a vertex the change deleted, once the ring changed', () => {
  // The vertices v0 to v5, named by their x; the change deletes v3
  const RING = [
    [0, 0],
    [1, 0.1],
    [2, 0.2],
    [3, 0.3],
    [4, 0.4],
    [5, 0.5],
  ];
  const without = (ring: number[][], i: number) => ring.filter((_, k) => k !== i);
  const xs = (ring: number[][]) => ring.map((q) => q[0]);

  /** Deletes the vertex `deleted` of the ring, lets `edit` change the ring, and writes back */
  async function scene(deleted: number, edit: (ring: number[][]) => number[][]) {
    draw.features.create({
      id: 'l',
      type: 'LineString',
      geometry: { type: 'LineString', coordinates: RING },
    } as never);
    const mark = changes.length;
    draw.features.update('l', {
      geometry: { type: 'LineString', coordinates: without(RING, deleted) },
    });
    const values = valuesSince(mark);
    const ring = edit(coordinatesOf('l'));
    elsewhere(() =>
      draw.features.update('l', { geometry: { type: 'LineString', coordinates: ring } }),
    );
    const counts = await draw.features.restore(values);
    return { after: xs(coordinatesOf('l')), skipped: counts?.skippedVertexCount };
  }

  const cases: Array<[string, number, (r: number[][]) => number[][], number[], number]> = [
    ['nothing else changed', 3, (r) => r, [0, 1, 2, 3, 4, 5], 0],
    ['v0 moved', 3, (r) => r.map((q, i) => (i === 0 ? [0, 9] : q)), [0, 1, 2, 3, 4, 5], 0],
    ['v2 moved', 3, (r) => r.map((q, i) => (i === 2 ? [2, 9] : q)), [0, 1, 2, 3, 4, 5], 0],
    ['v4 moved', 3, (r) => r.map((q, i) => (i === 3 ? [4, 9] : q)), [0, 1, 2, 3, 4, 5], 0],
    ['a vertex put before', 3, (r) => [r[0], [0.5, 9], ...r.slice(1)], [0, 0.5, 1, 2, 3, 4, 5], 0],
    [
      'a vertex put between v2 and v4',
      3,
      (r) => [...r.slice(0, 3), [2.5, 9], ...r.slice(3)],
      [0, 1, 2, 2.5, 3, 4, 5],
      0,
    ],
    ['v2 deleted', 3, (r) => without(r, 2), [0, 1, 3, 4, 5], 0],
    ['v4 deleted', 3, (r) => without(r, 3), [0, 1, 2, 5], 1],
    ['v5 deleted', 3, (r) => without(r, 4), [0, 1, 2, 3, 4], 0],
    ['the last one deleted, then v4 deleted', 5, (r) => r.slice(0, 4), [0, 1, 2, 3, 5], 0],
    [
      'the last one deleted, then a vertex put at the end',
      5,
      (r) => [...r, [4.5, 9]],
      [0, 1, 2, 3, 4, 4.5, 5],
      0,
    ],
  ];
  for (const [name, deleted, edit, after, skipped] of cases) {
    it(`comes back before the vertex that was after it: ${name}`, async () => {
      expect(await scene(deleted, edit)).toEqual({ after, skipped });
    });
  }
});

describe('a feature the change deleted that is there again', () => {
  it('is left as it is, brought back by the values of another subscriber', async () => {
    draw.features.create(point('a', 0, { properties: { k: 1 } }));
    const other: DocumentChange[] = [];
    draw.document.subscribe((c) => other.push(c), { previousValues: true });
    const mark = changes.length;
    const otherMark = other.length;
    draw.features.delete('a');
    const mine = valuesSince(mark);
    const theirs = other
      .slice(otherMark)
      .flatMap((c) => (c.previousValues ? [c.previousValues] : []));
    await draw.features.restore(theirs, { source: 'theirs' });
    elsewhere(() => draw.features.update('a', { properties: { k: 'elsewhere' } }));
    const told = changes.length;
    const counts = await draw.features.restore(mine, { source: 'back' });
    expect(counts?.changedCount).toBe(0);
    expect(changes.slice(told).filter((c) => c.source === 'back')).toEqual([]);
    expect(get('a').properties).toEqual({ k: 'elsewhere' });
  });

  it('is left as it is, brought back by a write made to the Store directly', async () => {
    draw.features.create(point('a', 0, { properties: { k: 1 } }));
    const mark = changes.length;
    draw.features.delete('a');
    const mine = valuesSince(mark);
    const ref = store.tables.findRow('a')?.ref as number;
    store.writeRows({
      rows: Int32Array.of(ref),
      fields: new Map<FeatureRowField, unknown[]>([['properties:k', ['outside']]]),
      deleted: Uint8Array.of(0),
    });
    const counts = await draw.features.restore(mine, { source: 'back' });
    expect(counts?.changedCount).toBe(0);
    expect(get('a').properties).toEqual({ k: 'outside' });
  });
});

describe('the feature before a change told from keys of its look', () => {
  it('has the look before, a key written to the Store directly', () => {
    draw.features.create(point('a', 0, { style: { pointColor: '#000000', pointRadius: 4 } }));
    const told: Array<{ feature: Feature; previous: Feature }> = [];
    // A new instance over the same Store, which has not read the feature yet
    draw.destroy();
    draw = createDraw(createMapStub().map, { store });
    draw.on('feature.updated', ({ feature, previous }) => told.push({ feature, previous }));
    store.writeRows({
      rows: Int32Array.of(store.tables.getRowRef('a') as number),
      fields: new Map<FeatureRowField, unknown[]>([['style:pointColor', ['#ff0000']]]),
    });
    expect(told).toHaveLength(1);
    expect(told[0].feature.style).toEqual({ pointColor: '#ff0000', pointRadius: 4 });
    expect(told[0].previous.style).toEqual({ pointColor: '#000000', pointRadius: 4 });
  });
});
