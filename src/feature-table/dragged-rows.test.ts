// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What follows rows dragged in bulk reads them by their state: whether a row is dragged, where a
 * position of it is drawn now (as the edit of the drag moves it once written, as the reference
 * computes it apart), and its rotation and scale; the rows of a selection of many features are read by their summary, and the
 * decision of such a selection is told to what builds their moving parts.
 */

import { describe, expect, it } from 'vitest';
import type { FeatureTables } from '../api/tables.js';
import { listSelectedRows } from '../store/bulk-selection.js';
import { DrawStore } from '../store/draw-store.js';
import { selectionValueOf } from '../store/selection-value.js';
import { TableContractStore } from '../store/table-memory.js';
import type { Feature } from '../store/types.js';
import { referenceRotate, referenceScale } from '../test-support/enu-reference.js';
import { internalsOf } from '../test-utils.js';
import { draggedFeatureOf, draggedRowsOf } from './dragged-rows.js';
import { BULK_MOVE_SET } from './feature-row-states.js';
import type { TableSelection } from './selection.js';

function point(id: string, x: number, type: Feature['type'] = 'Point'): Feature {
  return {
    id,
    type,
    geometry: { type: 'Point', coordinates: [x, 35] },
    layerId: 'l',
    groupId: undefined,
    properties: type === 'Circle' ? { 'maplibre-gl-draw:radiusMeters': 10 } : {},
    style: {},
    visible: true,
    locked: false,
  };
}

/** A position near another, the numbers past the first two the same */
function expectNear(actual: readonly number[] | undefined, expected: readonly number[]): void {
  expect(actual?.length).toBe(expected.length);
  expect(Math.abs((actual?.[0] as number) - (expected[0] as number))).toBeLessThan(1e-9);
  expect(Math.abs((actual?.[1] as number) - (expected[1] as number))).toBeLessThan(1e-9);
  expect(actual?.slice(2)).toEqual(expected.slice(2));
}

function setup() {
  const store = new DrawStore(new TableContractStore(), { selectionIdsLimit: 2 });
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  store.transact(() => {
    store.createFeature(point('a', 139));
    store.createFeature(point('b', 139.1, 'Circle'));
    store.createFeature(point('c', 139.2));
    store.createFeature(point('d', 139.3));
  });
  const tables = store.tables as FeatureTables;
  return { store, tables, handleOf: (id: string) => tables.getRowRef(id) as number };
}

describe('the rows dragged', () => {
  it('are none while no row is drawn moved', () => {
    const { tables } = setup();
    expect(draggedRowsOf(tables)).toBeNull();
    expect(draggedRowsOf(undefined)).toBeNull();
  });

  it('tell whether a row is dragged and where its positions are drawn, its rotation and scale', () => {
    const { tables, handleOf } = setup();
    const states = internalsOf(tables).states;
    states.setMoving(Int32Array.of(handleOf('a'), handleOf('b')), BULK_MOVE_SET);
    // a turns by its rotation, as the write of the drag would turn it
    states.setByValues(Int32Array.of(handleOf('a')), true);
    states.setTransform(BULK_MOVE_SET, { kind: 'rotate', center: [139.1, 35], angleDegrees: 15 });
    states.setTranslation(BULK_MOVE_SET, 0.5, -0.25);
    const dragged = draggedRowsOf(tables);
    expect(dragged?.has(handleOf('a'))).toBe(true);
    expect(dragged?.has(handleOf('c'))).toBe(false);
    const moved = referenceRotate([139, 35], [139.1, 35], 15);
    expectNear(dragged?.position(handleOf('a'), [139, 35, 7]), [
      moved[0] + 0.5,
      moved[1] - 0.25,
      7,
    ]);
    expect(dragged?.position(handleOf('c'), [139.2, 35])).toEqual([139.2, 35]);
    expect(dragged?.rotation(handleOf('a'))).toBe(15);
    expect(dragged?.rotation(handleOf('b'))).toBe(0);
    expect(dragged?.rotation(handleOf('c'))).toBe(0);
    expect(dragged?.scale(handleOf('b'))).toBe(1);
  });

  it('give a feature turned by its values the rotation the write gives it, read as the write reads it', () => {
    const { tables, handleOf } = setup();
    const states = internalsOf(tables).states;
    states.setMoving(Int32Array.of(handleOf('a')), BULK_MOVE_SET);
    states.setByValues(Int32Array.of(handleOf('a')), true);
    states.setTransform(BULK_MOVE_SET, { kind: 'rotate', center: [139, 35], angleDegrees: 15 });
    const dragged = draggedRowsOf(tables);
    if (!dragged) throw new Error('no row dragged');
    const rotationOf = (value: unknown): unknown =>
      draggedFeatureOf(
        { ...point('a', 139), properties: { 'maplibre-gl-draw:rotation': value } },
        tables,
        dragged,
      ).properties['maplibre-gl-draw:rotation'];
    expect(rotationOf(350)).toBe(5);
    // A value that is no number is turned from 0; a number that is not finite is left
    expect(rotationOf('30')).toBe(15);
    expect(rotationOf(null)).toBe(15);
    expect(rotationOf(Number.NaN)).toBeNaN();
    expect(rotationOf(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('keep the shape of a Circle and of a row scaled by its values when they are resized, and give their factor', () => {
    const { store, tables, handleOf } = setup();
    store.transact(() => {
      store.createFeature({
        ...point('e', 139.4, 'Marker'),
        properties: { 'maplibre-gl-draw:scale': 2 },
      });
    });
    const states = internalsOf(tables).states;
    const rows = ['a', 'b', 'e'].map(handleOf);
    states.setMoving(Int32Array.from(rows), BULK_MOVE_SET);
    // e is resized by its scale, as the write of the drag would resize it
    states.setByValues(Int32Array.of(handleOf('e')), true);
    states.setTransform(BULK_MOVE_SET, {
      kind: 'scale',
      center: [139, 34.9],
      eastFactor: 2,
      northFactor: 0.5,
      sizeFactor: 2,
    });
    const dragged = draggedRowsOf(tables);
    expectNear(
      dragged?.position(handleOf('a'), [139, 35]),
      referenceScale([139, 35], [139, 34.9], 2, 0.5),
    );
    for (const id of ['b', 'e']) {
      expectNear(
        dragged?.position(handleOf(id), [139, 35]),
        referenceScale([139, 35], [139, 34.9], 2, 2),
      );
      expect(dragged?.scale(handleOf(id))).toBe(2);
    }
    expect(dragged?.scale(handleOf('a'))).toBe(1);
  });

  it('of a selection of many features are read by its value', () => {
    const { store, handleOf } = setup();
    store.setSelection('feature', ['a', 'b', 'c']);
    const value = selectionValueOf(store);
    expect(value.ids).toBeNull();
    expect(Array.from(listSelectedRows(value))).toEqual(
      ['a', 'b', 'c'].map(handleOf).sort((x, y) => x - y),
    );
    expect(
      listSelectedRows({ type: 'feature', count: 0, ids: [], layerIds: [], bbox: null }),
    ).toEqual(new Int32Array(0));
  });

  it('of a selection of many features are told once it is decided, and its end', () => {
    const { store, tables } = setup();
    const told: Array<TableSelection | null> = [];
    internalsOf(tables).onBulkSelected((rows) => told.push(rows));
    store.setSelection('feature', ['a', 'b', 'c']);
    store.setSelection('feature', ['a', 'b', 'c']);
    store.setSelection('feature', ['a']);
    expect(told.map((rows) => rows?.count ?? null)).toEqual([3, null]);
  });
});
