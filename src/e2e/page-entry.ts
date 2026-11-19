// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The script of the end-to-end test page
 *
 * It is bundled from the sources (not from dist) by the harness and loaded into headless
 * Chromium. maplibre-gl stays external and resolves to maplibre's own build through the import
 * map of the page, so the engine and the page share one maplibre.
 *
 * Besides the public entry point, the page carries the table subpath, the test terrain
 * (`dem-fixture.ts`), the few internals the terrain tests read the GPU side of the engine
 * through, and the built-in Store the tests of a replaced Store fill with rows before the
 * instance.
 */

import * as maplibregl from 'maplibre-gl';
import { geometryColumnOf, newRowFields } from '../api/impl/feature-rows.js';
import type { Feature } from '../api/model.js';
import { createDraw } from '../index.js';
import { getAnchorProjector } from '../shared/math/index.js';
import { createOrderKeyBetween, createStore, type Store } from '../store/index.js';
import { prepareTable } from '../table/index.js';
import { DemAtlas } from '../view/terrain/dem-atlas.js';
import {
  getMapTerrain,
  getRenderableTerrainTiles,
  getTerrainTileData,
} from '../view/terrain/detect.js';
import { TERRAIN_SAMPLE_GLSL } from '../view/terrain/drape/shared.js';
import { addTestTerrain, installTestDem, TEST_PEAK, testElevation } from './dem-fixture.js';

installTestDem(maplibregl);

/** Writes features of one layer to a Store as rows, one after another at the front of it */
function writeFeatureRows(store: Store, features: readonly Feature[]): boolean {
  let key: string | undefined;
  const places = features.map((feature) => {
    key = createOrderKeyBetween(key, undefined);
    return { parent: feature.groupId ?? feature.layerId, orderKey: key };
  });
  return store.createRows({
    ids: features.map((feature) => feature.id),
    fields: newRowFields(features, places),
    geometry: geometryColumnOf(
      features.map((feature) => feature.geometry),
      2,
    ),
  });
}

(window as unknown as { e2e: unknown }).e2e = {
  maplibregl,
  createDraw,
  prepareTable,
  terrain: { addTestTerrain, TEST_PEAK, testElevation },
  internals: {
    DemAtlas,
    createStore,
    writeFeatureRows,
    getAnchorProjector,
    getMapTerrain,
    getRenderableTerrainTiles,
    getTerrainTileData,
    TERRAIN_SAMPLE_GLSL,
  },
};
