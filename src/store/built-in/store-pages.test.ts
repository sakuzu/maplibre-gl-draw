// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pages of rows built in a Worker, and the Worker of the built-in Store
 *
 * - A page built in a Worker is posted without a copy and taken in as it is: the Store holds its
 *   arrays, gives its rows references and tells them as created
 * - The list of the buffers to transfer holds every buffer of the pages, each once
 * - The builder refuses an id added twice, a geometry outside the six types, and values that
 *   cannot be held; it names a group the options do not give when it finishes
 * - The Store takes the pages all or none: a layer or a group that is not there, an id in use or
 *   given twice, other dimensions, or a value that is not a page add nothing
 * - The large merges and builds of rows go to the Worker of the application when the Store is
 *   given one, and run on the main thread, in the frames, when it is not
 * - The objects the Store makes to take pages in do not grow with their rows
 *
 * A Worker is stood in for by posting what it is given and what it gives back through
 * `structuredClone`, with the transfer it would post with: what crosses is what a Worker gets.
 */

import { listPages, type TableWorkBudget } from '@sakuzu/kasane/render';
import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { Layer } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { countsOf, expectNotProportional, workDuring } from '../../test-utils.js';
import { storeOf } from './create-store.js';
import { openDocument } from './document.js';
import { createRowPageBuilder, getRowPageTransferList, mergeRowPages } from './pages.js';
import type {
  FeatureRowField,
  NewRows,
  RowInput,
  RowPage,
  RowPageBuilderOptions,
  RowPageWorker,
  Store,
  StoreChange,
  StoreGroup,
} from './types.js';

// ---------------------------------------------------------------------------------------------
// What the tests write

function layer(id: string): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  };
}

function group(id: string, layerId: string, orderKey: string): StoreGroup {
  return { id, layerId, orderKey, name: id, featureIds: [], visible: true, locked: false };
}

/** The key of the order of the `i`-th row */
function keyOf(i: number): string {
  return `k${String(i).padStart(7, '0')}`;
}

/** The `i`-th point of a grid */
function pointRow(i: number, more: Partial<RowInput> = {}): RowInput {
  return {
    id: `p${String(i).padStart(7, '0')}`,
    type: 'Point',
    geometry: {
      type: 'Point',
      coordinates: [139 + (i % 1000) * 1e-4, 35 + Math.floor(i / 1000) * 1e-4],
    },
    orderKey: keyOf(i),
    ...more,
  };
}

/** Builds rows into pages, as a Worker does */
function build(rows: readonly RowInput[], options?: RowPageBuilderOptions): RowPage[] {
  const builder = createRowPageBuilder(options);
  for (const row of rows) builder.addRow(row);
  return builder.finish();
}

/** Posts pages from a Worker: what the main thread receives, the arrays of the sender emptied */
function post(pages: RowPage[]): RowPage[] {
  return structuredClone(pages, { transfer: getRowPageTransferList(pages) });
}

/** `count` points from the `from`-th, built in a Worker and posted */
function pointPages(count: number, from = 0): RowPage[] {
  return post(build(Array.from({ length: count }, (_, i) => pointRow(from + i))));
}

/** A Store with the layer `a` and the changes it tells, over a document of its own */
function newStore(worker?: RowPageWorker) {
  const document = openDocument(undefined, worker);
  const store = storeOf(document);
  store.createLayer(layer('a'));
  const changes: StoreChange[] = [];
  store.subscribe((change) => changes.push(change));
  return { document, store, changes, counts: countsOf(store) };
}

/** What a Store holds, to tell that a write changed nothing */
function contentOf(store: Store) {
  const view = store.tables.get('a');
  const rows = view ? view.listRowRefs(0, view.rowCount) : new Int32Array(0);
  return {
    rows: [...rows].map((row) => store.tables.getRowId(row)),
    groups: store.listGroups().map((g) => g.id),
  };
}

/** The number of rows of a group of a layer */
function membersOf(store: Store, layerId: string, groupId: string): number {
  return store.tables.get(layerId)?.countGroupMembers(store.tables.findGroup(groupId) ?? -1) ?? 0;
}

/** Every `ArrayBuffer` a value holds, each once */
function buffersIn(value: unknown, out = new Set<ArrayBuffer>(), seen = new Set<object>()) {
  if (typeof value !== 'object' || value === null || seen.has(value)) return out;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) out.add(value.buffer);
    return out;
  }
  for (const item of Object.values(value)) buffersIn(item, out, seen);
  return out;
}

/** A budget of the work of a frame that takes `steps` steps */
function frameBudget(steps: number): TableWorkBudget & { readonly taken: number } {
  let taken = 0;
  return {
    get taken() {
      return taken;
    },
    canStep: () => taken < steps,
    step: (work) => {
      taken++;
      return work(performance.now() + 1_000);
    },
  };
}

/** A Worker of the application: what it is given and what it gives back are posted */
function postingWorker() {
  const calls: Array<{ kind: 'merge' | 'build'; rows: number }> = [];
  const worker: RowPageWorker = {
    merge: async (task) => {
      const merged = mergeRowPages(structuredClone(task));
      calls.push({ kind: 'merge', rows: merged.reduce((sum, page) => sum + page.length, 0) });
      return post(merged);
    },
    build: async (rows, options) => {
      calls.push({ kind: 'build', rows: rows.length });
      return post(build(structuredClone(rows), structuredClone(options)));
    },
  };
  return { worker, calls };
}

/** New point rows of the layer `a`, written as columns */
function newPoints(ids: readonly string[], keys: readonly string[]): NewRows {
  const starts = Int32Array.from({ length: ids.length + 1 }, (_, i) => i);
  const coordinates = new Float64Array(ids.length * 2);
  for (let i = 0; i < ids.length; i++) coordinates[i * 2] = 139 + i * 1e-5;
  coordinates.fill(35, 0, 0);
  for (let i = 0; i < ids.length; i++) coordinates[i * 2 + 1] = 35;
  return {
    ids,
    fields: new Map<FeatureRowField, unknown[]>([
      ['type', ids.map(() => 'Point')],
      ['parent', ids.map(() => 'a')],
      ['orderKey', [...keys]],
    ]),
    geometry: {
      types: new Uint8Array(ids.length),
      coordinates,
      valuesPerPosition: 2,
      partStarts: starts,
      ringStarts: starts,
      positionStarts: starts,
    },
  };
}

/**
 * Runs frames of the drawing on the tables of a document, one step of work each: the rebuilt
 * pages and the pages of new rows taken in, as the drawing runs them before it draws
 */
async function runFrames(document: ReturnType<typeof openDocument>, frames: number) {
  const pages = listPages(document.rows);
  const steps: number[] = [];
  for (let f = 0; f < frames; f++) {
    const budget = frameBudget(1);
    pages.rebuild(budget);
    pages.advanceQueuedBlocks(budget);
    pages.swap();
    steps.push(budget.taken);
    // What a Worker gives back comes in a later task
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------

describe('pages built in a Worker', () => {
  it('are taken in without a copy: the Store holds their arrays, gives their rows references and tells them as created', () => {
    const { document, store, changes } = newStore();
    store.createGroup(group('g', 'a', keyOf(5)));
    changes.length = 0;
    const rows: RowInput[] = [
      pointRow(0, { style: { fillColor: '#ff0000' }, properties: { name: 'first', n: 1 } }),
      pointRow(1, { visible: false, locked: true }),
      pointRow(2, {
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      }),
      pointRow(3, { geometry: null }),
      pointRow(4, { groupId: 'g', orderKey: 'a' }),
    ];
    const built = build(rows, { groups: [{ id: 'g', orderKey: keyOf(5) }] });
    const pages = post(built);
    // The arrays of the Worker are empty once posted
    expect(buffersIn(built).size).toBeGreaterThan(0);
    expect([...buffersIn(built)].every((buffer) => buffer.byteLength === 0)).toBe(true);
    const buffers = buffersIn(pages);

    expect(store.transact(() => store.createRowsFromPages('a', pages), 'remote')).toBe(true);

    // The tables hold the page itself, and the same buffers
    const index = listPages(document.rows);
    const refs = store.tables.get('a')?.listRowRefs(0, 10) ?? new Int32Array(0);
    expect(refs).toHaveLength(5);
    for (const ref of refs) expect(index.placeOf(ref)?.group.data).toBe(pages[0]);
    for (const buffer of buffersIn(pages)) expect(buffers.has(buffer)).toBe(true);
    // Its rows have references, and the change tells them as created
    const page = pages[0] as unknown as { rows: Int32Array };
    expect([...page.rows].every((ref) => ref >= 0)).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0].source).toBe('remote');
    expect([...(changes[0].rows?.layers.get('a')?.created ?? [])].sort()).toEqual(
      [...page.rows].sort(),
    );
    // The values are those of the rows built
    const ref = (i: number) => store.tables.getRowRef(rows[i].id) as number;
    const values = store.tables.readValues(Int32Array.from([0, 1, 2, 3, 4], ref), [
      'type',
      'parent',
      'orderKey',
      'visible',
      'locked',
      'style',
      'properties:name',
      'geometry',
    ]);
    expect(values.fields.get('parent')).toEqual(['a', 'a', 'a', 'a', 'g']);
    expect(values.fields.get('orderKey')).toEqual([keyOf(0), keyOf(1), keyOf(2), keyOf(3), 'a']);
    expect(values.fields.get('visible')).toEqual([true, false, true, true, true]);
    expect(values.fields.get('locked')).toEqual([false, true, false, false, false]);
    expect(values.fields.get('style')?.[0]).toEqual({ fillColor: '#ff0000' });
    expect(values.fields.get('properties:name')?.[0]).toBe('first');
    expect([...(values.geometry?.types ?? [])]).toEqual([0, 0, 2, 255, 0]);
    expect(membersOf(store, 'a', 'g')).toBe(1);
  });

  it('are listed for the transfer by every buffer they hold, each once', () => {
    const pages = build(
      Array.from({ length: 10_000 }, (_, i) =>
        pointRow(i, { style: { fillColor: i % 2 ? '#000000' : '#ffffff' }, properties: { n: i } }),
      ),
    );
    expect(pages.length).toBeGreaterThan(1);
    const list = getRowPageTransferList(pages);
    expect(new Set(list).size).toBe(list.length);
    expect(new Set(list)).toEqual(buffersIn(pages));
    expect(getRowPageTransferList([])).toEqual([]);
  });
});

describe('the builder of the pages', () => {
  const refusals: Array<[string, Partial<RowInput>]> = [
    ['a GeometryCollection', { geometry: { type: 'GeometryCollection', geometries: [] } }],
    [
      'a type that is not a geometry',
      { geometry: { type: 'Circle', coordinates: [0, 0] } as unknown as Geometry },
    ],
    ['a position of three values', { geometry: { type: 'Point', coordinates: [0, 0, 1] } }],
    [
      'a position that is not finite',
      { geometry: { type: 'Point', coordinates: [0, Number.NaN] } },
    ],
    [
      'a ring that is not closed',
      {
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
            ],
          ],
        },
      },
    ],
    ['a style value that is not finite', { style: { strokeWidth: Number.POSITIVE_INFINITY } }],
    ['a style value that is a function', { style: { strokeWidth: (() => 1) as never } }],
    ['an attribute that is not finite', { properties: { n: Number.NaN } }],
    ['an attribute that is a function', { properties: { f: () => 1 } }],
  ];

  it.each(refusals)('refuses %s with invalidInput', (_, more) => {
    const builder = createRowPageBuilder();
    builder.addRow(pointRow(0));
    expect(() => builder.addRow(pointRow(1, more))).toThrow(
      expect.objectContaining({ code: 'invalidInput' }),
    );
    expect(builder.length).toBe(1);
    expect(builder.finish().map((page) => page.length)).toEqual([1]);
  });

  it('refuses an id added twice with invalidInput', () => {
    const builder = createRowPageBuilder();
    builder.addRow(pointRow(0));
    let error: unknown;
    try {
      builder.addRow(pointRow(0, { orderKey: 'other' }));
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(DrawError);
    expect((error as DrawError).code).toBe('invalidInput');
    expect(builder.length).toBe(1);
  });

  it('names a group the options do not give with notFound when it finishes', () => {
    const builder = createRowPageBuilder({ groups: [{ id: 'g', orderKey: 'a' }] });
    builder.addRow(pointRow(0, { groupId: 'g' }));
    builder.addRow(pointRow(1, { groupId: 'h' }));
    let error: unknown;
    try {
      builder.finish();
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(DrawError);
    expect((error as DrawError).code).toBe('notFound');
  });

  it('leaves out an attribute whose value is undefined', () => {
    const { store } = newStore();
    store.createRowsFromPages(
      'a',
      post(build([pointRow(0, { properties: { a: 1, b: undefined } })])),
    );
    const ref = store.tables.getRowRef(pointRow(0).id) as number;
    const values = store.tables.readValues(Int32Array.of(ref), ['properties:a', 'properties:b']);
    expect(values.fields.get('properties:a')).toEqual([1]);
    expect(values.fields.get('properties:b')).toEqual([undefined]);
  });
});

describe('the Store takes pages all or none', () => {
  /** A Store with a row `p0000000`, a group `g` of `a`, a layer `b` and its group `h` */
  function filled() {
    const made = newStore();
    const { store } = made;
    store.createLayer(layer('b'));
    store.createGroup(group('g', 'a', 'x'));
    store.createGroup(group('h', 'b', 'x'));
    store.createRowsFromPages('a', pointPages(1));
    made.changes.length = 0;
    return made;
  }

  /** Throws the code a write throws, after checking it wrote nothing and told nothing */
  function refused(made: ReturnType<typeof filled>, write: () => unknown): string {
    const before = contentOf(made.store);
    let code = 'none';
    try {
      write();
    } catch (error) {
      code = error instanceof DrawError ? error.code : String(error);
    }
    expect(contentOf(made.store)).toEqual(before);
    expect(made.changes).toEqual([]);
    return code;
  }

  it('refuses a layer that is not there with notFound', () => {
    const made = filled();
    const pages = pointPages(10, 10);
    expect(refused(made, () => made.store.createRowsFromPages('c', pages))).toBe('notFound');
    expect(refused(made, () => made.store.createRowsFromPages('g', pages))).toBe('notFound');
    // The pages are not taken: another layer takes them afterwards
    expect(made.store.createRowsFromPages('b', pages)).toBe(true);
  });

  it('refuses a group that is not there, or that is not one of the layer, with notFound', () => {
    const made = filled();
    const options = { groups: [{ id: 'z', orderKey: 'x' }] };
    const missing = [
      ...pointPages(4_000, 10),
      ...post(build([pointRow(5_000, { groupId: 'z' })], options)),
    ];
    expect(refused(made, () => made.store.createRowsFromPages('a', missing))).toBe('notFound');
    const other = post(
      build([pointRow(20, { groupId: 'h' })], { groups: [{ id: 'h', orderKey: 'x' }] }),
    );
    expect(refused(made, () => made.store.createRowsFromPages('a', other))).toBe('notFound');
    // The page still names its group by its place, and goes into the layer of the group
    expect(made.store.createRowsFromPages('b', other)).toBe(true);
    expect(membersOf(made.store, 'b', 'h')).toBe(1);
  });

  it('refuses an id in use, the id of a group, and an id given twice, with alreadyExists', () => {
    const made = filled();
    const inUse = [...pointPages(5, 10), ...pointPages(1, 0)];
    expect(refused(made, () => made.store.createRowsFromPages('a', inUse))).toBe('alreadyExists');
    const ofGroup = post(build([pointRow(30), pointRow(31, { id: 'g' })]));
    expect(refused(made, () => made.store.createRowsFromPages('a', ofGroup))).toBe('alreadyExists');
    const twice = [...pointPages(5, 40), ...pointPages(5, 44)];
    expect(refused(made, () => made.store.createRowsFromPages('a', twice))).toBe('alreadyExists');
    const same = pointPages(5, 50);
    expect(refused(made, () => made.store.createRowsFromPages('a', [...same, ...same]))).toBe(
      'alreadyExists',
    );
  });

  it('refuses a page built for other dimensions, and a value that is not a page, with invalidInput', () => {
    const made = filled();
    const three = post(
      build([{ ...pointRow(60), geometry: { type: 'Point', coordinates: [139, 35, 10] } }], {
        valuesPerPosition: 3,
      }),
    );
    expect(refused(made, () => made.store.createRowsFromPages('a', three))).toBe('invalidInput');
    const notPage = [...pointPages(3, 70), { length: 1 } as unknown as RowPage];
    expect(refused(made, () => made.store.createRowsFromPages('a', notPage))).toBe('invalidInput');
    // A page taken in once is not a page to take in again
    const taken = pointPages(3, 80);
    made.store.createRowsFromPages('b', taken);
    made.changes.length = 0;
    expect(refused(made, () => made.store.createRowsFromPages('a', taken))).toBe('invalidInput');
  });

  it('do not take a page while the tables still hold a deleted row of one of its ids, and take it with that reference after the clear', () => {
    const { store } = newStore();
    store.createRowsFromPages('a', pointPages(3));
    const ref = store.tables.getRowRef(pointRow(1).id) as number;
    store.writeRows({ rows: Int32Array.of(ref), fields: new Map(), deleted: Uint8Array.of(1) });
    const again = pointPages(1, 1);
    expect(store.createRowsFromPages('a', again)).toBe(false);
    expect(store.tables.get('a')?.rowCount).toBe(2);
    // The whole document opened again from pages, in one transaction, for a listener that asks
    // for the values before
    const told: StoreChange[] = [];
    store.subscribe((change) => told.push(change), { previousValues: true });
    store.transact(() => {
      store.clear();
      store.createLayer(layer('a'));
      expect(store.createRowsFromPages('a', again)).toBe(true);
    }, 'remote');
    expect(store.tables.getRowRef(pointRow(1).id)).toBe(ref);
    expect(told).toHaveLength(1);
    expect(told[0].reset).toBe(true);
    expect(told[0].previousValues?.get('a')?.rows).toBeInstanceOf(Int32Array);
  });
});

describe('the Worker of the Store', () => {
  /**
   * Opens 12,000 points from pages, then writes 9,000 new rows among the rows of the first page
   * (a merge of more than 8,192 rows) and 3,000 new rows after the last (a build of new rows)
   */
  function largeWork(store: Store) {
    store.createRowsFromPages(
      'a',
      post(
        build(Array.from({ length: 12_000 }, (_, i) => pointRow(i, { orderKey: keyOf(i * 2) }))),
      ),
    );
    const among = Array.from({ length: 9_000 }, (_, i) => `q${i}`);
    store.createRows(
      newPoints(
        among,
        among.map((_, i) => `${keyOf(2 * (i % 4_096))}m${i}`),
      ),
    );
    const after = Array.from({ length: 3_000 }, (_, i) => `z${i}`);
    store.createRows(
      newPoints(
        after,
        after.map((_, i) => `z${String(i).padStart(6, '0')}`),
      ),
    );
  }

  it('runs the large merges and builds of rows, posted to it and posted back', async () => {
    const { worker, calls } = postingWorker();
    const { document, store } = newStore(worker);
    largeWork(store);
    expect(calls).toEqual([]);
    await runFrames(document, 20);
    expect(calls.map((call) => call.kind).sort()).toEqual(['build', 'merge']);
    expect(calls.find((call) => call.kind === 'build')?.rows).toBe(3_000);
    expect(calls.find((call) => call.kind === 'merge')?.rows).toBeGreaterThan(8_192);
    const stats = listPages(document.rows).versionStats();
    expect(stats.swapped).toBeGreaterThan(0);
    expect(stats.pending).toBe(0);
    // The rows are read as written
    expect(store.tables.get('a')?.rowCount).toBe(24_000);
    const ref = store.tables.getRowRef('q8999') as number;
    expect(
      store.tables.readValues(Int32Array.of(ref), ['orderKey']).fields.get('orderKey'),
    ).toEqual([`${keyOf(2 * (8_999 % 4_096))}m8999`]);
  });

  it('gives the rows to build with their groups by their ids, and the pages built back take the references of the groups', async () => {
    const { worker, calls } = postingWorker();
    const { document, store } = newStore(worker);
    store.createGroup(group('g', 'a', 'm'));
    const ids = Array.from({ length: 200 }, (_, i) => `n${i}`);
    const rows = newPoints(
      ids,
      ids.map((_, i) => `k${String(i).padStart(4, '0')}`),
    );
    (rows.fields as Map<FeatureRowField, unknown[]>).set(
      'parent',
      ids.map(() => 'g'),
    );
    (rows.fields as Map<FeatureRowField, unknown[]>).set(
      'properties:n',
      ids.map((_, i) => i),
    );
    store.createRows(rows);
    await runFrames(document, 10);
    expect(calls).toEqual([{ kind: 'build', rows: 200 }]);
    expect(membersOf(store, 'a', 'g')).toBe(200);
    const ref = store.tables.getRowRef('n7') as number;
    const values = store.tables.readValues(Int32Array.of(ref), [
      'parent',
      'properties:n',
      'visible',
    ]);
    expect(values.fields.get('parent')).toEqual(['g']);
    expect(values.fields.get('properties:n')).toEqual([7]);
    expect(values.fields.get('visible')).toEqual([true]);
  });

  it('runs them on the main thread when there is none, a step at a time in the frames of the drawing', async () => {
    const { document, store } = newStore();
    largeWork(store);
    const pages = listPages(document.rows);
    // Nothing is merged nor built while the rows are written
    expect(pages.versionStats().swapped).toBe(0);
    const steps = await runFrames(document, 200);
    expect(Math.max(...steps)).toBeLessThanOrEqual(1);
    expect(steps.filter((taken) => taken > 0).length).toBeGreaterThan(1);
    expect(pages.versionStats().swapped).toBeGreaterThan(0);
    expect(pages.versionStats().lastMergeMs).toBeGreaterThan(0);
    expect(pages.hasPendingWork).toBe(false);
    expect(store.tables.get('a')?.rowCount).toBe(24_000);
  });
});

describe('taking pages in', () => {
  it('makes no more objects of the Store for the rows of more pages', () => {
    expectNotProportional((size) => {
      const { store, counts } = newStore();
      const pages = pointPages(size);
      return workDuring(counts, () => {
        store.transact(() => store.createRowsFromPages('a', pages), 'remote');
      }).objectsCreated;
    }, 'the objects of the Store a creation of rows from pages makes');
  });

  it('opens a million points built in a Worker, a few pages at a time in the parts of one operation', () => {
    const count = 1_000_000;
    const { store, changes } = newStore();
    const pages = pointPages(count);
    const operationId = store.newOperationId();
    const perPart = 8;
    for (let from = 0; from < pages.length; from += perPart) {
      const hasMoreParts = from + perPart < pages.length;
      store.transact(
        () => store.createRowsFromPages('a', pages.slice(from, from + perPart)),
        'remote',
        { operationId, hasMoreParts },
      );
    }
    expect(store.tables.get('a')?.rowCount).toBe(count);
    expect(changes).toHaveLength(Math.ceil(pages.length / perPart));
    expect(changes.every((change) => change.operationId === operationId)).toBe(true);
    expect(changes[changes.length - 1].hasMoreParts).toBe(false);
    expect(
      changes.every(
        (change) => (change.rows?.layers.get('a')?.created.length ?? 0) <= perPart * 4_096,
      ),
    ).toBe(true);
    const ref = store.tables.getRowRef(pointRow(123_456).id) as number;
    expect(store.tables.get('a')?.getPointPosition(ref)).toEqual([
      139 + (123_456 % 1000) * 1e-4,
      35 + Math.floor(123_456 / 1000) * 1e-4,
    ]);
  }, 60_000);
});
