// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The document opened from its storage, and closed: `draw.open()` reads it (`load`), connects the
 * storage and sends on what its outbox kept; what the storage writes (`receive`, `replace`,
 * `advance`, `report`, `key`); what is received while a commit is not answered, when that commit is
 * refused; `draw.close` with each `unsent`, and `draw.remove`
 */

import { createReferenceBackend } from '@sakuzu/maplibre-gl-draw-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { random, storedOf, writtenOf } from '../../test-support/random-commits.js';
import { drawWith, point, STORE_KINDS, settled } from '../../test-support/refusing-storage.js';
import { createMapStub } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import type { Change } from '../events.js';
import type { DrawDocument } from '../model.js';
import type { Refusal, SaveStage } from '../status.js';
import type { Answer, Backend, BackendContext, Outbox } from './backend.js';
import { readStoredDocument } from './kept.js';
import {
  applyOperations,
  type Batch,
  type FeatureRecord,
  type StoredDocument,
  type ValueBatch,
  type ValueOperation,
} from './values.js';

const LAYER = 'maplibre-gl-draw:layerId';

const draws: Draw[] = [];

afterEach(() => {
  for (const d of draws.splice(0)) {
    try {
      d.destroy();
    } catch {
      // Removed by the test
    }
  }
});

/** The document of a storage as a document of the library, as a storage gives it to open */
function documentOf(document: StoredDocument): DrawDocument {
  const shown = storedOf(readStoredDocument(document).shown);
  return {
    version: '4.0.0',
    layerOrder: shown.layers.map((layer) => layer.id),
    layers: shown.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      styleRule: undefined,
      metadata: undefined,
      items: layer.items,
    })),
    groups: shown.groups,
    features: shown.features.map((feature) => ({
      type: 'Feature',
      ...feature,
    })) as DrawDocument['features'],
  };
}

/**
 * A document with the items of its layers and groups sorted by their IDs: the order of the items a
 * document read without keys gets here is not the storage's (see `opened`)
 */
function unordered<T extends { layers: { items: string[] }[]; groups: { featureIds: string[] }[] }>(
  document: T,
): T {
  return {
    ...document,
    layers: document.layers.map((layer) => ({ ...layer, items: [...layer.items].sort() })),
    groups: document.groups.map((group) => ({
      ...group,
      featureIds: [...group.featureIds].sort(),
    })),
  };
}

/** An outbox in memory */
function memoryOutbox(): Outbox & {
  readonly batches: Map<string, Batch>;
  readonly kept: Map<string, Refusal>;
} {
  const batches = new Map<string, Batch>();
  const kept = new Map<string, Refusal>();
  return {
    batches,
    kept,
    async put(batch) {
      batches.set(batch.id, batch);
    },
    async delete(id) {
      batches.delete(id);
      kept.delete(id);
    },
    async list() {
      return [...batches.values()];
    },
    async keep(refusal) {
      kept.set(refusal.id, refusal);
    },
    async refusals() {
      return [...kept.values()];
    },
  };
}

/**
 * The reference storage, connected: it holds its answers while the test says so, refuses what the
 * test names, and gives the edits made elsewhere (`push`)
 */
function storage(
  options: {
    readonly outbox?: Outbox;
    readonly stages?: readonly SaveStage[];
    readonly refuse?: (batch: ValueBatch) => boolean;
    readonly connect?: boolean;
  } = {},
) {
  const reference = createReferenceBackend();
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  const sent: ValueBatch[] = [];
  let context: BackendContext | null = null;
  const counts = { loads: 0, connects: 0, cuts: 0 };

  const backend: Backend = {
    maxBatchBytes: 700,
    ...(options.stages && { stages: options.stages }),
    ...(options.outbox && { outbox: options.outbox }),
    async load() {
      counts.loads++;
      return documentOf(reference.document);
    },
    ...(options.connect !== false && {
      async connect(given: BackendContext) {
        counts.connects++;
        context = given;
        return () => {
          counts.cuts++;
          context = null;
        };
      },
    }),
    async send(batch, task): Promise<Answer> {
      sent.push(batch);
      if (gate) await gate;
      if (options.refuse?.(batch)) return { status: 'refused', reason: 'rules', message: 'no' };
      return reference.send(batch, task);
    },
    abandon: (commit, task) => reference.abandon?.(commit, task) ?? Promise.resolve(),
  };
  return {
    backend,
    document: reference.document,
    sent,
    counts,
    get context(): BackendContext {
      if (!context) throw new Error('Not connected');
      return context;
    },
    hold() {
      if (gate) return;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open?.();
    },
    /** What was written elsewhere: applied by the storage, then received here */
    push(operations: readonly ValueOperation[]): Promise<void> {
      applyOperations(reference.document, operations);
      return (context as BackendContext).receive({ source: 'remote', operations });
    },
  };
}

function layerOperation(id: string, key: string): ValueOperation {
  return {
    type: 'create',
    kind: 'layer',
    id,
    record: { name: id, visible: true, locked: false, opacity: 1, style: {}, styleRule: null, key },
  };
}

function featureRecord(layerId: string, key: string, n = 0): FeatureRecord {
  return {
    geometry: { type: 'Point', coordinates: [1, 2] },
    properties: { [LAYER]: layerId, n },
    key,
  };
}

/** A key of the order of a number, in the order of the numbers */
function keyOf(i: number): string {
  return `V${String(i).padStart(6, '0')}`;
}

/** The creations of three points of the layer `a` */
const THREE: readonly ValueOperation[] = [1, 2, 3].map((i) => ({
  type: 'create',
  kind: 'feature',
  id: `f${i}`,
  record: featureRecord('a', keyOf(i)),
}));

/** A storage holding a layer `a` of three points */
function seeded(options: Parameters<typeof storage>[0] = {}) {
  const made = storage(options);
  applyOperations(made.document, [layerOperation('a', 'V'), ...THREE]);
  return made;
}

/**
 * An instance opened from a storage holding a layer `a`, then given its three points from
 * elsewhere: the keys of their order are the storage's (a document read from a string or GeoJSON
 * carries none, so the keys here are made from the order)
 */
async function opened(
  makeStore: () => import('../../store/store.js').Store,
  options: Parameters<typeof storage>[0] = {},
) {
  const s = storage(options);
  applyOperations(s.document, [layerOperation('a', 'V')]);
  const d = make(makeStore, s.backend);
  await d.open();
  await s.push(THREE);
  return { s, d };
}

function make(kind: () => import('../../store/store.js').Store, backend: Backend): Draw {
  const d = drawWith(kind(), backend);
  draws.push(d);
  return d;
}

/** The value `n` of a feature */
function n(d: Draw, id: string): unknown {
  return d.features.get(id)?.properties.n;
}

/** Waits a few tasks */
async function tasks(count = 3): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the document opened from its storage', () => {
  for (const [kind, makeStore] of STORE_KINDS) {
    it(`is read from it, written as it gave it (not sent), then the storage is connected (${kind})`, async () => {
      const s = seeded();
      const d = make(makeStore, s.backend);
      const states: string[] = [];
      d.status.subscribe((status) => states.push(status.document.state));
      const changes: Change[] = [];
      d.on('change', (change) => changes.push(change));
      const opened = d.open();
      expect(d.status.value.document).toEqual({
        state: 'opening',
        progress: null,
        viewReady: false,
      });
      expect(d.status.value.editable).toBe(false);
      // A write waits until it is open
      const write = d.write((tx) => tx.features.update('f1', { properties: { n: 5 } }));
      const result = await opened;
      expect(result).toEqual({ features: 3, skipped: [] });
      expect(d.status.value.document).toEqual({ state: 'open' });
      expect(d.status.value.editable).toBe(true);
      expect(states).toContain('opening');
      expect(s.counts).toEqual({ loads: 1, connects: 1, cuts: 0 });
      expect(s.context.draw.features.count()).toBe(3);
      await write;
      expect(n(d, 'f1')).toBe(5);
      await settled(d);
      // Only the write is sent: the document read from the storage is not
      expect([...new Set(s.sent.map((batch) => batch.commit))]).toEqual([write.id]);
      expect(changes.map((change) => change.source)).toEqual(['open', 'local']);
      expect(writtenOf(d.document.toJSON())).toEqual(
        storedOf(readStoredDocument(s.document).shown),
      );
    });

    it(`is opened and receives the edits of others while read-only (${kind})`, async () => {
      const s = seeded();
      const d = make(makeStore, s.backend);
      d.setReadOnly(true);
      await d.open();
      expect(d.features.count()).toBe(3);
      expect(d.status.value.editable).toBe(false);
      await s.push([{ type: 'set', kind: 'feature', ids: ['f1'], set: { properties: { n: 9 } } }]);
      expect(n(d, 'f1')).toBe(9);
      // A large one, written over several tasks, all of it
      const many = Array.from({ length: 6000 }, (_, i) => `r${i}`);
      await s.push(
        many.map((id, i) => ({
          type: 'create',
          kind: 'feature',
          id,
          record: featureRecord('a', keyOf(10 + i), i),
        })),
      );
      expect(d.features.count()).toBe(6003);
      await s.push([{ type: 'delete', kind: 'feature', ids: many }]);
      expect(d.features.count()).toBe(3);
      expect(s.sent).toEqual([]);
    });

    it(`fails as the storage fails to give the document, and tells it (${kind})`, async () => {
      const s = seeded();
      s.backend.load = async () => {
        throw new Error('down');
      };
      const d = make(makeStore, s.backend);
      await expect(d.open()).rejects.toMatchObject({ code: 'network' });
      expect(d.status.value.document.state).toBe('failed');
      // Nothing changed: it can be opened again
      s.backend.load = async () => documentOf(s.document);
      await d.open();
      expect(d.status.value.document.state).toBe('open');
      expect(d.features.count()).toBe(3);
    });
  }

  it('is no source given in place of its options, and needs a storage', async () => {
    const d = drawWith(STORE_KINDS[0][1](), seeded().backend);
    draws.push(d);
    // @ts-expect-error: no such value
    await expect(d.open({ unsent: 'nothing' })).rejects.toMatchObject({
      code: 'invalidInput',
    });
    const none = createDraw(createMapStub().map, { initDefaultLayer: false });
    draws.push(none);
    await expect(none.open()).rejects.toMatchObject({ code: 'invalidState' });
  });
});

describe('what the storage writes', () => {
  for (const [kind, makeStore] of STORE_KINDS) {
    it(`is received over several tasks: the reads give the document before it, change is told once (${kind})`, async () => {
      const { s, d } = await opened(makeStore);
      const changes: Change[] = [];
      d.on('change', (change) => changes.push(change));
      const operations: ValueOperation[] = Array.from({ length: 6000 }, (_, i) => ({
        type: 'create',
        kind: 'feature',
        id: `r${i}`,
        record: featureRecord('a', keyOf(10 + i), i),
      }));
      applyOperations(s.document, operations);
      const received = s.context.receive({ commit: 'c-1', label: 'theirs', operations });
      // Not written yet as the reads read it (a Store of objects writes it at once)
      expect(d.features.count()).toBe(kind === 'rows' ? 3 : 6003);
      await received;
      expect(d.features.count()).toBe(6003);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ source: 'remote', commit: 'c-1', label: 'theirs' });
      expect(writtenOf(d.document.toJSON())).toEqual(
        storedOf(readStoredDocument(s.document).shown),
      );
      expect(s.sent).toEqual([]);
    });

    it(`is written before a write of this client that comes while it is received (${kind})`, async () => {
      const { s, d } = await opened(makeStore);
      const order: string[] = [];
      d.on('change', (change) => order.push(change.source));
      const operations: ValueOperation[] = Array.from({ length: 3000 }, (_, i) => ({
        type: 'set',
        kind: 'feature',
        ids: [`f${(i % 3) + 1}`],
        set: { properties: { n: i } },
      }));
      applyOperations(s.document, operations);
      const received = s.context.receive({ operations });
      const write = d.write((tx) => tx.features.update('f1', { properties: { n: -1 } }));
      await Promise.all([received, write]);
      expect(order).toEqual(['remote', 'local']);
      expect(n(d, 'f1')).toBe(-1);
      expect(n(d, 'f2')).toBe(2998);
      await settled(d);
      expect(writtenOf(d.document.toJSON())).toEqual(
        storedOf(readStoredDocument(s.document).shown),
      );
    });

    it(`keeps a value received after a refused commit wrote the same key (${kind})`, async () => {
      let refuse = false;
      const { s, d } = await opened(makeStore, { refuse: () => refuse });
      s.hold();
      refuse = true;
      // Refused once the answers come: it wrote n of f1 and f2, and made x
      await d.write(async (tx) => {
        await tx.features.update(['f1', 'f2'], { properties: { n: 1 } });
        await tx.features.create(point('x', 'a'));
      });
      await tasks();
      // Received meanwhile: f1 written again, f3 written
      await s.push([
        { type: 'set', kind: 'feature', ids: ['f1'], set: { properties: { n: 7 } } },
        { type: 'set', kind: 'feature', ids: ['f3'], set: { properties: { n: 3 } } },
      ]);
      expect(n(d, 'f1')).toBe(7);
      s.release();
      await settled(d);
      await tasks();
      expect(d.backend.refusals.value).toHaveLength(1);
      // The value received stays, the refused one goes, and so does what it made
      expect([n(d, 'f1'), n(d, 'f2'), n(d, 'f3'), d.features.has('x')]).toEqual([7, 0, 3, false]);
      expect(writtenOf(d.document.toJSON())).toEqual(
        storedOf(readStoredDocument(s.document).shown),
      );
    });

    it(`settles on the document of the storage when a refusal comes while it is received (${kind})`, async () => {
      let refuse = false;
      const { s, d } = await opened(makeStore, { refuse: () => refuse });
      s.hold();
      refuse = true;
      await d.write((tx) => tx.features.update(['f1', 'f2', 'f3'], { properties: { n: 1 } }));
      await tasks();
      const operations: ValueOperation[] = [
        ...Array.from(
          { length: 4000 },
          (_, i): ValueOperation => ({
            type: 'create',
            kind: 'feature',
            id: `r${i}`,
            record: featureRecord('a', keyOf(10 + i), i),
          }),
        ),
        { type: 'set', kind: 'feature', ids: ['f2'], set: { properties: { n: 22 } } },
      ];
      applyOperations(s.document, operations);
      const received = s.context.receive({ operations });
      // The refusal comes before it is all written
      s.release();
      await received;
      await settled(d);
      await tasks();
      expect(d.backend.refusals.value).toHaveLength(1);
      expect([n(d, 'f1'), n(d, 'f2'), n(d, 'f3')]).toEqual([0, 22, 0]);
      expect(writtenOf(d.document.toJSON())).toEqual(
        storedOf(readStoredDocument(s.document).shown),
      );
    });

    it(`settles on the document of the storage in random runs of writes, receipts and refusals (${kind})`, async () => {
      let refusedCount = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const next = random(seed);
        // The commits refused, decided as they are made
        const refused = new Set<string>();
        const { s, d } = await opened(makeStore, { refuse: (batch) => refused.has(batch.commit) });
        // The features a commit not answered yet writes that the storage will accept: what others
        // write of them meanwhile would be applied in another order here and there (this client
        // holds its document; the first shape of a storage tells it nothing of the order)
        const accepting = new Set<string>();
        for (let i = 0; i < 25; i++) {
          const choice = next();
          const id = `f${1 + Math.floor(next() * 3)}`;
          if (choice < 0.35) {
            s.hold();
            const write = d.write((tx) => tx.features.update(id, { properties: { n: i } }));
            if (next() < 0.35) refused.add(write.id);
            else accepting.add(id);
            await tasks(1);
          } else if (choice < 0.7) {
            if (accepting.has(id)) continue;
            await s.push([
              { type: 'set', kind: 'feature', ids: [id], set: { properties: { n: 100 + i } } },
            ]);
          } else {
            s.release();
            await settled(d);
            accepting.clear();
          }
        }
        s.release();
        await settled(d);
        await tasks(10);
        refusedCount += d.backend.refusals.value.length;
        expect({ seed, shown: writtenOf(d.document.toJSON()) }).toEqual({
          seed,
          shown: storedOf(readStoredDocument(s.document).shown),
        });
      }
      expect(refusedCount).toBeGreaterThan(3);
    });
  }

  it('replaces the document, tells the connection, the stages, the editing and the keys', async () => {
    const { s, d } = await opened(STORE_KINDS[1][1], { stages: ['durable'] });
    expect(d.status.value.connection).toEqual({ state: 'connecting', attempt: 1 });
    s.context.report({ connection: { state: 'online', sinceMilliseconds: 5 }, editable: false });
    expect(d.status.value.connection).toEqual({ state: 'online', sinceMilliseconds: 5 });
    expect(d.status.value.editable).toBe(false);
    const transfer = { phase: 'send', done: 1, total: 2 } as const;
    s.context.report({ editable: true, transfer });
    expect(d.status.value.editable).toBe(true);
    expect(d.status.value.saving.sending).toBe(transfer);
    s.context.report({ transfer: null });
    const write = d.write((tx) => tx.features.update('f1', { properties: { n: 4 } }));
    await write.save({ until: 'accepted' });
    expect(d.status.value.saving.stage).toBe('accepted');
    s.context.advance(write.id, 'durable');
    await write.save({ until: 'durable' });
    expect(d.status.value.saving.stage).toBe('durable');
    expect(s.context.key('f2')).toBe(keyOf(2));
    expect(s.context.key('a')).toBe('V');
    expect(s.context.key('nothing')).toBeUndefined();
    // Replaced as the storage holds it: not sent, the steps of undo dropped
    applyOperations(s.document, [
      { type: 'delete', kind: 'feature', ids: ['f3'] },
      { type: 'set', kind: 'feature', ids: ['f2'], set: { properties: { n: 8 } } },
    ]);
    const before = s.sent.length;
    await s.context.replace(documentOf(s.document));
    expect([d.features.has('f3'), n(d, 'f2')]).toEqual([false, 8]);
    expect(d.status.value.history.canUndo).toBe(false);
    await tasks();
    expect(s.sent.length).toBe(before);
  });
});

describe('the document closed', () => {
  for (const [kind, makeStore] of STORE_KINDS) {
    it(`keeps in the outbox the commits not sent and the refusals, sent on and given back by the next opening (${kind})`, async () => {
      const outbox = memoryOutbox();
      let refuse = false;
      const { s, d } = await opened(makeStore, {
        outbox,
        refuse: (batch) => refuse && batch.label === 'no',
      });
      expect(d.status.value.saving.stages).toEqual(['local', 'stored', 'accepted']);
      refuse = true;
      await d.write((tx) => tx.features.update('f3', { properties: { n: 33 } }), { label: 'no' });
      await settled(d);
      await tasks();
      expect(d.backend.refusals.value).toHaveLength(1);
      const refusal = d.backend.refusals.value[0];
      expect([...outbox.kept.keys()]).toEqual([refusal.id]);
      s.hold();
      const one = d.write((tx) => tx.features.update('f1', { properties: { n: 11 } }));
      const two = d.write((tx) => tx.features.create(point('g', 'a', { n: 12 })));
      await one.save({ until: 'stored' });
      await two.save({ until: 'stored' });
      expect(d.status.value.saving.stage).toBe('stored');
      const result = await d.close({ unsent: 'keep' });
      expect(result).toEqual({ unsent: 2, refused: 1, kept: true });
      expect(d.status.value.document).toEqual({ state: 'closed' });
      expect(d.status.value.connection).toMatchObject({
        state: 'closed',
        reason: 'closedByClient',
      });
      expect(d.status.value.editable).toBe(false);
      expect(d.features.count()).toBe(0);
      expect(s.counts.cuts).toBe(1);
      await expect(
        d.write((tx) => tx.features.update('f1', { properties: { n: 0 } })),
      ).rejects.toMatchObject({
        code: 'invalidState',
      });
      // What was in flight reaches the storage or not: it is sent again by its batch
      s.release();
      await tasks();
      await d.open();
      expect([n(d, 'f1'), n(d, 'g'), n(d, 'f3')]).toEqual([11, 12, 0]);
      await settled(d);
      expect(unordered(writtenOf(d.document.toJSON()))).toEqual(
        unordered(storedOf(readStoredDocument(s.document).shown)),
      );
      expect(outbox.batches.size).toBe(1);
      // The refusal is given back with what its commit did
      expect(d.backend.refusals.value).toEqual([refusal]);
      const exported = JSON.parse(await (await d.backend.refusals.export(refusal.id)).text());
      expect(exported.features.map((f: { id: string }) => f.id)).toEqual(['f3']);
      expect(exported.features[0].properties.n).toBe(33);
      await d.backend.refusals.dismiss(refusal.id);
      await tasks();
      expect([outbox.batches.size, outbox.kept.size]).toEqual([0, 0]);
      // A refusal made after it takes another ID
      refuse = true;
      await d.write((tx) => tx.features.update('f2', { properties: { n: 1 } }), { label: 'no' });
      await settled(d);
      await tasks();
      expect(d.backend.refusals.value.map((one) => one.id)).not.toContain(refusal.id);
    });

    it(`waits for the commits not sent, or drops them (${kind})`, async () => {
      const s = seeded();
      const d = make(makeStore, s.backend);
      await d.open();
      s.hold();
      void d.write((tx) => tx.features.update('f1', { properties: { n: 1 } }));
      await tasks();
      // A signal that stops the wait does not close
      const stop = new AbortController();
      const stopped = d.close({ signal: stop.signal });
      stop.abort();
      await expect(stopped).rejects.toMatchObject({ code: 'aborted' });
      expect(d.status.value.document.state).toBe('open');
      const closing = d.close();
      await tasks();
      expect(d.status.value.document.state).toBe('open');
      s.release();
      expect(await closing).toEqual({ unsent: 0, refused: 0, kept: true });
      expect(s.document.features.get('f1')?.properties.n).toBe(1);
      // Opened again, then closed dropping what is not sent
      await d.open();
      s.hold();
      void d.write((tx) => tx.features.update('f1', { properties: { n: 2 } }));
      await tasks();
      expect(await d.close({ unsent: 'discard' })).toEqual({ unsent: 1, refused: 0, kept: false });
      await expect(d.close({ unsent: 'keep' })).resolves.toEqual({
        unsent: 0,
        refused: 0,
        kept: true,
      });
      s.release();
    });

    it(`cannot keep without an outbox, and remove says what is lost (${kind})`, async () => {
      const s = seeded();
      const d = make(makeStore, s.backend);
      await d.open();
      s.hold();
      void d.write((tx) => tx.features.update('f1', { properties: { n: 1 } }));
      await tasks();
      await expect(d.close({ unsent: 'keep' })).rejects.toMatchObject({ code: 'invalidState' });
      expect(d.remove()).toEqual({ unsent: 1, refused: 0, kept: false });
      expect(() => d.features.count()).toThrow();
      expect(s.counts.cuts).toBe(1);
      s.release();
      const outbox = memoryOutbox();
      const kept = seeded({ outbox });
      const other = make(makeStore, kept.backend);
      await other.open();
      kept.hold();
      const write = other.write((tx) => tx.features.update('f1', { properties: { n: 1 } }));
      await write.save({ until: 'stored' });
      expect(other.remove()).toEqual({ unsent: 1, refused: 0, kept: true });
      expect(outbox.batches.size).toBe(1);
      kept.release();
    });

    it(`fails a source in place of commits not sent, unless unsent says what becomes of them (${kind})`, async () => {
      const s = seeded();
      const d = make(makeStore, s.backend);
      await d.open();
      s.hold();
      void d.write((tx) => tx.features.update('f1', { properties: { n: 1 } }));
      await tasks();
      const file = JSON.stringify(documentOf(s.document));
      await expect(d.open(file)).rejects.toMatchObject({ code: 'unsentWrites' });
      expect(n(d, 'f1')).toBe(1);
      await expect(d.open(file, { unsent: 'keep' })).rejects.toMatchObject({
        code: 'invalidState',
      });
      const waiting = d.open(file, { unsent: 'wait' });
      await tasks();
      s.release();
      await waiting;
      expect(n(d, 'f1')).toBe(0);
      s.hold();
      void d.write((tx) => tx.features.update('f2', { properties: { n: 2 } }));
      await tasks();
      await d.open(file, { unsent: 'discard' });
      expect(n(d, 'f2')).toBe(0);
      s.release();
    });
  }
});
