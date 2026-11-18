// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work of the values before and of the deleted rows kept, counted by the numbers the built-in
 * Store keeps of the work it does for the values before only
 *
 * - While no listener asks for the values before, a write reads no row and makes no object for
 *   them, whatever its number of rows
 * - The values before of a move are held as the columns of the geometries: the objects made for
 *   them do not grow with the rows moved, and do not grow with the listeners that receive them
 */

import { describe, expect, it } from 'vitest';
import type { Layer } from '../../api/model.js';
import type { WorkCounts } from '../../shared/work-counts.js';
import { expectNotProportional, workDuring } from '../../test-utils.js';
import { storeOf } from './create-store.js';
import { openDocument } from './document.js';
import type {
  FeatureRowField,
  GeometryColumn,
  NewRows,
  StoreChange,
  SubscribeOptions,
} from './types.js';

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

/** `count` points in a line, moved by `by`, as one column */
function points(count: number, by = 0): GeometryColumn {
  const coordinates = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    coordinates[i * 2] = i * 1e-5 + by;
    coordinates[i * 2 + 1] = by;
  }
  const starts = Int32Array.from({ length: count + 1 }, (_, i) => i);
  return {
    types: new Uint8Array(count),
    coordinates,
    valuesPerPosition: 2,
    partStarts: starts,
    ringStarts: starts,
    positionStarts: starts,
  };
}

/** `count` new points of the layer `a` */
function pointRows(count: number): NewRows {
  const ids = Array.from({ length: count }, (_, i) => `r${String(i).padStart(7, '0')}`);
  return {
    ids,
    fields: new Map<FeatureRowField, unknown[]>([
      ['type', ids.map(() => 'Point')],
      ['parent', ids.map(() => 'a')],
      ['orderKey', ids.map((id) => `k${id}`)],
    ]),
    geometry: points(count),
  };
}

/**
 * A Store of `size` points in the layer `a`, with listeners subscribed so, the numbers of the
 * work it does for the values before, and the references of its rows
 */
function newStore(size: number, listeners: readonly (SubscribeOptions | undefined)[]) {
  const document = openDocument();
  const store = storeOf(document);
  store.createLayer(layer('a'));
  store.createRows(pointRows(size));
  const changes: StoreChange[][] = listeners.map(() => []);
  listeners.forEach((options, i) => {
    store.subscribe((change) => changes[i].push(change), options);
  });
  const view = store.tables.get('a');
  if (!view) throw new Error('no rows');
  const before: WorkCounts = document.changes.beforeCounts;
  return { store, changes, before, rows: view.listRowRefs(0, size) };
}

/** Moves every row of a Store by one degree, in one write of their geometries */
function moveAll(store: ReturnType<typeof newStore>['store'], rows: Int32Array): void {
  store.transact(
    () => store.writeRows({ rows, fields: new Map(), geometry: points(rows.length, 1) }),
    'local',
  );
}

describe('the values before', () => {
  it('are not read, and make nothing, while no listener asks for them', () => {
    // A listener that asks for nothing, and one that asks for the changes of another source
    const listeners = [undefined, { previousValues: ['remote'] }, { keepDeletedRows: false }];
    expectNotProportional(
      (size) => {
        const { store, before, rows } = newStore(size, listeners);
        return workDuring(before, () => moveAll(store, rows)).rowsTouched;
      },
      'the rows read for the values before while no listener asks for them',
      { zero: true },
    );
    expectNotProportional(
      (size) => {
        const { store, before, rows } = newStore(size, listeners);
        return workDuring(before, () => moveAll(store, rows)).objectsCreated;
      },
      'the objects made for the values before while no listener asks for them',
      { zero: true },
    );
  });

  it('of a move are held as the columns of the geometries, not as an object per row', () => {
    const comparison = expectNotProportional((size) => {
      const { store, before, rows, changes } = newStore(size, [{ previousValues: true }]);
      const work = workDuring(before, () => moveAll(store, rows));
      // The values before are those of every row moved, as they were
      const values = changes[0][0].previousValues?.get('a');
      expect(values?.rows).toHaveLength(size);
      expect(values?.geometry?.coordinates[2 * (size - 1)]).toBeCloseTo((size - 1) * 1e-5);
      // Every row was read once
      expect(work.rowsTouched).toBe(size);
      return work.objectsCreated;
    }, 'the objects made for the values before of a move');
    expect(comparison.large).toBe(comparison.small);
  });

  it('make no more objects for more rows when the transaction writes them in several writes', () => {
    expectNotProportional((size) => {
      const { store, before, rows } = newStore(size, [{ previousValues: true }]);
      const half = rows.length / 2;
      return workDuring(before, () =>
        store.transact(() => {
          store.writeRows({
            rows: rows.subarray(0, half),
            fields: new Map(),
            geometry: points(half, 1),
          });
          store.writeRows({
            rows,
            fields: new Map([['visible', new Array(rows.length).fill(false)]]),
            geometry: points(rows.length, 2),
          });
        }, 'local'),
      ).objectsCreated;
    }, 'the objects made for the values before of two writes of the rows');
  });

  it('share their arrays between the listeners: more listeners make no more arrays', () => {
    const arrays = (listeners: number) => {
      const { store, before, rows } = newStore(
        1_000,
        Array.from({ length: listeners }, () => ({ previousValues: true })),
      );
      return workDuring(before, () => moveAll(store, rows)).objectsCreated;
    };
    // Each listener has a few objects of its own over the arrays (a map, values, their fields and
    // the geometry of each layer), the arrays are made once
    expect(arrays(3) - arrays(1)).toBe(2 * 4);
  });
});
