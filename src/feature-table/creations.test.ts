// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Many new rows written at once
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

import { PAGE_TARGET_ROWS } from '@sakuzu/kasane';
import type { TableWorkBudget } from '@sakuzu/kasane/render';
import { describe, expect, it, vi } from 'vitest';
import type { FeatureTablesWorker } from '../api/tables.js';
import { circleRowRings } from '../table/circle-rings.js';
import { FEATURE_TABLE_COLUMNS } from '../table/tabane/columns.js';
import { tablesBuilderOptionsOf } from '../table/tables-values.js';
import {
  featureRowDataBuilder as createPageDataBuilder,
  expectTablesMatch,
  referenceKey as key,
  type ReferenceRow,
  ReferenceRows,
  rowPatch,
  tablesOfReference,
} from '../test-utils.js';
import { STATE_HIDDEN_MASK } from './feature-row-states.js';
import type { FeatureTablesInternals } from './feature-tables.js';
import { hitTestLayerTable } from './hit-test.js';

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
  const handles = setup.writer.allocateRowRefs({ offsets, bytes });
  const change = setup.writer.writeRows(
    rowPatch(Array.from(handles), {
      type: rows.map(() => 'Point'),
      parent: rows.map(() => 'a'),
      geometry: rows.map((_, i) => ({ type: 'Point', coordinates: [i, 1] })),
      key: rows.map((row) => row.order),
      'properties:n': rows.map((_, i) => i),
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
  const table = internals.rowTable('a');
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
      internals.advanceQueuedBlocks(UNBOUNDED);
      internals.rebuild(UNBOUNDED);
      internals.advanceQueuedBlocks(UNBOUNDED);
    }
    internals.flushVersions();
    expect(internals.deltaRowCount()).toBe(0);
    expect(internals.hasPendingWork).toBe(false);
    // The two groups of the points, then the import in groups of the target size
    expect(sizes(internals)).toEqual([10, 10, 4096, 4096, 1808]);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });

  it('give their type and their values that are not objects without being built', () => {
    const reference = pointsReference(20);
    const setup = tablesOfReference(reference, ['a'], 10);
    const { tables, internals } = setup;
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: `n${i}`,
      order: `${key(50_000)}${String(i).padStart(6, '0')}`,
    }));
    const { handles } = create(setup, reference, rows);
    const view = tables.get('a');
    const built = vi.spyOn(internals as unknown as { buildRows(): unknown }, 'buildRows');
    expect(view?.getRowType(handles[7] as number)).toBe('Point');
    expect(view?.getRowValue(handles[7] as number, 'n')).toBe(7);
    expect(view?.getRowValue(handles[7] as number, 'none')).toBeUndefined();
    expect(built).not.toHaveBeenCalled();
    // A read of the row builds it, and the values are those of the row from then on
    expect(view?.getRow(handles[7] as number)?.properties).toEqual({ n: 7 });
    expect(built).toHaveBeenCalledTimes(1);
    expect(view?.getRowValue(handles[7] as number, 'n')).toBe(7);
    built.mockRestore();
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

  it('gather within the range of a group once the delta is large, and go into it at once', () => {
    const reference = pointsReference(20);
    const setup = tablesOfReference(reference, ['a'], 10);
    const { tables, internals, groupHandleOf } = setup;
    const within = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `in${from + i}`,
        order: `${key(3000)}${String(from + i).padStart(6, '0')}`,
      }));
    // Into the delta until it holds a group of rows
    create(setup, reference, within(0, PAGE_TARGET_ROWS));
    expect(internals.deltaRowCount()).toBe(PAGE_TARGET_ROWS);
    // Past it, the rows that follow are read from where they gather
    create(setup, reference, within(PAGE_TARGET_ROWS, 100));
    expect(internals.deltaRowCount()).toBe(PAGE_TARGET_ROWS);
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
        const builder = createPageDataBuilder({
          columns: FEATURE_TABLE_COLUMNS,
          ...tablesBuilderOptionsOf(options),
          rings: circleRowRings,
        });
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
    for (let i = 0; i < 4; i++) internals.rebuild(UNBOUNDED);
    await Promise.resolve();
    internals.advanceQueuedBlocks(UNBOUNDED);
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
    expect(tables.getRowRef('c5')).toBe(handles[5]);
    writer.writeRows(rowPatch([handles[5]], { 'properties:n': [-1] }));
    (reference.rows.get('c5') as ReferenceRow).properties = { n: -1 };
    expect(tables.getRowRef('c5')).toBe(handles[5]);
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
            const builder = createPageDataBuilder({
              columns: FEATURE_TABLE_COLUMNS,
              ...tablesBuilderOptionsOf(options),
              rings: circleRowRings,
            });
            for (const row of rows) builder.addRow(structuredClone(row));
            resolve(builder.finish());
          };
        }),
    };
    const reference = pointsReference(4);
    const setup = tablesOfReference(reference, ['a'], 10, { worker });
    const { tables, internals, groupHandleOf } = setup;
    const table = internals.rowTable('a');
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
      expect(inBox.map((handle) => tables.getRowId(handle))).toEqual(['r10']);
      const hit = hitTestLayerTable(internals, table as NonNullable<typeof table>, {
        coordinate: [10, 1],
        reach: 0.1,
        toleranceOf: () => 0.1,
        testShape: () => null,
        test: (feature, [x, y], tolerance) => {
          const [px, py] = (feature.geometry as { coordinates: number[] }).coordinates;
          return Math.hypot(px - x, py - y) <= tolerance;
        },
      });
      const hitHandle = hit ? hit.group.data.rows[hit.row] : -1;
      expect(tables.getRowId(hitHandle)).toBe('r10');
      expect(tables.get('a')?.getRowValue(hitHandle, 'n')).toBe(10);
    };
    // Gathered
    reads();
    // Being built in the Worker
    for (let i = 0; i < 4; i++) internals.rebuild(UNBOUNDED);
    expect(release).not.toBeNull();
    reads();
    // Built and queued to be taken in
    (release as unknown as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(internals.hasQueuedBlocks).toBe(true);
    reads();
    // Hidden by this client while queued: the state of the row read is hidden
    internals.states.setHidden(Int32Array.of(handles[10]), true);
    const place = internals.placeOf(handles[10]);
    expect(place?.group.pending).toBe(true);
    expect((place?.group.state[place.row] ?? 0) & STATE_HIDDEN_MASK).not.toBe(0);
    internals.states.setHidden(Int32Array.of(handles[10]), false);
    // Taken in
    internals.advanceQueuedBlocks(UNBOUNDED);
    expect(internals.hasQueuedBlocks).toBe(false);
    expect(internals.placeOf(handles[10])?.group.pending).toBe(false);
    reads();
  });

  it('keep their groups and the first group of the delta apart, whichever goes in first', () => {
    // A layer without groups: new rows of a run of their own (every other key) are gathered,
    // the rows within their run go to the delta, whose first group starts while the run is
    // built; the run is taken in before that group is swapped in
    const reference = new ReferenceRows();
    const setup = tablesOfReference(reference, ['a'], 10);
    const { tables, internals, groupHandleOf } = setup;
    let uploaded = false;
    internals.attachReceiver({ uploaded: () => uploaded, swapped: () => {}, dropped: () => {} });
    const order = (i: number) => key(10_000 + i * 10);
    create(
      setup,
      reference,
      Array.from({ length: 200 }, (_, i) => ({ id: `even${i}`, order: order(2 * i) })),
    );
    create(
      setup,
      reference,
      Array.from({ length: 200 }, (_, i) => ({ id: `odd${i}`, order: order(2 * i + 1) })),
    );
    expect(internals.deltaRowCount()).toBe(200);
    for (let frame = 0; frame < 6; frame++) {
      internals.advanceQueuedBlocks(UNBOUNDED);
      internals.rebuild(UNBOUNDED);
      internals.swap();
    }
    expect(internals.builtVersions('a').length).toBeGreaterThan(0);
    expect(sizes(internals)).toEqual([200]);
    // The GPU side of the first group of the delta is up: it overlaps the run taken in, so it is
    // not swapped in, and the rows of the delta go to the next version of the run's group
    uploaded = true;
    expect(() => internals.swap()).not.toThrow();
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
    expect(() => internals.flushVersions()).not.toThrow();
    expect(internals.deltaRowCount()).toBe(0);
    expect(sizes(internals).reduce((sum, n) => sum + n, 0)).toBe(400);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });
});
