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
 * through, the in-memory Store the tests of a replaced Store fill before the instance, and the
 * builder of row groups the tests of the layers held as rows fill their tables with (and the
 * in-memory Store of rows).
 */

import * as maplibregl from 'maplibre-gl';
import { tableDiagnosticsOf } from '../api/impl/table-diagnostics.js';
import { createDraw, createFeatureTables, createTableMemoryStore } from '../index.js';
import { circleRowRings } from '../shared/circle-rings.js';
import { getAnchorProjector } from '../shared/math/index.js';
import { MemoryContractStore } from '../store/memory.js';
import { prepareTable } from '../table/index.js';
import { createRowGroupBuilder, type RowGroupBuilderOptions } from '../table/row-group-builder.js';
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
  tables: {
    createFeatureTables,
    // The rows of the pages are built as a Worker of a host builds them: with the rings of the
    // Circles
    createRowGroupBuilder: (options: RowGroupBuilderOptions = {}) =>
      createRowGroupBuilder({ rings: circleRowRings, ...options }),
    createTableMemoryStore,
  },
  terrain: { addTestTerrain, TEST_PEAK, testElevation },
  internals: {
    DemAtlas,
    MemoryContractStore,
    getAnchorProjector,
    getMapTerrain,
    getRenderableTerrainTiles,
    getTerrainTileData,
    TERRAIN_SAMPLE_GLSL,
    // The hooks of measurement of the drawing of the rows (not part of the API)
    tableDiagnosticsOf,
  },
};
