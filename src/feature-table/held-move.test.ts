// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Many rows held moved as a whole in the middle of an edit: from
 * `moveOpenedByStateFrom` rows held, a row held moved as a whole is drawn moved by its state and
 * the translation of its moving set, its row is not written until the edit ends, and its feature
 * takes every value written. Fewer rows, or another change than a move, write the row as before.
 */

import type { Geometry, Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureTables, RowField } from '../api/tables.js';
import { RELEASE_DELAY_MS } from '../store/draw-store.js';
import type { Store } from '../store/store.js';
import { createTableStore } from '../store/table-memory.js';
import type { Feature, StoreChange } from '../store/types.js';
import { internalsOf } from '../test-utils.js';
import { draggedRowsOf } from './dragged-rows.js';
import { featureTablesInternals } from './feature-tables.js';
import { translationBetween } from './held-move.js';
import {
  GPU_STATE_MOVE_SHIFT,
  STATE_MOVE_MASK,
  STATE_MOVE_SHIFT,
  toGpuState,
} from './row-state.js';

function squareAt(x: number, y: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [x, y],
        [x + 1, y],
        [x + 1, y + 1],
        [x, y + 1],
        [x, y],
      ],
    ],
  };
}

function square(id: string, x: number): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: squareAt(x, 0),
    layerId: 'rows',
    groupId: undefined,
    properties: { name: id },
    style: {},
    visible: true,
    locked: false,
  };
}

/** A geometry moved by a translation, as a move of the selection writes it */
function moved(geometry: Geometry, dx: number, dy: number): Geometry {
  const walk = (value: unknown): unknown =>
    Array.isArray(value) && typeof value[0] === 'number'
      ? [value[0] + dx, value[1] + dy, ...value.slice(2)]
      : Array.isArray(value)
        ? value.map(walk)
        : value;
  return { ...geometry, coordinates: walk((geometry as Polygon).coordinates) } as Geometry;
}

describe('translationBetween', () => {
  it('finds the translation of a geometry moved as a whole', () => {
    const a = squareAt(139.7, 35.6);
    expect(translationBetween(a, moved(a, 0.0001, -0.0002))).toEqual([
      expect.closeTo(0.0001, 12),
      expect.closeTo(-0.0002, 12),
    ]);
    expect(translationBetween(a, a)).toEqual([0, 0]);
    const multi: Geometry = {
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0, 5],
          [1, 1, 6],
        ],
        [[2, 2, 7]],
      ],
    };
    expect(translationBetween(multi, moved(multi, 3, 4))).toEqual([3, 4]);
    const collection: Geometry = {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [0, 0] },
        {
          type: 'LineString',
          coordinates: [
            [1, 1],
            [2, 2],
          ],
        },
      ],
    };
    const movedCollection: Geometry = {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [1, 2] },
        {
          type: 'LineString',
          coordinates: [
            [2, 3],
            [3, 4],
          ],
        },
      ],
    };
    expect(translationBetween(collection, movedCollection)).toEqual([1, 2]);
  });

  it('finds none for another shape, a position moved apart, another elevation or no position', () => {
    const a = squareAt(0, 0);
    const corner = structuredClone(a);
    corner.coordinates[0][2] = [1.5, 1];
    expect(translationBetween(a, corner)).toBeNull();
    expect(translationBetween(a, { type: 'LineString', coordinates: a.coordinates[0] })).toBeNull();
    const fewer = structuredClone(a);
    fewer.coordinates[0].pop();
    expect(translationBetween(a, fewer)).toBeNull();
    expect(
      translationBetween(
        { type: 'Point', coordinates: [0, 0, 1] },
        { type: 'Point', coordinates: [1, 1, 2] },
      ),
    ).toBeNull();
    expect(
      translationBetween(
        { type: 'MultiPoint', coordinates: [] },
        {
          type: 'MultiPoint',
          coordinates: [],
        },
      ),
    ).toBeNull();
    expect(translationBetween(null, a)).toBeNull();
  });
});

/** A Store of rows with five squares, moved by its state from `from` rows held */
function setup(from: number) {
  const { store, writer } = createTableStore({ moveOpenedByStateFrom: from });
  store.createLayer({
    id: 'rows',
    name: 'rows',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  for (let i = 0; i < 5; i++) store.createFeature(square(`s${i}`, i * 2));
  const tables = store.tables as FeatureTables;
  const notified: StoreChange[] = [];
  store.subscribe((change) => notified.push(change));
  return { store, writer, tables, notified };
}

/** The geometry a row holds */
function rowGeometry(tables: FeatureTables, id: string): Geometry | null | undefined {
  return tables.get('rows')?.getRow(tables.findRow(id) ?? -1)?.geometry;
}

/** The moving set of a row (0 for none), in the sets of handles and in the copy of its group */
function movingSet(tables: FeatureTables, id: string): [number, number] {
  const internals = featureTablesInternals(tables);
  const handle = tables.findRow(id) ?? -1;
  const place = internals?.placeOf(handle);
  const copy = place ? place.group.state[place.row] : 0;
  return [
    ((internals?.states.stateOf(handle) ?? 0) & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT,
    (toGpuState(copy) >> GPU_STATE_MOVE_SHIFT) & 3,
  ];
}

/** Moves the features as a drag of the selection does, in the middle of the drag */
function drag(store: Store, ids: readonly string[], dx: number, dy: number): void {
  store.transact(() => {
    for (const id of ids) {
      store.updateFeature(
        id,
        { geometry: moved(squareAt(Number(id.slice(1)) * 2, 0), dx, dy) },
        {
          isIntermediate: true,
        },
      );
    }
  });
}

describe('many rows held moved as a whole', () => {
  const ids = ['s0', 's1', 's2', 's3'];
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('draws the rows moved by their state, and writes them once the move ends', () => {
    const { store, tables, notified } = setup(3);
    store.setSelection('feature', ids);
    drag(store, ids, 0.5, 0.25);
    drag(store, ids, 1, 0.5);
    for (const id of ids) {
      expect(rowGeometry(tables, id)).toEqual(squareAt(Number(id.slice(1)) * 2, 0));
      expect(internalsOf(tables).getOpenedFeature(id)?.geometry).toEqual(
        moved(rowGeometry(tables, id) as Geometry, 1, 0.5),
      );
      expect(movingSet(tables, id)).toEqual([1, 1]);
    }
    expect(movingSet(tables, 's4')).toEqual([0, 0]);
    expect(featureTablesInternals(tables)?.states.translation(1)).toEqual([1, 0.5]);
    // The features are notified in the middle of the edit as before
    const last = notified[notified.length - 1];
    expect(last.features?.updated?.map((u) => [u.id, u.isIntermediate])).toEqual(
      ids.map((id) => [id, true]),
    );
    expect(last.rows).toBeUndefined();
    // The end of the move writes the rows, and takes them out of the moving set
    store.transact(() => {
      for (const id of ids) {
        store.updateFeature(id, { geometry: moved(squareAt(Number(id.slice(1)) * 2, 0), 1, 0.5) });
      }
    });
    for (const id of ids) {
      expect(rowGeometry(tables, id)).toEqual(moved(squareAt(Number(id.slice(1)) * 2, 0), 1, 0.5));
      expect(movingSet(tables, id)).toEqual([0, 0]);
    }
    // Nothing is dragged any more: the moving set is let go of with its last row
    expect(featureTablesInternals(tables)?.states.translation(1)).toEqual([0, 0]);
    expect(draggedRowsOf(tables)).toBeNull();
    store.setSelection(null, []);
    expect(rowGeometry(tables, 's0')).toEqual(moved(squareAt(0, 0), 1, 0.5));
  });

  it('puts the rows back where they were when the move does not end', () => {
    const { store, tables } = setup(3);
    store.setSelection('feature', ids);
    drag(store, ids, 1, 1);
    store.abortIntermediateUpdates?.(ids);
    for (const id of ids) {
      const start = squareAt(Number(id.slice(1)) * 2, 0);
      expect(rowGeometry(tables, id)).toEqual(start);
      expect(internalsOf(tables).getOpenedFeature(id)?.geometry).toEqual(start);
      expect(movingSet(tables, id)).toEqual([0, 0]);
    }
    expect(draggedRowsOf(tables)).toBeNull();
    // Let go of in the middle of a move: the rows hold the values before it
    drag(store, ids, 2, 2);
    store.setSelection(null, []);
    vi.advanceTimersByTime(RELEASE_DELAY_MS * 2);
    expect(internalsOf(tables).getOpenedFeature('s0')).toBeUndefined();
    for (const id of ids) {
      expect(rowGeometry(tables, id)).toEqual(squareAt(Number(id.slice(1)) * 2, 0));
      expect(movingSet(tables, id)).toEqual([0, 0]);
    }
    expect(draggedRowsOf(tables)).toBeNull();
  });

  it('writes the rows in the middle of the move when fewer rows are held', () => {
    const { store, tables } = setup(5);
    store.setSelection('feature', ids);
    drag(store, ids, 1, 0.5);
    for (const id of ids) {
      expect(rowGeometry(tables, id)).toEqual(moved(squareAt(Number(id.slice(1)) * 2, 0), 1, 0.5));
      expect(movingSet(tables, id)).toEqual([0, 0]);
    }
  });

  it('writes a row whose change is not a move as a whole, and one moved before from its state', () => {
    const { store, tables } = setup(3);
    store.setSelection('feature', ids);
    drag(store, ids, 1, 0.5);
    // A corner of s0 dragged after its move: the row is written with the shape, out of the set
    const shape = structuredClone(moved(squareAt(0, 0), 1, 0.5)) as Polygon;
    shape.coordinates[0][2] = [5, 5];
    store.updateFeature('s0', { geometry: shape }, { isIntermediate: true });
    expect(rowGeometry(tables, 's0')).toEqual(shape);
    expect(movingSet(tables, 's0')).toEqual([0, 0]);
    expect(movingSet(tables, 's1')).toEqual([1, 1]);
    // A write of another field than the geometry is written to the row
    store.updateFeature('s1', { properties: { name: 'x' } }, { isIntermediate: true });
    expect(tables.get('rows')?.getRowValue(tables.findRow('s1') ?? -1, 'name')).toBe('x');
    expect(movingSet(tables, 's1')).toEqual([0, 0]);
    expect(rowGeometry(tables, 's1')).toEqual(moved(squareAt(2, 0), 1, 0.5));
  });

  it('keeps the geometry of a feature moved when another writes its row', () => {
    const { store, writer, tables } = setup(3);
    store.setSelection('feature', ids);
    drag(store, ids, 1, 0.5);
    const handle = tables.findRow('s2') as number;
    store.transact(() => {
      writer.apply({
        handles: Int32Array.of(handle),
        fields: new Map<RowField, unknown[]>([
          ['property:name', ['other']],
          ['geometry', [squareAt(40, 40)]],
        ]),
      });
    }, 'remote');
    // The name is written; the geometry the move writes is kept apart until it ends
    expect(internalsOf(tables).getOpenedFeature('s2')?.properties.name).toBe('other');
    expect(internalsOf(tables).getOpenedFeature('s2')?.geometry).toEqual(
      moved(squareAt(4, 0), 1, 0.5),
    );
    expect(rowGeometry(tables, 's2')).toEqual(squareAt(4, 0));
    expect(movingSet(tables, 's2')).toEqual([1, 1]);
    // Let go of without an end, the row takes the geometry the other wrote
    store.abortIntermediateUpdates?.(['s2']);
    expect(rowGeometry(tables, 's2')).toEqual(squareAt(40, 40));
    expect(movingSet(tables, 's2')).toEqual([0, 0]);
  });

  it('takes a row deleted in the middle of a move out of the moving set', () => {
    const { store, tables } = setup(3);
    store.setSelection('feature', ids);
    drag(store, ids, 1, 0.5);
    const handle = tables.findRow('s3') as number;
    store.deleteFeature('s3');
    expect(featureTablesInternals(tables)?.states.stateOf(handle)).toBe(0);
  });
});
