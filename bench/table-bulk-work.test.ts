// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work of one edit of every feature selected in bulk, without a browser: the rows of the
 * table page (`benchFeature`, mixed, 100 000 by default) held by the in-memory Store of rows, all
 * selected, then moved, resized and given a color once each, as the select mode and
 * `draw.selection.update` make them. Each prints the time of its work and the heap it leaves.
 *
 * It measures, it does not check: it runs only when asked
 * (`BULK_WORK=100000 npx vitest run --config bench/vitest.config.ts table-bulk-work`, with
 * `--pool=forks --execArgv=--expose-gc` for the heap after a collection). With
 * `BULK_WORK_PROFILE` set to a directory, the CPU profile of each piece of work is written there.
 */

import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { join } from 'node:path';
import { createRowBlockBuilder, createTableStore } from '@sakuzu/maplibre-gl-draw/kasane';
import { describe, expect, it } from 'vitest';
import * as featureTablesModule from '../src/feature-table/feature-tables';
import * as selectionModule from '../src/feature-table/selection';
import * as slicedModule from '../src/operations/bulk-sliced';
import * as transformModule from '../src/operations/bulk-transform';
import { benchFeature, extentOf, stylesOf, type TableBenchParams } from './table-data';

// The library keeps these to itself (the declarations of its build leave them out): they are
// read from its modules with the shapes used here
/** A set of rows */
interface Rows {
  readonly count: number;
}
/** The Store of rows as the select mode uses it */
interface BulkStore {
  readonly tables?: { findRow(id: string): number | undefined };
  selectRows(rows: Rows): void;
  getSelectedRows(): Rows | null;
  applyBulk(op: unknown, rows?: Rows): boolean;
}
const { featureTablesInternals } = featureTablesModule as unknown as {
  featureTablesInternals(tables: unknown): { addQueuedRowBlocks(): void } | undefined;
};
const { TableSelection } = selectionModule as unknown as {
  TableSelection: { of(handles: readonly number[]): Rows };
};
const { writeKindsInSlices } = slicedModule as unknown as {
  writeKindsInSlices(
    store: BulkStore,
    rows: Rows,
    kinds: unknown,
    options: { onDone(written: boolean): void; schedule(step: () => void): void },
  ): boolean;
};
const {
  translateBulkSelection,
  rotateBulkSelection,
  resizeBulkSelection,
  translationKinds,
  rotationKinds,
} = transformModule as unknown as {
  translationKinds(rows: Rows, dx: number, dy: number): unknown;
  rotationKinds(
    store: BulkStore,
    center: [number, number],
    angle: number,
    extensions: undefined,
    rows: Rows,
  ): unknown;
  translateBulkSelection(store: BulkStore, dx: number, dy: number, rows: Rows): boolean;
  rotateBulkSelection(
    store: BulkStore,
    center: [number, number],
    angle: number,
    extensions: undefined,
    rows: Rows,
  ): boolean;
  resizeBulkSelection(
    store: BulkStore,
    resize: unknown,
    extensions: undefined,
    rows: Rows,
  ): boolean;
};

const COUNT = Number(process.env.BULK_WORK ?? 0);

const PROFILE = process.env.BULK_WORK_PROFILE;

/** The memory in use, the heap and the buffers (after a collection when it can be asked) */
function memoryMb(): number {
  (globalThis as { gc?: () => void }).gc?.();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return (heapUsed + arrayBuffers) / 2 ** 20;
}

/** Runs a command of the inspector of this process */
function post(session: Session, method: string, params?: object): Promise<unknown> {
  return new Promise((resolve, reject) =>
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result))),
  );
}

/**
 * Times a piece of work, the memory before and after it, and the most memory while it ran (the
 * heap sampled by the collector's own statistics at its end, the buffers at the end)
 */
async function timed(name: string, work: () => unknown): Promise<void> {
  const before = memoryMb();
  const session = PROFILE ? new Session() : null;
  if (session) {
    session.connect();
    await post(session, 'Profiler.enable');
    // A sample every 0.1 ms: the pieces of a work of tens of milliseconds are told apart
    await post(session, 'Profiler.setSamplingInterval', { interval: 100 });
    await post(session, 'Profiler.start');
  }
  const t0 = performance.now();
  const result = work();
  const ms = performance.now() - t0;
  const peak = (process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers) / 2 ** 20;
  if (session && PROFILE) {
    const { profile } = (await post(session, 'Profiler.stop')) as { profile: unknown };
    writeFileSync(
      join(PROFILE, `${name.replace(/\W+/g, '-')}.cpuprofile`),
      JSON.stringify(profile),
    );
    session.disconnect();
  }
  const after = memoryMb();
  console.log(
    `[bulk-work] ${name}: ${ms.toFixed(1)} ms, memory ${before.toFixed(0)} -> ${peak.toFixed(0)} (end, before a collection) -> ${after.toFixed(0)} MB (${result})`,
  );
}

/**
 * Writes kinds of rows in steps, as a drag let go writes them: the time of each step (the longest
 * is the longest a frame waits), and of all of them
 */
function inSteps(name: string, store: BulkStore, rows: Rows, kinds: unknown): void {
  const steps: Array<() => void> = [];
  const times: number[] = [];
  let done = false;
  const t0 = performance.now();
  writeKindsInSlices(store, rows, kinds, {
    onDone: () => {
      done = true;
    },
    schedule: (step) => steps.push(step),
  });
  times.push(performance.now() - t0);
  while (steps.length > 0) {
    const step = steps.shift() as () => void;
    const s0 = performance.now();
    step();
    times.push(performance.now() - s0);
  }
  const total = times.reduce((sum, time) => sum + time, 0);
  console.log(
    `[bulk-work] ${name} in steps: ${times.length} steps, longest ${Math.max(...times).toFixed(1)} ms, all ${total.toFixed(1)} ms (${done})`,
  );
}

function storeOf(params: TableBenchParams): BulkStore {
  const { store, writer } = createTableStore();
  store.createLayer({
    id: 'rows',
    name: 'rows',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  } as never);
  const styles = stylesOf(params);
  let builder = createRowBlockBuilder();
  for (let i = 0; i < params.n; i++) {
    const feature = benchFeature(params, styles, i);
    builder.addRow({
      id: feature.id,
      type: feature.type,
      geometry: feature.geometry,
      order: feature.order,
      style: feature.style,
      properties: feature.properties,
    } as never);
    if (builder.length >= 16_384) {
      writer.addRowBlocks('rows', builder.finish());
      builder = createRowBlockBuilder();
    }
  }
  if (builder.length > 0) writer.addRowBlocks('rows', builder.finish());
  featureTablesInternals(store.tables)?.addQueuedRowBlocks();
  return store as unknown as BulkStore;
}

describe.skipIf(COUNT === 0)('the work of one edit of every feature selected in bulk', () => {
  it('moves, turns, resizes and colors them', async () => {
    const params: TableBenchParams = {
      n: COUNT,
      kind: 'mixed',
      styles: 16,
      translucent: true,
      data: '',
      shuffle: false,
    };
    const store = storeOf(params);
    const tables = store.tables;
    expect(tables).toBeDefined();
    const handles: number[] = [];
    for (let i = 0; i < params.n; i++) handles.push(tables?.findRow(`f${i}`) as number);
    await timed('select all', () => store.selectRows(TableSelection.of(handles)));
    const rows = store.getSelectedRows() as Rows;
    expect(rows.count).toBe(params.n);
    const [west, south, east, north] = extentOf(params);
    const bbox = {
      topLeft: [west, north] as [number, number],
      topRight: [east, north] as [number, number],
      bottomRight: [east, south] as [number, number],
      bottomLeft: [west, south] as [number, number],
      center: [(west + east) / 2, (south + north) / 2] as [number, number],
    };
    await timed('move', () => translateBulkSelection(store, 0.001, 0.0005, rows));
    await timed('rotate', () => rotateBulkSelection(store, bbox.center, 0.2, undefined, rows));
    await timed('resize', () =>
      resizeBulkSelection(
        store,
        {
          handle: 'resize-ne',
          bbox,
          startLngLat: { lng: east, lat: north },
          currentLngLat: { lng: east + (east - west) * 0.1, lat: north + (north - south) * 0.1 },
        },
        undefined,
        rows,
      ),
    );
    inSteps('move', store, rows, translationKinds(rows, 0.001, 0.0005));
    inSteps('rotate', store, rows, rotationKinds(store, bbox.center, 0.2, undefined, rows));
    for (let k = 0; k < 3; k++) {
      await timed(`color ${k + 1}`, () =>
        store.applyBulk(
          {
            kind: 'update',
            make: () => ({ style: { fillColor: `#${(k * 40 + 20).toString(16)}8040` } }),
          },
          rows,
        ),
      );
    }
  });
});
