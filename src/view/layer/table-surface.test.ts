// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The layers held as rows drawn in one draw on the terrain and on the globe, with the real
 * renderers on a GL that counts its calls
 *
 * - The draws of a frame are the chunks in view, on the terrain and on the globe as on a flat
 *   map: neither the number of rows nor the order of their kinds changes them (drawn by kind,
 *   a layer whose kinds alternate takes a draw per row)
 * - The rows are drawn in their order: the ranges drawn, and the instances in each chunk
 * - The fills are cut on the mesh of the surface, their triangles facing the camera on their
 *   front on the terrain, and the outlines on the same step; the segments of a line are cut into
 *   pieces of equal length no longer than the piece of the surface
 * - The points get the elevation the hit testing projects them with, and read it again only
 *   under the tiles of the terrain that came or went
 * - A new step of the surface packs again the rows whose cut changed, in their places, the
 *   chunk drawn meanwhile
 * - The state of the rows (hidden, moved) is written before the main pass of the frame it is
 *   drawn in, on the terrain and on the globe as on a flat map
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import { globeSubdivisionGrid } from '../../shared/math/globe-subdivision.js';
import type { Feature, Layer } from '../../shared/types/model.js';
import { createTestDrawer, feature, tablesOfFeatures } from '../../test-utils.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { GpuLedger } from '../gpu-ledger.js';
import { retainedDrawRun } from '../renderers/draw-run.js';
import { SDFLineRenderer } from '../renderers/line/sdf-line.js';
import { PointInstanceRenderer } from '../renderers/point/point-instance.js';
import { SDFPolygonRenderer } from '../renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import { ROWS_KIND, type RowsChunkData, readRowsInstance } from '../renderers/rows/rows-format.js';
import { type RowsChunk, RowsRenderer } from '../renderers/rows/rows-renderer.js';
import { beginRenderFrame } from '../shaders/frame.js';
import { calculateOffsetUniforms, type ShaderData } from '../shaders/helpers.js';
import { anchorElevationMeters, setAnchorFrame } from '../terrain/anchor.js';
import { INACTIVE_TERRAIN_STATE, TerrainContext } from '../terrain/context.js';
import type { TerrainLike } from '../terrain/detect.js';
import { mercatorX, mercatorY } from '../terrain/tessellation.js';
import type { StoreRetainedDrawDeps } from './store-retained-immediate.js';
import { MAX_SEGMENT_PIECES, SURFACE_ROOM } from './table-collect.js';
import { type TableDrawRecord, TableLayerRenderer } from './table-retained.js';
import { LINE_PIECE_ZOOM, nextCoarsening } from './table-surface.js';

const LAYER: Layer = {
  id: 'layer',
  name: 'layer',
  visible: true,
  locked: false,
  opacity: 1,
  items: [],
  styleRule: undefined,
  metadata: undefined,
};

const MERCATOR: ShaderData = { vertexShaderPrelude: '', define: '', variantName: 'mercator' };
const GLOBE: ShaderData = {
  vertexShaderPrelude: '',
  define: '#define GLOBE',
  variantName: 'globe',
};

const CENTER: [number, number] = [139.7, 35.68];
const CELL = 0.003;
/** The step of the mesh of the terrain of the tests (zoom 11, 128 cells a tile) */
const STEP = 1 / (2 ** 11 * 128);

/** A GL that counts its calls by name */
function countingGL() {
  const counts = new Map<string, number>();
  let counting = false;
  let next = 1;
  const target: Record<string, unknown> = {
    drawingBufferWidth: 1280,
    drawingBufferHeight: 800,
    canvas: { width: 1280, height: 800 },
  };
  const results: Record<string, (...args: unknown[]) => unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: (_program, name) => ({ name }),
    getParameter: () => 4096,
    isEnabled: () => false,
  };
  const gl = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (/^[A-Z_0-9]+$/.test(prop)) return prop.length;
      const result = prop.startsWith('create')
        ? () => ({ id: next++ })
        : (results[prop] ?? (() => undefined));
      const fn = (...args: unknown[]) => {
        if (counting) counts.set(prop, (counts.get(prop) ?? 0) + 1);
        return result(...args);
      };
      t[prop] = fn;
      return fn;
    },
  }) as unknown as WebGL2RenderingContext;
  return {
    gl,
    start: () => {
      counts.clear();
      counting = true;
    },
    stop: () => {
      counting = false;
      return new Map(counts);
    },
  };
}

/** The `i`-th of `n` features on a grid around the center: a point, then a polygon, in turn */
function alternating(n: number, i: number, kinds: 'alternating' | 'grouped'): Feature {
  const columns = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / columns);
  const x = CENTER[0] - (columns * CELL) / 2 + (i % columns) * CELL;
  const y = CENTER[1] - (rows * CELL) / 2 + Math.floor(i / columns) * CELL;
  const s = CELL * 0.8;
  const point = kinds === 'alternating' ? i % 2 === 0 : i < n / 2;
  if (point) return feature(`f${i}`, 'Point', [x + s / 2, y + s / 2]);
  return feature(`f${i}`, 'Polygon', [
    [
      [x, y],
      [x + s, y],
      [x + s, y + s],
      [x, y + s],
      [x, y],
    ],
  ]);
}

function projection(transition = 0): ProjectionData {
  return {
    mainMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: transition,
    fallbackMatrix: new Float32Array(16),
  } as unknown as ProjectionData;
}

/** A terrain whose ground is a slope rising to the east, drawn as the tiles given */
function slopeTerrain(tiles: () => Array<{ x: number; y: number; z: number }>): TerrainLike {
  return {
    getTerrainData: () => null,
    getElevationForLngLatZoom: (lngLat: { lng: number; lat: number }) =>
      (lngLat.lng - CENTER[0]) * 10_000 + 100,
    tileManager: {
      getRenderableTiles: () => tiles().map((canonical) => ({ tileID: { canonical } })),
    },
  } as unknown as TerrainLike;
}

/** The tile of a zoom under a position */
function tileAt(lng: number, lat: number, z: number): { x: number; y: number; z: number } {
  const size = 2 ** z;
  return { x: Math.floor(mercatorX(lng) * size), y: Math.floor(mercatorY(lat) * size), z };
}

let terrain: TerrainContext;

beforeEach(() => {
  terrain = new TerrainContext();
});

/** Turns the terrain of the tests on for a frame (the step of its mesh and its tiles) */
function terrainFrame(
  source: TerrainLike,
  options: { step?: number; generation?: number } = {},
): void {
  terrain.renderState = {
    ...INACTIVE_TERRAIN_STATE,
    active: true,
    stepGrid: options.step ?? STEP,
    stepMeters: 1,
    elevationScale: 1e-7,
    generation: options.generation ?? 1,
  };
  const projectionData = projection();
  setAnchorFrame(terrain, {
    terrain: source,
    zoom: 12,
    elevationScale: 1e-7,
    projection: projectionData,
    offsetUniforms: calculateOffsetUniforms(CENTER, projectionData),
    width: 1280,
    height: 800,
    cameraMercator: [mercatorX(CENTER[0]), mercatorY(CENTER[1] - 0.05), 1e-4],
  });
}

/** The globe of the tests on for a frame */
function globeFrame(zoom = 4): void {
  terrain.globeGrids = {
    fill: globeSubdivisionGrid(zoom, 'fill'),
    line: globeSubdivisionGrid(zoom, 'line'),
  };
}

function setup(features: Feature[], targetRows?: number) {
  const { internals, table, tables, writer } = tablesOfFeatures('layer', features, targetRows);
  const mock = countingGL();
  const ledger = new GpuLedger();
  const point = new PointInstanceRenderer({} as MapLibreMap, mock.gl, ledger, 1, terrain);
  const line = new SDFLineRenderer({} as MapLibreMap, mock.gl, ledger, 1, terrain);
  const polygon = new SDFPolygonRenderer(mock.gl, { terrain, gpu: ledger }, 1);
  const rows = new RowsRenderer(null, mock.gl, ledger, 1, terrain);
  const made: RowsChunkData[] = [];
  const heights = new Map<RowsChunk, Float32Array>();
  const createChunk = rows.createChunk.bind(rows);
  rows.createChunk = (data) => {
    made.push(data);
    return createChunk(data);
  };
  const setHeights = rows.setHeights.bind(rows);
  rows.setHeights = (chunk, values) => {
    heights.set(chunk, values.slice());
    setHeights(chunk, values);
  };
  const patched: number[] = [];
  const patchRows = rows.patchRows.bind(rows);
  rows.patchRows = (chunk, fromRow, patch) => {
    const fits = patchRows(chunk, fromRow, patch);
    patched.push(fits ? chunk.data.rowBase + fromRow : -1);
    return fits;
  };
  const renderers: RetainedRendererSet = {
    point,
    line,
    polygon,
    rows,
    styles: createTestDrawer(),
    viewport: () => [mock.gl.drawingBufferWidth, mock.gl.drawingBufferHeight],
    run: retainedDrawRun(mock.gl),
  };
  const deps: StoreRetainedDrawDeps = {
    renderers,
    batchManager: { beginFrame: () => {}, processFeature: () => true, endFrame: () => {} },
    customRenderers: new Map(),
    customRendererContext: {} as never,
    companions: createFeatureCompanionRegistry(),
  };
  const renderer = new TableLayerRenderer({
    gl: mock.gl,
    terrain,
    ledger,
    requestRepaint: () => {},
    buildBudgetMs: Number.POSITIVE_INFINITY,
  });
  const frame = (options: { globe?: boolean } = {}) => {
    renderer.prerender();
    beginRenderFrame();
    const shaderData = options.globe ? GLOBE : MERCATOR;
    const projectionData = projection(options.globe ? 1 : 0);
    const offset = calculateOffsetUniforms(CENTER, projectionData);
    for (const r of [point, line, polygon]) r.ensureShader(shaderData);
    point.setOffsetUniforms(offset);
    point.setProjectionData(projectionData);
    line.setOffsetUniforms(offset);
    polygon.setOffsetUniforms(offset);
    rows.ensureShader(shaderData);
    rows.setOffsetUniforms(offset);
    renderer.beginFrame();
    const record: TableDrawRecord[] = [];
    renderer.recordDraws(record);
    renderer.drawLayer(
      internals,
      table,
      LAYER,
      { projectionData, zoom: 12, bounds: undefined },
      deps,
    );
    renderer.endFrame();
    renderer.recordDraws(null);
    return record;
  };
  return { internals, table, tables, writer, renderer, rows, frame, made, heights, patched, mock };
}

function drawCount(counts: Map<string, number>): number {
  return (counts.get('drawArraysInstanced') ?? 0) + (counts.get('drawElements') ?? 0);
}

function features(n: number, kinds: 'alternating' | 'grouped'): Feature[] {
  const out: Feature[] = [];
  for (let i = 0; i < n; i++) out.push(alternating(n, i, kinds));
  return out;
}

/** The draws of a frame once its chunks are built, with the ranges drawn */
function drawsOf(
  n: number,
  kinds: 'alternating' | 'grouped',
  surface: 'terrain' | 'globe',
  byKind = false,
): { draws: number; record: TableDrawRecord[]; calls: number } {
  const source = slopeTerrain(() => [tileAt(CENTER[0], CENTER[1], 11)]);
  const { renderer, frame, mock } = setup(features(n, kinds));
  renderer.setDrawingByKind(byKind);
  const globe = surface === 'globe';
  const prepare = () => (globe ? globeFrame() : terrainFrame(source));
  prepare();
  frame({ globe });
  prepare();
  frame({ globe });
  prepare();
  mock.start();
  const record = frame({ globe });
  const counts = mock.stop();
  let calls = 0;
  for (const value of counts.values()) calls += value;
  return { draws: drawCount(counts), record, calls };
}

describe('the drawing of the rows on the terrain and on the globe', () => {
  it('draws the chunks in view, whatever the number of rows and the order of their kinds', () => {
    for (const surface of ['terrain', 'globe'] as const) {
      const small = drawsOf(4_000, 'alternating', surface);
      const large = drawsOf(20_000, 'alternating', surface);
      const grouped = drawsOf(20_000, 'grouped', surface);
      const before = drawsOf(20_000, 'alternating', surface, true);
      console.log(
        `[${surface}] points and polygons in turn, 20,000 rows: ${large.draws} draws (${large.calls} GL calls) in one draw, ${before.draws} draws (${before.calls} GL calls) by kind; 4,000 rows ${small.draws}, grouped by kind ${grouped.draws}`,
      );
      for (const { draws, record } of [small, large, grouped]) {
        // Every range drawn is a chunk drawn in one draw, and each is one draw
        expect(record.every((entry) => entry.kind === 'rows')).toBe(true);
        expect(draws).toBe(record.length);
      }
      // A few chunks of 40,000 coordinates: the draws do not follow the rows nor their order
      expect(large.draws).toBeLessThan(20);
      expect(grouped.draws).toBeLessThanOrEqual(large.draws + 2);
      expect(large.draws).toBeLessThanOrEqual(small.draws * 6);
      // Drawn by kind, a layer whose kinds alternate takes a draw per row
      expect(before.draws).toBeGreaterThan(19_000);
    }
  });

  it('draws the rows in their order, and packs the instances of a chunk in the order of its rows', () => {
    const source = slopeTerrain(() => [tileAt(CENTER[0], CENTER[1], 11)]);
    for (const surface of ['terrain', 'globe'] as const) {
      const { table, frame, made } = setup(features(2_000, 'alternating'), 300);
      const prepare = () => (surface === 'globe' ? globeFrame() : terrainFrame(source));
      prepare();
      frame({ globe: surface === 'globe' });
      prepare();
      const record = frame({ globe: surface === 'globe' });
      // The ranges drawn are the rows of the layer, each once, in order (as one at a time)
      const drawn: string[] = [];
      for (const entry of record) {
        for (let row = entry.from; row < entry.to; row++) drawn.push(`${entry.groupIndex}:${row}`);
      }
      const all: string[] = [];
      for (let g = 0; g < table.groupCount; g++) {
        for (let row = 0; row < table.groupAt(g).data.length; row++) all.push(`${g}:${row}`);
      }
      expect(drawn).toEqual(all);
      for (const data of made) {
        let last = -1;
        for (let i = 0; i < data.instanceCount; i++) {
          const { row } = readRowsInstance(data.instances, i);
          expect(row).toBeGreaterThanOrEqual(last);
          last = row;
        }
      }
    }
  });

  it('cuts the fills on the mesh of the terrain, facing the camera, and the outlines on its step', () => {
    const source = slopeTerrain(() => [tileAt(CENTER[0], CENTER[1], 11)]);
    const polygon = feature('g', 'Polygon', [
      [
        [CENTER[0], CENTER[1]],
        [CENTER[0] + 0.02, CENTER[1]],
        [CENTER[0] + 0.02, CENTER[1] + 0.02],
        [CENTER[0], CENTER[1] + 0.02],
        [CENTER[0], CENTER[1]],
      ],
    ]);
    const flat = setup([polygon]);
    flat.frame();
    const plain = flat.made[0];
    const cut = setup([polygon]);
    terrainFrame(source);
    cut.frame();
    const data = cut.made[0];
    const count = (packed: RowsChunkData, kind: number) => {
      let n = 0;
      for (let i = 0; i < packed.instanceCount; i++) {
        if (readRowsInstance(packed.instances, i).kind === kind) n++;
      }
      return n;
    };
    // A square of 0.02 degrees is about 15 cells of the step each way
    expect(count(data, ROWS_KIND.fill)).toBeGreaterThan(count(plain, ROWS_KIND.fill) * 50);
    expect(count(data, ROWS_KIND.outline)).toBeGreaterThan(count(plain, ROWS_KIND.outline) * 10);
    // The front of every pair of triangles faces the camera (a negative cross product on the
    // Mercator plane, as the cut of the terrain turns its triangles)
    const at = (index: number): [number, number] => [
      mercatorX(data.coords[index * 2] + data.origin[0]),
      mercatorY(data.coords[index * 2 + 1] + data.origin[1]),
    ];
    for (let i = 0; i < data.instanceCount; i++) {
      const instance = readRowsInstance(data.instances, i);
      if (instance.kind !== ROWS_KIND.fill) continue;
      const [a, b, c] = instance.indices.map(at);
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      expect(cross).toBeLessThanOrEqual(1e-18);
    }
  });

  it('cuts the segments of the lines into pieces of equal length, no longer than the piece', () => {
    const source = slopeTerrain(() => [tileAt(CENTER[0], CENTER[1], 11)]);
    const line = feature('l', 'LineString', [
      [CENTER[0], CENTER[1]],
      [CENTER[0] + 0.05, CENTER[1] + 0.01],
      [CENTER[0] + 0.05, CENTER[1] + 0.012],
    ]);
    const { frame, made } = setup([line]);
    terrainFrame(source);
    frame();
    const data = made[0];
    const piece = 1 / (2 ** LINE_PIECE_ZOOM * 128);
    const bySegment = new Map<number, Array<[number, number]>>();
    for (let i = 0; i < data.instanceCount; i++) {
      const { kind, indices, t0, t1 } = readRowsInstance(data.instances, i);
      // The room the row leaves after its pieces draws nothing
      if (kind === ROWS_KIND.fill) {
        expect(new Set(indices).size).toBe(1);
        continue;
      }
      expect(kind).toBe(ROWS_KIND.segment);
      const list = bySegment.get(indices[1]) ?? [];
      list.push([t0, t1]);
      bySegment.set(indices[1], list);
    }
    // The coordinates are the line's own (and the room it leaves, a copy of its last one)
    expect(data.coordCount).toBe(3 + Math.ceil(3 * SURFACE_ROOM));
    for (const [start, pieces] of bySegment) {
      const a = [
        data.coords[start * 2] + data.origin[0],
        data.coords[start * 2 + 1] + data.origin[1],
      ];
      const b = [
        data.coords[start * 2 + 2] + data.origin[0],
        data.coords[start * 2 + 3] + data.origin[1],
      ];
      const length = Math.hypot(
        mercatorX(b[0]) - mercatorX(a[0]),
        mercatorY(b[1]) - mercatorY(a[1]),
      );
      expect(pieces.length).toBe(
        Math.min(MAX_SEGMENT_PIECES, Math.max(1, Math.ceil(length / piece))),
      );
      // In order from 0 to 1, each piece starting where the one before ends, of equal length
      expect(pieces[0][0]).toBe(0);
      expect(pieces[pieces.length - 1][1]).toBe(1);
      for (let k = 0; k < pieces.length; k++) {
        if (k > 0) expect(pieces[k][0]).toBe(pieces[k - 1][1]);
        expect(pieces[k][1] - pieces[k][0]).toBeCloseTo(1 / pieces.length, 6);
        expect((pieces[k][1] - pieces[k][0]) * length).toBeLessThanOrEqual(piece * 1.000001);
      }
    }
    // The first segment (about 4.5 km) is cut, the last one (about 200 m) is in two pieces
    expect(bySegment.get(0)?.length).toBeGreaterThan(20);
  });

  it('gives the points the elevation the hit testing projects them with', () => {
    let tiles = [tileAt(CENTER[0], CENTER[1], 11)];
    const source = slopeTerrain(() => tiles);
    const { frame, heights, made, table } = setup(features(400, 'alternating'));
    terrainFrame(source);
    frame();
    terrainFrame(source);
    frame();
    expect(heights.size).toBeGreaterThan(0);
    const group = table.groupAt(0);
    const check = () => {
      for (const [chunk, values] of heights) {
        const data = made.find((d) => d.rowFirst === chunk.data.rowFirst) as RowsChunkData;
        for (let i = 0; i < data.instanceCount; i++) {
          const { kind, row, indices } = readRowsInstance(data.instances, i);
          if (kind !== ROWS_KIND.point) continue;
          const at = group.data.rowBounds;
          const lng = at[row * 4];
          const lat = at[row * 4 + 1];
          expect(values[indices[0]]).toBeCloseTo(anchorElevationMeters(terrain, lng, lat), 4);
        }
      }
    };
    check();
    // The tiles of the terrain change: the points under them read their elevation again
    const written = heights.size;
    heights.clear();
    tiles = [tileAt(CENTER[0], CENTER[1], 12)];
    terrainFrame(source);
    frame();
    expect(heights.size).toBeGreaterThan(0);
    expect(heights.size).toBeLessThanOrEqual(written);
    check();
    // A tile far away comes: no chunk under it reads its points again
    heights.clear();
    tiles = [tileAt(CENTER[0], CENTER[1], 12), tileAt(CENTER[0] + 60, CENTER[1], 12)];
    terrainFrame(source);
    frame();
    expect(heights.size).toBe(0);
  });

  it('writes the elevations of the points again when the DEM under them arrives, and only there', () => {
    // maplibre draws the tiles of the view before their DEM arrives: flat until it does, with
    // the tiles drawn staying the same
    const near = tileAt(CENTER[0], CENTER[1], 11);
    const far = tileAt(CENTER[0] + 60, CENTER[1], 11);
    const tiles = [near, far].map((canonical) => ({ tileID: { canonical, wrap: 0 } }));
    const name = (t: { x: number; y: number; z: number }) => `${t.z}/${t.x}/${t.y}`;
    const dems = new Map<string, object>();
    const source = {
      getTerrainData: () => null,
      getElevationForLngLatZoom: (lngLat: { lng: number; lat: number }) =>
        dems.has(name(tileAt(lngLat.lng, lngLat.lat, 11)))
          ? (lngLat.lng - CENTER[0]) * 10_000 + 100
          : 0,
      tileManager: {
        getRenderableTiles: () => tiles,
        getSourceTile: (tileID: { canonical: { x: number; y: number; z: number } }) => {
          const dem = dems.get(name(tileID.canonical));
          return (
            dem && { tileID: { key: name(tileID.canonical), canonical: tileID.canonical }, dem }
          );
        },
      },
    } as unknown as TerrainLike;
    const { frame, heights, made, table } = setup(features(400, 'alternating'));
    const group = table.groupAt(0);
    const pointElevations = (): Array<{ written: number; drawnAt: number }> => {
      const out: Array<{ written: number; drawnAt: number }> = [];
      for (const [chunk, values] of heights) {
        const data = made.find((d) => d.rowFirst === chunk.data.rowFirst) as RowsChunkData;
        for (let i = 0; i < data.instanceCount; i++) {
          const { kind, row, indices } = readRowsInstance(data.instances, i);
          if (kind !== ROWS_KIND.point) continue;
          const lng = group.data.rowBounds[row * 4];
          const lat = group.data.rowBounds[row * 4 + 1];
          // What the hit testing projects the point with in the same frame
          out.push({
            written: values[indices[0]],
            drawnAt: anchorElevationMeters(terrain, lng, lat),
          });
        }
      }
      return out;
    };
    terrainFrame(source);
    frame();
    terrainFrame(source);
    frame();
    const flat = pointElevations();
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.every(({ written }) => written === 0)).toBe(true);

    // The DEM under the points arrives: their elevations are written again, as the hit testing
    // reads them
    heights.clear();
    dems.set(name(near), {});
    terrainFrame(source);
    frame();
    const ground = pointElevations();
    expect(ground.length).toBe(flat.length);
    for (const { written, drawnAt } of ground) {
      expect(drawnAt).not.toBe(0);
      expect(written).toBeCloseTo(drawnAt, 4);
    }

    // The DEM of a tile far away arrives: no chunk under it reads its points again
    heights.clear();
    dems.set(name(far), {});
    terrainFrame(source);
    frame();
    expect(heights.size).toBe(0);
  });

  it('packs again, in their places, the rows a new step of the terrain cuts otherwise', () => {
    const source = slopeTerrain(() => [tileAt(CENTER[0], CENTER[1], 11)]);
    const { frame, patched, made } = setup(features(400, 'alternating'));
    terrainFrame(source, { step: STEP / 2, generation: 1 });
    frame();
    terrainFrame(source, { step: STEP / 2, generation: 1 });
    frame();
    const built = made.length;
    // A coarser step: the polygon rows are packed again, each into its place (they fit)
    terrainFrame(source, { step: STEP * 4, generation: 2 });
    const record = frame();
    const polygons = 200;
    expect(patched.filter((row) => row >= 0)).toHaveLength(polygons);
    expect(made.length).toBe(built);
    // Every row is drawn meanwhile
    expect(record.reduce((sum, entry) => sum + entry.to - entry.from, 0)).toBe(400);
    // A finer step: a row does not fit its place, and its chunk is built again (drawn until then)
    patched.length = 0;
    terrainFrame(source, { step: STEP / 8, generation: 3 });
    const meanwhile = frame();
    expect(patched).toContain(-1);
    expect(meanwhile.reduce((sum, entry) => sum + entry.to - entry.from, 0)).toBe(400);
    terrainFrame(source, { step: STEP / 8, generation: 3 });
    frame();
    expect(made.length).toBeGreaterThan(built);
  });

  it('writes the state of the rows before the main pass of the frame it is drawn in', () => {
    const source = slopeTerrain(() => [tileAt(CENTER[0], CENTER[1], 11)]);
    for (const surface of ['terrain', 'globe'] as const) {
      const { frame, internals, table, mock } = setup(features(200, 'alternating'));
      const globe = surface === 'globe';
      const prepare = () => (globe ? globeFrame() : terrainFrame(source));
      prepare();
      frame({ globe });
      prepare();
      frame({ globe });
      const group = table.groupAt(0);
      internals.states.setHidden(Int32Array.of(group.data.rows[0], group.data.rows[1]), true);
      prepare();
      mock.start();
      const record = frame({ globe });
      const counts = mock.stop();
      // The texture of the state is written once, before the rows are drawn in one draw
      expect(counts.get('texSubImage2D') ?? 0).toBeGreaterThan(0);
      expect(record.every((entry) => entry.kind === 'rows')).toBe(true);
      expect(group.gpuState[0] & 1).toBe(1);
      // Rows of a moving set, moved, turned and resized: the state and the motion of the set
      // reach the program in the frame they are set in, the rows drawn in one draw
      const moved = Int32Array.of(group.data.rows[2], group.data.rows[3]);
      internals.states.setMoving(moved, 1);
      for (const edit of [
        { kind: 'translate', from: [CENTER[0], CENTER[1]], to: [CENTER[0] + 0.01, CENTER[1]] },
        { kind: 'rotate', center: [CENTER[0], CENTER[1]], angleDegrees: 30 },
        {
          kind: 'scale',
          center: [CENTER[0], CENTER[1]],
          eastFactor: 2,
          northFactor: 2,
          sizeFactor: 2,
        },
      ] as const) {
        if (edit.kind === 'translate') internals.states.setTranslation(1, 0.01, 0);
        else internals.states.setTransform(1, edit as never);
        prepare();
        mock.start();
        const drawn = frame({ globe });
        const set = mock.stop();
        expect((set.get('uniform2fv') ?? 0) + (set.get('uniform4fv') ?? 0)).toBeGreaterThan(0);
        expect(drawn.every((entry) => entry.kind === 'rows')).toBe(true);
        expect(drawn.reduce((sum, entry) => sum + entry.to - entry.from, 0)).toBe(200);
        expect((group.gpuState[2] >> 1) & 3).toBe(1);
      }
    }
  });
});

describe('the coarsening of the fills of a frame', () => {
  it('is coarser at once over the budget, finer only well under it', () => {
    const budget = 1_000_000;
    expect(nextCoarsening(1, budget / 2)).toBe(1);
    const coarse = nextCoarsening(1, budget * 20);
    expect(coarse).toBeGreaterThan(1);
    // A little fewer cells, with a step coarser than they need: it stays
    expect(nextCoarsening(1, budget * 15)).toBeLessThan(coarse);
    expect(nextCoarsening(coarse, budget * 15)).toBe(coarse);
    // Well under it: finer
    expect(nextCoarsening(coarse, budget / 10)).toBeLessThan(coarse);
  });
});
