// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Many new rows written at once (6.5 of the design, J12)
 *
 * - New rows whose keys are a run no row of the layer is within, at a place between two groups,
 *   are built into row groups of their own and never go to the delta: an import of thousands of
 *   rows in writes of a thousand is built into groups of the target size, the rows of a write
 *   continuing the run of the writes before
 * - A run within the range of a group, a run with a row of the delta within it, and a few new
 *   rows go to the delta
 * - The run is built in the Worker of the host when it has one
 * - A row of a run written before the run is built makes it built at once
 * - Every read of the tables gives the reference from the write of the new rows on: while they are
 *   gathered, built in the Worker, and queued to be taken in, as once they are taken in
 */

import { describe, expect, it } from 'vitest';
import type { FeatureTablesWorker } from '../api/tables.js';
import { createRowGroupBuilder } from '../table/row-group-builder.js';
import {
  expectTablesMatch,
  referenceKey as key,
  type ReferenceRow,
  ReferenceRows,
  rowPatch,
  tablesOfReference,
} from '../test-utils.js';
import type { FeatureTablesInternals } from './feature-tables.js';
import { hitTestLayerTable } from './hit-test.js';
import { STATE_HIDDEN_MASK } from './row-state.js';
import type { TableWorkBudget } from './types.js';

/** Points in a row, one per key every 1,000 */
function pointsReference(count: number): ReferenceRows {
  const reference = new ReferenceRows();
  for (let i = 0; i < count; i++) reference.rows.set(`p${i}`, pointRow(`p${i}`, key(i * 1000), i));
  return reference;
}

function pointRow(id: string, order: string, x: number): ReferenceRow {
  return {
    id,
    layerId: 'a',
    type: 'Point',
    geometry: { type: 'Point', coordinates: [x, 0] },
    order,
    groupId: undefined,
    member: '',
    style: {},
    properties: { n: x },
    visible: true,
    locked: false,
    deleted: false,
  };
}

const UNBOUNDED: TableWorkBudget = {
  canStep: () => true,
  step: (work) => work(Number.POSITIVE_INFINITY),
};

/** Writes new rows, of the keys given, to the tables and to the reference */
function create(
  setup: ReturnType<typeof tablesOfReference>,
  reference: ReferenceRows,
  rows: Array<{ id: string; order: string }>,
) {
  const encoder = new TextEncoder();
  const parts = rows.map((row) => encoder.encode(row.id));
  const offsets = new Int32Array(rows.length + 1);
  for (let i = 0; i < parts.length; i++) offsets[i + 1] = offsets[i] + parts[i].length;
  const bytes = new Uint8Array(offsets[rows.length]);
  parts.forEach((part, i) => {
    bytes.set(part, offsets[i]);
  });
  const handles = setup.writer.allocateHandles({ offsets, bytes });
  const change = setup.writer.apply(
    rowPatch(Array.from(handles), {
      type: rows.map(() => 'Point'),
      layerId: rows.map(() => 'a'),
      geometry: rows.map((_, i) => ({ type: 'Point', coordinates: [i, 1] })),
      order: rows.map((row) => row.order),
      'property:n': rows.map((_, i) => i),
    }),
  );
  rows.forEach((row, i) => {
    reference.rows.set(row.id, {
      ...pointRow(row.id, row.order, i),
      geometry: { type: 'Point', coordinates: [i, 1] },
    });
  });
  return { handles, change };
}

/** The sizes of the groups of a layer */
function sizes(internals: FeatureTablesInternals): number[] {
  const table = internals.layerTable('a');
  return Array.from(
    { length: table?.groupCount ?? 0 },
    (_, g) => table?.groupAt(g).data.length ?? 0,
  );
}

describe('many new rows written at once', () => {
  it('are built into groups of their own, the writes of an import continuing its run', () => {
    const reference = pointsReference(20);
    const setup = tablesOfReference(reference, ['a'], 10);
    const { tables, internals, groupHandleOf } = setup;
    for (let w = 0; w < 10; w++) {
      const rows = Array.from({ length: 1000 }, (_, i) => ({
        id: `n${w}-${i}`,
        order: `${key(50_000)}${String(w * 1000 + i).padStart(6, '0')}`,
      }));
      create(setup, reference, rows);
      expect(internals.deltaRowCount()).toBe(0);
      // A frame between the writes
      internals.advanceAdoption(UNBOUNDED);
      internals.advanceVersions(UNBOUNDED);
      internals.advanceAdoption(UNBOUNDED);
    }
    internals.flushVersions();
    expect(internals.deltaRowCount()).toBe(0);
    expect(internals.hasPendingWork).toBe(false);
    // The two groups of the points, then the import in groups of the target size
    expect(sizes(internals)).toEqual([10, 10, 4096, 4096, 1808]);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });

  it('go to the delta within the range of a group, around a row of the delta, or when few', () => {
    const reference = pointsReference(20);
    const setup = tablesOfReference(reference, ['a'], 10);
    const { tables, internals, groupHandleOf } = setup;
    // Within the range of the first group (between p3 and p4)
    create(
      setup,
      reference,
      Array.from({ length: 100 }, (_, i) => ({ id: `in${i}`, order: `${key(3000)}${i}` })),
    );
    expect(internals.deltaRowCount()).toBe(100);
    // A few after the last group
    create(setup, reference, [{ id: 'few', order: key(90_000) }]);
    expect(internals.deltaRowCount()).toBe(101);
    // Around a row of the delta (the one just written)
    create(
      setup,
      reference,
      Array.from({ length: 100 }, (_, i) => ({
        id: `around${i}`,
        order: `${key(89_000)}${String(i * 3).padStart(4, '0')}${i === 50 ? 'z' : ''}`,
      })).concat([{ id: 'after', order: key(91_000) }]),
    );
    expect(internals.deltaRowCount()).toBe(202);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
    internals.flushVersions();
    expect(internals.deltaRowCount()).toBe(0);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });

  it('are built in the Worker of the host', async () => {
    const built: number[] = [];
    const worker: FeatureTablesWorker = {
      merge: () => Promise.reject(new Error('no merge')),
      build: (rows, options) => {
        built.push(rows.length);
        const builder = createRowGroupBuilder(options);
        for (const row of rows) builder.addRow(structuredClone(row));
        return Promise.resolve(builder.finish());
      },
    };
    const reference = pointsReference(4);
    const setup = tablesOfReference(reference, ['a'], 10, { worker });
    const { tables, internals, groupHandleOf } = setup;
    create(
      setup,
      reference,
      Array.from({ length: 500 }, (_, i) => ({ id: `w${i}`, order: `${key(9000)}${i}` })),
    );
    for (let i = 0; i < 4; i++) internals.advanceVersions(UNBOUNDED);
    await Promise.resolve();
    internals.advanceAdoption(UNBOUNDED);
    expect(built).toEqual([500]);
    expect(internals.deltaRowCount()).toBe(0);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });

  it('are built at once when a row of them is written before they are', () => {
    const reference = pointsReference(4);
    const setup = tablesOfReference(reference, ['a'], 10);
    const { tables, writer, internals, groupHandleOf } = setup;
    expect(internals.deltaRowCount()).toBe(0);
    const { handles } = create(
      setup,
      reference,
      Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, order: `${key(9000)}${i}` })),
    );
    // Read before it is built
    expect(tables.handleOf('c5')).toBe(handles[5]);
    writer.apply(rowPatch([handles[5]], { 'property:n': [-1] }));
    (reference.rows.get('c5') as ReferenceRow).properties = { n: -1 };
    expect(tables.handleOf('c5')).toBe(handles[5]);
    expect(internals.deltaRowCount()).toBe(0);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });

  it('are read from their write on, while gathered, built in the Worker and queued', async () => {
    let release: (() => void) | null = null;
    const worker: FeatureTablesWorker = {
      merge: () => Promise.reject(new Error('no merge')),
      build: (rows, options) =>
        new Promise((resolve) => {
          release = () => {
            const builder = createRowGroupBuilder(options);
            for (const row of rows) builder.addRow(structuredClone(row));
            resolve(builder.finish());
          };
        }),
    };
    const reference = pointsReference(4);
    const setup = tablesOfReference(reference, ['a'], 10, { worker });
    const { tables, internals, groupHandleOf } = setup;
    const table = internals.layerTable('a');
    const { handles, change } = create(
      setup,
      reference,
      Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, order: `${key(9000)}${i}` })),
    );
    expect(Array.from(change.layers.get('a')?.created ?? [])).toEqual(Array.from(handles));
    const reads = (): void => {
      expect(internals.deltaRowCount()).toBe(0);
      expectTablesMatch(tables, reference, ['a'], groupHandleOf);
      // A search of a box, and a hit test at a new row
      const inBox: number[] = [];
      const cursor = tables.scan({ layerIds: ['a'], bbox: [9.5, 0.5, 10.5, 1.5], order: 'layer' });
      for (let batch = cursor.next(); batch; batch = cursor.next()) inBox.push(...batch);
      expect(inBox.map((handle) => tables.idOf(handle))).toEqual(['r10']);
      const hit = hitTestLayerTable(internals, table as NonNullable<typeof table>, {
        coordinate: [10, 1],
        reach: 0.1,
        toleranceOf: () => 0.1,
        test: (feature, [x, y], tolerance) => {
          const [px, py] = (feature.geometry as { coordinates: number[] }).coordinates;
          return Math.hypot(px - x, py - y) <= tolerance;
        },
      });
      expect(hit?.feature.id).toBe('r10');
      expect(hit?.feature.properties).toEqual({ n: 10 });
    };
    // Gathered
    reads();
    // Being built in the Worker
    for (let i = 0; i < 4; i++) internals.advanceVersions(UNBOUNDED);
    expect(release).not.toBeNull();
    reads();
    // Built and queued to be taken in
    (release as unknown as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(internals.hasPendingAdoption).toBe(true);
    reads();
    // Hidden by this client while queued: the state of the row read is hidden
    internals.states.setHidden(Int32Array.of(handles[10]), true);
    const place = internals.placeOf(handles[10]);
    expect(place?.group.pending).toBe(true);
    expect((place?.group.state[place.row] ?? 0) & STATE_HIDDEN_MASK).not.toBe(0);
    internals.states.setHidden(Int32Array.of(handles[10]), false);
    // Taken in
    internals.advanceAdoption(UNBOUNDED);
    expect(internals.hasPendingAdoption).toBe(false);
    expect(internals.placeOf(handles[10])?.group.pending).toBe(false);
    reads();
  });
});
