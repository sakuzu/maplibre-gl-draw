// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DrapePlanner: the reason of every frame and the hand-over to the datasets
 *
 * The GL side (the drape renderer), the tile index and the terrain of maplibre are replaced by
 * fakes whose answers each test sets, so that every branch of the planning can be reached
 * without WebGL.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../store/store.js';
import type { RetainedStyleResolver } from '../renderers/retained.js';
import { TerrainContext } from '../terrain/context.js';
import type { RenderableTerrainTile } from '../terrain/detect.js';
import { getTerrainDrapeDebug } from '../terrain/state.js';
import {
  DRAPE_STABLE_FRAMES,
  DRAPE_STALE_PLAN_MAX_FRAMES,
  DRAPE_WIDE_EDGE_BUDGET,
  DrapePlanner,
  type DrapePlannerDatasets,
  type MapTerrain,
  TERRAIN_ANALYTIC_MIN_ZOOM,
} from './drape-planner.js';

/** The answers of the fakes (reset before every test) */
const fake = {
  tiles: [] as RenderableTerrainTile[],
  /** Tiles that have a DEM */
  withDem: new Set<unknown>(),
  /** Tiles whose index is built */
  indexed: new Set<unknown>(),
  elements: 1,
  edgeCount: 10,
  canDrape: true,
  overflow: false,
  packId: 1 as number | null,
  upload: true,
  drapedDatasets: new Set<string>(['c1']),
  /** Number of calls of collectDrapeElements */
  collects: 0,
  /** Whether the index leaves tiles for the next frames */
  pending: false,
  /** The budgets the index was prepared with */
  budgets: [] as number[],
};

vi.mock('../terrain/detect.js', () => ({
  getRenderableTerrainTiles: () => fake.tiles,
  getTerrainMeshSize: () => 64,
  getTerrainTileData: (_terrain: unknown, tile: RenderableTerrainTile) =>
    fake.withDem.has(tile.tileID) ? { texture: {}, dim: 512, exaggeration: 1 } : null,
}));

vi.mock('../terrain/drape/pass.js', () => ({
  drapeLayerSource: (layerIndex: number, datasetCount: number) => {
    const source = datasetCount + 1 + layerIndex;
    return source < 8 ? source : 0;
  },
  collectDrapeElements: () => {
    fake.collects++;
    return {
      layerSources: new Map([['layer-1', 1]]),
      elements: Array.from({ length: fake.elements }, () => ({})),
      excluded: new Set<string>(['point-1']),
      quadBreaks: [],
      entryStarts: new Map<string, number>(),
      aboveStoreStart: fake.elements,
      edgeCount: fake.edgeCount,
      vertexCount: fake.edgeCount,
      drapedDatasets: fake.drapedDatasets,
    };
  },
  canDrape: () => fake.canDrape,
}));

vi.mock('../terrain/drape/bin-store.js', () => ({
  DrapeTileStore: class {
    sync(): void {}
    setSelection(): void {}
    clear(): void {}
    prepare(_tiles: unknown, budget: number) {
      fake.budgets.push(budget);
      return {
        pending: fake.pending,
        overflow: fake.overflow,
        maxTileEdges: 0,
        truncatedCells: 0,
        unfitTiles: 0,
        maxEdgesPerCell: 0,
        maxRunsPerCell: 0,
      };
    }
    entryOf(tile: RenderableTerrainTile) {
      return fake.indexed.has(tile.x) ? { cellOffset: 0, grid: 4 } : undefined;
    }
    get pack() {
      return fake.packId === null ? null : { id: fake.packId, markedCount: 0 };
    }
    get quadBreaks() {
      return [];
    }
    get elementCount() {
      return fake.elements;
    }
  },
}));

vi.mock('../terrain/drape/renderer.js', () => ({
  DRAPE_MAX_SOURCES: 8,
  DrapeRenderer: class {
    lastError = '';
    upload(): boolean {
      return fake.upload;
    }
    ensure(): boolean {
      return true;
    }
    dispose(): void {}
  },
}));

function tile(x: number): RenderableTerrainTile {
  return { x, y: 0, z: 12, tileID: `t${x}` };
}

function createPlanner(options: { timeSlicing?: boolean } = {}) {
  const terrain = new TerrainContext();
  const layer = { id: 'layer-1', opacity: 1 };
  const setDrapedDatasets = vi.fn();
  const datasets: DrapePlannerDatasets = {
    listInternal: () => [],
    setDrapedDatasets,
  };
  const map = { triggerRepaint: vi.fn() };
  const planner = new DrapePlanner({
    map: map as unknown as MapLibreMap,
    timeSlicing: options.timeSlicing,
    store: {
      getLayerOrder: () => ['layer-1'],
      getLayer: (id: string) => (id === 'layer-1' ? layer : undefined),
    } as unknown as Store,
    terrain,
    datasets: datasets,
  });
  const frame = (options: { terrain?: boolean; rawZoom?: number } = {}) =>
    planner.planFrame({
      gl: {} as WebGL2RenderingContext,
      resolveStyles: () => ({}) as RetainedStyleResolver,
      mapTerrain: (options.terrain === false ? null : {}) as MapTerrain,
      dpr: 1,
      zoom: options.rawZoom ?? 14,
      rawZoom: options.rawZoom ?? 14,
    });
  const reason = () => getTerrainDrapeDebug(terrain).reason;
  return { planner, terrain, frame, reason, setDrapedDatasets, layer, map };
}

beforeEach(() => {
  fake.tiles = [tile(1), tile(2)];
  fake.withDem = new Set(['t1', 't2']);
  fake.indexed = new Set([1, 2]);
  fake.elements = 1;
  fake.edgeCount = 10;
  fake.canDrape = true;
  fake.overflow = false;
  fake.packId = 1;
  fake.upload = true;
  fake.collects = 0;
  fake.pending = false;
  fake.budgets = [];
});

describe('DrapePlanner pending work', () => {
  it('is pending, and asks for frames, while the hand-over settles', () => {
    const { planner, frame, map } = createPlanner();
    frame();
    expect(planner.hasPendingWork).toBe(true);
    expect(map.triggerRepaint).toHaveBeenCalled();
    for (let i = 1; i < DRAPE_STABLE_FRAMES; i++) frame();
    expect(planner.hasPendingWork).toBe(false);
  });

  it('is pending while the index leaves tiles for the next frames', () => {
    const { planner, frame } = createPlanner();
    for (let i = 0; i < DRAPE_STABLE_FRAMES; i++) frame();
    expect(planner.hasPendingWork).toBe(false);
    fake.pending = true;
    frame();
    expect(planner.hasPendingWork).toBe(true);
  });

  it('builds the whole index in the frame without time slicing', () => {
    createPlanner({ timeSlicing: false }).frame();
    createPlanner().frame();
    expect(fake.budgets[0]).toBe(Number.POSITIVE_INFINITY);
    expect(fake.budgets[1]).toBeLessThan(Number.POSITIVE_INFINITY);
  });
});

describe('DrapePlanner reasons', () => {
  it('reports terrain-off without terrain and does not use the drape', () => {
    const { frame, reason } = createPlanner();
    expect(frame({ terrain: false })).toBe(false);
    expect(reason()).toBe('terrain-off');
  });

  it('plans with the tiles of the frame when everything is ready (ok)', () => {
    const { planner, terrain, frame, reason } = createPlanner();
    expect(frame()).toBe(true);
    expect(reason()).toBe('ok');
    expect(getTerrainDrapeDebug(terrain).tileCount).toBe(2);
    // The features that do not go on the drape come from the plan
    expect(planner.excluded.has('point-1')).toBe(true);
  });

  it('reports wide-zoom outside the band when the elements are heavy', () => {
    fake.edgeCount = DRAPE_WIDE_EDGE_BUDGET + 1;
    const { frame, reason } = createPlanner();
    expect(frame({ rawZoom: TERRAIN_ANALYTIC_MIN_ZOOM - 1 })).toBe(false);
    expect(reason()).toBe('wide-zoom');
  });

  it('uses the drape outside the band when the elements are light', () => {
    const { frame, reason } = createPlanner();
    expect(frame({ rawZoom: TERRAIN_ANALYTIC_MIN_ZOOM - 1 })).toBe(true);
    expect(reason()).toBe('ok');
  });

  it('reports no-drapeable-features and vertex-budget', () => {
    fake.elements = 0;
    const empty = createPlanner();
    expect(empty.frame()).toBe(false);
    expect(empty.reason()).toBe('no-drapeable-features');

    fake.elements = 1;
    fake.canDrape = false;
    const heavy = createPlanner();
    expect(heavy.frame()).toBe(false);
    expect(heavy.reason()).toBe('vertex-budget');
  });

  it('reports cell-overflow and texture-limit', () => {
    fake.overflow = true;
    const overflow = createPlanner();
    expect(overflow.frame()).toBe(false);
    expect(overflow.reason()).toBe('cell-overflow');

    fake.overflow = false;
    fake.upload = false;
    const limit = createPlanner();
    expect(limit.frame()).toBe(false);
    expect(limit.reason()).toBe('texture-limit');
  });

  it('reports no-dem-tiles without a previous plan, and keeps a usable plan (stale-plan)', () => {
    fake.withDem = new Set();
    const fresh = createPlanner();
    expect(fresh.frame()).toBe(false);
    expect(fresh.reason()).toBe('no-dem-tiles');

    fake.withDem = new Set(['t1', 't2']);
    const kept = createPlanner();
    expect(kept.frame()).toBe(true);
    fake.withDem = new Set();
    expect(kept.frame()).toBe(true);
    expect(kept.reason()).toBe('stale-plan');
  });

  it('keeps the previous plan while the index is incomplete, for a limited number of frames', () => {
    const { frame, reason } = createPlanner();
    expect(frame()).toBe(true);
    expect(reason()).toBe('ok');
    // Only one of the two tiles is indexed now: the previous plan covers more of the view
    fake.indexed = new Set([1]);
    for (let i = 0; i < DRAPE_STALE_PLAN_MAX_FRAMES; i++) {
      expect(frame()).toBe(true);
      expect(reason()).toBe('stale-plan');
    }
    // Beyond the limit it is redrawn with what could be built
    expect(frame()).toBe(true);
    expect(reason()).toBe('ok');
  });

  it('does not keep the previous plan once the pack was swapped', () => {
    const { frame, reason } = createPlanner();
    expect(frame()).toBe(true);
    fake.indexed = new Set([1]);
    fake.packId = 2;
    expect(frame()).toBe(true);
    expect(reason()).toBe('ok');
  });

  it('drops the plan with the GPU side (the next frame plans again)', () => {
    const { planner, frame, reason } = createPlanner();
    expect(frame()).toBe(true);
    planner.releaseGpu();
    expect(planner.renderer).toBeNull();
    expect(planner.excluded.size).toBe(0);
    fake.withDem = new Set();
    expect(frame()).toBe(false);
    expect(reason()).toBe('no-dem-tiles');
  });
});

describe('DrapePlanner hand-over', () => {
  it('hands over only after the drape stayed usable, and keeps it through a missing DEM', () => {
    const { planner, frame, reason, setDrapedDatasets } = createPlanner();
    for (let i = 1; i < DRAPE_STABLE_FRAMES; i++) {
      frame();
      expect(setDrapedDatasets).toHaveBeenLastCalledWith(null);
    }
    frame();
    expect(setDrapedDatasets).toHaveBeenLastCalledWith(fake.drapedDatasets);

    // A transient failure (no DEM, and no previous plan to keep after the GPU side went away)
    // keeps the hand-over
    planner.releaseGpu();
    fake.withDem = new Set();
    frame();
    expect(reason()).toBe('no-dem-tiles');
    expect(setDrapedDatasets).toHaveBeenLastCalledWith(fake.drapedDatasets);

    // A settled reason releases it at once
    frame({ terrain: false });
    expect(setDrapedDatasets).toHaveBeenLastCalledWith(null);
  });
});

describe('DrapePlanner layer opacity', () => {
  it('writes the opacity of a layer into its source every frame without collecting again', () => {
    const { planner, frame, layer } = createPlanner();
    expect(frame()).toBe(true);
    expect(planner.sourceFactors[2]).toBe(1);
    const collects = fake.collects;

    layer.opacity = 0.25;
    expect(frame()).toBe(true);
    expect(planner.sourceFactors[2]).toBe(0.25);
    // The size of the source is not touched
    expect(planner.sourceFactors[3]).toBe(1);
    expect(fake.collects).toBe(collects);
  });
});
