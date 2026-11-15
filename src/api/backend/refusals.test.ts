// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The commits a storage of the first shape refuses: taken out of the document here, so that random
 * runs of commits, some refused, leave this client and the storage with the same document; the four
 * rules of the take-out (a value written again later stays, what was created goes, what was deleted
 * comes back, what depends on a refused commit is refused with it); the records, `export`, `retry`
 * and `dismiss`; `backend.save` and `reconnect`
 */

import { createReferenceBackend } from '@sakuzu/maplibre-gl-draw-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { random, step, storedOf, writtenOf } from '../../test-support/random-commits.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import { createDrawOnEngine } from '../impl/create-draw.js';
import { createEngine } from '../impl/engine.js';
import { toEngineOptions } from '../impl/options.js';
import type { FeatureInput } from '../model.js';
import type { Answer, Backend } from './backend.js';
import { readStoredDocument } from './kept.js';
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

/** An instance on a Store with a storage (see `drawWith` of `sender.test.ts`) */
function drawWith(store: Store, backend: Backend, rowsReadAtOnce?: number): Draw {
  const options = { store, backend, initDefaultLayer: false };
  const engine = createEngine(
    createMapStub().map,
    toEngineOptions(options, () => false),
    { deferDefaultMode: true },
  );
  const made = createDrawOnEngine(engine, options, () => {}, {
    retryDelay: () => 0,
    ...(rowsReadAtOnce !== undefined && { rowsReadAtOnce }),
  });
  engine.enterDefaultMode();
  return made;
}

/**
 * The reference storage, refusing the commits `refuse` names, and holding the answers while `held`
 * says so
 */
function refusing(refuse: (batch: ValueBatch) => boolean) {
  const reference = createReferenceBackend();
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  const sent: ValueBatch[] = [];
  const backend: Backend & { readonly document: StoredDocument } = {
    document: reference.document,
    maxBatchBytes: 700,
    load: (task) => reference.load(task),
    async send(batch, task): Promise<Answer> {
      sent.push(batch);
      if (gate) await gate;
      if (refuse(batch)) return { status: 'refused', reason: 'rules', message: 'no' };
      return reference.send(batch, task);
    },
    abandon: (commit, task) => reference.abandon?.(commit, task) ?? Promise.resolve(),
  };
  return {
    backend,
    sent,
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open?.();
    },
  };
}

/** Until no commit is left to send */
async function settled(d: Draw): Promise<void> {
  for (let i = 0; i < 4000; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (d.status.value.saving.unsaved === 0) return;
  }
  throw new Error(`Not saved: ${JSON.stringify(d.status.value.saving)}`);
}

const point = (
  id: string,
  layerId: string,
  properties: Record<string, unknown> = {},
): FeatureInput => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [1, 2] },
  properties: { 'maplibre-gl-draw:layerId': layerId, ...properties },
});

/** An instance with a layer `a` of three points, saved */
async function started(kind: () => Store, refuse: (batch: ValueBatch) => boolean) {
  const storage = refusing(refuse);
  draw = drawWith(kind(), storage.backend);
  const d = draw;
  await d.write(async (tx) => {
    await tx.layers.create({ id: 'a', name: 'A' });
    await tx.layers.create({ id: 'b', name: 'B' });
    await tx.features.create([point('f1', 'a', { n: 0 }), point('f2', 'a'), point('f3', 'a')]);
  });
  await settled(d);
  return { d, storage };
}

/**
 * The seeds of the random runs: a range, and the seeds that found the shapes of what went wrong
 * while the take-out was made (the same keys under one parent, a create the storage left out, a row
 * deleted read after it was made again and written, records that no longer fit in one tree)
 */
const SEEDS = [
  ...Array.from({ length: 100 }, (_, i) => i + 1),
  120,
  136,
  209,
  238,
  280,
  306,
  307,
  311,
  323,
  331,
  428,
  432,
  500,
  546,
  594,
  706,
  833,
  893,
];

/**
 * Whether the document of a storage has records that do not fit in one tree: a member whose layer
 * key is not the layer of its group, a feature or a group whose container is gone, a group with no
 * member (read by the rules of `kept.ts`)
 */
function outOfTree(document: StoredDocument): boolean {
  const members = new Set<string>();
  for (const record of document.features.values()) {
    const layerId = record.properties['maplibre-gl-draw:layerId'] as string;
    const groupId = record.properties['maplibre-gl-draw:groupId'] as string | undefined;
    if (groupId === undefined) {
      if (!document.layers.has(layerId)) return true;
      continue;
    }
    const group = document.groups.get(groupId);
    if (!group || group.layerId !== layerId) return true;
    members.add(groupId);
  }
  for (const [id, group] of document.groups) {
    if (!document.layers.has(group.layerId) || !members.has(id)) return true;
  }
  return false;
}

/** What the storage shows, by the rules every client reads its document with */
function shownOf(document: StoredDocument) {
  return storedOf(readStoredDocument(document).shown);
}

describe('the commits a storage refuses', () => {
  for (const [kind, makeStore] of KINDS) {
    for (const atOnce of kind === 'rows' ? [undefined, 0] : [undefined]) {
      const how = atOnce === 0 ? ', the rows read over several tasks' : '';
      // The documents are compared with `toEqual`: the order of the keys of an object is not
      // compared (the properties of a feature come in the order they were written), the order of
      // the items of a layer or a group is
      it(`leave this client with the document of the storage (${kind}${how})`, async () => {
        let refused = 0;
        let outside = 0;
        for (const seed of SEEDS) {
          const next = random(seed);
          const pick = random(seed + 100);
          const made = new Set<string>();
          const storage = refusing((batch) => made.has(batch.commit) && pick() < 0.15);
          draw = drawWith(makeStore(), storage.backend, atOnce);
          const d = draw;
          d.on('change', (change) => {
            if (change.source !== 'refused' && change.source !== 'remote') made.add(change.commit);
          });
          await d.write(async (tx) => {
            await tx.layers.create({ id: 'a', name: 'A' });
            await tx.layers.create({ id: 'b', name: 'B' });
          });
          const ids = { feature: 0, layer: 0, group: 0 };
          let seen = false;
          for (let i = 0; i < 70; i++) {
            // Now and then the answers wait: the commits after one refused are made before it is
            if (pick() < 0.3) storage.hold();
            await step(d, next, ids);
            await step(d, next, ids);
            storage.release();
            if (outOfTree(storage.backend.document)) seen = true;
            if (i % 10 === 9) {
              await settled(d);
              if (outOfTree(storage.backend.document)) seen = true;
              expect({ seed, i, stored: shownOf(storage.backend.document) }).toEqual({
                seed,
                i,
                stored: writtenOf(d.document.toJSON()),
              });
            }
          }
          await settled(d);
          expect({ seed, stored: shownOf(storage.backend.document) }).toEqual({
            seed,
            stored: writtenOf(d.document.toJSON()),
          });
          refused += d.backend.refusals.value.length;
          if (seen) outside++;
          expect(d.status.value.saving.refused).toBe(d.backend.refusals.value.length);
          draw.destroy();
          draw = undefined;
        }
        expect(refused).toBeGreaterThan(400);
        // The runs whose storage came to hold records out of one tree are read by the rules too
        expect(outside).toBeGreaterThan(10);
      }, 60_000);
    }

    it(`keep a value a later commit wrote again (${kind})`, async () => {
      const { d, storage } = await started(makeStore, (batch) => batch.label === 'first');
      storage.hold();
      await d.write((tx) => tx.features.update('f1', { properties: { n: 1 } }), { label: 'first' });
      await d.write((tx) => tx.features.update('f1', { properties: { n: 2 } }));
      storage.release();
      await settled(d);
      expect(d.features.get('f1')?.properties.n).toBe(2);
      expect(storage.backend.document.features.get('f1')?.properties.n).toBe(2);
      expect(shownOf(storage.backend.document)).toEqual(writtenOf(d.document.toJSON()));
    });

    it(`take a value back to the one before both commits when both are refused (${kind})`, async () => {
      const { d, storage } = await started(makeStore, (batch) => batch.label !== undefined);
      storage.hold();
      await d.write((tx) => tx.features.update('f1', { properties: { n: 1 } }), { label: 'one' });
      await d.write((tx) => tx.features.update('f1', { properties: { n: 2 } }), { label: 'two' });
      storage.release();
      await settled(d);
      expect(d.features.get('f1')?.properties.n).toBe(0);
      expect(d.backend.refusals.value.map((one) => [one.label, one.reason])).toEqual([
        ['one', 'rules'],
        ['two', 'rules'],
      ]);
      expect(shownOf(storage.backend.document)).toEqual(writtenOf(d.document.toJSON()));
    });

    it(`delete what a refused commit created, and bring back what it deleted (${kind})`, async () => {
      const { d } = await started(makeStore, (batch) => batch.label === 'refused');
      const order = () => [...d.layers.listItems('a')];
      const before = order();
      await d.write(
        async (tx) => {
          await tx.features.create(point('g1', 'a'));
          await tx.features.delete(['f2']);
        },
        { label: 'refused' },
      );
      expect(d.features.get('g1')).toBeDefined();
      expect(d.features.get('f2')).toBeUndefined();
      await settled(d);
      expect(d.features.get('g1')).toBeUndefined();
      expect(d.features.get('f2')).toBeDefined();
      expect(order()).toEqual(before);
    });

    it(`refuse with it the later commits that name what it created (${kind})`, async () => {
      const { d, storage } = await started(makeStore, (batch) => batch.label === 'create');
      storage.hold();
      await d.write((tx) => tx.features.create(point('g1', 'a')), { label: 'create' });
      const dependent = d.write((tx) => tx.features.update('g1', { properties: { n: 5 } }));
      await dependent;
      const other = d.write((tx) => tx.features.update('f3', { properties: { n: 7 } }));
      await other;
      const saved = dependent.save().then(
        () => null,
        (error: unknown) => error,
      );
      storage.release();
      await settled(d);
      const error = (await saved) as DrawError;
      expect(error).toBeInstanceOf(DrawError);
      expect(error.code).toBe('refused');
      expect(error.refusal?.reason).toBe('dependsOnRefused');
      expect(error.refusal?.commit).toBe(dependent.id);
      await other.save();
      expect(d.features.get('g1')).toBeUndefined();
      expect(d.features.get('f3')?.properties.n).toBe(7);
      expect(d.backend.refusals.value.map((one) => one.reason)).toEqual([
        'rules',
        'dependsOnRefused',
      ]);
      expect(shownOf(storage.backend.document)).toEqual(writtenOf(d.document.toJSON()));
    });
  }

  for (const [kind, makeStore] of KINDS) {
    it(`keep what a refused commit brings back into a layer deleted after it, and show it with the layer (${kind})`, async () => {
      const { d, storage } = await started(makeStore, (batch) => batch.label === 'refused');
      storage.hold();
      await d.write((tx) => tx.features.delete(['f2']), { label: 'refused' });
      // The deletion of the layer names what it holds here (f2 is not there)
      await d.write((tx) => tx.layers.delete('a'));
      storage.release();
      await settled(d);
      // The storage still has f2, in no layer: kept, and shown by neither
      expect(storage.backend.document.features.has('f2')).toBe(true);
      expect(storage.backend.document.layers.has('a')).toBe(false);
      expect(d.features.get('f2')).toBeUndefined();
      expect(shownOf(storage.backend.document)).toEqual(writtenOf(d.document.toJSON()));
      // Made again, the layer comes back with what the storage kept in it
      await d.undo();
      await settled(d);
      expect([...d.layers.listItems('a')]).toEqual(['f1', 'f2', 'f3']);
      expect(shownOf(storage.backend.document)).toEqual(writtenOf(d.document.toJSON()));
    });

    it(`keep a member a refused commit brings back into a group moved after it, in the layer of the group (${kind})`, async () => {
      const { d, storage } = await started(makeStore, (batch) => batch.label === 'refused');
      await d.write((tx) => tx.groups.create({ id: 'g', name: 'G', members: ['f1', 'f2'] }));
      await settled(d);
      storage.hold();
      await d.write((tx) => tx.features.place(['f2'], { layerId: 'a' }), { label: 'refused' });
      // The move names the members here (f2 is not one)
      await d.write((tx) => tx.groups.place('g', { layerId: 'b' }));
      storage.release();
      await settled(d);
      const stored = storage.backend.document.features.get('f2')?.properties;
      expect(stored?.['maplibre-gl-draw:layerId']).toBe('a');
      expect(stored?.['maplibre-gl-draw:groupId']).toBe('g');
      // A member is in the layer of its group
      expect(d.features.get('f2')?.properties['maplibre-gl-draw:layerId']).toBe('b');
      expect(d.groups.get('g')?.layerId).toBe('b');
      expect(shownOf(storage.backend.document)).toEqual(writtenOf(d.document.toJSON()));
      // The group deleted alone, its member goes to the layer its keys say
      await d.write((tx) => tx.groups.delete('g', { members: 'keep' }));
      await settled(d);
      expect(shownOf(storage.backend.document)).toEqual(writtenOf(d.document.toJSON()));
    });
  }

  it('take a refused commit out while the document is read-only, out of the undo', async () => {
    const { d } = await started(
      () => createTableStore().store,
      (b) => b.label === 'refused',
    );
    await d.write((tx) => tx.features.update('f1', { properties: { n: 1 } }));
    await d.write((tx) => tx.features.update('f1', { properties: { n: 9 } }), {
      label: 'refused',
    });
    d.setReadOnly(true);
    let source: string | null = null;
    d.on('change', (change) => {
      source = change.source;
    });
    await settled(d);
    expect(source).toBe('refused');
    expect(d.features.get('f1')?.properties.n).toBe(1);
    d.setReadOnly(false);
    // The step of the refused commit is gone: an undo takes back the commit before it
    expect(d.status.value.history.undoLabel).toBeUndefined();
    await d.undo();
    expect(d.features.get('f1')?.properties.n).toBe(0);
  });

  it('give out the refused edits as GeoJSON that an import brings back', async () => {
    const { d } = await started(
      () => new MemoryStore(),
      (b) => b.label === 'refused',
    );
    await d.write(
      async (tx) => {
        await tx.features.update('f1', { properties: { n: 4 } });
        await tx.features.create(point('g1', 'a', { m: 'x' }));
        await tx.features.delete(['f3']);
      },
      { label: 'refused' },
    );
    await settled(d);
    expect(d.features.get('f1')?.properties.n).toBe(0);
    const [refusal] = d.backend.refusals.value;
    expect(refusal.ids).toEqual(['g1', 'f1', 'f3']);
    expect(refusal.count).toBe(3);
    const blob = await d.backend.refusals.export(refusal.id);
    const collection = JSON.parse(await blob.text());
    expect(collection['maplibre-gl-draw:deletedIds']).toEqual(['f3']);
    expect(
      collection.features.map((feature: { id: string; properties: Record<string, unknown> }) => [
        feature.id,
        feature.properties.n ?? feature.properties.m,
      ]),
    ).toEqual([
      ['g1', 'x'],
      ['f1', 4],
    ]);
    await d.write(async (tx) => {
      await tx.import(collection, { layer: 'b', duplicateIds: 'renew' });
    });
    const brought = d.features.list({ layerId: 'b' });
    expect(brought.map((feature) => feature.properties.n ?? feature.properties.m).sort()).toEqual(
      [4, 'x'].sort(),
    );
    await expect(d.backend.refusals.export('nothing')).rejects.toMatchObject({ code: 'notFound' });
  });

  it('make the refused edits again as one commit, and dismiss them', async () => {
    let refuseLabels = true;
    const { d, storage } = await started(
      () => createTableStore().store,
      (b) => refuseLabels && b.label !== undefined,
    );
    await d.write((tx) => tx.features.update('f1', { properties: { n: 3 } }), { label: 'x' });
    await d.write((tx) => tx.features.create(point('g1', 'a')), { label: 'y' });
    await d.write((tx) => tx.features.update('f2', { properties: { n: 8 } }), { label: 'z' });
    await settled(d);
    expect(d.backend.refusals.value).toHaveLength(3);
    expect(d.status.value.saving.refused).toBe(3);
    await expect(d.backend.save()).rejects.toMatchObject({ code: 'refused' });
    const [, , last] = d.backend.refusals.value;
    await d.backend.refusals.dismiss(last.id);
    expect(d.backend.refusals.value).toHaveLength(2);
    refuseLabels = false;
    const sentBefore = storage.sent.length;
    const retried = d.backend.refusals.retry({ all: true });
    await retried;
    expect(d.backend.refusals.value).toHaveLength(0);
    await retried.save();
    await d.backend.save();
    const commits = new Set(storage.sent.slice(sentBefore).map((batch) => batch.commit));
    expect([...commits]).toEqual([retried.id]);
    expect(d.features.get('f1')?.properties.n).toBe(3);
    expect(d.features.get('g1')).toBeDefined();
    expect(d.features.get('f2')?.properties.n).toBeUndefined();
    expect(shownOf(storage.backend.document)).toEqual(writtenOf(d.document.toJSON()));
  });

  it('save every commit, and connect again after the storage closed', async () => {
    let closed = true;
    const reference = createReferenceBackend();
    const backend: Backend = {
      load: (task) => reference.load(task),
      async send(batch, task) {
        if (closed) return { status: 'closed', reason: 'credential' };
        return reference.send(batch, task);
      },
    };
    draw = drawWith(new MemoryStore(), backend);
    const d = draw;
    const write = d.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
    await write;
    const saving = d.backend.save();
    await expect(saving).rejects.toMatchObject({ code: 'credential' });
    expect(d.status.value.connection.state).toBe('closed');
    closed = false;
    await d.backend.reconnect();
    await d.backend.save();
    expect(d.status.value.connection.state).toBe('online');
    expect(reference.document.layers.has('a')).toBe(true);
    const none = drawWith(new MemoryStore(), backend);
    await expect(none.backend.save({ until: 'stored' })).rejects.toMatchObject({
      code: 'invalidState',
    });
    none.destroy();
  });
});

/**
 * The reference storage giving the features it is sent to create IDs of its own (`n…` becomes
 * `s…`), as a storage that decides the IDs does
 */
function renaming(gate: { wait: Promise<void> | null } = { wait: null }) {
  const reference = createReferenceBackend();
  const backend: Backend & { readonly document: StoredDocument } = {
    document: reference.document,
    load: (task) => reference.load(task),
    async send(batch, task): Promise<Answer> {
      if (gate.wait) await gate.wait;
      const reassigned: Record<string, string> = {};
      const operations = batch.operations.map((operation) => {
        if (operation.type !== 'create' || operation.kind !== 'feature') return operation;
        if (!operation.id.startsWith('n')) return operation;
        const id = `s${operation.id.slice(1)}`;
        reassigned[operation.id] = id;
        return { ...operation, id };
      });
      const answer = await reference.send({ ...batch, operations }, task);
      if (answer.status !== 'accepted') return answer;
      return { ...answer, reassigned };
    },
  };
  return backend;
}

describe('the IDs a storage gives', () => {
  for (const [kind, makeStore] of KINDS) {
    it(`go on with a feature deleted here before the answer came (${kind})`, async () => {
      const gate = { wait: null as Promise<void> | null };
      let open = (): void => {};
      const backend = renaming(gate);
      draw = drawWith(makeStore(), backend);
      const d = draw;
      await d.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
      await d.backend.save();
      gate.wait = new Promise((resolve) => {
        open = resolve;
      });
      await d.write((tx) => tx.features.create([point('n1', 'a')]));
      await d.write((tx) => tx.features.delete(['n1']));
      gate.wait = null;
      open();
      await settled(d);
      // The deletion not sent names the ID the storage gave
      expect([...backend.document.features.keys()]).toEqual([]);
      expect(d.features.list({}, { limit: 10 })).toEqual([]);
      // The undo makes it again under its new ID
      await d.undo();
      await settled(d);
      expect([...backend.document.features.keys()]).toEqual(['s1']);
      expect(d.features.list({}, { limit: 10 }).map((feature) => feature.id)).toEqual(['s1']);
    });

    it(`go on with the sketches of the features (${kind})`, async () => {
      const gate = { wait: null as Promise<void> | null };
      let open = (): void => {};
      const backend = renaming(gate);
      draw = drawWith(makeStore(), backend);
      const d = draw;
      await d.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
      await d.backend.save();
      gate.wait = new Promise((resolve) => {
        open = resolve;
      });
      const created = d.write((tx) => tx.features.create([point('n1', 'a'), point('n2', 'a')]));
      await created;
      const sketch = d.sketches.add({
        edits: [
          { kind: 'translate', target: { featureIds: ['n1', 'n2'] }, from: [0, 0], to: [1, 1] },
        ],
      });
      gate.wait = null;
      open();
      await created.save();
      const now = d.sketches.get(sketch?.id as string);
      expect(now?.edits).toEqual([
        { kind: 'translate', target: { featureIds: ['s1', 's2'] }, from: [0, 0], to: [1, 1] },
      ]);
      // Committed, it moves the features under their new IDs
      d.sketches.commit(sketch?.id as string);
      await d.backend.save();
      const moved = d.features.get('s1');
      if (moved?.geometry.type !== 'Point') throw new Error('s1 is no point');
      const [x, y] = moved.geometry.coordinates;
      expect(x).toBeCloseTo(2, 2);
      expect(y).toBeCloseTo(3, 2);
      expect(shownOf(backend.document)).toEqual(writtenOf(d.document.toJSON()));
    });

    it(`go on with the selection, what is hidden, the undo and the commits after (${kind})`, async () => {
      const backend = renaming();
      draw = drawWith(makeStore(), backend);
      const d = draw;
      await d.write(async (tx) => {
        await tx.layers.create({ id: 'a', name: 'A' });
      });
      const changes: Array<{ source: string; reassigned: Readonly<Record<string, string>> }> = [];
      d.on('change', (change) => {
        if (Object.keys(change.reassigned).length > 0) {
          changes.push({ source: change.source, reassigned: change.reassigned });
        }
      });
      const created = d.write((tx) => tx.features.create([point('n1', 'a'), point('n2', 'a')]));
      await created;
      d.selection.set('feature', ['n1']);
      d.hidden.add('n2');
      const updated = d.write((tx) => tx.features.update('n1', { properties: { n: 3 } }));
      await updated;
      await updated.save();
      expect(changes).toEqual([{ source: 'remote', reassigned: { n1: 's1', n2: 's2' } }]);
      expect(d.features.get('n1')).toBeUndefined();
      expect(d.features.get('s1')?.properties.n).toBe(3);
      expect(d.selection.value.ids).toEqual(['s1']);
      expect(d.hidden.has('s2')).toBe(true);
      expect([...d.layers.listItems('a')]).toEqual(['s1', 's2']);
      expect(backend.document.features.get('s1')?.properties.n).toBe(3);
      expect(shownOf(backend.document)).toEqual(writtenOf(d.document.toJSON()));
      // The steps of undo name the features by their new IDs
      await d.undo();
      expect(d.features.get('s1')?.properties.n).toBeUndefined();
      await d.undo();
      expect(d.features.get('s1')).toBeUndefined();
      await d.backend.save();
      expect(shownOf(backend.document)).toEqual(writtenOf(d.document.toJSON()));
    });
  }
});
