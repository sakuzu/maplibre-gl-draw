// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The boxes StoreSpatialIndex gives the Store for the types whose extent comes from more than
 * their positions: they are those the published version measured its features with
 * (`RBushSpatialIndex` over the same features, with the same tile size and the same
 * calculators), for the queries around them, and they stay so after the tile size changes and
 * after a calculator is registered and cancelled
 */

import { describe, expect, it } from 'vitest';
import { createDocumentAccess } from '../../api/impl/document-access.js';
import { createStore } from '../built-in/create-store.js';
import type { BoundingBox, Feature } from '../types.js';
import { RBushSpatialIndex } from './spatial-index.js';
import { StoreSpatialIndex } from './store-spatial-index.js';

function feature(
  id: string,
  type: string,
  coordinates: [number, number],
  properties: Record<string, unknown> = {},
): Feature {
  return {
    id,
    type: type as Feature['type'],
    geometry: { type: 'Point', coordinates },
    layerId: 'l',
    groupId: undefined,
    properties,
    locked: false,
    visible: true,
    style: {},
  };
}

/** The features: Images (one rotated, one scaled), Circles (one over a pole), a custom type, points */
const FEATURES: Feature[] = [
  feature('img', 'Image', [0, 0], {
    'maplibre-gl-draw:imageWidth': 800,
    'maplibre-gl-draw:imageHeight': 400,
    'maplibre-gl-draw:createdZoom': 9,
  }),
  feature('rot', 'Image', [3, 1], {
    'maplibre-gl-draw:imageWidth': 600,
    'maplibre-gl-draw:imageHeight': 600,
    'maplibre-gl-draw:createdZoom': 10,
    'maplibre-gl-draw:rotation': 30,
    'maplibre-gl-draw:scale': 1.5,
  }),
  feature('bare', 'Image', [-3, -1]),
  feature('cir', 'Circle', [-2, 2], { 'maplibre-gl-draw:radiusMeters': 80_000 }),
  feature('pole', 'Circle', [10, 89.5], { 'maplibre-gl-draw:radiusMeters': 100_000 }),
  feature('flat', 'Circle', [2, -2], { 'maplibre-gl-draw:radiusMeters': 0 }),
  feature('own', 'Own', [-1, -3]),
  feature('pt', 'Point', [1, 1]),
];

/** A calculator of the type `Own`: a box of two degrees around the point, read with the tile size */
const ownBox = (f: Feature, tileSize: number): BoundingBox => {
  const [x, y] = (f.geometry as GeoJSON.Point).coordinates;
  const reach = tileSize / 256;
  return { minX: x - reach, minY: y - reach, maxX: x + reach, maxY: y + reach };
};

/** The queries: a grid of boxes around the features */
function queries(): BoundingBox[] {
  const out: BoundingBox[] = [];
  for (let x = -5; x <= 12; x += 0.25) {
    for (let y = -5; y <= 90; y += y < 3 ? 0.25 : 5) {
      out.push({ minX: x, minY: y, maxX: x + 0.1, maxY: y + 0.1 });
    }
  }
  return out;
}

/** The index over a built-in Store holding the features, and the published one over them */
function indexes() {
  const store = createDocumentAccess(createStore());
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  });
  for (const f of FEATURES) store.createFeature(f);
  const index = new StoreSpatialIndex(store);
  const published = new RBushSpatialIndex();
  published.load(FEATURES);
  return { index, published };
}

/** Throws unless both find the same features for every query */
function expectSame(index: StoreSpatialIndex, published: RBushSpatialIndex): void {
  let found = 0;
  for (const query of queries()) {
    const ids = index.findInBounds(query).sort();
    expect(ids, JSON.stringify(query)).toEqual(published.findInBounds(query).sort());
    found += ids.length;
  }
  // The grid meets the features
  expect(found).toBeGreaterThan(0);
}

/** The published index measured again with what it is set with now */
function reload(published: RBushSpatialIndex): void {
  published.clear();
  published.load(FEATURES);
}

describe('the boxes of StoreSpatialIndex', () => {
  it('are those of the published version', () => {
    const { index, published } = indexes();
    expectSame(index, published);
  });

  it('are those of the published version after the tile size changes', () => {
    const { index, published } = indexes();
    index.setTileSize(256);
    published.setTileSize(256);
    reload(published);
    expectSame(index, published);
    index.setTileSize(1024);
    published.setTileSize(1024);
    reload(published);
    expectSame(index, published);
  });

  it('are those of the published version once a calculator is registered and cancelled', () => {
    const { index, published } = indexes();
    const cancel = index.setCustomBoundingBoxCalculator('Own', ownBox);
    const cancelPublished = published.setCustomBoundingBoxCalculator('Own', ownBox);
    reload(published);
    expectSame(index, published);

    // A calculator of a built-in type replaces its box
    const square = (f: Feature): BoundingBox => {
      const [x, y] = (f.geometry as GeoJSON.Point).coordinates;
      return { minX: x - 1, minY: y - 1, maxX: x + 1, maxY: y + 1 };
    };
    const cancelImage = index.setCustomBoundingBoxCalculator('Image', square);
    const cancelImagePublished = published.setCustomBoundingBoxCalculator('Image', square);
    reload(published);
    expectSame(index, published);

    // The tile size reaches the calculators
    index.setTileSize(1024);
    published.setTileSize(1024);
    reload(published);
    expectSame(index, published);

    cancel();
    cancelPublished();
    cancelImage();
    cancelImagePublished();
    reload(published);
    expectSame(index, published);
  });
});
