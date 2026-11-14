// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The commits of this client sent to a storage of the first shape: random runs of commits, with
 * sends that fail before and after the storage applied them, leave the reference storage with the
 * document the instance writes out, on a Store of objects and on a Store of rows (its rows read at
 * once and over several tasks); a commit is one commit for the storage, whatever writes it over
 * several tasks; `Write.save` follows a commit to its stage, and `draw.status` tells how far
 */

import { createReferenceBackend } from '@sakuzu/maplibre-gl-draw-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { writeKindsInSlices } from '../../operations/bulk-sliced.js';
import { type BulkKinds, transformKinds } from '../../operations/bulk-transform.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { random, step, storedOf, writtenOf } from '../../test-support/random-commits.js';
import { createMapStub } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { Change } from '../events.js';
import { createDrawOnEngine } from '../impl/create-draw.js';
import { createEngine } from '../impl/engine.js';
import { toEngineOptions } from '../impl/options.js';
import type { Status } from '../status.js';
import type { FeatureTables } from '../tables.js';
import type { Answer, Backend } from './backend.js';
import type { SenderOptions } from './sender.js';
import type { StoredDocument, ValueBatch } from './values.js';

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

const KINDS: ReadonlyArray<readonly [string, () => Store]> = [
  ['objects', () => new MemoryStore()],
  ['rows', () => createTableStore().store],
];

/**
 * An instance on a Store with a storage. `createDraw` takes a Store or a storage, not both, while
 * the two ways stand side by side: the tests of a Store of rows make the instance on its engine
 */
function drawWith(
  store: Store,
  backend: Backend,
  senderOptions: Pick<SenderOptions, 'rowsReadAtOnce' | 'retryDelay'> = {},
): Draw {
  const options = { store, backend, initDefaultLayer: false };
  const engine = createEngine(
    createMapStub().map,
    toEngineOptions(options, () => false),
    { deferDefaultMode: true },
  );
  const made = createDrawOnEngine(engine, options, () => {}, senderOptions);
  engine.enterDefaultMode();
  return made;
}

/** A storage over the reference storage that records what it is sent, failing when asked */
function recording(options: { fail?: (batch: ValueBatch) => 'before' | 'after' | null } = {}) {
  const reference = createReferenceBackend();
  const sent: ValueBatch[] = [];
  // The document the storage holds once each commit is applied, by commit
  const after = new Map<string, unknown>();
  let failures = 0;
  const backend: Backend & { readonly document: StoredDocument } = {
    document: reference.document,
    maxBatchBytes: 700,
    load: (task) => reference.load(task),
    async send(batch, task): Promise<Answer> {
      sent.push(batch);
      const fail = options.fail?.(batch) ?? null;
      if (fail === 'before') {
        failures++;
        throw new Error('cut before');
      }
      const answer = await reference.send(batch, task);
      if (answer.status === 'accepted' && !after.has(batch.commit)) {
        after.set(batch.commit, structuredClone(storedOf(reference.document)));
      }
      if (fail === 'after') {
        // Applied, and the answer lost
        failures++;
        throw new Error('cut after');
      }
      return answer;
    },
    abandon: (commit, task) => reference.abandon?.(commit, task) ?? Promise.resolve(),
  };
  return { backend, sent, after, failures: () => failures };
}

/** Until every commit is accepted */
async function settled(d: Draw): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { saving, connection } = d.status.value;
    if (saving.unsaved === 0 && connection.state === 'online') return;
  }
  throw new Error(`Not saved: ${JSON.stringify(d.status.value.saving)}`);
}

describe('the commits sent to a storage', () => {
  for (const [kind, makeStore] of KINDS) {
    for (const [atOnce, waits] of (kind === 'rows'
      ? [
          [undefined, false],
          [0, false],
          [undefined, true],
          [0, true],
        ]
      : [
          [undefined, false],
          [undefined, true],
        ]) as [number | undefined, boolean][]) {
      const how = `${atOnce === 0 ? ', the rows read over several tasks' : ''}${
        waits ? ', the sending going on between the writes' : ''
      }`;
      it(`leave the storage with the document written out, sends failing (${kind}${how})`, async () => {
        let failures = 0;
        let commits = 0;
        for (const seed of [11, 12, 13, 14]) {
          const next = random(seed);
          const fail = random(seed + 100);
          const storage = recording({
            fail: () => {
              const pick = fail();
              return pick < 0.15 ? 'before' : pick < 0.25 ? 'after' : null;
            },
          });
          draw = drawWith(makeStore(), storage.backend, {
            retryDelay: () => 0,
            ...(atOnce !== undefined && { rowsReadAtOnce: atOnce }),
          });
          await draw.write(async (tx) => {
            await tx.layers.create({ id: 'a', name: 'A' });
            await tx.layers.create({ id: 'b', name: 'B' });
          });
          // The document written out once each commit is made, by commit
          const made = new Map<string, unknown>();
          let last: string | null = null;
          draw.on('change', (change) => {
            last = change.commit;
          });
          const ids = { feature: 0, layer: 0, group: 0 };
          for (let i = 0; i < 60; i++) {
            last = null;
            await step(draw, next, ids);
            // Tasks pass now and then: the next write comes while a commit is read or sent
            if (waits) {
              for (let t = Math.floor(fail() * 4); t > 0; t--) {
                await new Promise((resolve) => setTimeout(resolve, 0));
              }
            }
            if (last !== null) made.set(last, structuredClone(writtenOf(draw.document.toJSON())));
            // Now and then the storage catches up, and holds the document written out
            if (i % 20 === 19) {
              await settled(draw);
              expect(storedOf(storage.backend.document)).toEqual(writtenOf(draw.document.toJSON()));
            }
          }
          await settled(draw);
          expect({ seed, stored: storedOf(storage.backend.document) }).toEqual({
            seed,
            stored: writtenOf(draw.document.toJSON()),
          });
          // Each commit is sent as it was made, not with what the commits after it wrote (a
          // commit that changed nothing the storage keeps sends nothing)
          let previous: unknown = null;
          let checked = 0;
          for (const [commit, written] of made) {
            const stored = storage.after.get(commit);
            if (stored === undefined) {
              expect({ seed, commit, unchanged: written }).toEqual({
                seed,
                commit,
                unchanged: previous,
              });
              continue;
            }
            previous = written;
            checked++;
            expect({ seed, commit, stored }).toEqual({
              seed,
              commit,
              stored: written,
            });
          }
          expect(checked).toBeGreaterThan(30);
          failures += storage.failures();
          commits += new Set(storage.sent.map((batch) => batch.commit)).size;
          draw.destroy();
          draw = undefined;
        }
        expect(failures).toBeGreaterThan(10);
        expect(commits).toBeGreaterThan(100);
      });
    }
  }

  it('sends a commit with the ID of its write and of its change', async () => {
    const storage = recording();
    const store = new MemoryStore();
    draw = drawWith(store, storage.backend);
    const changes: Change[] = [];
    draw.on('change', (change) => changes.push(change));
    const write = draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' }), { label: 'made' });
    await write.save();
    expect(storage.sent.map((batch) => [batch.commit, batch.label])).toEqual([[write.id, 'made']]);
    expect(changes.map((change) => change.commit)).toEqual([write.id]);
    // A write of the host to the Store, with no write of the instance: one ID too
    store.createFeature({
      id: 'p',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 2] },
      layerId: 'a',
      groupId: undefined,
      properties: {},
      style: {},
      visible: true,
      locked: false,
    });
    await settled(draw);
    expect(storage.sent).toHaveLength(2);
    expect(storage.sent[1].commit).toBe(changes[1].commit);
    expect(storage.backend.document.features.has('p')).toBe(true);
  });

  for (const [kind, makeStore] of KINDS) {
    it(`sends a selection of more than 2,000 features written as one commit (${kind})`, async () => {
      const storage = recording();
      draw = drawWith(makeStore(), { ...storage.backend, maxBatchBytes: 1 << 20 });
      await draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
      const inputs = Array.from({ length: 2500 }, (_, i) => ({
        type: 'Feature' as const,
        id: `f${i}`,
        geometry: { type: 'Point' as const, coordinates: [i * 0.001, 1] },
        properties: { 'maplibre-gl-draw:layerId': 'a', n: i },
      }));
      await draw.write((tx) => tx.features.create(inputs));
      await settled(draw);
      draw.selection.setAll();
      expect(draw.selection.value.count).toBe(2500);
      const target = draw.selection.target;
      const sentBefore = storage.sent.length;
      const write = draw.write((tx) => tx.features.update(target, { properties: { n: -1 } }));
      await write.save();
      const batches = storage.sent.slice(sentBefore);
      expect(new Set(batches.map((batch) => batch.commit))).toEqual(new Set([write.id]));
      const updated = batches
        .flatMap((batch) => batch.operations)
        .flatMap((operation) =>
          operation.type === 'set' && operation.kind === 'feature' ? operation.ids : [],
        );
      expect(new Set(updated).size).toBe(2500);
      expect(storage.backend.document.features.get('f2499')?.properties.n).toBe(-1);
      expect(storedOf(storage.backend.document)).toEqual(writtenOf(draw.document.toJSON()));
    });
  }

  it('sends the steps of a drag of features selected in bulk as one commit', async () => {
    const storage = recording();
    const store = createTableStore().store;
    draw = drawWith(store, { ...storage.backend, maxBatchBytes: 1 << 20 });
    await draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
    const inputs = Array.from({ length: 3000 }, (_, i) => ({
      type: 'Feature' as const,
      id: `f${i}`,
      geometry: { type: 'Point' as const, coordinates: [i * 0.001, 1] },
      properties: { 'maplibre-gl-draw:layerId': 'a' },
    }));
    await draw.write((tx) => tx.features.create(inputs));
    await settled(draw);
    const changes: Change[] = [];
    draw.on('change', (change) => changes.push(change));
    const tables = store.tables as FeatureTables;
    draw.selection.setAll();
    const rows = store.getSelectedRows();
    expect(rows?.count).toBe(3000);
    if (!rows) return;
    const sentBefore = storage.sent.length;
    const ended = new Promise<void>((resolve) => {
      writeKindsInSlices(
        store,
        rows,
        transformKinds(store, { kind: 'translate', from: [0, 0], to: [1, 0] }, rows) as BulkKinds,
        { onDone: () => resolve(), budgetMs: 0 },
      );
    });
    await ended;
    await settled(draw);
    // Written in steps, a change each, all of one commit
    expect(changes.length).toBeGreaterThan(2);
    expect(new Set(changes.map((change) => change.commit)).size).toBe(1);
    const batches = storage.sent.slice(sentBefore);
    expect(new Set(batches.map((batch) => batch.commit))).toEqual(new Set([changes[0].commit]));
    expect(tables.getRowRef('f2999')).toBeDefined();
    expect(storedOf(storage.backend.document)).toEqual(writtenOf(draw.document.toJSON()));
    // One step of undo, taken back as one commit
    const undo = draw.undo();
    await undo.save();
    expect(storedOf(storage.backend.document)).toEqual(writtenOf(draw.document.toJSON()));
    expect(storage.sent[storage.sent.length - 1]?.commit).toBe(undo.id);
  });
});

describe('a commit of many rows read over several tasks', () => {
  it('is sent as it was made, whatever is written while it is read', async () => {
    const storage = recording();
    const store = createTableStore().store;
    const d = drawWith(
      store,
      { ...storage.backend, maxBatchBytes: 1 << 20 },
      { retryDelay: () => 0 },
    );
    draw = d;
    await d.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
    await settled(d);
    let last = '';
    d.on('change', (change) => {
      last = change.commit;
    });
    const made = new Map<string, unknown>();
    const note = (): void => {
      made.set(last, structuredClone(writtenOf(d.document.toJSON())));
    };
    const count = 30_000;
    const inputs = Array.from({ length: count }, (_, i) => ({
      type: 'Feature' as const,
      id: `f${i}`,
      geometry: { type: 'Point' as const, coordinates: [i * 0.0001, 1] },
      properties: { 'maplibre-gl-draw:layerId': 'a', n: i },
    }));
    const created = draw.write((tx) => tx.features.create(inputs));
    await created;
    note();
    // Writes while the rows of the creation are read, a few tasks apart
    let whileRead = 0;
    for (let i = 0; i < 12; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!storage.after.has(created.id)) whileRead++;
      const ids = Array.from({ length: 50 }, (_, k) => `f${(i * 997 + k * 131) % count}`);
      await draw.write((tx) => tx.features.update(ids, { properties: { n: -i, [`m${i}`]: i } }));
      note();
      if (i % 3 === 0) {
        await draw.write((tx) => tx.features.delete([`f${i * 7}`]));
        note();
      }
    }
    expect(whileRead).toBeGreaterThan(3);
    await settled(draw);
    expect(storedOf(storage.backend.document)).toEqual(writtenOf(draw.document.toJSON()));
    expect(made.size).toBe(17);
    for (const [commit, written] of made) {
      expect({ commit, stored: storage.after.get(commit) }).toEqual({ commit, stored: written });
    }
  }, 60_000);
});

describe('Write.save', () => {
  it('settles at the stage asked for, and fails as the storage refuses', async () => {
    let refuse = false;
    const storage = recording();
    const backend: Backend = {
      ...storage.backend,
      stages: ['durable'],
      async send(batch, task) {
        if (refuse) return { status: 'refused', reason: 'rules', message: 'not that' };
        const answer = await storage.backend.send(batch, task);
        return answer.status === 'accepted' ? { status: 'accepted', durable: true } : answer;
      },
    };
    draw = drawWith(new MemoryStore(), backend);
    expect(draw.status.value.saving.stages).toEqual(['local', 'accepted', 'durable']);
    const write = draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
    await write.save({ until: 'durable' });
    expect(draw.status.value.saving).toMatchObject({ stage: 'durable', unsaved: 0, refused: 0 });
    refuse = true;
    const refused = draw.write((tx) => tx.layers.create({ id: 'b', name: 'B' }));
    await expect(refused.save()).rejects.toMatchObject({ code: 'refused' });
    expect(draw.status.value.saving.refused).toBe(1);
    // Asked again later, it fails the same
    await expect(refused.save()).rejects.toMatchObject({ code: 'refused' });
    // A write that failed saves nothing: it fails as the write
    const failed = draw.write(() => Promise.reject(new DrawError('invalidInput', 'no')));
    await expect(failed).rejects.toMatchObject({ code: 'invalidInput' });
    await expect(failed.save()).rejects.toMatchObject({ code: 'invalidInput' });
    // A stage the storage does not go through
    await expect(write.save({ until: 'stored' })).rejects.toMatchObject({ code: 'invalidState' });
  });

  it('fails with invalidState without a storage', async () => {
    draw = createDraw(createMapStub().map);
    const write = draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
    await expect(write.save()).rejects.toMatchObject({ code: 'invalidState' });
    await expect(draw.undo().save()).rejects.toMatchObject({ code: 'invalidState' });
  });

  it('sends at once a commit waiting to be sent again, and tells the connection', async () => {
    let down = true;
    const storage = recording({ fail: () => (down ? 'before' : null) });
    draw = drawWith(new MemoryStore(), storage.backend, { retryDelay: () => 60_000 });
    const seen: Status['connection'][] = [];
    // Each connection once: the state is made again for its other parts too
    draw.status.subscribe((status) => {
      if (seen[seen.length - 1] !== status.connection) seen.push(status.connection);
    });
    const write = draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
    await write;
    for (let i = 0; i < 20 && draw.status.value.connection.state !== 'offline'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(draw.status.value.connection).toMatchObject({ state: 'offline', attempt: 1 });
    expect(draw.status.value.saving.unsaved).toBe(1);
    down = false;
    // Waiting a minute is cut short by the save
    await write.save();
    expect(draw.status.value.connection.state).toBe('online');
    expect(seen.map((connection) => connection.state)).toEqual(['online', 'offline', 'online']);
    expect(storage.backend.document.layers.has('a')).toBe(true);
  });

  it('gives up a commit past the retries of the storage, and sends the next', async () => {
    const storage = recording({ fail: (batch) => (batch.label === 'lost' ? 'before' : null) });
    draw = drawWith(
      new MemoryStore(),
      { ...storage.backend, retry: { maxAttempts: 3 } },
      { retryDelay: () => 0 },
    );
    const lost = draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' }), { label: 'lost' });
    const next = draw.write((tx) => tx.layers.create({ id: 'b', name: 'B' }));
    await expect(lost.save()).rejects.toMatchObject({ code: 'refused' });
    await next.save();
    expect(storage.sent.filter((batch) => batch.label === 'lost')).toHaveLength(3);
    expect(storage.backend.document.layers.has('b')).toBe(true);
  });

  it('stops at a closed connection: the saves fail with its reason', async () => {
    const storage = recording();
    draw = drawWith(new MemoryStore(), {
      ...storage.backend,
      send: async () => ({ status: 'closed', reason: 'permission' }),
    });
    const write = draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
    await expect(write.save()).rejects.toMatchObject({ code: 'permission' });
    expect(draw.status.value.connection).toMatchObject({ state: 'closed', reason: 'permission' });
    expect(draw.status.value.saving.unsaved).toBe(1);
  });
});

describe('createDraw with a storage', () => {
  it('takes a Store or a storage, not both', () => {
    const { backend } = recording();
    expect(() => createDraw(createMapStub().map, { store: new MemoryStore(), backend })).toThrow(
      expect.objectContaining({ code: 'invalidInput' }),
    );
    expect(() =>
      createDraw(createMapStub().map, { backend: { load: backend.load } as unknown as Backend }),
    ).toThrow(expect.objectContaining({ code: 'invalidInput' }));
  });

  it('sends the commits of the built-in Store', async () => {
    const { backend } = recording();
    draw = createDraw(createMapStub().map, { backend, initDefaultLayer: false });
    expect(draw.status.value.connection.state).toBe('online');
    await draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' })).save();
    expect(backend.document.layers.get('a')?.name).toBe('A');
  });
});

describe('draw.status', () => {
  it('has no storage and the steps of undo, the same object while nothing changes', async () => {
    draw = createDraw(createMapStub().map, { initDefaultLayer: false });
    const first = draw.status.value;
    expect(first).toMatchObject({
      document: { state: 'open' },
      connection: { state: 'none' },
      saving: { stage: 'local', stages: ['local'], unsaved: 0, refused: 0 },
      history: { canUndo: false, canRedo: false },
      editable: true,
      problems: [],
    });
    expect(draw.status.value).toBe(first);
    await draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' }), { label: 'a layer' });
    expect(draw.status.value.history).toEqual({
      canUndo: true,
      canRedo: false,
      undoLabel: 'a layer',
      redoLabel: undefined,
    });
    await draw.undo();
    expect(draw.status.value.history).toEqual({
      canUndo: false,
      canRedo: true,
      undoLabel: undefined,
      redoLabel: 'a layer',
    });
    await draw.redo();
    expect(draw.status.value.history).toMatchObject({ canUndo: true, undoLabel: 'a layer' });
    const before = draw.status.value;
    // A selection changes nothing of the state
    draw.selection.clear();
    expect(draw.status.value).toBe(before);
    draw.setReadOnly(true);
    expect(draw.status.value.editable).toBe(false);
    draw.setReadOnly(false);
    expect(draw.status.value.editable).toBe(true);
  });

  it('keeps the writes a commit left out as problems, the newest first', async () => {
    draw = createDraw(createMapStub().map, { initDefaultLayer: false });
    await draw.write(async (tx) => {
      await tx.layers.create({ id: 'a', name: 'A' });
      await tx.features.create({
        type: 'Feature',
        id: 'f',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { 'maplibre-gl-draw:layerId': 'a' },
      });
    });
    const d = draw;
    const late = (label: string) =>
      d.write(
        async (tx) => {
          await tx.features.update('f', { properties: { n: 1 } });
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
        { label },
      );
    const first = late('first');
    await d.write((tx) => tx.features.delete('f'));
    expect((await first.result).skipped).toBe(1);
    await d.write((tx) =>
      tx.features.create({
        type: 'Feature',
        id: 'f',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { 'maplibre-gl-draw:layerId': 'a' },
      }),
    );
    const second = late('second');
    await d.write((tx) => tx.features.delete('f'));
    await second;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const problems = d.status.value.problems;
    expect(problems.map((problem) => [problem.type, problem.label, problem.commit])).toEqual([
      ['skipped', 'second', second.id],
      ['skipped', 'first', first.id],
    ]);
    expect(problems[0]).toMatchObject({ count: 1, error: { code: 'notFound' } });
    expect(problems[0].id).toBeGreaterThan(problems[1].id);
  });

  it('keeps 20 problems at most', async () => {
    draw = createDraw(createMapStub().map, { initDefaultLayer: false });
    await draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
    const d = draw;
    for (let i = 0; i < 22; i++) {
      await d.write((tx) =>
        tx.features.create({
          type: 'Feature',
          id: `f${i}`,
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: { 'maplibre-gl-draw:layerId': 'a' },
        }),
      );
      const late = d.write(async (tx) => {
        await tx.features.update(`f${i}`, { properties: { n: 1 } });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await d.write((tx) => tx.features.delete(`f${i}`));
      await late;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.status.value.problems).toHaveLength(20);
  });

  it('keeps the edits the storage left out as problems', async () => {
    const storage = recording();
    draw = drawWith(new MemoryStore(), {
      ...storage.backend,
      async send(batch, task) {
        await storage.backend.send(batch, task);
        return { status: 'accepted', skipped: [{ ids: ['a'], reason: 'no room' }] };
      },
    });
    const write = draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' }), { label: 'x' });
    await write.save();
    expect(draw.status.value.problems).toEqual([
      expect.objectContaining({
        type: 'skipped',
        label: 'x',
        commit: write.id,
        count: 1,
        error: expect.objectContaining({ code: 'refused', ids: ['a'] }),
      }),
    ]);
  });
});
