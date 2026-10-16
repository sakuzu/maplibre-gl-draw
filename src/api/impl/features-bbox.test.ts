// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The extent of the features that match a filter (`features.bbox`): the same over a Store of
 * objects and a Store of rows, through deletions and geometries written; over a Store of rows it
 * is read from the boxes of the rows, without making features
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawStore } from '../../store/draw-store.js';
import { createTableStore, TableContractStore } from '../../store/table-memory.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { FeatureFilter, FeatureInput } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

const instances: Draw[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const draw of instances.splice(0)) draw.destroy();
});

/** An instance over a Store of objects (the default one) or a Store of rows */
function instance(rows: boolean): Draw {
  const store = rows ? createTableStore().store : undefined;
  const engine = createEngine(
    createMapStub().map,
    { ...(store && { store }), initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { ...(store && { store }), initDefaultLayer: false });
  instances.push(draw);
  draw.layers.create({ id: 'a', name: 'a' });
  draw.layers.create({ id: 'b', name: 'b' });
  return draw;
}

/** Features of every kind of geometry over the two layers, some hidden or locked */
const FEATURES: FeatureInput[] = [
  { id: 'p', type: 'Point', layerId: 'a', geometry: { type: 'Point', coordinates: [1, 2] } },
  {
    id: 'l',
    type: 'LineString',
    layerId: 'a',
    geometry: {
      type: 'LineString',
      coordinates: [
        [-3, 4],
        [5, -6],
      ],
    },
    visible: false,
  },
  {
    id: 'g',
    type: 'Polygon',
    layerId: 'b',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [10, 10],
          [12, 10],
          [12, 13],
          [10, 13],
          [10, 10],
        ],
      ],
    },
    locked: true,
  },
  {
    id: 'c',
    type: 'Circle',
    layerId: 'b',
    geometry: { type: 'Point', coordinates: [20, 30] },
    properties: { 'maplibre-gl-draw:radiusMeters': 50000 },
  },
  {
    id: 'm',
    type: 'MultiPoint',
    layerId: 'a',
    geometry: {
      type: 'MultiPoint',
      coordinates: [
        [-8, 1],
        [0, 9],
      ],
    },
  },
];

/** Filters of every key */
const FILTERS: Array<FeatureFilter | undefined> = [
  undefined,
  { layerId: 'a' },
  { layerId: 'b' },
  { layerId: 'missing' },
  { groupId: 'grp' },
  { type: 'Circle' },
  { type: 'LineString' },
  { visible: false },
  { shown: true },
  { locked: true },
  { bbox: [0, 0, 15, 15] },
  { layerId: 'a', visible: true },
];

describe('the extent of features', () => {
  it('is the same over a Store of objects and a Store of rows', () => {
    const objects = instance(false);
    const rows = instance(true);
    for (const draw of [objects, rows]) {
      draw.features.createMany(FEATURES);
      draw.groups.create({ id: 'grp', featureIds: ['p', 'm'] });
    }
    const read = (draw: Draw) => FILTERS.map((filter) => draw.features.bbox(filter));
    expect(read(rows)).toEqual(read(objects));
    expect(objects.features.bbox({ layerId: 'a' })).toEqual([-8, -6, 5, 9]);
    expect(objects.features.bbox({ layerId: 'missing' })).toBeNull();
    // A feature at an edge deleted, and a geometry written smaller
    for (const draw of [objects, rows]) {
      draw.features.delete('m');
      draw.features.update('l', {
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      });
    }
    expect(read(rows)).toEqual(read(objects));
    expect(objects.features.bbox({ layerId: 'a' })).toEqual([0, 0, 1, 2]);
    for (const draw of [objects, rows]) draw.features.deleteMany(['p', 'l']);
    expect(rows.features.bbox({ layerId: 'a' })).toBeNull();
    expect(objects.features.bbox({ layerId: 'a' })).toBeNull();
  });

  it('reads a layer of 100,000 rows without making a feature', () => {
    const draw = instance(true);
    const n = 100_000;
    draw.features.createMany(
      Array.from({ length: n }, (_, i) => ({
        id: `r${i}`,
        type: 'Point' as const,
        layerId: 'a',
        geometry: {
          type: 'Point' as const,
          coordinates: [(i % 1000) * 0.01, Math.floor(i / 1000) * 0.01],
        },
      })),
    );
    const drawStore = vi.spyOn(DrawStore.prototype, 'getFeature');
    const contract = vi.spyOn(TableContractStore.prototype, 'getFeature');
    const box = draw.features.bbox({ layerId: 'a' });
    expect(box?.map((value) => Math.round(value * 100) / 100)).toEqual([0, 0, 9.99, 0.99]);
    expect(draw.features.bbox({ bbox: [1, 0.5, 2, 0.6] })).toEqual([1, 0.5, 2, 0.6]);
    expect(drawStore).not.toHaveBeenCalled();
    expect(contract).not.toHaveBeenCalled();
  });
});
