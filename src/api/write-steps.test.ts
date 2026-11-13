// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A commit too long for one task, made over several tasks as one transaction: one `change`, one
 * step of undo, finished first by what reads the rows or writes before its last step. And the
 * creations next to each other in a transaction, made as one write of their rows
 */

import { TablesStore } from '@sakuzu/kasane/render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawStore } from '../store/draw-store.js';
import { TableContractStore } from '../store/table-memory.js';
import { writesOf } from '../test-support/writes.js';
import { createMapStub, internalsOf } from '../test-utils.js';
import type { Draw } from './draw.js';
import { createDraw } from './draw.js';
import type { Progress } from './write.js';

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

/** `count` rows in the layer `l` (and an empty layer `m`), every one selected in bulk */
function rowsDraw(
  count: number,
  options: ConstructorParameters<typeof TableContractStore>[0] = {},
): { draw: Draw; store: DrawStore } {
  const store = new DrawStore(new TableContractStore(options), { selectionIdsLimit: 2 });
  store.createLayer(layer('l'));
  store.createLayer(layer('m'));
  const draw = createDraw(createMapStub().map, { store: store as never, initDefaultLayer: false });
  draws.push(draw);
  writesOf(draw).features.createMany(
    Array.from({ length: count }, (_, i) => ({
      id: `r${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i * 0.001, 1] },
      layerId: 'l',
      properties: {},
    })) as never,
  );
  draw.selection.setAll();
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

/**
 * The options of a write that tell when its first step is made (its progress is told after each
 * step a later one follows), and the promise of that
 */
function stepped(): { options: { onProgress: () => void }; first: Promise<void> } {
  let told = (): void => {};
  const first = new Promise<void>((resolve) => {
    told = resolve;
  });
  return { options: { onProgress: () => told() }, first };
}

/** Until a promise settles, the microtasks before it run (no later task) */
async function settledInThisTask(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 100 && !settled; i++) await Promise.resolve();
  return settled;
}

const styleOf = (draw: Draw, id: string) => draw.features.get(id)?.properties[STYLE];

describe('a commit too long for one task', () => {
  it('is written over several tasks as one change and one step of undo', async () => {
    const { draw, store } = rowsDraw(1000);
    const commits: string[] = [];
    draw.on('change', (change) => commits.push(change.commit));
    slowClock();
    const target = draw.selection.target;
    const steps = stepped();
    const write = draw.write((tx) => tx.features.update(target, red), steps.options);
    await steps.first;
    expect(store.slicedWritePending).toBe(true);
    expect(commits).toEqual([]);
    expect(await write).toBe(1000);
    expect(commits).toEqual([write.id]);
    expect(store.slicedWritePending).toBe(false);
    expect(styleOf(draw, 'r0')).toEqual({ pointColor: '#ff0000' });
    expect(styleOf(draw, 'r999')).toEqual({ pointColor: '#ff0000' });
    await draw.undo();
    expect(styleOf(draw, 'r0')).toBeUndefined();
    expect(styleOf(draw, 'r999')).toBeUndefined();
  });

  it('is read as the document before it until its last step, without finishing it', async () => {
    const { draw, store } = rowsDraw(1000);
    const commits: string[] = [];
    draw.on('change', (change) => commits.push(change.commit));
    slowClock();
    const target = draw.selection.target;
    const steps = stepped();
    const write = draw.write((tx) => tx.features.update(target, red), steps.options);
    await steps.first;
    expect(store.slicedWritePending).toBe(true);
    // The rows of the first part are written, but read as they were
    expect(styleOf(draw, 'r0')).toBeUndefined();
    expect(styleOf(draw, 'r999')).toBeUndefined();
    expect(draw.features.list({}, { limit: 3 }).map((f) => f.properties[STYLE])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(store.slicedWritePending).toBe(true);
    expect(commits).toEqual([]);
    expect((await write.result).skipped).toBe(0);
    expect(styleOf(draw, 'r0')).toEqual({ pointColor: '#ff0000' });
    expect(styleOf(draw, 'r999')).toEqual({ pointColor: '#ff0000' });
  });

  it('is finished by a read of the rows of this client before its last step', async () => {
    const { draw, store } = rowsDraw(1000);
    slowClock();
    const target = draw.selection.target;
    const steps = stepped();
    const write = draw.write((tx) => tx.features.update(target, red), steps.options);
    await steps.first;
    expect(store.slicedWritePending).toBe(true);
    // What this client does reads the Store itself: nothing reads the rows half written
    expect(store.getFeature('r999')?.style).toEqual({ pointColor: '#ff0000' });
    expect(store.slicedWritePending).toBe(false);
    expect((await write.result).skipped).toBe(0);
  });

  it('is finished by another write of this client, which comes after it', async () => {
    const { draw } = rowsDraw(1000);
    const commits: string[] = [];
    draw.on('change', (change) => commits.push(change.commit));
    slowClock();
    const target = draw.selection.target;
    const steps = stepped();
    const first = draw.write((tx) => tx.features.update(target, red), steps.options);
    await steps.first;
    const blue = { properties: { [STYLE]: { pointColor: '#0000ff' } } };
    const second = draw.write((tx) => tx.features.update('r0', blue));
    await Promise.all([first, second]);
    expect(commits).toEqual([first.id, second.id]);
    expect(styleOf(draw, 'r0')).toEqual({ pointColor: '#0000ff' });
    expect(styleOf(draw, 'r1')).toEqual({ pointColor: '#ff0000' });
  });

  it('deletes rows in parts, the groups they leave empty deleted at its end', async () => {
    const { draw, store } = rowsDraw(1000);
    const group = await draw.write((tx) =>
      tx.groups.create({ members: ['r0', 'r1', 'r2'], name: 'g' }),
    );
    draw.selection.setAll();
    const commits: string[] = [];
    draw.on('change', (change) => commits.push(change.commit));
    slowClock();
    const target = draw.selection.target;
    const steps = stepped();
    const write = draw.write((tx) => tx.features.delete(target), steps.options);
    await steps.first;
    expect(store.slicedWritePending).toBe(true);
    // The group of the first part stays until the last step (read without finishing it)
    expect(store.getGroup(group.id)).toBeDefined();
    expect(await write).toBe(1000);
    expect(store.getGroup(group.id)).toBeUndefined();
    expect(draw.features.count()).toBe(0);
    expect(commits).toEqual([write.id]);
    await draw.undo();
    expect(draw.features.count()).toBe(1000);
    expect(draw.groups.get(group.id)?.name).toBe('g');
    expect(draw.groups.listMembers(group.id)).toEqual(['r0', 'r1', 'r2']);
  });

  it('is made in one task once a write of a layer is made in it', async () => {
    const { draw, store } = rowsDraw(1000);
    slowClock();
    const target = draw.selection.target;
    const write = draw.write(async (tx) => {
      await tx.layers.update('m', { name: 'n' });
      await tx.features.update(target, red);
    });
    expect(await settledInThisTask(write)).toBe(true);
    expect(store.slicedWritePending).toBe(false);
    expect(draw.layers.get('m')?.name).toBe('n');
    expect(styleOf(draw, 'r999')).toEqual({ pointColor: '#ff0000' });
  });

  it('tells its progress, the last time with every part written', async () => {
    const { draw } = rowsDraw(1000);
    slowClock();
    const told: Progress[] = [];
    const target = draw.selection.target;
    await draw.write((tx) => tx.features.update(target, red), {
      onProgress: (progress) => told.push(progress),
    });
    expect(told.length).toBeGreaterThan(1);
    expect(told.every((progress) => progress.phase === 'apply')).toBe(true);
    expect(told[told.length - 1]).toEqual({ phase: 'apply', done: 1000, total: 1000 });
  });

  it('is not stopped by its signal once it began', async () => {
    const { draw } = rowsDraw(1000);
    slowClock();
    const controller = new AbortController();
    const target = draw.selection.target;
    const steps = stepped();
    const write = draw.write((tx) => tx.features.update(target, red), {
      signal: controller.signal,
      ...steps.options,
    });
    await steps.first;
    controller.abort();
    expect(await write).toBe(1000);
    expect(styleOf(draw, 'r999')).toEqual({ pointColor: '#ff0000' });
  });
});

describe('the idle work of the tables during a commit in steps', () => {
  it('waits for the last step, and is asked for again after it', async () => {
    let held: () => boolean = () => false;
    // Each idle period given, and whether a write over several tasks was held then
    const given: boolean[] = [];
    let askedAfter = 0;
    let ended = false;
    // Past the rows from which the index of the boxes is built while the page is idle
    const { draw, store } = rowsDraw(20_000, {
      scheduleIdleWork: (task) => {
        if (ended) askedAfter++;
        const timer = setTimeout(() => {
          given.push(held());
          task(performance.now() + 1000);
        }, 0);
        return () => clearTimeout(timer);
      },
    });
    held = () => store.slicedWritePending;
    // The delta of the layer the rows go to is made a part at a time: each part is a group of its
    // own (a few rows join the newest group, up to a thousand rows or so), so no step makes the
    // rows of the parts before it again
    const proto = TablesStore.prototype as unknown as Record<string, (...args: never[]) => unknown>;
    const rebuild = proto.rebuildDelta;
    const make = proto.makeDeltaGroup;
    /** The rows each rebuild brought in, and the rows of the groups it made */
    const rebuilds: Array<{ coming: number; made: number }> = [];
    vi.spyOn(proto, 'rebuildDelta').mockImplementation(function (this: unknown, ...args: never[]) {
      rebuilds.push({ coming: (args[2] as unknown[]).length, made: 0 });
      return rebuild.apply(this, args);
    });
    vi.spyOn(proto, 'makeDeltaGroup').mockImplementation(function (
      this: unknown,
      ...args: never[]
    ) {
      const made = make.apply(this, args) as { group: { data: { length: number } } } | null;
      const last = rebuilds[rebuilds.length - 1];
      if (last) last.made += made?.group.data.length ?? 0;
      return made;
    });
    slowClock();
    const target = draw.selection.target;
    const steps = stepped();
    const write = draw.write((tx) => tx.features.place(target, { layerId: 'm' }), steps.options);
    await steps.first;
    await write;
    ended = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(draw.features.count({ layerId: 'm' })).toBe(20_000);
    vi.restoreAllMocks();
    expect(rebuilds.length).toBeGreaterThan(1);
    for (const { coming, made } of rebuilds) expect(made).toBeLessThanOrEqual(coming + 1_024);
    expect(internalsOf(store.tables).rowTable('m')?.delta.groups.length).toBeGreaterThan(1);
    // An idle period given while the write was held does no work: the work is asked for again
    expect(given.some((wasHeld) => wasHeld)).toBe(true);
    expect(askedAfter).toBeGreaterThan(0);
  });
});

describe('the creations next to each other in a transaction', () => {
  it('are made as few writes of their rows, in their order', async () => {
    const { draw } = rowsDraw(0);
    const created = vi.spyOn(TableContractStore.prototype, 'createFeatures');
    const ids = await draw.write(async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < 300; i++) {
        const feature = await tx.features.create({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [i * 0.001, 2] },
          properties: { 'maplibre-gl-draw:layerId': 'l', n: i },
        });
        out.push(feature.id);
      }
      return out;
    });
    expect(created.mock.calls.length).toBeLessThanOrEqual(2);
    expect(draw.layers.listItems('l')).toEqual(ids);
  });

  it('leave out a creation whose layer is gone at the commit, as a creation alone is', async () => {
    const { draw, store } = rowsDraw(0);
    const write = draw.write(async (tx) => {
      await tx.features.create({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0, 2] },
        properties: { 'maplibre-gl-draw:layerId': 'l' },
      });
      await tx.features.create({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { 'maplibre-gl-draw:layerId': 'm' },
      });
      await tx.features.create({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [2, 2] },
        properties: { 'maplibre-gl-draw:layerId': 'l' },
      });
      // The layer goes from elsewhere before the commit
      store.transact(() => store.deleteLayer('m'), 'remote');
    });
    expect((await write.result).skipped).toBe(1);
    expect(draw.features.count({ layerId: 'l' })).toBe(2);
  });
});
