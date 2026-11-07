// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shape of a feature as it is seen: the value of the Store with the writes in the middle of an
 * edit, the sketches over it, moved where its row is drawn. The rows moved by their state are made
 * a shape by the computation the GPU draws them with, a feature held moved as a whole is written
 * where it is moved to and is not moved again.
 */

import { describe, expect, it } from 'vitest';
import type { FeatureTables } from '../api/tables.js';
import { BULK_MOVE_SET, HELD_MOVE_SET } from '../feature-table/row-state.js';
import { DrawStore } from '../store/draw-store.js';
import { TableContractStore } from '../store/table-memory.js';
import type { Feature } from '../store/types.js';
import { referenceRotate } from '../test-support/enu-reference.js';
import { internalsOf } from '../test-utils.js';
import { bulkRowMotionOf, RenderedShapes, rowMotionOf } from './rendered-shapes.js';

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

function rowsSetup() {
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
  });
  const tables = store.tables as FeatureTables;
  const handleOf = (id: string) => tables.findRow(id) as number;
  return { store, tables, handleOf, states: internalsOf(tables).states };
}

const position = (feature: Feature | undefined) =>
  (feature?.geometry as GeoJSON.Point | undefined)?.coordinates;

describe('the shape of a feature', () => {
  it('is the value of the Store while nothing is under way', () => {
    const { store } = rowsSetup();
    const shapes = new RenderedShapes(store);
    expect(position(shapes.get('a'))).toEqual([139, 35]);
    expect(shapes.get('none')).toBeUndefined();
    expect(shapes.draggedRows()).toBeNull();
  });

  it('is moved where its row is drawn, by the computation the GPU draws the row with', () => {
    const { store, states, handleOf } = rowsSetup();
    const shapes = new RenderedShapes(store);
    states.setMoving(Int32Array.of(handleOf('a')), BULK_MOVE_SET);
    states.setTranslation(BULK_MOVE_SET, 0.5, -0.25);
    expect(position(shapes.get('a'))).toEqual([139.5, 34.75]);
    // The rows that are not dragged, and the value of the Store, stay where they are
    expect(position(shapes.get('c'))).toEqual([139.2, 35]);
    expect(position(store.getFeature('a'))).toEqual([139, 35]);
  });

  it('reads the rows dragged once for each change of how they move', () => {
    const { store, states, handleOf } = rowsSetup();
    const shapes = new RenderedShapes(store);
    states.setMoving(Int32Array.of(handleOf('a')), BULK_MOVE_SET);
    states.setTranslation(BULK_MOVE_SET, 0.5, 0);
    const dragged = shapes.draggedRows();
    expect(shapes.draggedRows()).toBe(dragged);
    states.setTranslation(BULK_MOVE_SET, 1, 0);
    expect(shapes.draggedRows()).not.toBe(dragged);
    expect(position(shapes.get('a'))).toEqual([140, 35]);
    states.setMoving(Int32Array.of(handleOf('a')), 0);
    expect(shapes.draggedRows()).toBeNull();
    expect(position(shapes.get('a'))).toEqual([139, 35]);
  });

  it('holds the rotation and the radius the write of the drag gives', () => {
    const { store, states, handleOf } = rowsSetup();
    const shapes = new RenderedShapes(store);
    states.setMoving(Int32Array.of(handleOf('a'), handleOf('b')), BULK_MOVE_SET);
    states.setByValues(Int32Array.of(handleOf('a')), true);
    states.setTransform(BULK_MOVE_SET, { kind: 'rotate', center: [139.1, 35], angleDegrees: -15 });
    const turned = shapes.get('a');
    expect(turned?.properties['maplibre-gl-draw:rotation']).toBe(345);
    const [x, y] = referenceRotate([139, 35], [139.1, 35], -15);
    expect(position(turned)?.[0]).toBeCloseTo(x, 9);
    expect(position(turned)?.[1]).toBeCloseTo(y, 9);
    states.setTransform(BULK_MOVE_SET, {
      kind: 'scale',
      center: [139.1, 35],
      eastFactor: 2,
      northFactor: 2,
      sizeFactor: 2,
    });
    expect(shapes.get('b')?.properties['maplibre-gl-draw:radiusMeters']).toBe(20);
  });

  it('is not moved twice for a feature held moved as a whole, written where it is moved to', () => {
    const { store, states, tables, handleOf } = rowsSetup();
    const shapes = new RenderedShapes(store);
    internalsOf(tables).open('test', ['a']);
    states.setMoving(Int32Array.of(handleOf('a')), HELD_MOVE_SET);
    states.setTranslation(HELD_MOVE_SET, 1, 0);
    expect(position(shapes.get('a'))).toEqual([139, 35]);
  });

  it('is moved for a feature held that is dragged with the rows selected in bulk', () => {
    const { store, states, tables, handleOf } = rowsSetup();
    const shapes = new RenderedShapes(store);
    internalsOf(tables).open('test', ['a']);
    states.setMoving(Int32Array.of(handleOf('a')), BULK_MOVE_SET);
    states.setTranslation(BULK_MOVE_SET, 1, 0);
    expect(position(shapes.get('a'))).toEqual([140, 35]);
  });
});

describe('the motions of the rows', () => {
  it('are given as the GPU reads them, and the rows selected in bulk by their set', () => {
    const { states, tables, handleOf } = rowsSetup();
    const internals = internalsOf(tables);
    states.setMoving(Int32Array.of(handleOf('a')), BULK_MOVE_SET);
    states.setTranslation(BULK_MOVE_SET, 0.5, -0.25);
    expect(rowMotionOf(internals, BULK_MOVE_SET)).toEqual({
      translation: [0.5, -0.25],
      transform: null,
    });
    expect(bulkRowMotionOf(internals)).toEqual(rowMotionOf(internals, BULK_MOVE_SET));
  });
});
