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
 * in-memory Store of rows), and the internal writes the scenes make their documents with.
 */

import * as maplibregl from 'maplibre-gl';
import { tableDiagnosticsOf } from '../api/impl/table-diagnostics.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { createDraw, readFeature } from '../index.js';
import { createFeatureTables } from '../kasane/index.js';
import { getAnchorProjector } from '../shared/math/index.js';
import { MemoryContractStore } from '../store/memory.js';
import { createTableStore } from '../store/table-memory.js';
import {
  createFeaturePageBuilder,
  type FeaturePageBuilderOptions,
} from '../table/feature-row-blocks.js';
import { prepareTable } from '../table/index.js';
import { PIE_TYPE, piePlugin } from '../test-support/quad-pie.js';
import { writesOf } from '../test-support/writes.js';
import { GpuLedger } from '../view/gpu-ledger.js';
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
  readFeature,
  // The internal writes, for the scenes that only make a document (synchronous, in the shape of
  // the Store), where an application writes with `draw.write`
  writesOf,
  prepareTable,
  tables: {
    createFeatureTables,
    createPageBuilder: (options: FeaturePageBuilderOptions = {}) =>
      createFeaturePageBuilder(options),
    createTableStore,
  },
  terrain: { addTestTerrain, TEST_PEAK, testElevation },
  // The pies of the prototype of the quads of the drawing of the rows
  quadPie: { piePlugin, PIE_TYPE },
  internals: {
    DemAtlas,
    GpuLedger,
    MemoryContractStore,
    getAnchorProjector,
    getMapTerrain,
    getRenderableTerrainTiles,
    getTerrainTileData,
    TERRAIN_SAMPLE_GLSL,
    // The hooks of measurement of the drawing of the rows, and the rows held as features (not
    // part of the API)
    tableDiagnosticsOf,
    featureTablesInternals,
  },
};
