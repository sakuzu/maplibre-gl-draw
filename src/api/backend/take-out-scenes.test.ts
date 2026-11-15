// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The take-out of a refused commit, scene by scene: what this client holds of the features it
 * takes back and writes again (the selection, those hidden here), a large move behind a small
 * refused commit written in one write, the steps of undo after it (a refused commit as never
 * made), and a row deleted, not read yet, whose ID the storage changes
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { createTableStore } from '../../store/table-memory.js';
import { writtenOf } from '../../test-support/random-commits.js';
import {
  drawWith,
  point,
  refusing,
  STORE_KINDS,
  settled,
  shownOf,
} from '../../test-support/refusing-storage.js';
import type { Draw } from '../draw.js';
import type { Answer } from './backend.js';
import type { StoredDocument, ValueBatch } from './values.js';

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

/** A storage that refuses the commits labelled `refused`, and an instance on it */
function started(makeStore: Parameters<typeof drawWith>[0], maxBatchBytes?: number) {
  const storage = refusing((batch) => batch.label === 'refused', { maxBatchBytes });
  draw = drawWith(makeStore, storage.backend);
  return { d: draw, storage };
}

/** Whether this client shows what the storage has */
function same(d: Draw, document: StoredDocument): boolean {
  return JSON.stringify(shownOf(document)) === JSON.stringify(writtenOf(d.document.toJSON()));
}

/** The values a property takes in the batches sent */
function sentValues(sent: readonly ValueBatch[], id: string, name: string): unknown[] {
  const out: unknown[] = [];
  for (const batch of sent) {
    for (const operation of batch.operations) {
      if (operation.kind !== 'feature') continue;
      if (operation.type === 'set' && operation.ids.includes(id)) {
        const value = operation.set.properties?.[name];
        if (value !== undefined) out.push(value);
      } else if (operation.type === 'create' && operation.id === id) {
        const value = operation.record.properties[name];
        if (value !== undefined) out.push(value);
      }
    }
  }
  return out;
}

describe('the take-out of a refused commit', () => {
  for (const [kind, makeStore] of STORE_KINDS) {
    describe(kind, () => {
      it('keeps the selection and what is hidden here of the features it takes back and writes again', async () => {
        const { d, storage } = started(makeStore());
        await d.write(async (tx) => {
          await tx.layers.create({ id: 'a', name: 'A' });
          await tx.features.create([point('f1', 'a', { n: 0 })]);
        });
        await settled(d);
        const told: string[] = [];
        d.on('change', (change) => {
          if (change.source !== 'refused') return;
          told.push(...change.features.created, ...change.features.deleted);
        });
        storage.hold();
        await d.write((tx) => tx.features.update('f1', { properties: { n: 1 } }), {
          label: 'refused',
        });
        // A later commit that touches what the refused one touched, and makes features
        await d.write(async (tx) => {
          await tx.features.create([point('f9', 'a'), point('f8', 'a')]);
          await tx.features.update('f1', { properties: { n: 2 } });
        });
        d.selection.set('feature', ['f9', 'f1']);
        d.hidden.add('f8');
        storage.release();
        await settled(d);
        expect(d.selection.value.ids).toEqual(['f9', 'f1']);
        expect(d.hidden.has('f8')).toBe(true);
        expect(told).toEqual([]);
        expect(same(d, storage.backend.document)).toBe(true);
      });

      it('keeps the selection of a feature drawn in the layer of a refused one', async () => {
        const { d, storage } = started(makeStore());
        await d.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
        await settled(d);
        storage.hold();
        await d.write((tx) => tx.features.create([point('f8', 'a')]), { label: 'refused' });
        await d.write((tx) => tx.features.create([point('f9', 'a')]));
        d.selection.set('feature', ['f9']);
        storage.release();
        await settled(d);
        expect(d.selection.value.ids).toEqual(['f9']);
        expect(d.features.get('f8')).toBeUndefined();
      });

      it('takes a feature a refused commit deleted out of the selection only once it is gone', async () => {
        const { d, storage } = started(makeStore());
        await d.write(async (tx) => {
          await tx.layers.create({ id: 'a', name: 'A' });
          await tx.features.create([point('f1', 'a'), point('f2', 'a')]);
        });
        await settled(d);
        storage.hold();
        // A feature made by the refused commit, selected: it goes, and leaves the selection
        await d.write((tx) => tx.features.create([point('f3', 'a')]), { label: 'refused' });
        d.selection.set('feature', ['f3', 'f2']);
        storage.release();
        await settled(d);
        expect(d.selection.value.ids).toEqual(['f2']);
        expect(same(d, storage.backend.document)).toBe(true);
      });

      it('writes a large move behind a small refused commit in one write of the places', async () => {
        const count = 1500;
        const rows = kind === 'rows' ? createTableStore() : null;
        const objects = new MemoryStore();
        const { d, storage } = started(rows ? rows.store : objects, 1 << 20);
        const ids = Array.from({ length: count }, (_, i) => `p${i}`);
        await d.write(async (tx) => {
          await tx.layers.create({ id: 'a', name: 'A' });
          await tx.layers.create({ id: 'b', name: 'B' });
          await tx.features.create(ids.map((id) => point(id, 'a')));
        });
        await settled(d);
        storage.hold();
        await d.write((tx) => tx.features.create([point('x1', 'a')]), { label: 'refused' });
        await d.write((tx) => tx.features.place(ids, { layerId: 'b' }));
        const writes = rows ? vi.spyOn(rows.writer, 'writeRows') : vi.spyOn(objects, 'moveItems');
        storage.release();
        await settled(d);
        // Taken back to `a`, then written again in `b`: one write each (and the deletion of the
        // refused feature, a write of the rows)
        expect(writes.mock.calls.length).toBe(rows ? 3 : 2);
        expect(d.layers.countItems('b')).toBe(count);
        expect(
          storage.backend.document.features.get('p0')?.properties['maplibre-gl-draw:layerId'],
        ).toBe('b');
        expect(same(d, storage.backend.document)).toBe(true);
      });
    });
  }
});

describe('the steps of undo after a take-out', () => {
  for (const [kind, makeStore] of STORE_KINDS) {
    describe(kind, () => {
      it('take a later commit back to what it was before it, the refused commit as never made', async () => {
        const { d, storage } = started(makeStore());
        await d.write(async (tx) => {
          await tx.layers.create({ id: 'a', name: 'A' });
          await tx.features.create([point('f1', 'a', { n: 0 })]);
        });
        await settled(d);
        storage.hold();
        await d.write((tx) => tx.features.update('f1', { properties: { n: 1 } }), {
          label: 'refused',
        });
        await d.write((tx) => tx.features.update('f1', { properties: { n: 2 } }));
        storage.release();
        await settled(d);
        expect(d.features.get('f1')?.properties.n).toBe(2);
        const before = storage.sent.length;
        await d.undo();
        await settled(d);
        expect(d.features.get('f1')?.properties.n).toBe(0);
        expect(storage.backend.document.features.get('f1')?.properties.n).toBe(0);
        // The refused value is not sent again
        expect(sentValues(storage.sent.slice(before), 'f1', 'n')).toEqual([0]);
        await d.redo();
        await settled(d);
        expect(d.features.get('f1')?.properties.n).toBe(2);
        expect(same(d, storage.backend.document)).toBe(true);
        await d.undo();
        await settled(d);
        expect(storage.backend.document.features.get('f1')?.properties.n).toBe(0);
        expect(d.status.value.history.canUndo).toBe(true);
      });

      it('take the name of a layer back to the one before the refused commit', async () => {
        const { d, storage } = started(makeStore());
        await d.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
        await settled(d);
        storage.hold();
        await d.write((tx) => tx.layers.update('a', { name: 'X' }), { label: 'refused' });
        await d.write((tx) => tx.layers.update('a', { name: 'Y' }));
        storage.release();
        await settled(d);
        await d.undo();
        await settled(d);
        expect(d.layers.get('a')?.name).toBe('A');
        expect(storage.backend.document.layers.get('a')?.name).toBe('A');
      });

      it('put a feature back where it was, out of a group a refused commit made', async () => {
        const { d, storage } = started(makeStore());
        await d.write(async (tx) => {
          await tx.layers.create({ id: 'a', name: 'A' });
          await tx.layers.create({ id: 'b', name: 'B' });
          await tx.features.create([point('f1', 'a'), point('f2', 'a'), point('f3', 'a')]);
        });
        await settled(d);
        storage.hold();
        await d.write((tx) => tx.groups.create({ id: 'g', name: 'G', members: ['f1', 'f2'] }), {
          label: 'refused',
        });
        await d.write((tx) => tx.features.place(['f1'], { layerId: 'b' }));
        storage.release();
        await settled(d);
        await d.undo();
        await settled(d);
        expect(d.features.get('f1')?.properties['maplibre-gl-draw:layerId']).toBe('a');
        expect(d.groups.list()).toEqual([]);
        expect(
          storage.backend.document.features.get('f1')?.properties['maplibre-gl-draw:layerId'],
        ).toBe('a');
        expect(same(d, storage.backend.document)).toBe(true);
      });

      it('put a feature back in the group a refused deletion left', async () => {
        const { d, storage } = started(makeStore());
        await d.write(async (tx) => {
          await tx.layers.create({ id: 'a', name: 'A' });
          await tx.layers.create({ id: 'b', name: 'B' });
          await tx.features.create([point('f1', 'a'), point('f2', 'a'), point('f3', 'a')]);
        });
        await d.write((tx) => tx.groups.create({ id: 'g', name: 'G', members: ['f1', 'f2'] }));
        await settled(d);
        storage.hold();
        await d.write((tx) => tx.groups.delete('g', { members: 'keep' }), { label: 'refused' });
        await d.write((tx) => tx.features.place(['f1'], { layerId: 'b' }));
        storage.release();
        await settled(d);
        await d.undo();
        await settled(d);
        expect(d.features.get('f1')?.properties['maplibre-gl-draw:groupId']).toBe('g');
        expect(same(d, storage.backend.document)).toBe(true);
      });

      it('take back the commit an undo not sent yet takes back, as it is written again', async () => {
        const { d, storage } = started(makeStore());
        await d.write(async (tx) => {
          await tx.layers.create({ id: 'a', name: 'A' });
          await tx.features.create([point('f1', 'a', { n: 0 })]);
        });
        await settled(d);
        storage.hold();
        await d.write((tx) => tx.features.update('f1', { properties: { n: 1 } }), {
          label: 'refused',
        });
        await d.write((tx) => tx.features.update('f1', { properties: { n: 2 } }));
        // Taken back before the storage answers: it wrote the refused value back here
        await d.undo();
        expect(d.features.get('f1')?.properties.n).toBe(1);
        storage.release();
        await settled(d);
        expect(d.features.get('f1')?.properties.n).toBe(0);
        expect(storage.backend.document.features.get('f1')?.properties.n).toBe(0);
        expect(sentValues(storage.sent, 'f1', 'n').filter((n) => n === 1)).toHaveLength(1);
        await d.redo();
        await settled(d);
        expect(storage.backend.document.features.get('f1')?.properties.n).toBe(2);
        expect(same(d, storage.backend.document)).toBe(true);
      });

      it('leave nothing to redo of an undo of the refused commit itself', async () => {
        const { d, storage } = started(makeStore());
        await d.write(async (tx) => {
          await tx.layers.create({ id: 'a', name: 'A' });
          await tx.features.create([point('f1', 'a', { n: 0 })]);
        });
        await settled(d);
        storage.hold();
        await d.write((tx) => tx.features.update('f1', { properties: { n: 1 } }), {
          label: 'refused',
        });
        await d.undo();
        expect(d.status.value.history.canRedo).toBe(true);
        storage.release();
        await settled(d);
        expect(d.features.get('f1')?.properties.n).toBe(0);
        expect(d.status.value.history.canRedo).toBe(false);
        expect(sentValues(storage.sent, 'f1', 'n').filter((n) => n === 1)).toHaveLength(1);
        expect(same(d, storage.backend.document)).toBe(true);
      });

      it('leave the steps as they are when nothing is refused', async () => {
        const storage = refusing(() => false);
        draw = drawWith(makeStore(), storage.backend);
        const d = draw;
        await d.write(async (tx) => {
          await tx.layers.create({ id: 'a', name: 'A' });
          await tx.features.create([point('f1', 'a', { n: 0 })]);
        });
        storage.hold();
        await d.write((tx) => tx.features.update('f1', { properties: { n: 1 } }));
        await d.write((tx) => tx.features.update('f1', { properties: { n: 2 } }));
        storage.release();
        await settled(d);
        await d.undo();
        expect(d.features.get('f1')?.properties.n).toBe(1);
        await d.undo();
        expect(d.features.get('f1')?.properties.n).toBe(0);
        await d.undo();
        expect(d.features.get('f1')).toBeUndefined();
        await settled(d);
        expect(same(d, storage.backend.document)).toBe(true);
      });
    });
  }
});

describe('a row deleted and not read yet whose ID the storage changes', () => {
  it('is read as it was once an undo makes it again', async () => {
    // The commit that makes `n1` is answered with its ID `s1`, after the commit that deletes it
    // is made: the storage holds it under `s1`
    const storage = refusing(() => false, {
      answer(batch: ValueBatch, answer: Answer): Answer {
        if (answer.status !== 'accepted' || batch.label !== 'make') return answer;
        const record = reference.features.get('n1');
        if (record) {
          reference.features.delete('n1');
          reference.features.set('s1', record);
        }
        return { ...answer, reassigned: { n1: 's1' } };
      },
    });
    const reference = storage.backend.document;
    draw = drawWith(createTableStore().store, storage.backend, 0);
    const d = draw;
    await d.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
    await settled(d);
    storage.hold();
    await d.write((tx) => tx.features.create([point('n1', 'a', { n: 1 })]), { label: 'make' });
    await d.write((tx) => tx.features.delete(['n1']));
    storage.release();
    await settled(d);
    expect(reference.features.size).toBe(0);
    await d.undo();
    await d.write((tx) =>
      tx.features.update(d.features.list({}, { limit: 10 })[0].id, { properties: { n: 2 } }),
    );
    await settled(d);
    expect(same(d, reference)).toBe(true);
    expect(d.features.list({}, { limit: 10 }).map((feature) => feature.properties.n)).toEqual([2]);
  });
});
