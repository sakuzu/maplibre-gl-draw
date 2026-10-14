// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What follows rows dragged in bulk reads them by their state: whether a row is dragged, where a
 * position of it is drawn now (as the shader moves it, computed on the CPU), and its rotation
 * and scale; the rows of a selection of many features are read by their summary, and the
 * decision of such a selection is told to what builds their moving parts.
 */

import { describe, expect, it } from 'vitest';
import type { FeatureTables } from '../api/tables.js';
import { rotationTransform, transformPosition } from '../shared/math/plane-transform.js';
import { listSelectedRows } from '../store/bulk-selection.js';
import { DrawStore } from '../store/draw-store.js';
import { TableContractStore } from '../store/table-memory.js';
import type { Feature } from '../store/types.js';
import { internalsOf } from '../test-utils.js';
import { draggedRowsOf } from './dragged-rows.js';
import { BULK_MOVE_SET } from './row-state.js';
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

function setup() {
  const store = new DrawStore(new TableContractStore(), { holdLimit: 2 });
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
  return { store, tables, handleOf: (id: string) => tables.findRow(id) as number };
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
    const transform = rotationTransform([139.1, 35], 0.25);
    states.setTransform(BULK_MOVE_SET, transform);
    states.setTranslation(BULK_MOVE_SET, 0.5, -0.25);
    const dragged = draggedRowsOf(tables);
    expect(dragged?.has(handleOf('a'))).toBe(true);
    expect(dragged?.has(handleOf('c'))).toBe(false);
    const moved = transformPosition(transform, [139, 35, 7], false);
    expect(dragged?.position(handleOf('a'), [139, 35, 7])).toEqual([
      moved[0] + 0.5,
      moved[1] - 0.25,
      7,
    ]);
    expect(dragged?.position(handleOf('c'), [139.2, 35])).toEqual([139.2, 35]);
    expect(dragged?.rotation(handleOf('a'))).toBeCloseTo((0.25 * 180) / Math.PI, 12);
    expect(dragged?.rotation(handleOf('c'))).toBe(0);
    expect(dragged?.scale(handleOf('b'))).toBe(1);
  });

  it('of a selection of many features are read by its summary', () => {
    const { store, handleOf } = setup();
    store.setSelection('feature', ['a', 'b', 'c']);
    const bulk = store.getSelection().bulk;
    expect(Array.from(listSelectedRows(bulk as never))).toEqual(
      ['a', 'b', 'c'].map(handleOf).sort((x, y) => x - y),
    );
    expect(listSelectedRows({ count: 0, layerIds: [], bounds: null })).toEqual(new Int32Array(0));
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
