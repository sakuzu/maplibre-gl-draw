// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.restore`: what the values before a change hold, and what writing them back does
 *
 * - The geometries: vertex by vertex (a vertex moved, added or deleted is taken back, the others
 *   stay, a vertex that cannot be followed is counted), or whole (a move, a rotation, a scaling,
 *   a change of the rings)
 * - The other values key by key, the deleted features at their place, the groups with them
 * - The values of each subscriber, held once, let go of, used up once written back whole
 * - Several values from the last to the first, the references checked against the IDs, the
 *   `restore` calls one after another
 */

import type { LineString, Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import { drawnRowsOf } from '../../store/built-in/drawn-rows.js';
import type { FeatureRowField, Store } from '../../store/built-in/types.js';
import { createMapStub } from '../../test-utils.js';
import type { DocumentSubscribeOptions } from '../document.js';
import type { Draw } from '../draw.js';
import type { DocumentChange } from '../events.js';
import type { Feature, FeatureValues } from '../model.js';
import { createDraw } from './create-draw.js';
import { sharedValuesOf } from './feature-values.js';

let store: Store;
let draw: Draw;

beforeEach(() => {
  store = createStore();
  draw = createDraw(createMapStub().map, { store });
});

afterEach(() => {
  draw.destroy();
});

/** The changes a subscriber that asks for the values before receives from now on */
function record(previousValues: DocumentSubscribeOptions['previousValues'] = ['local']) {
  const changes: DocumentChange[] = [];
  const stop = draw.document.subscribe((change) => changes.push(change), { previousValues });
  return {
    changes,
    stop,
    /** The values of every change from now on, in the order they arrived */
    all: (): FeatureValues[] =>
      changes.flatMap((change) => (change.previousValues ? [change.previousValues] : [])),
    /** The values of the last operation, in the order its parts arrived */
    last: (): FeatureValues[] => {
      const id = changes[changes.length - 1]?.operationId;
      return changes
        .filter((change) => change.operationId === id)
        .flatMap((change) => (change.previousValues ? [change.previousValues] : []));
    },
  };
}

const coords = (n: number): number[][] => Array.from({ length: n }, (_, i) => [i, 0]);

const line = (id: string, positions = coords(6)) => ({
  id,
  type: 'LineString' as const,
  geometry: { type: 'LineString' as const, coordinates: positions },
});

const square = (x: number, y: number, size: number): number[][] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
  [x, y],
];

const area = (id: string, rings = [square(0, 0, 10)]) => ({
  id,
  type: 'Polygon' as const,
  geometry: { type: 'Polygon' as const, coordinates: rings },
});

const point = (id: string, x = 0, more: Record<string, unknown> = {}) => ({
  id,
  type: 'Point' as const,
  geometry: { type: 'Point' as const, coordinates: [x, 0] },
  ...more,
});

/** The positions of a feature */
const positionsOf = (id: string): unknown =>
  (draw.features.get(id)?.geometry as LineString | Polygon | undefined)?.coordinates;

/** Moves positions of a line: `moves` gives the new position of some indices */
function moved(positions: number[][], moves: Record<number, number[]>): number[][] {
  return positions.map((position, i) => moves[i] ?? position);
}

/** Writes the geometry of a line or an area to the Store directly, as a change made elsewhere */
function writeDirectly(id: string, geometry: LineString | Polygon): void {
  const ref = store.tables.getRowRef(id) as number;
  const rings = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
  const positionStarts = [0];
  const coordinates: number[] = [];
  for (const ring of rings) {
    for (const position of ring) coordinates.push(position[0], position[1]);
    positionStarts.push(coordinates.length / 2);
  }
  store.writeRows({
    rows: Int32Array.of(ref),
    fields: new Map(),
    geometry: {
      types: Uint8Array.of(geometry.type === 'LineString' ? 1 : 2),
      coordinates: Float64Array.from(coordinates),
      valuesPerPosition: 2,
      partStarts: Int32Array.of(0, 1),
      ringStarts: Int32Array.of(0, rings.length),
      positionStarts: Int32Array.from(positionStarts),
    },
  });
}

/** Whether the Store keeps a deleted row of an ID */
const kept = (id: string): boolean => store.tables.findRow(id)?.deleted === true;

describe('the geometry written back vertex by vertex', () => {
  it('takes back the vertex it moved, and leaves the one moved elsewhere afterwards', async () => {
    draw.features.create(line('a'));
    const mine = record();
    draw.features.update('a', {
      geometry: { type: 'LineString', coordinates: moved(coords(6), { 2: [2, 5] }) },
    });
    // Elsewhere, the vertex 4 of the same feature moves
    writeDirectly('a', {
      type: 'LineString',
      coordinates: moved(coords(6), { 2: [2, 5], 4: [4, 9] }),
    });
    const counts = await draw.features.restore(mine.all());
    expect(positionsOf('a')).toEqual(moved(coords(6), { 4: [4, 9] }));
    expect(counts).toEqual(expect.objectContaining({ changedCount: 1, skippedVertexCount: 0 }));
  });

  it('deletes the vertex it added, and brings back the vertex it deleted', async () => {
    draw.features.create(line('a'));
    const mine = record();
    const added = [...coords(6).slice(0, 3), [2.5, 1], ...coords(6).slice(3)];
    draw.features.update('a', { geometry: { type: 'LineString', coordinates: added } });
    // The vertex [4, 0] deleted
    const withoutOne = added.filter((_, i) => i !== 5);
    draw.features.update('a', { geometry: { type: 'LineString', coordinates: withoutOne } });
    const [add, remove] = mine.all();
    await draw.features.restore([remove]);
    expect(positionsOf('a')).toEqual(added);
    // The vertex added before, followed along the deletion and its writing back
    await draw.features.restore([add]);
    expect(positionsOf('a')).toEqual(coords(6));
  });

  it('takes the whole geometry back when the change changed the number of rings', async () => {
    draw.features.create(area('p'));
    const mine = record();
    draw.features.update('p', {
      geometry: { type: 'Polygon', coordinates: [square(0, 0, 10), square(2, 2, 2)] },
    });
    const values = mine.all();
    expect(sharedValuesOf(values[0])?.tracked.size).toBe(0);
    // A vertex of the outer ring moved elsewhere goes back with the whole geometry
    const outer = moved(square(0, 0, 10), { 1: [11, 0] });
    writeDirectly('p', { type: 'Polygon', coordinates: [outer, square(2, 2, 2)] });
    await draw.features.restore(values);
    expect(positionsOf('p')).toEqual([square(0, 0, 10)]);
  });

  it('counts the vertices it cannot follow, and leaves them as they are', async () => {
    draw.features.create(area('p'));
    const mine = record();
    const outer = moved(square(0, 0, 10), { 2: [12, 12] });
    draw.features.update('p', { geometry: { type: 'Polygon', coordinates: [outer] } });
    // Elsewhere, a hole: the number of rings changes, and no vertex of the part can be followed
    writeDirectly('p', { type: 'Polygon', coordinates: [outer, square(2, 2, 2)] });
    const counts = await draw.features.restore(mine.all());
    expect(counts?.skippedVertexCount).toBe(1);
    expect(positionsOf('p')).toEqual([outer, square(2, 2, 2)]);
  });

  it('compares a geometry given whole with the same rings vertex by vertex', async () => {
    draw.features.create(area('p'));
    const mine = record();
    const outer = moved(square(0, 0, 10), { 1: [11, -1] });
    draw.features.update('p', { geometry: { type: 'Polygon', coordinates: [outer] } });
    expect(sharedValuesOf(mine.all()[0])?.tracked.size).toBe(1);
    writeDirectly('p', {
      type: 'Polygon',
      coordinates: [moved(outer, { 3: [-1, 11] })],
    });
    await draw.features.restore(mine.all());
    expect(positionsOf('p')).toEqual([moved(square(0, 0, 10), { 3: [-1, 11] })]);
  });
});

describe('the geometry written back whole', () => {
  it.each([
    ['a move', (target: string[]) => draw.features.translate(target, { from: [0, 0], to: [1, 1] })],
    [
      'a rotation',
      (target: string[]) =>
        draw.features.rotate(target, { center: [2, 0], counterclockwiseDegrees: 30 }),
    ],
    [
      'a scaling',
      (target: string[]) =>
        draw.features.scale(target, {
          center: [2, 0],
          eastFactor: 2,
          northFactor: 2,
          sizeFactor: 2,
        }),
    ],
  ])('takes back %s whole, without a record per feature', async (_name, run) => {
    draw.features.create(line('a'));
    const before = positionsOf('a');
    const mine = record();
    await run(['a']);
    const values = mine.last();
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(sharedValuesOf(value)?.tracked.size).toBe(0);
    // A vertex moved since goes back with the whole geometry
    const now = (draw.features.get('a') as Feature).geometry as LineString;
    writeDirectly('a', {
      type: 'LineString',
      coordinates: moved(now.coordinates, { 4: [40, 40] }),
    });
    await draw.features.restore(values);
    const after = positionsOf('a') as number[][];
    (before as number[][]).forEach((position, i) => {
      expect(after[i][0]).toBeCloseTo(position[0], 9);
      expect(after[i][1]).toBeCloseTo(position[1], 9);
    });
  });

  it('takes back whole an update written in a transaction where a move was applied first', async () => {
    draw.features.createMany([line('a'), line('b')]);
    const move = draw.features.translate(['a'], { from: [0, 0], to: [0, 1] });
    const mine = record();
    // The write of `a` applies the move to it first, in the transaction of the update of `b`
    draw.transact(() => {
      draw.features.update('a', { properties: { name: 'a' } });
      draw.features.update('b', {
        geometry: { type: 'LineString', coordinates: moved(coords(6), { 1: [1, 3] }) },
      });
    });
    const [values] = mine.all();
    expect(sharedValuesOf(values)?.tracked.size).toBe(0);
    await move;
    writeDirectly('b', {
      type: 'LineString',
      coordinates: moved(coords(6), { 1: [1, 3], 5: [5, 5] }),
    });
    await draw.features.restore([values]);
    expect(positionsOf('b')).toEqual(coords(6));
  });
});

describe('the other values', () => {
  it('writes back the keys the change wrote, and leaves the others as they are now', async () => {
    draw.features.create(point('a', 0, { properties: { name: 'one', size: 1 } }));
    const mine = record();
    draw.features.update('a', { properties: { name: 'two' }, style: { pointColor: '#f00' } });
    draw.features.update('a', { properties: { size: 2 } });
    await draw.features.restore([mine.all()[0]]);
    const feature = draw.features.get('a') as Feature;
    expect(feature.properties).toEqual({ name: 'one', size: 2 });
    expect(feature.style.pointColor).toBeUndefined();
  });

  it('writes back the values of several changes from the last to the first', async () => {
    draw.features.create(point('a', 0, { properties: { name: 'one' } }));
    const mine = record();
    draw.features.update('a', { properties: { name: 'two' } });
    draw.features.update('a', { properties: { name: 'three' } });
    draw.features.update('a', { visible: false });
    await draw.features.restore(mine.all());
    expect(draw.features.get('a')?.properties.name).toBe('one');
    expect(draw.features.get('a')?.visible).toBe(true);
  });

  it('writes back two moves of the same feature, given in the order they arrived', async () => {
    draw.features.create(line('a'));
    const mine = record();
    await draw.features.translate(['a'], { from: [0, 0], to: [0, 1] });
    await draw.features.translate(['a'], { from: [0, 0], to: [1, 0] });
    await draw.features.restore(mine.all());
    const after = positionsOf('a') as number[][];
    coords(6).forEach((position, i) => {
      expect(after[i][0]).toBeCloseTo(position[0], 9);
      expect(after[i][1]).toBeCloseTo(position[1], 9);
    });
  });

  it('writes back two changes vertex by vertex: a vertex moved, then a vertex added', async () => {
    draw.features.create(line('a'));
    const mine = record();
    const first = moved(coords(6), { 2: [2, 5] });
    draw.features.update('a', { geometry: { type: 'LineString', coordinates: first } });
    const second = [...first.slice(0, 3), [2.5, 2], ...first.slice(3)];
    draw.features.update('a', { geometry: { type: 'LineString', coordinates: second } });
    await draw.features.restore(mine.all());
    expect(positionsOf('a')).toEqual(coords(6));
  });
});

describe('the features deleted and created', () => {
  it('brings back the deleted features at their place, told as created', async () => {
    const layerId = draw.layers.list()[0].id;
    draw.features.createMany([point('a'), point('b', 1), point('c', 2)]);
    draw.groups.create({ id: 'g', featureIds: ['a', 'b'] });
    const order = draw.layers.listItemIds(layerId, { start: 0, end: 10 });
    const members = draw.groups.listFeatureIds('g', { start: 0, end: 10 });
    const mine = record();
    await draw.features.deleteMany(['b', 'c']);
    expect(kept('b')).toBe(true);
    const created: string[] = [];
    draw.on('feature.created', ({ feature }) => created.push(feature.id));
    const changes = record(false);
    await draw.features.restore(mine.last());
    expect(draw.groups.listFeatureIds('g', { start: 0, end: 10 })).toEqual(members);
    expect(draw.layers.listItemIds(layerId, { start: 0, end: 10 })).toEqual(order);
    expect(created.sort()).toEqual(['b', 'c']);
    expect([...changes.changes[0].features.created.iterate()].sort()).toEqual(['b', 'c']);
  });

  it('deletes the features the change created', async () => {
    const mine = record();
    draw.features.createMany([point('a'), point('b', 1)]);
    await draw.features.restore(mine.all());
    expect(draw.features.count()).toBe(0);
  });

  it('puts a feature whose group is not there in the layer of the group, at its front', async () => {
    const layerId = draw.layers.list()[0].id;
    draw.features.createMany([point('a'), point('b', 1), point('c', 2)]);
    draw.groups.create({ id: 'g', featureIds: ['a', 'b'] });
    const mine = record();
    draw.features.move('a', { groupId: null });
    // Deleted by a later change, whose values are not written back
    draw.groups.delete('g');
    await draw.features.restore([mine.all()[0]]);
    expect(draw.features.get('a')?.groupId).toBeUndefined();
    const items = draw.layers.listItemIds(layerId, { start: 0, end: 10 });
    expect(items[items.length - 1]).toBe('a');
  });

  it('neither deletes nor adds an embedded file of an image deleted and brought back', async () => {
    store.createFile({
      id: 'file-1',
      mimeType: 'image/png',
      dataURL: 'data:image/png;base64,AA==',
    });
    draw.features.create({
      id: 'img',
      type: 'Image',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {
        'maplibre-gl-draw:imageFileId': 'file-1',
        'maplibre-gl-draw:imageWidth': 20,
        'maplibre-gl-draw:imageHeight': 10,
      },
    });
    const files = store.listFiles();
    const mine = record();
    draw.features.delete('img');
    expect(store.listFiles()).toEqual(files);
    await draw.features.restore(mine.all());
    expect(draw.features.has('img')).toBe(true);
    expect(store.listFiles()).toEqual(files);
  });
});

describe('the groups', () => {
  it('deletes the group the change created, its features back in the layer', async () => {
    const layerId = draw.layers.list()[0].id;
    draw.features.createMany([point('a'), point('b', 1), point('c', 2)]);
    const order = draw.layers.listItemIds(layerId, { start: 0, end: 10 });
    const mine = record();
    draw.groups.create({ id: 'g', featureIds: ['a', 'b'] });
    await draw.features.restore(mine.all());
    expect(draw.groups.has('g')).toBe(false);
    expect(draw.layers.listItemIds(layerId, { start: 0, end: 10 })).toEqual(order);
  });

  it('brings back the group the change deleted, with its features', async () => {
    const layerId = draw.layers.list()[0].id;
    draw.features.createMany([point('a'), point('b', 1), point('c', 2)]);
    draw.groups.create({ id: 'g', name: 'The group', featureIds: ['a', 'c'] });
    const group = draw.groups.get('g');
    const order = draw.layers.listItemIds(layerId, { start: 0, end: 10 });
    const mine = record();
    draw.groups.delete('g');
    await draw.features.restore(mine.all());
    expect(draw.groups.get('g')).toEqual(group);
    expect(draw.layers.listItemIds(layerId, { start: 0, end: 10 })).toEqual(order);
  });

  it('moves back the group the change moved, and takes back its values', async () => {
    const first = draw.layers.list()[0].id;
    const other = draw.layers.create({ name: 'other' })?.id as string;
    draw.features.createMany([point('a'), point('b', 1)]);
    draw.groups.create({ id: 'g', name: 'Before', featureIds: ['a'] });
    const order = draw.layers.listItemIds(first, { start: 0, end: 10 });
    const mine = record();
    draw.groups.move('g', { layerId: other });
    draw.groups.update('g', { name: 'After', visible: false });
    await draw.features.restore(mine.all());
    expect(draw.groups.get('g')).toEqual(
      expect.objectContaining({ layerId: first, name: 'Before', visible: true }),
    );
    expect(draw.features.get('a')?.layerId).toBe(first);
    expect(draw.layers.listItemIds(first, { start: 0, end: 10 })).toEqual(order);
  });

  it('writes back a change of a group alone: a name, or an empty group created', async () => {
    const layerId = draw.layers.list()[0].id;
    draw.features.create(point('a'));
    draw.groups.create({ id: 'g', name: 'Before', featureIds: ['a'] });
    const mine = record(true);
    draw.groups.update('g', { name: 'After' });
    // An empty group, as a change made elsewhere writes it
    store.createGroup({
      id: 'empty',
      layerId,
      name: 'Empty',
      visible: true,
      locked: false,
      orderKey: 'z0',
    });
    const [renamed, created] = mine.all();
    expect(renamed).toBeDefined();
    expect(created).toBeDefined();
    await draw.features.restore([created]);
    expect(draw.groups.has('empty')).toBe(false);
    await draw.features.restore([renamed]);
    expect(draw.groups.get('g')?.name).toBe('Before');
  });
});

describe('the values of the subscribers', () => {
  it('holds one array for two subscribers, and keeps the deleted feature until both let go', async () => {
    draw.features.create(point('a'));
    const first = record(true);
    const second = record(true);
    draw.features.delete('a');
    const [one] = first.all();
    const [two] = second.all();
    expect(one).not.toBe(two);
    expect(sharedValuesOf(one)).toBe(sharedValuesOf(two));
    expect(one.byteLength).toBe(two.byteLength);
    draw.features.releaseValues([one]);
    expect(kept('a')).toBe(true);
    // Unsubscribing lets go of nothing
    second.stop();
    expect(kept('a')).toBe(true);
    draw.features.releaseValues([two]);
    expect(kept('a')).toBe(false);
  });

  it('refuses values let go of, and lets go of values given to a restore once it has ended', async () => {
    draw.features.create(point('a'));
    const mine = record();
    draw.features.delete('a');
    const [values] = mine.all();
    const restoring = draw.features.restore([values]);
    draw.features.releaseValues([values]);
    expect(kept('a')).toBe(true);
    await restoring;
    expect(draw.features.has('a')).toBe(true);
    await expect(draw.features.restore([values])).rejects.toMatchObject({ code: 'invalidInput' });
  });

  it('refuses the same values given again, and writes nothing then', async () => {
    draw.features.create(point('a', 0, { properties: { name: 'one' } }));
    const mine = record();
    draw.features.update('a', { properties: { name: 'two' } });
    const [values] = mine.all();
    await draw.features.restore([values]);
    draw.features.update('a', { properties: { name: 'three' } });
    const after = record(false);
    await expect(draw.features.restore([values])).rejects.toMatchObject({ code: 'invalidInput' });
    expect(draw.features.get('a')?.properties.name).toBe('three');
    expect(after.changes).toEqual([]);
  });

  it('refuses what is not values of this instance, and a layer that is not there', async () => {
    const other = createDraw(createMapStub().map, { store: createStore() });
    try {
      other.features.create(point('x'));
      const theirs: FeatureValues[] = [];
      other.document.subscribe(
        (change) => {
          if (change.previousValues) theirs.push(change.previousValues);
        },
        { previousValues: true },
      );
      other.features.update('x', { properties: { name: 'x' } });
      await expect(draw.features.restore(theirs)).rejects.toMatchObject({ code: 'invalidInput' });
      await expect(draw.features.restore([{} as FeatureValues])).rejects.toMatchObject({
        code: 'invalidInput',
      });
    } finally {
      other.destroy();
    }
    const layerId = draw.layers.create({ name: 'gone' })?.id as string;
    draw.features.create({ ...point('a'), layerId });
    const mine = record();
    draw.features.update('a', { properties: { name: 'two' } });
    await draw.layers.delete(layerId);
    await expect(draw.features.restore(mine.all().slice(0, 1))).rejects.toMatchObject({
      code: 'notFound',
    });
  });

  it('runs two restores one after the other: the same values once, other values in turn', async () => {
    draw.features.create(point('a', 0, { properties: { name: 'one' } }));
    const mine = record();
    draw.features.update('a', { properties: { name: 'two' } });
    draw.features.update('a', { properties: { size: 2 } });
    const [name, size] = mine.all();
    const firstRun = draw.features.restore([name]);
    const again = draw.features.restore([name]);
    await expect(firstRun).resolves.toEqual(expect.objectContaining({ changedCount: 1 }));
    await expect(again).rejects.toMatchObject({ code: 'invalidInput' });
    const one = draw.features.restore([size]);
    draw.features.update('a', { properties: { other: true } });
    await one;
    expect(draw.features.get('a')?.properties).toEqual({ name: 'one', other: true });
  });
});

describe('the references of the rows', () => {
  it('leaves a feature that took the reference of a row the values hold as it is', async () => {
    draw.features.create(point('a', 0, { properties: { name: 'one' } }));
    const mine = record();
    draw.features.update('a', { properties: { name: 'two' } });
    const ref = store.tables.getRowRef('a') as number;
    // Deleted by a source whose values are not asked: nothing keeps the row
    draw.transact(() => draw.features.delete('a'), { source: 'remote' });
    // Once the tables have done their work, the reference is given to the next row made
    const work = drawnRowsOf(store.tables);
    const budget = {
      canStep: () => true,
      step: <T>(step: (deadline: number) => T): T => step(Number.POSITIVE_INFINITY),
    };
    for (let i = 0; i < 32 && work?.hasPendingWork; i++) work.advance(budget);
    const made = draw.features.createMany(
      Array.from({ length: 200 }, (_, i) => point(`n${i}`, i / 100, { properties: { name: 'n' } })),
    );
    const taker = store.tables.getRowId(ref);
    expect(taker).toBeDefined();
    expect(taker).not.toBe('a');
    const before = draw.features.get(taker as string);
    // The values of the update alone (those of the features made are not written back)
    const counts = await draw.features.restore(mine.all().slice(0, 1));
    expect(draw.features.get(taker as string)).toEqual(before);
    expect(draw.features.has('a')).toBe(false);
    expect(counts?.changedCount).toBe(0);
    expect(made).toHaveLength(200);
  });
});

describe('the refusals and the locks', () => {
  it('is refused with null when read-only, and leaves a locked feature unless the locks are ignored', async () => {
    draw.features.createMany([point('a'), point('b', 1)]);
    const mine = record();
    draw.features.updateMany([
      { id: 'a', patch: { properties: { name: 'A' } } },
      { id: 'b', patch: { properties: { name: 'B' } } },
    ]);
    const values = mine.all();
    draw.setReadOnly(true);
    await expect(draw.features.restore(values)).resolves.toBeNull();
    draw.setReadOnly(false);
    draw.features.update('a', { locked: true });
    const counts = await draw.features.restore(values);
    expect(counts).toEqual(expect.objectContaining({ changedCount: 1, lockedCount: 1 }));
    expect(draw.features.get('a')?.properties.name).toBe('A');
    expect(draw.features.get('b')?.properties.name).toBeUndefined();
  });

  it('writes a locked feature back when the locks are ignored', async () => {
    draw.features.create(point('a'));
    const mine = record();
    draw.features.update('a', { properties: { name: 'A' } });
    draw.features.update('a', { locked: true });
    const [values] = mine.all();
    await expect(draw.features.restore([values])).resolves.toBeNull();
    const counts = await draw.features.restore([values], { ignoreLocks: true });
    expect(counts?.changedCount).toBe(1);
    expect(draw.features.get('a')?.properties.name).toBeUndefined();
  });

  it('writes from the source given, and its changes carry the values that make the change again', async () => {
    draw.features.create(point('a', 0, { properties: { name: 'one' } }));
    const mine = record(true);
    draw.features.update('a', { properties: { name: 'two' } });
    const [values] = mine.all();
    await draw.features.restore([values], { source: 'undo' });
    const back = mine.changes[mine.changes.length - 1];
    expect(back.source).toBe('undo');
    expect(draw.features.get('a')?.properties.name).toBe('one');
    await draw.features.restore([back.previousValues as FeatureValues], { source: 'redo' });
    expect(draw.features.get('a')?.properties.name).toBe('two');
  });
});

describe('the rows written as columns', () => {
  it('reads the values of a row written to the Store directly, and writes them back', async () => {
    draw.features.create(point('a', 0, { properties: { name: 'one' } }));
    const mine = record(true);
    const ref = store.tables.getRowRef('a') as number;
    store.writeRows({
      rows: Int32Array.of(ref),
      fields: new Map<FeatureRowField, unknown[]>([['properties:name', ['two']]]),
    });
    await draw.features.restore(mine.all());
    expect(draw.features.get('a')?.properties.name).toBe('one');
  });
});
