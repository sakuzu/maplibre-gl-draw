// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the writes over several tasks do, written down once and compared after every rework of the
 * order they are made in
 *
 * The writes of this client that go on over several tasks are the write of a drag of features
 * selected in bulk once let go (`operations/bulk-sliced.ts`) and a restore of many rows
 * (`row-steps.ts`). Each case starts one of them and, while it is under way, makes something else:
 * a write of this client, a read, a write from elsewhere, a change of the state of this client,
 * another write over several tasks, or asks for the rest to be written. It records, after each
 * thing made and after each task that runs, the notifications, the rows each write told it wrote,
 * its end, whether a write is under way, the timers waiting and the rows written back so far. At
 * the end of the case the document is read whole.
 *
 * The record is compared with the one written before the rework
 * (`__snapshots__/write-queue-parity.jsonl`), so a rework that changes how the writes are put in
 * order and not what they do keeps it as it is.
 */

import { readFileSync } from 'node:fs';
import { ROW_FLAG_DELETED } from '@sakuzu/kasane/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureTables, RowWrite } from '../api/tables.js';
import { createRowValues, rowValuesOf } from '../api/tables.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { TableSelection } from '../feature-table/selection.js';
import { writeKindsInSlices } from '../operations/bulk-sliced.js';
import { type BulkKinds, transformKinds } from '../operations/bulk-transform.js';
import { DrawStore } from './draw-store.js';
import { BULK_SLICE_ROWS } from './row-steps.js';
import type { TransformEdit } from './store.js';
import { TableContractStore } from './table-memory.js';
import type { Feature, FeatureValues, RowValues, StoreChange } from './types.js';

/** A move of one degree to the east along the equator */
const EAST_ONE_DEGREE: TransformEdit = { kind: 'translate', from: [0, 0], to: [1, 0] };

/** The rows of each layer: more than are written at a time in a step */
const COUNT = BULK_SLICE_ROWS * 2 + 10;

let clock = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Each look at the clock is 13 ms later: a step writes one run of rows
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    clock += 13;
    return clock;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function point(layerId: string, i: number): Feature {
  return {
    id: `${layerId}${i}`,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [i * 0.001, 1] },
    layerId,
    groupId: undefined,
    properties: { n: i },
    style: {},
    visible: true,
    locked: false,
  };
}

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

/** What a notification says, by counts */
function notificationOf(change: StoreChange): Record<string, unknown> {
  const out: Record<string, unknown> = { source: change.source };
  if (change.rows) {
    const rows: Record<string, number[]> = {};
    for (const [id, l] of change.rows.layers) {
      rows[id] = [l.created.length, l.updated.length, l.deleted.length];
    }
    out.rows = rows;
  }
  if (change.features) {
    out.features = [
      change.features.created?.length ?? 0,
      change.features.updated?.length ?? 0,
      change.features.deleted?.length ?? 0,
    ];
  }
  if (change.groups) {
    out.groups = [
      change.groups.created?.length ?? 0,
      change.groups.updated?.length ?? 0,
      change.groups.deleted?.length ?? 0,
    ];
  }
  if (change.selection) out.selection = change.selection.type;
  if (change.mode) out.mode = true;
  if (change.uiStateChanged) out.uiState = true;
  if (change.order) out.order = change.order.length;
  if (change.restoreToken !== undefined) out.restoreToken = true;
  if (change.previousValues) {
    out.previousValues = rowValuesOf(change.previousValues as FeatureValues).handles.length;
  }
  return out;
}

/**
 * A layer `l` of rows to drag, selected in bulk, and a layer `r` of rows deleted, with the values
 * a restore brings them back with
 */
function setup() {
  const contract = new TableContractStore();
  const store = new DrawStore(contract, { selectionIdsLimit: 3 });
  store.createLayer(layer('l'));
  store.createLayer(layer('r'));
  store.createFeatures(Array.from({ length: COUNT }, (_, i) => point('l', i)));
  store.createFeatures(Array.from({ length: COUNT }, (_, i) => point('r', i)));
  const tables = store.tables as FeatureTables;
  const lHandles = Array.from({ length: COUNT }, (_, i) => tables.getRowRef(`l${i}`) as number);
  const rHandles = Int32Array.from(
    { length: COUNT },
    (_, i) => tables.getRowRef(`r${i}`) as number,
  );
  store.selectRows(TableSelection.of(lHandles));
  const rows = store.getSelectedRows() as TableSelection;
  const changes: StoreChange[] = [];
  store.subscribe((change) => changes.push(change));
  const deleting = createRowValues({
    handles: rHandles,
    fields: new Map(),
    deleted: new Uint8Array(COUNT).fill(1),
  });
  const deletion: RowWrite = { patch: deleting, before: tables.readValues(deleting) };
  store.applyRows(deletion);
  const before = rowValuesOf(changes[changes.length - 1].previousValues as FeatureValues);
  changes.length = 0;

  const log: string[] = [];
  const written: number[] = [];
  const done: boolean[] = [];
  /** Starts the write of a drag of every row of `l` one degree to the east */
  const drag = (): boolean =>
    writeKindsInSlices(store, rows, transformKinds(store, EAST_ONE_DEGREE, rows) as BulkKinds, {
      onWritten: (list) => written.push(list.length),
      onDone: (wrote) => done.push(wrote),
    });
  /** Starts a restore of the rows of `r` (all of them, or the first `n`) */
  const restore = (n = COUNT): RowValues | null =>
    store.restoreRows(
      n === COUNT
        ? before
        : {
            handles: before.handles.slice(0, n),
            fields: new Map(
              Array.from(before.fields, ([field, column]) => [field, column.slice(0, n)]),
            ),
            ...(before.deleted && { deleted: before.deleted.slice(0, n) }),
          },
    );
  /** The rows of `r` there, read from the rows themselves (not through a read that finishes) */
  const rBack = (): number => {
    const internals = featureTablesInternals(tables);
    let back = 0;
    for (const handle of rHandles) {
      const place = internals?.placeOf(handle);
      if (place && (place.group.data.flags[place.row] & ROW_FLAG_DELETED) === 0) back++;
    }
    return back;
  };
  /** Writes down what is there now, after something made */
  const note = (label: string): void => {
    log.push(
      JSON.stringify({
        step: label,
        notified: changes.map(notificationOf),
        written: [...written],
        done: [...done],
        pending: store.slicedWritePending,
        timers: vi.getTimerCount(),
        rBack: rBack(),
      }),
    );
    changes.length = 0;
    written.length = 0;
    done.length = 0;
  };
  /** Runs the tasks waiting, one after the other, writing down each */
  const runTasks = (): void => {
    let tasks = 0;
    while (vi.getTimerCount() > 0 && tasks < 100) {
      vi.advanceTimersToNextTimer();
      tasks++;
      note(`task ${tasks}`);
    }
  };
  /** Reads the document whole (the reads finish what is under way) */
  const readWhole = (): void => {
    const xs = (id: string) =>
      Array.from({ length: COUNT }, (_, i) => {
        const f = store.getFeature(`${id}${i}`);
        return f
          ? Math.round((f.geometry as { coordinates: number[] }).coordinates[0] * 1e6)
          : null;
      });
    const others = ['x', 'y'].map((id) => [id, store.getFeature(id)?.layerId ?? null]);
    log.push(JSON.stringify({ l: xs('l'), r: xs('r'), others, groups: store.listGroups().length }));
  };
  return { contract, store, tables, drag, restore, note, runTasks, readWhole, log };
}

type Setup = ReturnType<typeof setup>;

/** A case: what starts, and what is made while it is under way */
interface Case {
  readonly name: string;
  readonly run: (s: Setup) => void;
}

const other = (id: string): Feature => ({ ...point('l', 0), id });

const CASES: readonly Case[] = [
  {
    name: 'a drag written through',
    run: (s) => {
      s.drag();
      s.note('started');
      s.runTasks();
    },
  },
  {
    name: 'a drag, then a feature created by this client',
    run: (s) => {
      s.drag();
      s.note('started');
      s.store.createFeature(other('x'));
      s.note('created');
      s.runTasks();
    },
  },
  {
    name: 'a drag, then a feature updated in a transaction of this client',
    run: (s) => {
      s.drag();
      s.note('started');
      s.store.transact(
        () => s.store.updateFeature(`l${COUNT - 1}`, { properties: { n: -1 } }),
        'history',
      );
      s.note('updated');
      s.runTasks();
    },
  },
  {
    name: 'a drag, then reads',
    run: (s) => {
      s.drag();
      s.note('started');
      s.store.getFeature(`l${COUNT - 1}`);
      s.note('a feature read');
      s.tables.get('l')?.getRow(s.tables.getRowRef(`l${COUNT - 1}`) as number);
      s.note('a row read');
      s.runTasks();
    },
  },
  {
    name: 'a drag, then a write from elsewhere',
    run: (s) => {
      s.drag();
      s.note('started');
      s.contract.transact(() => {
        s.contract.updateFeature(`l${COUNT - 1}`, {
          geometry: { type: 'Point', coordinates: [50, 1] },
        });
      }, 'remote');
      s.note('written from elsewhere');
      s.store.transact(() => s.store.createFeature(other('y')), 'remote');
      s.note('written from elsewhere through the Store');
      s.runTasks();
    },
  },
  {
    name: 'a drag, then changes of the state of this client',
    run: (s) => {
      s.drag();
      s.note('started');
      s.store.setMode('drawPoint');
      s.note('the mode set');
      s.store.setLocallyHidden('l1', true);
      s.note('hidden here');
      s.store.setSelection('feature', ['l2']);
      s.note('selected');
      s.runTasks();
    },
  },
  {
    name: 'a drag, then another drag',
    run: (s) => {
      s.drag();
      s.note('started');
      s.drag();
      s.note('started again');
      s.runTasks();
    },
  },
  {
    name: 'a drag, then a restore',
    run: (s) => {
      s.drag();
      s.note('started');
      s.restore();
      s.note('restore started');
      s.runTasks();
    },
  },
  {
    name: 'a drag, then the rest asked for',
    run: (s) => {
      s.drag();
      s.note('started');
      s.store.finishSlicedWrite();
      s.note('finished');
      s.runTasks();
    },
  },
  {
    name: 'a drag, then an operation on the rows selected',
    run: (s) => {
      s.drag();
      s.note('started');
      s.store.applyBulk({ kind: 'delete' });
      s.note('deleted');
      s.runTasks();
    },
  },
  {
    name: 'a restore of few rows',
    run: (s) => {
      s.restore(BULK_SLICE_ROWS);
      s.note('restored');
      s.runTasks();
    },
  },
  {
    name: 'a restore written through',
    run: (s) => {
      s.restore();
      s.note('started');
      s.runTasks();
    },
  },
  {
    name: 'a restore in a transaction of this client',
    run: (s) => {
      s.store.transact(() => {
        s.restore();
        s.note('started in it');
      }, 'history');
      s.note('transaction ended');
      s.runTasks();
    },
  },
  {
    name: 'a restore, then a feature created by this client',
    run: (s) => {
      s.restore();
      s.note('started');
      s.store.createFeature(other('x'));
      s.note('created');
      s.runTasks();
    },
  },
  {
    name: 'a restore, then reads',
    run: (s) => {
      s.restore();
      s.note('started');
      s.tables.get('r')?.getRow(s.tables.getRowRef(`r${COUNT - 1}`) as number);
      s.note('a row read');
      s.runTasks();
    },
  },
  {
    name: 'a restore, then a feature read',
    run: (s) => {
      s.restore();
      s.note('started');
      s.store.getFeature(`r${COUNT - 1}`);
      s.note('a feature read');
      s.runTasks();
    },
  },
  {
    name: 'a restore, then a write from elsewhere',
    run: (s) => {
      s.restore();
      s.note('started');
      s.contract.transact(() => s.contract.createFeature(other('y')), 'remote');
      s.note('written from elsewhere');
      s.runTasks();
    },
  },
  {
    name: 'a restore, then a write from elsewhere through the Store',
    run: (s) => {
      s.restore();
      s.note('started');
      s.store.transact(() => s.store.createFeature(other('y')), 'remote');
      s.note('written from elsewhere');
      s.runTasks();
    },
  },
  {
    name: 'a restore, then changes of the state of this client',
    run: (s) => {
      s.restore();
      s.note('started');
      s.store.setMode('drawPoint');
      s.note('the mode set');
      s.store.setSelection('feature', ['l2']);
      s.note('selected');
      s.runTasks();
    },
  },
  {
    name: 'a restore, then the rows selected read',
    run: (s) => {
      s.restore();
      s.note('started');
      s.store.getUnlockedSelectedRows();
      s.note('the rows selected read');
      s.runTasks();
    },
  },
  {
    name: 'a restore, then rows selected',
    run: (s) => {
      s.restore();
      s.note('started');
      s.store.selectRows(TableSelection.of([s.tables.getRowRef('l1') as number]));
      s.note('selected');
      s.runTasks();
    },
  },
  {
    name: 'a restore, then a selection put back',
    run: (s) => {
      const selection = s.store.getSelection();
      s.restore();
      s.note('started');
      s.store.restoreSelection(selection);
      s.note('put back');
      s.runTasks();
    },
  },
  {
    name: 'a drag, then the rows selected read',
    run: (s) => {
      s.drag();
      s.note('started');
      s.store.getUnlockedSelectedRows();
      s.note('the rows selected read');
      s.runTasks();
    },
  },
  {
    name: 'a restore, then another restore',
    run: (s) => {
      s.restore();
      s.note('started');
      s.restore();
      s.note('started again');
      s.runTasks();
    },
  },
  {
    name: 'a restore, then a drag',
    run: (s) => {
      s.restore();
      s.note('started');
      s.drag();
      s.note('drag started');
      s.runTasks();
    },
  },
  {
    name: 'a restore, then the rest asked for',
    run: (s) => {
      s.restore();
      s.note('started');
      s.store.finishSlicedWrite();
      s.note('finished');
      s.runTasks();
    },
  },
];

describe('the writes over several tasks, as they were before their order was reworked', () => {
  it('does the same in every case', () => {
    const lines: string[] = [];
    for (const c of CASES) {
      const s = setup();
      c.run(s);
      s.readWhole();
      lines.push(JSON.stringify({ case: c.name }), ...s.log);
    }
    const recorded = readFileSync(
      new URL('./__snapshots__/write-queue-parity.jsonl', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter((line) => line !== '');
    expect(lines.length).toBe(recorded.length);
    lines.forEach((line, i) => {
      expect(JSON.parse(line)).toEqual(JSON.parse(recorded[i]));
    });
  });
});
