// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hit testing of the layers held as rows of columns in the unified z traversal
 *
 * A row is hit as it is drawn: the frontmost row, in the order of the layer, of the layers in
 * the stacking order. The hit is a row (`kind: 'row'`) and no feature of the Store is made; a
 * hidden row, a hidden layer and a row out of reach are not hit.
 *
 * A hit that asks for the feature of the row (a click, a drag) is given the feature the Store
 * makes of the row (`kind: 'store'`); nothing is held for it, and a row selected is hit as a row
 * otherwise.
 *
 * The companions of the rows are hit in the order they are drawn, as the companions of the
 * features are: from the front, each row itself, then its companions.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayerTableView } from '../../api/tables.js';
import { createFeatureTablesStore } from '../../feature-table/feature-row-tables.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { getAnchorProjector } from '../../shared/math/index.js';
import { DrawStore } from '../../store/draw-store.js';
import { MemoryContractStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Feature } from '../../store/types.js';
import { createRowBlockDataBuilder } from '../../table/row-group-builder.js';
import { feature, orderKey, rowOfFeature } from '../../test-utils.js';
import {
  createFeatureCompanionRegistry,
  type FeatureCompanionProvider,
  type FeatureCompanionRegistry,
} from '../../view/feature-companion.js';
import {
  clearAnchorFrame,
  installAnchorProjector,
  projectAnchor,
  setAnchorFrame,
  uninstallAnchorProjector,
} from '../../view/terrain/anchor.js';
import { TerrainContext } from '../../view/terrain/context.js';
import type { TerrainLike } from '../../view/terrain/detect.js';
import { HitTestServiceImpl } from './service.js';
import { createTopmostHitTester, type TopHit, type TopmostAnchorProjector } from './topmost.js';

const square = (x: number, y: number) => [
  [
    [x, y],
    [x + 10, y],
    [x + 10, y + 10],
    [x, y + 10],
    [x, y],
  ],
];

/** An unproject that maps longitude/latitude naively and linearly (1 degree = 10px) */
const unproject = (p: { x: number; y: number }): { lng: number; lat: number } => ({
  lng: p.x / 10,
  lat: -p.y / 10,
});
const at = (lng: number, lat: number) => ({ x: lng * 10, y: -lat * 10 });

let store: DrawStore;
let tables: ReturnType<typeof createFeatureTablesStore>;

function layer(id: string): void {
  store.createLayer({
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
}

function adopt(layerId: string, features: Feature[]): void {
  const builder = createRowBlockDataBuilder({ targetRows: 2 });
  features.forEach((f, i) => {
    builder.addRow(rowOfFeature(f, orderKey(i)));
  });
  tables.writer.addRowBlocks(layerId, builder.finish());
  featureTablesInternals(tables.tables)?.addQueuedRowBlocks();
}

beforeEach(() => {
  tables = createFeatureTablesStore();
  const contract = new MemoryContractStore();
  Object.defineProperty(contract, 'tables', { value: tables.tables });
  store = new DrawStore(contract);
});

function tester() {
  const service = new HitTestServiceImpl(store, new RBushSpatialIndex());
  return createTopmostHitTester({
    store,
    hitTestService: service,
    unproject,
    toleranceLngLat: () => 0.5,
    getZoom: () => 3,
  });
}

function rowId(hit: TopHit | null): string | null {
  return hit?.kind === 'row' ? hit.id : null;
}

describe('the hit testing of the rows held as columns', () => {
  it('returns the frontmost row as a row, with its handle', () => {
    layer('l');
    adopt('l', [
      feature('back', 'Polygon', square(0, 0)),
      feature('middle', 'Polygon', square(5, 5)),
      feature('front', 'Polygon', square(8, 8)),
    ]);
    const hit = tester()(at(9, 9));
    expect(hit?.kind).toBe('row');
    expect(rowId(hit)).toBe('front');
    if (hit?.kind !== 'row') throw new Error('row');
    expect(hit.layerId).toBe('l');
    expect(hit.handle).toBe(tables.tables.findRow('front'));
    expect(hit.locked).toBe(false);
    expect(rowId(tester()(at(6, 6)))).toBe('middle');
    expect(tester()(at(30, 30))).toBeNull();
  });

  it('follows the stacking order of the layers', () => {
    layer('below');
    layer('above');
    adopt('below', [feature('b', 'Polygon', square(0, 0))]);
    adopt('above', [feature('a', 'Polygon', square(0, 0))]);
    expect(rowId(tester()(at(5, 5)))).toBe('a');
    store.setLayerOrder(['above', 'below']);
    expect(rowId(tester()(at(5, 5)))).toBe('b');
  });

  it('does not hit a hidden row, nor the rows of a hidden layer', () => {
    layer('l');
    adopt('l', [
      feature('back', 'Polygon', square(0, 0)),
      feature('front', 'Polygon', square(0, 0), { visible: false }),
    ]);
    expect(rowId(tester()(at(5, 5)))).toBe('back');
    const internals = featureTablesInternals(tables.tables);
    internals?.states.setHidden(Int32Array.of(tables.tables.findRow('back') as number), true);
    expect(tester()(at(5, 5))).toBeNull();
    internals?.states.setHidden(Int32Array.of(tables.tables.findRow('back') as number), false);
    store.setLocallyHidden('l', true);
    expect(tester()(at(5, 5))).toBeNull();
  });

  it('tells a locked row, and a row of a locked layer', () => {
    layer('l');
    adopt('l', [feature('p', 'Polygon', square(0, 0), { locked: true })]);
    const hit = tester()(at(5, 5));
    expect(hit?.kind === 'row' && hit.locked).toBe(true);
  });

  it('makes no feature of the Store for a row', () => {
    layer('l');
    adopt('l', [feature('p', 'Polygon', square(0, 0))]);
    tester()(at(5, 5));
    expect(store.getFeature('p')).toBeUndefined();
  });

  it('measures the distance of a row hit from the row', () => {
    layer('l');
    adopt('l', [
      feature('line', 'LineString', [
        [0, 0],
        [10, 0],
      ]),
    ]);
    const hit = tester()(at(5, 0.2));
    expect(hit?.kind).toBe('row');
    if (hit?.kind !== 'row') throw new Error('row');
    // 0.2 degrees at 10 px per degree (a latitude difference counts a little more by cos φ)
    expect(hit.distancePx()).toBeCloseTo(2, 3);
  });
});

describe('the hit testing that asks for the feature of the row hit', () => {
  it('returns the feature of the row hit when it is asked for, and holds nothing', () => {
    layer('l');
    adopt('l', [feature('p', 'Polygon', square(0, 0))]);
    const hit = tester()(at(5, 5), { asFeature: true });
    expect(hit?.kind).toBe('store');
    expect(hit?.kind === 'store' && hit.feature).toMatchObject({
      id: 'p',
      geometry: { type: 'Polygon', coordinates: square(0, 0) },
    });
    // Without asking, the row is a row, selected or not
    expect(tester()(at(5, 5))?.kind).toBe('row');
    store.setSelection('feature', ['p']);
    expect(tester()(at(5, 5))?.kind).toBe('row');
  });
});

describe('the hit testing of the companions of the rows held as columns', () => {
  let companions: FeatureCompanionRegistry;

  beforeEach(() => {
    companions = createFeatureCompanionRegistry();
  });

  function companionTester() {
    const service = new HitTestServiceImpl(store, new RBushSpatialIndex());
    return createTopmostHitTester({
      store,
      hitTestService: service,
      unproject,
      toleranceLngLat: () => 0.5,
      getZoom: () => 3,
      project: ([lng, lat]) => at(lng, lat),
      clickTolerancePx: 5,
      companions,
    });
  }

  /**
   * A provider of a line drawn for each feature it names, along the latitude it gives, from
   * longitude 0 to 100 (a band away from its feature), answered from the rows when `rows`
   */
  function registerLines(lines: Record<string, number>, options: { rows?: boolean } = {}) {
    const has = vi.fn((f: Feature) => f.id in lines);
    const hitTest = vi.fn<FeatureCompanionProvider['hitTest']>((f, point, context) => {
      const lat = lines[f.id];
      if (lat === undefined) return null;
      const from = context.project([0, lat]);
      const to = context.project([100, lat]);
      const on =
        Math.abs(point.y - from.y) <= context.tolerancePx &&
        point.x >= from.x - context.tolerancePx &&
        point.x <= to.x + context.tolerancePx;
      return on ? { id: `line-of-${f.id}` } : null;
    });
    const onCompanionClick = vi.fn<FeatureCompanionProvider['onCompanionClick']>();
    companions.register({
      id: 'lines',
      has,
      ...(options.rows && {
        hasRow: (_view: LayerTableView, handle: number) => {
          const id = tables.tables.getRowId(handle);
          return id !== undefined && id in lines;
        },
      }),
      draw: () => {},
      hitTest,
      onCompanionClick,
    });
    return { has, hitTest, onCompanionClick };
  }

  it('hits the companion of a row on its line, as a companion of the feature of the row', () => {
    layer('l');
    adopt('l', [feature('a', 'Polygon', square(0, 0)), feature('b', 'Polygon', square(20, 0))]);
    registerLines({ a: 50 });
    const hit = companionTester()(at(60, 50));
    expect(hit).toEqual({
      kind: 'companion',
      companion: { providerId: 'lines', featureId: 'a', hit: { id: 'line-of-a' } },
    });
    expect(companionTester()(at(60, 40))).toBeNull();
  });

  it('asks only the rows with a companion, and makes no feature for the others', () => {
    layer('l');
    adopt('l', [
      feature('a', 'Polygon', square(0, 0)),
      feature('b', 'Polygon', square(20, 0)),
      feature('c', 'Polygon', square(40, 0)),
    ]);
    const { has, hitTest } = registerLines({ b: 50 }, { rows: true });
    expect(companionTester()(at(60, 50))?.kind).toBe('companion');
    expect(has.mock.calls.map(([f]) => f.id)).toEqual(['b']);
    expect(hitTest.mock.calls.map(([f]) => f.id)).toEqual(['b']);
  });

  it('asks a provider that answers from the features only on the features', () => {
    layer('l');
    adopt('l', [feature('a', 'Polygon', square(0, 0)), feature('b', 'Polygon', square(20, 0))]);
    const { hitTest } = registerLines({ a: 50 });
    expect(companionTester()(at(60, 50))?.kind).toBe('companion');
    expect(hitTest.mock.calls.map(([f]) => f.id)).toEqual(['a']);
  });

  it('lets a row win over its own companion, and over the companions behind it', () => {
    layer('l');
    adopt('l', [
      feature('back', 'Polygon', square(0, 0)),
      feature('front', 'Polygon', square(0, 40)),
    ]);
    // The line of the row behind passes under the row in front
    registerLines({ back: 45, front: 45 });
    expect(rowId(companionTester()(at(5, 45)))).toBe('front');
    expect(rowId(companionTester()(at(5, 5)))).toBe('back');
  });

  it('lets the companion of a row in front win over the rows behind it', () => {
    layer('l');
    adopt('l', [
      feature('back', 'Polygon', square(0, 0)),
      feature('front', 'Polygon', square(20, 20)),
    ]);
    registerLines({ front: 5 });
    const hit = companionTester()(at(5, 5));
    expect(hit?.kind === 'companion' && hit.companion.featureId).toBe('front');
  });

  it('lets a row in front of a layer win over the companions of the layer behind', () => {
    layer('below');
    layer('above');
    adopt('below', [feature('b', 'Polygon', square(20, 20))]);
    adopt('above', [feature('a', 'Polygon', square(0, 0))]);
    registerLines({ b: 5 });
    expect(rowId(companionTester()(at(5, 5)))).toBe('a');
    const hit = companionTester()(at(15, 5));
    expect(hit?.kind === 'companion' && hit.companion.featureId).toBe('b');
  });

  it('does not ask the companions of a hidden row, nor of the rows of a hidden layer', () => {
    layer('l');
    adopt('l', [
      feature('a', 'Polygon', square(0, 0)),
      feature('hidden', 'Polygon', square(20, 0), { visible: false }),
    ]);
    const { hitTest } = registerLines({ a: 50, hidden: 60 }, { rows: true });
    expect(companionTester()(at(60, 60))).toBeNull();
    expect(hitTest.mock.calls.map(([f]) => f.id)).toEqual(['a']);
    store.setLocallyHidden('l', true);
    expect(companionTester()(at(60, 50))).toBeNull();
    store.setLocallyHidden('l', false);
    store.updateLayer('l', { visible: false });
    expect(companionTester()(at(60, 50))).toBeNull();
  });

  it('gives a companion hit as a companion, even when the feature of a row is asked for', () => {
    layer('l');
    adopt('l', [feature('a', 'Polygon', square(0, 0))]);
    registerLines({ a: 50 });
    expect(companionTester()(at(60, 50), { asFeature: true })?.kind).toBe('companion');
  });

  /**
   * A provider of a line along the latitude in the attribute `band` of a feature, from
   * longitude 0 to 100, answered from the rows; it counts the rows it is asked about
   */
  function registerBands(id = 'bands') {
    const asked = { rows: 0 };
    const hitTest = vi.fn<FeatureCompanionProvider['hitTest']>((f, point, context) => {
      const lat = f.properties.band;
      if (typeof lat !== 'number') return null;
      const y = context.project([0, lat]).y;
      return Math.abs(point.y - y) <= context.tolerancePx ? { id: `band-of-${f.id}` } : null;
    });
    companions.register({
      id,
      has: (f) => typeof f.properties.band === 'number',
      hasRow: (view: LayerTableView, handle: number) => {
        asked.rows++;
        return typeof view.getRowValue(handle, 'band') === 'number';
      },
      draw: () => {},
      hitTest,
      onCompanionClick: () => {},
    });
    return { asked, hitTest };
  }

  /** Points on a grid of 200 columns, one degree apart, in groups of 4096 rows */
  function adoptGrid(layerId: string, count: number, extra: (i: number) => Partial<Feature>): void {
    const builder = createRowBlockDataBuilder({ targetRows: 4096 });
    for (let i = 0; i < count; i++) {
      const f = feature(`p${i}`, 'Point', [i % 200, Math.floor(i / 200)], extra(i));
      builder.addRow(rowOfFeature(f, orderKey(i)));
    }
    tables.writer.addRowBlocks(layerId, builder.finish());
    featureTablesInternals(tables.tables)?.addQueuedRowBlocks();
  }

  it('does not walk the rows of a layer on each hit: the rows with companions are kept', () => {
    layer('l');
    adoptGrid('l', 20_000, () => ({}));
    const { asked } = registerBands();
    const hitTest = companionTester();
    // Found once, on the first hit
    expect(rowId(hitTest(at(10, 10)))).toBe('p2010');
    expect(asked.rows).toBe(20_000);
    asked.rows = 0;
    for (let i = 0; i < 50; i++) {
      expect(rowId(hitTest(at(i, 20)))).toBe(`p${4000 + i}`);
      expect(hitTest(at(i + 0.5, 300))).toBeNull();
    }
    expect(asked.rows).toBe(0);
    // Another hit tester of the same providers keeps them as well
    companionTester()(at(10, 10));
    expect(asked.rows).toBe(0);
  });

  it('asks only the rows with companions in front of the row hit', () => {
    layer('l');
    // Every 1000th row has a band along latitude 30.5, between the rows of the grid
    adoptGrid('l', 20_000, (i) => (i % 1000 === 0 ? { properties: { band: 30.5 } } : {}));
    const { hitTest } = registerBands();
    const companionHit = companionTester()(at(150.5, 30.5));
    expect(companionHit?.kind === 'companion' && companionHit.companion.featureId).toBe('p19000');
    expect(hitTest).toHaveBeenCalledTimes(1);
    hitTest.mockClear();
    // On the row p10000 (row 50 of the grid): the rows with bands in front of it only
    expect(rowId(companionTester()(at(0, 50)))).toBe('p10000');
    expect(hitTest.mock.calls.map(([f]) => f.id)).toEqual(
      Array.from({ length: 9 }, (_, k) => `p${19000 - k * 1000}`),
    );
  });

  it('asks again only the row written for the rows with companions', () => {
    layer('l');
    adopt('l', [feature('a', 'Polygon', square(0, 0)), feature('b', 'Polygon', square(20, 0))]);
    const { asked } = registerBands();
    const hitTest = companionTester();
    expect(hitTest(at(60, 50))).toBeNull();
    tables.writer.apply({
      handles: Int32Array.of(tables.tables.findRow('a') as number),
      fields: new Map([['properties:band', [50]]]),
    });
    asked.rows = 0;
    const hit = hitTest(at(60, 50));
    expect(hit?.kind === 'companion' && hit.companion.featureId).toBe('a');
    expect(asked.rows).toBe(1);
  });

  it('finds the rows with companions again when the rows or the providers change', () => {
    layer('l');
    adopt('l', [feature('a', 'Polygon', square(0, 0), { properties: { band: 50 } })]);
    const hitTest = companionTester();
    // No provider yet
    expect(hitTest(at(60, 50))).toBeNull();
    registerBands();
    const first = hitTest(at(60, 50));
    expect(first?.kind === 'companion' && first.companion.featureId).toBe('a');
    // A row comes in front of it, with a band
    const builder = createRowBlockDataBuilder({ targetRows: 2 });
    builder.addRow(
      rowOfFeature(
        feature('b', 'Polygon', square(20, 0), { properties: { band: 50 } }),
        orderKey(5),
      ),
    );
    tables.writer.addRowBlocks('l', builder.finish());
    featureTablesInternals(tables.tables)?.addQueuedRowBlocks();
    const second = hitTest(at(60, 50));
    expect(second?.kind === 'companion' && second.companion.featureId).toBe('b');
    // The providers go
    companions.clear();
    expect(hitTest(at(60, 50))).toBeNull();
  });
});

describe('the hit testing of the points of the rows on the terrain', () => {
  /** A tester whose points of the rows are hit on the screen with an anchor projection */
  function screenTester(anchors: TopmostAnchorProjector) {
    const service = new HitTestServiceImpl(store, new RBushSpatialIndex());
    return createTopmostHitTester({
      store,
      hitTestService: service,
      unproject,
      toleranceLngLat: () => 0.5,
      getZoom: () => 3,
      clickTolerancePx: 5,
      anchors,
    });
  }

  it('hits a point drawn behind a ridge where it is drawn, far from the click unprojected', () => {
    // The click (100, 0) unprojects to longitude 10, on the ridge in front; the point stands at
    // longitude 40 and its anchor is drawn just beside the click
    layer('l');
    adopt('l', [feature('ghost', 'Point', [40, 0])]);
    const anchors: TopmostAnchorProjector = {
      project: (lng, lat) => (lng === 40 ? { x: 102, y: 1 } : at(lng, lat)),
      searchBoxes: () => [39, -1, 41, 1],
    };
    const hit = screenTester(anchors)({ x: 100, y: 0 });
    expect(rowId(hit)).toBe('ghost');
    if (hit?.kind !== 'row') throw new Error('row');
    // Measured on the screen, where it was hit
    expect(hit.distancePx()).toBeCloseTo(Math.hypot(2, 1), 6);
    // At the coordinate of the click it is not found: the test would protect nothing otherwise
    expect(tester()({ x: 100, y: 0 })).toBeNull();
  });

  it('does not hit a point drawn away from the click, near it in degrees, and lets the rows behind be hit', () => {
    layer('l');
    adopt('l', [feature('fill', 'Polygon', square(5, -5)), feature('point', 'Point', [10, 0])]);
    const anchors: TopmostAnchorProjector = {
      // Drawn far from the click on the screen (on the other side of a mountain)
      project: () => ({ x: 600, y: 600 }),
      searchBoxes: () => [9, -1, 11, 1],
    };
    expect(rowId(screenTester(anchors)(at(10, 0)))).toBe('fill');
    // At the coordinate the point in front is hit
    expect(rowId(tester()(at(10, 0)))).toBe('point');
  });

  it('hits the points at the coordinate as before where the projection is not usable', () => {
    layer('l');
    adopt('l', [feature('point', 'Point', [10, 0])]);
    const anchors: TopmostAnchorProjector = {
      project: () => null,
      searchBoxes: () => null,
    };
    expect(rowId(screenTester(anchors)(at(10, 0.2)))).toBe('point');
  });

  it('hits a point behind a ridge with the anchor projection the drawing uses', () => {
    // A ground that rises to 2,000 m and falls back to 0 (a ridge), with the anchors projected
    // as the drawing projects them, through the projector of the map
    const context = new TerrainContext();
    const map = {} as never;
    installAnchorProjector(map, context);
    try {
      const ridge = (lat: number) => (lat > 0.001 && lat < 0.002 ? 2000 : 0);
      const terrain = {
        getTerrainData: () => null,
        getElevationForLngLatZoom: (lngLat: { lng: number; lat: number }) => ridge(lngLat.lat),
        getMinMaxElevation: () => ({ minElevation: 0, maxElevation: 2000 }),
        tileManager: {
          getRenderableTiles: () => [{ tileID: { canonical: { x: 0, y: 0, z: 0 } } }],
        },
      } as unknown as TerrainLike;
      // Mercator to the screen (0.001 degrees about 110 px), seen from the south: 2,000 m lift
      // a position up the screen by about 100 px, so the ridge hides the ground just north of
      // it, where the point stands
      const m = new Array(16).fill(0);
      m[0] = 1e5;
      m[5] = -1e5;
      m[9] = 6667;
      m[10] = 1;
      m[12] = -0.5e5;
      m[13] = 0.5e5;
      m[15] = 1;
      setAnchorFrame(context, {
        terrain,
        zoom: 14,
        elevationScale: 1 / 4e7,
        projection: { mainMatrix: m } as never,
        offsetUniforms: {
          centerLngLat: [0, 0],
          centerLngLat64: [0, 0],
          centerMercator: [0.5, 0.5],
          projectionCenter: [0, 0, 0, 1],
        },
        width: 800,
        height: 600,
      });
      const projector = getAnchorProjector(map);
      const anchors: TopmostAnchorProjector = {
        project: (lng, lat) => projector?.project(lng, lat) ?? null,
        searchBoxes: (point, reachPx, near) =>
          projector?.searchBoxes?.(point.x, point.y, reachPx, near) ?? null,
      };
      // The point behind the ridge, on the ground at 0 m
      layer('l');
      adopt('l', [feature('behind', 'Point', [0.0005, 0.0025])]);
      const drawn = projectAnchor(context, 0.0005, 0.0025);
      expect(drawn).not.toBeNull();
      if (!drawn) return;
      // The top of the ridge is drawn over it
      const top = projectAnchor(context, 0.0005, 0.0015);
      expect(top && Math.abs(top.y - drawn.y)).toBeLessThan(20);
      // The click there unprojects onto the ridge, about 100 m in front of the point
      const onRidge = { lng: 0.0005, lat: 0.0015 };
      const service = new HitTestServiceImpl(store, new RBushSpatialIndex());
      const hitTest = (withAnchors: boolean) =>
        createTopmostHitTester({
          store,
          hitTestService: service,
          unproject: () => onRidge,
          toleranceLngLat: () => 1e-5,
          getZoom: () => 14,
          clickTolerancePx: 5,
          ...(withAnchors && { anchors }),
        })(drawn);
      expect(rowId(hitTest(true))).toBe('behind');
      expect(hitTest(false)).toBeNull();
    } finally {
      uninstallAnchorProjector(map);
      clearAnchorFrame(context);
    }
  });
});
