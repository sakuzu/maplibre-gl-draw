// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reads of the instance while a write over several tasks is under way (a commit in steps, an
 * undo of many rows): they read the document before it, without finishing it, whatever the write
 * changes (the values of the rows, their place, their deletion, their creation, the groups)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawStore } from '../store/draw-store.js';
import { TableContractStore } from '../store/table-memory.js';
import { writesOf } from '../test-support/writes.js';
import { createMapStub } from '../test-utils.js';
import type { Draw } from './draw.js';
import { createDraw } from './draw.js';
import type { Transaction } from './write.js';

const draws: Draw[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const draw of draws.splice(0)) draw.destroy();
});

const STYLE = 'maplibre-gl-draw:style';
const red = { properties: { [STYLE]: { pointColor: '#ff0000' } } };

function layer(id: string) {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table' as const,
    styleRule: undefined,
    metadata: undefined,
  };
}

/** `count` rows in the layer `l`, the first ten in the group `g`, and the layers `m` and `n` */
async function rowsDraw(count: number): Promise<{ draw: Draw; store: DrawStore }> {
  const store = new DrawStore(new TableContractStore(), { selectionIdsLimit: 2 });
  store.createLayer(layer('l'));
  store.createLayer(layer('m'));
  store.createLayer({ ...layer('n'), visible: false });
  const draw = createDraw(createMapStub().map, { store: store as never, initDefaultLayer: false });
  draws.push(draw);
  writesOf(draw).features.createMany(
    Array.from({ length: count }, (_, i) => ({
      id: `r${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i * 0.001, 1] },
      layerId: i % 7 === 3 ? 'n' : 'l',
      properties: {},
    })) as never,
  );
  await draw.write((tx) =>
    tx.groups.create({
      id: 'g',
      name: 'g',
      members: Array.from({ length: 10 }, (_, i) => `r${i * 7}`),
    }),
  );
  return { draw, store };
}

/** A clock that runs 30 ms per read: every part of a write spends the time of a step */
function slowClock(): void {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    now += 30;
    return now;
  });
}

/** Everything the instance reads of the document, as plain values */
function readAll(draw: Pick<Draw, 'features' | 'layers' | 'groups'>): unknown {
  const list = draw.features.list({}, { limit: 10_000 });
  return {
    list: list.map((feature) => [
      feature.id,
      feature.properties[STYLE] ?? null,
      feature.properties['maplibre-gl-draw:layerId'],
      feature.properties['maplibre-gl-draw:groupId'] ?? null,
    ]),
    some: ['r0', 'r3', 'r7', 'r500', 'r999', 'new0', 'new999'].map(
      (id) => draw.features.get(id)?.properties ?? null,
    ),
    has: ['r0', 'r999', 'new0'].map((id) => draw.features.has(id)),
    count: draw.features.count(),
    countL: draw.features.count({ layerId: 'l' }),
    countM: draw.features.count({ layerId: 'm' }),
    countG: draw.features.count({ groupId: 'g' }),
    shown: draw.features.count({ shown: true }),
    box: draw.features.bbox({ bbox: [0.1, 0, 0.3, 2] }),
    bbox: draw.features.bbox(),
    after: draw.features.has('r100')
      ? draw.features.list({ layerId: 'l' }, { limit: 5, after: 'r100' }).map((f) => f.id)
      : null,
    items: ['l', 'm', 'n'].map((id) => draw.layers.listItems(id)),
    itemCounts: ['l', 'm', 'n'].map((id) => draw.layers.countItems(id)),
    groups: draw.groups.list().map((group) => group.id),
    members: draw.groups.has('g') ? draw.groups.listMembers('g') : null,
    editable: draw.features.has('r1') ? draw.features.isEditable('r1') : null,
  };
}

/** Writes, and reads the document after its first step: the same as before it, nothing finished */
async function readBetweenSteps(
  draw: Draw,
  store: DrawStore,
  fn: (tx: Transaction) => unknown,
): Promise<void> {
  const before = readAll(draw);
  slowClock();
  let first = (): void => {};
  const stepped = new Promise<void>((resolve) => {
    first = resolve;
  });
  const write = draw.write(fn, { onProgress: () => first() });
  await stepped;
  expect(store.slicedWritePending).toBe(true);
  expect(readAll(draw)).toEqual(before);
  // A transaction reads the document committed as well
  let read: unknown;
  await draw.write((tx) => {
    read = readAll(tx);
  });
  expect(read).toEqual(before);
  expect(store.slicedWritePending).toBe(true);
  await write;
  vi.restoreAllMocks();
  const after = readAll(draw);
  // The undo of many rows is written over several tasks too: read as the document before it
  slowClock();
  const undo = draw.undo();
  if (store.slicedWritePending) expect(readAll(draw)).toEqual(after);
  await undo;
  vi.restoreAllMocks();
  expect(readAll(draw)).toEqual(before);
}

describe('the reads while a commit is written over several tasks', () => {
  it('read the values the rows had', async () => {
    const { draw, store } = await rowsDraw(1000);
    draw.selection.setAll();
    const target = draw.selection.target;
    await readBetweenSteps(draw, store, (tx) => tx.features.update(target, red));
  });

  it('read the rows deleted, and the group they leave empty', async () => {
    const { draw, store } = await rowsDraw(1000);
    draw.selection.setAll();
    const target = draw.selection.target;
    await readBetweenSteps(draw, store, (tx) => tx.features.delete(target));
  });

  it('read the rows deleted where they were, the ones written before in the delta too', async () => {
    const { draw, store } = await rowsDraw(1000);
    // Some rows read from the delta of the layer (put elsewhere and changed before), some deleted
    await draw.write((tx) =>
      tx.features.place(['r10', 'r20', 'r500'], { layerId: 'l', below: 'r900' }),
    );
    await draw.write((tx) => tx.features.update(['r30', 'r40'], red));
    await draw.write((tx) => tx.features.delete(['r50', 'r60']));
    draw.selection.setAll();
    const target = draw.selection.target;
    await readBetweenSteps(draw, store, (tx) => tx.features.delete(target));
  });

  it('read the rows put in another layer where they were', async () => {
    const { draw, store } = await rowsDraw(1000);
    draw.selection.setAll();
    const target = draw.selection.target;
    await readBetweenSteps(draw, store, (tx) => tx.features.place(target, { layerId: 'm' }));
  });

  it('read the rows put in a group where they were, and no group made', async () => {
    // Past the members a group is made of in one write of their rows
    const { draw, store } = await rowsDraw(3000);
    const members = Array.from({ length: 2900 }, (_, i) => `r${i + 50}`).filter(
      (_, i) => (i + 50) % 7 !== 3,
    );
    await readBetweenSteps(draw, store, (tx) => tx.groups.create({ id: 'h', members }));
  });

  it('read the rows taken out of their group where they were, and the group', async () => {
    const { draw, store } = await rowsDraw(3000);
    const members = Array.from({ length: 2900 }, (_, i) => `r${i + 50}`).filter(
      (_, i) => (i + 50) % 7 !== 3,
    );
    await draw.write((tx) => tx.groups.create({ id: 'h', members }));
    draw.selection.setAll();
    const target = draw.selection.target;
    await readBetweenSteps(draw, store, (tx) =>
      tx.features.place(target, { layerId: 'l', below: 'h' }),
    );
  });

  it('read the rows put in another place of their layer where they were', async () => {
    const { draw, store } = await rowsDraw(1000);
    draw.selection.setAll();
    const target = draw.selection.target;
    await readBetweenSteps(draw, store, (tx) =>
      tx.features.place(target, { layerId: 'l', below: 'r5' }),
    );
  });

  it('read no row created', async () => {
    const { draw, store } = await rowsDraw(1000);
    await readBetweenSteps(draw, store, async (tx) => {
      for (let i = 0; i < 1000; i++) {
        await tx.features.create({
          type: 'Feature',
          id: `new${i}`,
          geometry: { type: 'Point', coordinates: [0.2, 1] },
          properties: { 'maplibre-gl-draw:layerId': 'l' },
        });
      }
    });
  });

  it('read the rows of features named by their IDs, updated and moved', async () => {
    const { draw, store } = await rowsDraw(1000);
    const ids = Array.from({ length: 800 }, (_, i) => `r${i + 100}`);
    await readBetweenSteps(draw, store, async (tx) => {
      await tx.features.update(ids, red);
      await tx.features.translate(ids, { from: [0, 0], to: [1, 1] });
    });
  });
});
