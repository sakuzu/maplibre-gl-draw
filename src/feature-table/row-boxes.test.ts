// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The boxes of the rows whose boxes come from more than their points, in the index of the boxes
 * of every row of the tables
 *
 * - The row of an Image is found by the box of the image at its created zoom and at the tile size
 *   of the spatial index of the Store, not by its point; a new tile size finds it by its new box
 * - The row of a type with a calculation of its box (the type of an extension) is found by the box
 *   the calculation gives, and by its point again once the calculation is taken away
 * - A row of any other type is found by the box of its positions
 * - Tables given no boxes (`rowBoxes`) find every row by the box of its positions, an Image too
 */

import { describe, expect, it } from 'vitest';
import { drawPropertyKey } from '../shared/properties.js';
import { getBoundingBox } from '../shared/utils/feature-bbox.js';
import { StoreSpatialIndex } from '../store/spatial/store-spatial-index.js';
import type { Store } from '../store/store.js';
import { createTableStore } from '../store/table-memory.js';
import type { Feature } from '../store/types.js';
import { FEATURE_TABLE_COLUMNS } from '../table/tabane/columns.js';
import { featureRowDataBuilder as createPageDataBuilder } from '../test-utils.js';
import {
  createTables,
  type FeatureTablesInternals,
  featureTablesInternals,
} from './feature-tables.js';

const IMAGE: Feature = {
  id: 'image',
  type: 'Image',
  geometry: { type: 'Point', coordinates: [10, 20] },
  layerId: 'a',
  groupId: undefined,
  properties: {
    [drawPropertyKey('imageFileId')]: 'file',
    [drawPropertyKey('imageWidth')]: 200,
    [drawPropertyKey('imageHeight')]: 100,
    [drawPropertyKey('createdZoom')]: 10,
  },
  style: {},
  visible: true,
  locked: false,
};

const POINT: Feature = {
  ...IMAGE,
  id: 'point',
  type: 'Point',
  geometry: { type: 'Point', coordinates: [-10, -20] },
  properties: {},
};

function storeWith(features: readonly Feature[]): {
  store: Store;
  internals: FeatureTablesInternals;
} {
  const { store } = createTableStore();
  store.createLayer({
    id: 'a',
    name: 'a',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  store.createFeatures([...features]);
  const internals = featureTablesInternals(store.tables) as FeatureTablesInternals;
  internals.addQueuedPages();
  internals.flushVersions();
  return { store, internals };
}

/** The ids of the rows of the layer whose boxes meet a box */
function idsIn(
  store: Store,
  internals: FeatureTablesInternals,
  box: readonly [number, number, number, number],
): string[] {
  const table = internals.rowTable('a');
  if (!table) return [];
  const ids: string[] = [];
  internals.searchRowBoxes(table, box[0], box[1], box[2], box[3], (group, row) => {
    ids.push(store.tables?.getRowId(group.data.rows[row]) as string);
  });
  return ids.sort();
}

/** A box of a tenth of the size of a box, inside it at its north-east corner */
function cornerOf(box: readonly number[]): [number, number, number, number] {
  const w = (box[2] - box[0]) / 10;
  const h = (box[3] - box[1]) / 10;
  return [box[2] - w, box[3] - h, box[2] - w / 2, box[3] - h / 2];
}

describe('the boxes of the rows whose boxes come from more than their points', () => {
  it('finds the row of an Image by the box of the image, at the tile size of the index', () => {
    const { store, internals } = storeWith([IMAGE, POINT]);
    const at512 = getBoundingBox(IMAGE, 512);
    const at256 = getBoundingBox(IMAGE, 256);
    // A smaller tile is more degrees for a pixel: the box grows
    expect(at256[2]).toBeGreaterThan(at512[2]);
    expect(idsIn(store, internals, cornerOf(at512))).toEqual(['image']);
    expect(idsIn(store, internals, cornerOf(at256))).toEqual([]);
    const index = new StoreSpatialIndex(store);
    index.setTileSize(256);
    expect(idsIn(store, internals, cornerOf(at256))).toEqual(['image']);
    // The same tile size again changes nothing
    index.setTileSize(256);
    expect(idsIn(store, internals, cornerOf(at256))).toEqual(['image']);
    index.setTileSize(512);
    expect(idsIn(store, internals, cornerOf(at512))).toEqual(['image']);
    expect(idsIn(store, internals, cornerOf(at256))).toEqual([]);
    index.destroy();
  });

  it('finds the row of an Image written by its new box', () => {
    const { store, internals } = storeWith([IMAGE]);
    const wider: Feature = {
      ...IMAGE,
      properties: { ...IMAGE.properties, [drawPropertyKey('imageWidth')]: 400 },
    };
    store.updateFeature('image', { properties: wider.properties });
    expect(idsIn(store, internals, cornerOf(getBoundingBox(wider, 512)))).toEqual(['image']);
  });

  it('finds the rows of a type by the box its calculation gives, until it is taken away', () => {
    const { store, internals } = storeWith([IMAGE, POINT]);
    const around: [number, number, number, number] = [-10.9, -20.9, -10.5, -20.5];
    expect(idsIn(store, internals, around)).toEqual([]);
    expect(idsIn(store, internals, [-10, -20, -10, -20])).toEqual(['point']);
    const index = new StoreSpatialIndex(store);
    const tileSizes: number[] = [];
    const cancel = index.setCustomBoundingBoxCalculator('Point', (feature, tileSize) => {
      tileSizes.push(tileSize ?? -1);
      const [x, y] = (feature.geometry as { coordinates: number[] }).coordinates;
      return [x - 1, y - 1, x + 1, y + 1];
    });
    expect(idsIn(store, internals, around)).toEqual(['point']);
    expect(tileSizes[tileSizes.length - 1]).toBe(512);
    index.setTileSize(1024);
    expect(idsIn(store, internals, around)).toEqual(['point']);
    expect(tileSizes[tileSizes.length - 1]).toBe(1024);
    // The Image keeps the box of the image
    expect(idsIn(store, internals, cornerOf(getBoundingBox(IMAGE, 1024)))).toEqual(['image']);
    cancel();
    expect(idsIn(store, internals, around)).toEqual([]);
    expect(idsIn(store, internals, [-10, -20, -10, -20])).toEqual(['point']);
    index.destroy();
  });

  it('finds every row by the box of its points in tables given no boxes', () => {
    const { tables, writer } = createTables({ columns: FEATURE_TABLE_COLUMNS });
    const builder = createPageDataBuilder({ columns: FEATURE_TABLE_COLUMNS });
    builder.addRow({
      id: 'image',
      type: 'Image',
      geometry: IMAGE.geometry,
      key: 'a0',
      properties: IMAGE.properties,
    });
    writer.addPages('a', builder.finish());
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    internals.addQueuedPages();
    const store = { tables } as unknown as Store;
    expect(idsIn(store, internals, cornerOf(getBoundingBox(IMAGE, 512)))).toEqual([]);
    expect(idsIn(store, internals, [10, 20, 10, 20])).toEqual(['image']);
    // Nothing to read again
    internals.refreshBoxes();
    expect(idsIn(store, internals, [10, 20, 10, 20])).toEqual(['image']);
  });
});
