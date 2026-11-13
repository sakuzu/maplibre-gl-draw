// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The changes of the order of many rows put in a place in parts (`PlacementOrder`), made from
 * where they go and from where each part read them: the same as the changes one write of all of
 * them tells, read from the places of the rows once written (`ItemOrderWatch`)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Draw } from '../api/draw.js';
import { createDraw } from '../api/draw.js';
import type { Placement } from '../api/write.js';
import { TableSelection } from '../feature-table/selection.js';
import type { ItemOrderChange } from '../shared/types/model.js';
import { writesOf } from '../test-support/writes.js';
import { createMapStub } from '../test-utils.js';
import { DrawStore } from './draw-store.js';
import { TableContractStore } from './table-memory.js';
import type { ItemPlacement, StoreChange } from './types.js';

const draws: Draw[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const draw of draws.splice(0)) draw.destroy();
});

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

const ROWS = 700;
const id = (i: number): string => `r${String(i).padStart(4, '0')}`;

/** A scene: rows `r0000`… in the layer `l`, a few in the layer `m`, and groups made of them */
interface Scene {
  /** The groups to make, by id: their members */
  readonly groups?: Readonly<Record<string, readonly string[]>>;
  /** The rows selected and put in the place */
  readonly selected: (ids: readonly string[]) => readonly string[];
  readonly to: Placement;
}

/** A Store of rows with the scene made, the rows selected in bulk */
async function sceneDraw(scene: Scene): Promise<{ draw: Draw; store: DrawStore }> {
  const contract = new TableContractStore();
  const store = new DrawStore(contract, { selectionIdsLimit: 2 });
  store.createLayer(layer('l'));
  store.createLayer(layer('m'));
  const draw = createDraw(createMapStub().map, { store: store as never, initDefaultLayer: false });
  draws.push(draw);
  const features = Array.from({ length: ROWS }, (_, i) => ({
    id: id(i),
    type: 'Point',
    geometry: { type: 'Point', coordinates: [i * 0.001, 1] },
    layerId: i < ROWS - 20 ? 'l' : 'm',
    properties: {},
  }));
  writesOf(draw).features.createMany(features as never);
  for (const [groupId, members] of Object.entries(scene.groups ?? {})) {
    await draw.write((tx) => tx.groups.create({ id: groupId, members }));
  }
  const handles = scene
    .selected(features.map((feature) => feature.id))
    .map((rowId) => store.tables?.getRowRef(rowId) as number);
  store.selectRows(TableSelection.of(Int32Array.from(handles)));
  return { draw, store };
}

/** The changes of the order a notification tells, as plain values */
function plain(order: readonly ItemOrderChange[] | undefined): unknown {
  return JSON.parse(
    JSON.stringify(order ?? [], (_key, value) => {
      if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
      if (value instanceof Map) return Object.fromEntries(value);
      return value;
    }),
  );
}

/**
 * The changes of the order of the scene written in parts (through `draw.write`), and of the same
 * scene written in one write of every row (`applyBulk`)
 */
async function bothOrders(scene: Scene): Promise<{ parts: unknown; whole: unknown }> {
  const inParts = await sceneDraw(scene);
  const partsOrders: StoreChange['order'][] = [];
  inParts.store.subscribe((change) => {
    if (change.order) partsOrders.push(change.order);
  });
  let to: ItemPlacement | null = null;
  const plan = inParts.store.planPlaceRows.bind(inParts.store);
  vi.spyOn(inParts.store, 'planPlaceRows').mockImplementation((rows, place) => {
    to = place;
    return plan(rows, place);
  });
  const target = inParts.draw.selection.target;
  await inParts.draw.write((tx) => tx.features.place(target, scene.to));
  expect(to).not.toBeNull();

  const whole = await sceneDraw(scene);
  const wholeOrders: StoreChange['order'][] = [];
  whole.store.subscribe((change) => {
    if (change.order) wholeOrders.push(change.order);
  });
  whole.store.applyBulk({ kind: 'place', to: to as unknown as ItemPlacement });
  expect(partsOrders).toHaveLength(1);
  expect(wholeOrders).toHaveLength(1);
  return { parts: plain(partsOrders[0]), whole: plain(wholeOrders[0]) };
}

const first = (n: number) => (ids: readonly string[]) => ids.slice(0, n);
const everyOther = (ids: readonly string[]) => ids.filter((_, i) => i % 2 === 0 && i < 640);

describe('the changes of the order of many rows put in a place in parts', () => {
  it('are those of one write: to another layer, at its front', async () => {
    const { parts, whole } = await bothOrders({ selected: first(600), to: { layerId: 'm' } });
    expect(parts).toEqual(whole);
    expect((parts as Array<{ to?: unknown }>)[0].to).toBeDefined();
  });

  it('are those of one write: in the same layer, below a row, the rows taken from between others', async () => {
    const { parts, whole } = await bothOrders({
      selected: everyOther,
      to: { layerId: 'l', below: id(650) },
    });
    expect(parts).toEqual(whole);
  });

  it('are those of one write: at the back of a layer', async () => {
    const { parts, whole } = await bothOrders({
      selected: everyOther,
      to: { layerId: 'm', above: id(ROWS - 20) },
    });
    expect(parts).toEqual(whole);
  });

  it('are those of one write: out of a group, below it, the group left empty', async () => {
    const members = first(600)(Array.from({ length: ROWS }, (_, i) => id(i)));
    const { parts, whole } = await bothOrders({
      groups: { g: members },
      selected: first(600),
      to: { layerId: 'l', below: 'g' },
    });
    expect(parts).toEqual(whole);
  });

  it('are those of one write: out of a group, below it, members left in it', async () => {
    const members = first(650)(Array.from({ length: ROWS }, (_, i) => id(i)));
    const { parts, whole } = await bothOrders({
      groups: { g: members },
      selected: first(600),
      to: { layerId: 'l', below: 'g' },
    });
    expect(parts).toEqual(whole);
  });

  it('are those of one write: above a row, a group just below it left empty', async () => {
    const all = Array.from({ length: ROWS }, (_, i) => id(i));
    const { parts, whole } = await bothOrders({
      groups: { g: all.slice(300, 600) },
      selected: (ids) => ids.slice(0, 600),
      to: { layerId: 'l', above: id(600) },
    });
    expect(parts).toEqual(whole);
  });

  it('are those of one write: below a row, a group just above it left empty', async () => {
    const all = Array.from({ length: ROWS }, (_, i) => id(i));
    const { parts, whole } = await bothOrders({
      groups: { g: all.slice(100, 200) },
      selected: (ids) => [...ids.slice(100, 200), ...ids.slice(300, 641)],
      to: { layerId: 'l', below: id(99) },
    });
    expect(parts).toEqual(whole);
  });

  it('are those of one write: into a group among its members', async () => {
    const all = Array.from({ length: ROWS }, (_, i) => id(i));
    const { parts, whole } = await bothOrders({
      groups: { g: all.slice(600, 660) },
      selected: first(400),
      to: { groupId: 'g', below: id(620) },
    });
    expect(parts).toEqual(whole);
  });

  it('are none when the rows are where they go already', async () => {
    const scene: Scene = { selected: first(600), to: { layerId: 'm' } };
    const { draw, store } = await sceneDraw(scene);
    const target = draw.selection.target;
    await draw.write((tx) => tx.features.place(target, scene.to));
    const orders: unknown[] = [];
    store.subscribe((change) => {
      if (change.order) orders.push(change.order);
    });
    draw.selection.setAll();
    store.selectRows(
      TableSelection.of(
        Int32Array.from(first(600)(Array.from({ length: ROWS }, (_, i) => id(i))), (rowId) =>
          Number(store.tables?.getRowRef(rowId)),
        ),
      ),
    );
    const again = draw.selection.target;
    await draw.write((tx) => tx.features.place(again, scene.to));
    expect(orders).toEqual([]);
  });
});

/** A clock that runs 30 ms per read: every part of a write spends the time of a step */
function slowClock(): void {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    now += 30;
    return now;
  });
}

describe('the features selected in bulk once many rows are put in a place in parts', () => {
  it('give the layers they were put in, once the last step is written', async () => {
    const { draw, store } = await sceneDraw({ selected: first(600), to: { layerId: 'm' } });
    expect(draw.selection.value.layerIds).toEqual(['l']);
    slowClock();
    let steps = 0;
    const target = draw.selection.target;
    const write = draw.write((tx) => tx.features.place(target, { layerId: 'm' }), {
      onProgress: () => {
        steps++;
      },
    });
    await write;
    expect(steps).toBeGreaterThan(1);
    expect(store.slicedWritePending).toBe(false);
    expect(draw.selection.value.count).toBe(600);
    expect(draw.selection.value.layerIds).toEqual(['m']);
  });

  it('give the layers they were put in', async () => {
    const { draw } = await sceneDraw({ selected: first(600), to: { layerId: 'm' } });
    expect(draw.selection.value.layerIds).toEqual(['l']);
    const target = draw.selection.target;
    await draw.write((tx) => tx.features.place(target, { layerId: 'm' }));
    expect(draw.selection.value.count).toBe(600);
    expect(draw.selection.value.layerIds).toEqual(['m']);
  });

  it('give the layers of the rows put elsewhere and of the others', async () => {
    const { draw, store } = await sceneDraw({ selected: first(600), to: { layerId: 'm' } });
    const target = draw.selection.target;
    await draw.write((tx) => tx.features.place(target, { layerId: 'm' }));
    // The rows of the layer m before, and the ones put there, selected; some put back in l
    store.selectRows(
      TableSelection.of(
        Int32Array.from({ length: ROWS }, (_, i) => Number(store.tables?.getRowRef(id(i)))),
      ),
    );
    store.selectRows(
      TableSelection.of(
        Int32Array.from({ length: 640 }, (_, i) => Number(store.tables?.getRowRef(id(i)))),
      ),
    );
    expect([...draw.selection.value.layerIds].sort()).toEqual(['l', 'm']);
    const back = draw.selection.target;
    await draw.write((tx) => tx.features.place(back, { layerId: 'l' }));
    expect(draw.selection.value.layerIds).toEqual(['l']);
  });

  it('let go of the rows put in a layer that is not visible', async () => {
    const { draw } = await sceneDraw({ selected: first(600), to: { layerId: 'm' } });
    await draw.write((tx) => tx.layers.update('m', { visible: false }));
    const target = draw.selection.target;
    expect(draw.selection.value.count).toBe(600);
    await draw.write((tx) => tx.features.place(target, { layerId: 'm' }));
    expect(draw.selection.value.count).toBe(0);
  });

  it('let go of the rows put in a group that is not visible', async () => {
    const all = Array.from({ length: ROWS }, (_, i) => id(i));
    const { draw } = await sceneDraw({
      groups: { g: all.slice(650, 660) },
      selected: first(600),
      to: { groupId: 'g' },
    });
    await draw.write((tx) => tx.groups.update('g', { visible: false }));
    const target = draw.selection.target;
    expect(draw.selection.value.count).toBe(600);
    await draw.write((tx) => tx.features.place(target, { groupId: 'g' }));
    expect(draw.selection.value.count).toBe(0);
  });
});
