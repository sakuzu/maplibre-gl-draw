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
 * through, and the in-memory Store the tests of a replaced Store fill before the instance.
 */

import * as maplibregl from 'maplibre-gl';
import { createDraw } from '../index.js';
import { getAnchorProjector } from '../shared/math/index.js';
import { MemoryContractStore } from '../store/memory.js';
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

(window as unknown as { e2e: unknown }).e2e = {
  maplibregl,
  createDraw,
  prepareTable,
  terrain: { addTestTerrain, TEST_PEAK, testElevation },
  internals: {
    DemAtlas,
    MemoryContractStore,
    getAnchorProjector,
    getMapTerrain,
    getRenderableTerrainTiles,
    getTerrainTileData,
    TERRAIN_SAMPLE_GLSL,
  },
};
