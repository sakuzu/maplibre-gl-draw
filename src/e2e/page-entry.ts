// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The script of the end-to-end test page
 *
 * It is bundled from the sources (not from dist) by the harness and loaded into headless
 * Chromium. maplibre-gl stays external and resolves to maplibre's own build through the import
 * map of the page, so the engine and the page share one maplibre.
 *
 * Besides the public entry point, the page carries the columnar subpath, the test terrain
 * (`dem-fixture.ts`) and the few internals the terrain tests read the GPU side of the engine
 * through.
 */

import * as maplibregl from 'maplibre-gl';
import { prepareDatasetColumnar } from '../dataset/columnar/index.js';
import { createMapLibreGLDraw } from '../index.js';
import { getAnchorProjector } from '../shared/math/index.js';
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
  createMapLibreGLDraw,
  prepareDatasetColumnar,
  terrain: { addTestTerrain, TEST_PEAK, testElevation },
  internals: {
    DemAtlas,
    getAnchorProjector,
    getMapTerrain,
    getRenderableTerrainTiles,
    getTerrainTileData,
    TERRAIN_SAMPLE_GLSL,
  },
};
