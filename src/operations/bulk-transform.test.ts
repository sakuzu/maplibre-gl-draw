// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Moving, rotating and resizing features selected in bulk write their rows with the values the
 * drags of the same features selected one by one write for the same edit (a property test over
 * random documents), keep the values of a position after `x` and `y`, and are put back to the bit
 * by the values before.
 */

import type { CoordinateDimensions, Value } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import type { FeatureTables } from '../api/tables.js';
import { drawProperties } from '../shared/properties.js';
import type { BoundingBoxCoords } from '../shared/types/selection-box.js';
import { DrawStore } from '../store/draw-store.js';
import type { TransformEdit } from '../store/store.js';
import { TableContractStore } from '../store/table-memory.js';
import type { Feature, FeatureType, RowValues, StoreChange } from '../store/types.js';
import { transformBulkSelection } from './bulk-transform.js';
import { rotateEditOf } from './rotate.js';
import { scaleEditOf, startScale } from './scale.js';
import { transformedUpdates, transformStartOf, transformsOf } from './transform-features.js';

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random features: points, lines, polygons, circles, images, some with a rotation or a scale */
function featuresOf(seed: number, count: number, z: boolean): Feature[] {
  const next = random(seed);
  let elevation = 0;
  const at = (x: number, y: number) => (z ? [x, y, ++elevation] : [x, y]);
  const out: Feature[] = [];
  for (let i = 0; i < count; i++) {
    const x = 139 + next() * 0.2;
    const y = 35 + next() * 0.2;
    const kind = Math.floor(next() * 5);
    const type = (['Point', 'LineString', 'Polygon', 'Circle', 'Image'] as const)[kind];
    const coordinates =
      type === 'LineString'
        ? [at(x, y), at(x + 0.01, y + 0.003)]
        : type === 'Polygon'
          ? [[at(x, y), at(x + 0.01, y), at(x + 0.01, y + 0.01), at(x, y)]]
          : at(x, y);
    const properties: Record<string, Value> = { n: i };
    if (type === 'Circle') Object.assign(properties, drawProperties({ radiusMeters: 50 + i }));
    if (type === 'Image' || next() < 0.2) {
      Object.assign(properties, drawProperties({ rotation: Math.round(next() * 90) }));
    }
    if (type === 'Image') Object.assign(properties, drawProperties({ scale: 1 + i / 10 }));
    out.push({
      id: `f${i}`,
      type: type as FeatureType,
      geometry: {
        type: type === 'Circle' || type === 'Image' ? 'Point' : type,
        coordinates,
      } as Feature['geometry'],
      layerId: 'l',
      groupId: undefined,
      properties,
      style: {},
      visible: true,
      locked: false,
    });
  }
  return out;
}

function storeOf(features: Feature[], selectionIdsLimit: number, dims?: CoordinateDimensions) {
  const store = new DrawStore(new TableContractStore(dims ? { dimensionsOf: () => dims } : {}), {
    selectionIdsLimit,
  });
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
    for (const feature of features) store.createFeature(feature);
  });
  const changes: StoreChange[] = [];
  store.subscribe((change) => changes.push(change));
  return { store, changes, tables: store.tables as FeatureTables };
}

/** The values of every row of the layer (geometry, attributes) */
function rowsOf(_store: DrawStore, tables: FeatureTables, ids: readonly string[]): unknown[] {
  return ids.map((id) => {
    const handle = tables.findRow(id) as number;
    const values = tables.readValues({
      handles: Int32Array.of(handle),
      fields: new Map([
        ['geometry', []],
        ['type', []],
        ['properties:n', []],
        ['properties:maplibre-gl-draw:rotation', []],
        ['properties:maplibre-gl-draw:scale', []],
        ['properties:maplibre-gl-draw:radiusMeters', []],
      ]),
    });
    return Object.fromEntries([...values.fields].map(([field, list]) => [field, list[0]]));
  });
}

/** The features one by one: written as the drags of features write an edit */
function writeOneByOne(store: DrawStore, ids: readonly string[], edit: TransformEdit): void {
  const transforms = transformsOf(store);
  store.transact(() => {
    for (const id of ids) {
      const feature = store.getFeature(id) as Feature;
      const updates = transformedUpdates(transforms, edit, transformStartOf(feature), feature);
      if (updates) store.updateFeature(id, updates);
    }
  });
}

const BBOX: BoundingBoxCoords = {
  topLeft: [139, 35.21],
  topRight: [139.21, 35.21],
  bottomRight: [139.21, 35],
  bottomLeft: [139, 35],
  center: [139.105, 35.105],
};

describe('moving, rotating and resizing features selected in bulk', () => {
  it('write the values the drags of the same features write', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const features = featuresOf(seed, 40, false);
      const ids = features.map((feature) => feature.id);
      for (const operation of ['move', 'rotate', 'resize-ne', 'resize-w'] as const) {
        const bulk = storeOf(features, 3);
        const single = storeOf(features, 100_000);
        bulk.store.setSelection('feature', ids);
        expect(bulk.store.getSelectedRows()?.count).toBe(40);
        let edit: TransformEdit;
        if (operation === 'move') {
          edit = { kind: 'translate', from: [139.1, 35.1], to: [139.1123456789, 35.09012345679] };
        } else if (operation === 'rotate') {
          edit = rotateEditOf(BBOX.center, { lng: 139.3, lat: 35.1 }, { lng: 139.2, lat: 35.3 });
        } else {
          const state = startScale(operation, { lng: 139.21, lat: 35.21 }, BBOX);
          edit = scaleEditOf(state, { lng: 139.25, lat: 35.18 });
        }
        expect(transformBulkSelection(bulk.store, edit)).toBe(true);
        writeOneByOne(single.store, ids, edit);
        expect(rowsOf(bulk.store, bulk.tables, ids)).toEqual(
          rowsOf(single.store, single.tables, ids),
        );
      }
    }
  });

  it('are put back to the bit by the values before, in one change', () => {
    const features = featuresOf(9, 30, false);
    const ids = features.map((feature) => feature.id);
    const bulk = storeOf(features, 3);
    bulk.store.setSelection('feature', ids);
    const before = rowsOf(bulk.store, bulk.tables, ids);
    const count = bulk.changes.length;
    transformBulkSelection(
      bulk.store,
      scaleEditOf(startScale('resize-se', { lng: 139.21, lat: 35 }, BBOX), {
        lng: 139.3,
        lat: 34.9,
      }),
    );
    expect(bulk.changes.length).toBe(count + 1);
    const previous = bulk.changes[bulk.changes.length - 1].previousValues as RowValues;
    expect(previous.handles.length).toBe(30);
    bulk.store.restoreRows(previous);
    expect(rowsOf(bulk.store, bulk.tables, ids)).toEqual(before);
  });

  it('keep the values of a position after x and y', () => {
    const features = featuresOf(11, 20, true);
    const ids = features.map((feature) => feature.id);
    const flat = featuresOf(11, 20, false);
    const bulk = storeOf(features, 3, 'xyz');
    const plain = storeOf(flat, 3);
    bulk.store.setSelection('feature', ids);
    plain.store.setSelection('feature', ids);
    /** Every position of every row, flattened */
    const positions = (tables: FeatureTables): number[][] => {
      const out: number[][] = [];
      const walk = (value: unknown): void => {
        if (!Array.isArray(value)) return;
        if (typeof value[0] === 'number') out.push(value as number[]);
        else for (const child of value) walk(child);
      };
      for (const row of rowsOf(bulk.store, tables, ids)) {
        walk((row as { geometry: { coordinates: unknown } }).geometry.coordinates);
      }
      return out;
    };
    const zs = (_store: DrawStore, tables: FeatureTables) => positions(tables).map((p) => p[2]);
    const xys = (_store: DrawStore, tables: FeatureTables) =>
      positions(tables).map((p) => [p[0], p[1]]);
    const zBefore = zs(bulk.store, bulk.tables);
    for (const store of [bulk.store, plain.store]) {
      transformBulkSelection(store, { kind: 'rotate', center: BBOX.center, angleDegrees: 17 });
      transformBulkSelection(
        store,
        scaleEditOf(startScale('resize-n', { lng: 139.1, lat: 35.21 }, BBOX), {
          lng: 139.1,
          lat: 35.3,
        }),
      );
      transformBulkSelection(store, { kind: 'translate', from: [139, 35], to: [139.1, 35.2] });
    }
    expect(zs(bulk.store, bulk.tables)).toEqual(zBefore);
    expect(xys(bulk.store, bulk.tables)).toEqual(xys(plain.store, plain.tables));
  });

  it('leave a locked feature as it is and write the others', () => {
    const features = featuresOf(12, 10, false);
    features[3].locked = true;
    const bulk = storeOf(features, 3);
    const ids = features.map((feature) => feature.id);
    bulk.store.setSelection('feature', ids);
    const geometries = (): string[] =>
      rowsOf(bulk.store, bulk.tables, ids).map((row) =>
        JSON.stringify((row as { geometry: unknown }).geometry),
      );
    const before = geometries();
    expect(
      transformBulkSelection(bulk.store, { kind: 'translate', from: [139, 35], to: [140, 36] }),
    ).toBe(true);
    const after = geometries();
    features.forEach((_, i) => {
      if (i === 3) expect(after[i]).toEqual(before[i]);
      else expect(after[i]).not.toEqual(before[i]);
    });
  });

  it('write nothing when every feature selected is locked', () => {
    const features = featuresOf(12, 10, false);
    for (const feature of features) feature.locked = true;
    const bulk = storeOf(features, 3);
    bulk.store.setSelection(
      'feature',
      features.map((feature) => feature.id),
    );
    expect(
      transformBulkSelection(bulk.store, { kind: 'translate', from: [139, 35], to: [140, 36] }),
    ).toBe(false);
    expect(
      transformBulkSelection(bulk.store, { kind: 'rotate', center: BBOX.center, angleDegrees: 1 }),
    ).toBe(false);
  });
});
