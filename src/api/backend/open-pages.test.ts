// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A document opened bit by bit (design 6): `draw.open(pages)` and a storage whose `load` gives
 * pages of rows
 *
 * - The features and the groups are replaced, the layers stay, the rows go into the current layer
 * - While it opens, `status.document` is `opening` (`viewReady` at the end), the reads give the
 *   pages that arrived, `draw.write` waits, and `change` is told once, at the end
 * - Rows put first at their places, then the pages that hold them: every row once, in the order of
 *   its key
 * - A source read at once is opened the same way; a commit sent to a storage is one commit
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Page } from '../../table/index.js';
import { createPageBuilder } from '../../table/index.js';
import { drawWith } from '../../test-support/refusing-storage.js';
import { createMapStub } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import type { DrawError } from '../errors.js';
import type { Change } from '../events.js';
import type { ImportSource } from '../write.js';
import type { Answer, Backend } from './backend.js';
import type { ValueBatch } from './values.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const d of draws.splice(0)) d.destroy();
});

/** An instance on a Store of rows, with its default layer (the current one) */
function make(): Draw {
  const { store } = createTableStore();
  const d = createDraw(createMapStub().map, { store });
  draws.push(d);
  return d;
}

/** An instance on a Store of rows and a storage, with a layer made here (the current one) */
async function withStorage(backend: Backend): Promise<Draw> {
  const d = drawWith(createTableStore().store, backend);
  draws.push(d);
  await d.write((tx) => tx.layers.create({ id: 'L', name: 'L' }));
  d.layers.setActive('L');
  return d;
}

const key = (i: number): string => `V${String(i).padStart(4, '0')}`;

/** A page of the rows given, each a point with its value `n` */
function pageOf(rows: readonly { readonly i: number; readonly n: number }[]): Page {
  const builder = createPageBuilder();
  for (const { i, n } of rows) {
    builder.addRow({
      id: `r${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [139 + i * 0.001, 35] },
      key: key(i),
      properties: { n },
    });
  }
  const [page, ...more] = builder.finish();
  expect(more).toEqual([]);
  return page;
}

/** The pages of the rows from..to, `size` rows each */
function pagesOf(from: number, to: number, size: number): Page[] {
  const out: Page[] = [];
  for (let at = from; at < to; at += size) {
    out.push(
      pageOf(Array.from({ length: Math.min(size, to - at) }, (_, k) => ({ i: at + k, n: at + k }))),
    );
  }
  return out;
}

/** The items of the current layer, in their order */
function itemsOf(d: Draw): readonly string[] {
  return d.layers.listItems(d.layers.getActive()?.id as string);
}

/** A source of pages given one at a time, each once the test lets it go */
function gated(pages: readonly Page[]) {
  const gates: (() => void)[] = [];
  const waits = pages.map(() => new Promise<void>((resolve) => gates.push(resolve)));
  async function* source(): AsyncGenerator<Page> {
    for (const [i, page] of pages.entries()) {
      await waits[i];
      yield page;
    }
  }
  return { source: source(), next: (i: number) => gates[i]() };
}

/** Waits a few tasks */
async function tasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as DrawError).code;
  }
}

describe('draw.open with pages of rows', () => {
  it('replaces the features and the groups, keeps the layers, and puts the rows in the current layer', async () => {
    const d = make();
    const current = d.layers.getActive()?.id;
    await d.write(async (tx) => {
      await tx.layers.create({ id: 'other', name: 'other' });
      await tx.features.create({
        type: 'Feature',
        id: 'old',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { 'maplibre-gl-draw:layerId': 'other' },
      });
    });
    const changes: Change[] = [];
    d.on('change', (change) => changes.push(change));
    const states: string[] = [];
    d.status.subscribe(({ document }) =>
      states.push(document.state === 'opening' ? `opening ${document.viewReady}` : document.state),
    );
    const result = await d.open(pagesOf(0, 30, 10));
    expect(result).toEqual({ features: 30, skipped: [] });
    expect(d.features.count()).toBe(30);
    expect(d.features.get('old')).toBeUndefined();
    expect(d.layers.list().map((layer) => layer.id)).toContain('other');
    expect(itemsOf(d)).toEqual(Array.from({ length: 30 }, (_, i) => `r${i}`));
    expect(d.layers.getActive()?.id).toBe(current);
    // One change, the document replaced
    expect(changes).toHaveLength(1);
    expect(changes[0].source).toBe('open');
    expect(changes[0].features.deleted).toEqual(['old']);
    expect([...changes[0].features.created].sort()).toEqual(
      Array.from({ length: 30 }, (_, i) => `r${i}`).sort(),
    );
    expect(states).toContain('opening false');
    expect(states.indexOf('opening true')).toBeLessThan(states.lastIndexOf('open'));
    expect(d.status.value.document).toEqual({ state: 'open' });
    expect(await codeOf(d.undo())).toBe('invalidState');
  });

  it('gives the pages that arrived while it opens, holds the writes and tells one change', async () => {
    const d = make();
    const changes: Change[] = [];
    d.on('change', (change) => changes.push(change));
    const progress: number[] = [];
    const { source, next } = gated(pagesOf(0, 30, 10));
    const opened = d.open(source, { onProgress: ({ done }) => progress.push(done) });
    expect(d.status.value.document).toEqual({ state: 'opening', progress: null, viewReady: false });
    expect(d.status.value.editable).toBe(false);
    expect(d.isReadOnly()).toBe(true);
    let wrote = false;
    const write = d.write((tx) => tx.features.update('r0', { properties: { n: 99 } }));
    write.result.then(() => {
      wrote = true;
    });
    next(0);
    await tasks();
    expect(d.features.count()).toBe(10);
    expect(d.status.value.document).toMatchObject({
      state: 'opening',
      progress: { done: 10, total: null },
      viewReady: false,
    });
    next(1);
    await tasks();
    expect(d.features.count()).toBe(20);
    expect(changes).toHaveLength(0);
    expect(wrote).toBe(false);
    next(2);
    await opened;
    expect(progress).toEqual([10, 20, 30]);
    await write;
    expect(d.features.get('r0')?.properties.n).toBe(99);
    expect(changes.map((change) => change.source)).toEqual(['open', 'local']);
    expect(d.isReadOnly()).toBe(false);
  });

  it('replaces the rows put first at their places with the pages that hold them', async () => {
    const d = make();
    const ahead = [3, 40, 77];
    const { source, next } = gated([
      pageOf(ahead.map((i) => ({ i, n: -i }))),
      ...pagesOf(0, 100, 25),
    ]);
    const opened = d.open(source);
    next(0);
    await tasks();
    expect(itemsOf(d)).toEqual(['r3', 'r40', 'r77']);
    expect(d.features.get('r40')?.properties.n).toBe(-40);
    for (let p = 1; p <= 4; p++) {
      next(p);
      await tasks();
      const items = itemsOf(d);
      // No row twice, every row in the order of its key
      expect(new Set(items).size).toBe(items.length);
      expect([...items].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(items);
    }
    const result = await opened;
    expect(result.features).toBe(100);
    expect(itemsOf(d)).toEqual(Array.from({ length: 100 }, (_, i) => `r${i}`));
    expect(ahead.map((i) => d.features.get(`r${i}`)?.properties.n)).toEqual(ahead);
    expect(d.features.count()).toBe(100);
  });

  it('is refused without a Store of rows, without a current layer, and while read-only', async () => {
    const objects = createDraw(createMapStub().map, { store: new MemoryStore() });
    draws.push(objects);
    expect(await codeOf(objects.open(pagesOf(0, 2, 2)))).toBe('invalidInput');
    expect(objects.status.value.document).toEqual({ state: 'open' });
    const none = createDraw(createMapStub().map, {
      store: createTableStore().store,
      initDefaultLayer: false,
    });
    draws.push(none);
    expect(await codeOf(none.open(pagesOf(0, 2, 2)))).toBe('notFound');
    const d = make();
    await d.open(pagesOf(0, 2, 2));
    d.setReadOnly(true);
    expect(await codeOf(d.open(pagesOf(5, 7, 2)))).toBe('notEditable');
    expect(d.features.count()).toBe(2);
    expect(await codeOf(d.open([{ length: 1 } as unknown as Page]))).toBe('notEditable');
    d.setReadOnly(false);
    expect(await codeOf(d.open([{ length: 1 } as unknown as Page]))).toBe('invalidInput');
  });
});

describe('a source read at once', () => {
  it('opens the same way: opening, the writes held, one change', async () => {
    const d = make();
    const changes: Change[] = [];
    d.on('change', (change) => changes.push(change));
    const opened = d.open({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'a',
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: {},
        },
      ],
    });
    expect(d.status.value.document.state).toBe('opening');
    const write = d.write((tx) => tx.features.update('a', { properties: { n: 1 } }));
    await opened;
    expect(d.status.value.document).toEqual({ state: 'open' });
    await write;
    expect(d.features.get('a')?.properties.n).toBe(1);
    expect(changes.map((change) => change.source)).toEqual(['open', 'local']);
  });

  it('leaves the document as it was when it cannot be read', async () => {
    const d = make();
    await d.open(pagesOf(0, 3, 3));
    expect(await codeOf(d.open('not json'))).toBeDefined();
    expect(d.status.value.document).toEqual({ state: 'open' });
    expect(d.features.count()).toBe(3);
    expect(d.isReadOnly()).toBe(false);
  });
});

/** A storage that answers every batch, and loads what the test gives */
function storage(load: () => Promise<ImportSource>) {
  const sent: ValueBatch[] = [];
  const backend: Backend = {
    load,
    async send(batch): Promise<Answer> {
      sent.push(batch);
      return { status: 'accepted' };
    },
  };
  return { backend, sent };
}

/** Waits until nothing is left to send */
async function saved(d: Draw): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (d.status.value.saving.unsaved === 0) return;
  }
  throw new Error('not saved');
}

describe('a storage whose load gives pages', () => {
  it('opens bit by bit and sends none of it', async () => {
    const { source, next } = gated(pagesOf(0, 20, 10));
    const s = storage(async () => source);
    const d = await withStorage(s.backend);
    await saved(d);
    const before = s.sent.length;
    const changes: Change[] = [];
    d.on('change', (change) => changes.push(change));
    const opened = d.open();
    next(0);
    await tasks();
    expect(d.features.count()).toBe(10);
    expect(d.status.value.document).toMatchObject({ state: 'opening', viewReady: false });
    expect(changes).toHaveLength(0);
    next(1);
    expect(await opened).toEqual({ features: 20, skipped: [] });
    expect(d.status.value.document).toEqual({ state: 'open' });
    expect(changes.map((change) => change.source)).toEqual(['open']);
    const write = d.write((tx) => tx.features.update('r1', { properties: { n: 5 } }));
    await write;
    await saved(d);
    expect([...new Set(s.sent.slice(before).map((batch) => batch.commit))]).toEqual([write.id]);
  });

  it('sends pages opened as a source as one commit', async () => {
    const s = storage(async () => pagesOf(0, 2, 2));
    const d = await withStorage(s.backend);
    await d.open();
    await saved(d);
    const before = s.sent.length;
    const result = await d.open(pagesOf(10, 40, 10));
    expect(result.features).toBe(30);
    await saved(d);
    const sent = s.sent.slice(before);
    const commits = [...new Set(sent.map((batch) => batch.commit))];
    expect(commits).toHaveLength(1);
    const created = new Set(
      sent.flatMap((batch) =>
        batch.operations.flatMap((operation) =>
          operation.type === 'create' && operation.kind === 'feature' ? [operation.id] : [],
        ),
      ),
    );
    expect(created.size).toBe(30);
    expect(d.features.count()).toBe(30);
  });
});
