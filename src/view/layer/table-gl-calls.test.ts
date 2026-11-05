// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The number of GL calls per draw of the retained batches, on a GL that counts its calls
 *
 * 10,000 features of every kind in turn (a point, a line of 10 coordinates, a polygon of 5 and
 * one of 50), held as rows, are built in a first frame and drawn in a second one with the real
 * renderers; the calls of the second frame are counted. The same is done for the retained
 * batches the features of the Store and the datasets draw (`drawRetained`), interleaved.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { Feature, Layer } from '../../shared/types/model.js';
import { createTestDrawer, feature, tablesOfFeatures } from '../../test-utils.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { GpuLedger } from '../gpu-ledger.js';
import { retainedDrawRun } from '../renderers/draw-run.js';
import { SDFLineRenderer } from '../renderers/line/sdf-line.js';
import { PointInstanceRenderer } from '../renderers/point/point-instance.js';
import { SDFPolygonRenderer } from '../renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import { RowsRenderer } from '../renderers/rows/rows-renderer.js';
import { beginRenderFrame } from '../shaders/frame.js';
import { calculateOffsetUniforms, type ShaderData } from '../shaders/helpers.js';
import { TerrainContext } from '../terrain/context.js';
import type { StoreRetainedDrawDeps } from './store-retained-immediate.js';
import { TableLayerRenderer } from './table-retained.js';

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

const SHADER_DATA: ShaderData = { vertexShaderPrelude: '', define: '', variantName: 'mercator' };

const CENTER: [number, number] = [139.7, 35.68];
const CELL = 0.003;

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
  const make = (name: string, result: (...args: unknown[]) => unknown) => {
    return (...args: unknown[]) => {
      if (counting) counts.set(name, (counts.get(name) ?? 0) + 1);
      return result(...args);
    };
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
      const fn = make(prop, result);
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

/** The `i`-th feature of a mixed map: a point, a line, a polygon of 5 and one of 50 in turn */
function mixedFeature(n: number, i: number): Feature {
  const columns = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / columns);
  const x = CENTER[0] - (columns * CELL) / 2 + (i % columns) * CELL;
  const y = CENTER[1] - (rows * CELL) / 2 + Math.floor(i / columns) * CELL;
  const s = CELL * 0.8;
  switch (i % 4) {
    case 0:
      return feature(`f${i}`, 'Point', [x + s / 2, y + s / 2]);
    case 1: {
      const line: [number, number][] = [];
      for (let k = 0; k < 10; k++) line.push([x + (s * k) / 9, y + (k % 2 === 0 ? 0 : s)]);
      return feature(`f${i}`, 'LineString', line);
    }
    case 2:
      return feature(`f${i}`, 'Polygon', [
        [
          [x, y],
          [x + s, y],
          [x + s, y + s],
          [x, y + s],
          [x, y],
        ],
      ]);
    default: {
      const ring: [number, number][] = [];
      for (let k = 0; k < 49; k++) {
        const a = (k / 49) * Math.PI * 2;
        ring.push([x + s / 2 + (s / 2) * Math.cos(a), y + s / 2 + (s / 2) * Math.sin(a)]);
      }
      ring.push(ring[0]);
      return feature(`f${i}`, 'Polygon', [ring]);
    }
  }
}

function projection(): ProjectionData {
  return {
    mainMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 0, 0],
    projectionTransition: 0,
    fallbackMatrix: new Float32Array(16),
  } as unknown as ProjectionData;
}

/** The real renderers on the counting GL */
function realRenderers(gl: WebGL2RenderingContext, terrain: TerrainContext) {
  const ledger = new GpuLedger();
  const point = new PointInstanceRenderer({} as MapLibreMap, gl, ledger, 1, terrain);
  const line = new SDFLineRenderer({} as MapLibreMap, gl, ledger, 1, terrain);
  const polygon = new SDFPolygonRenderer(gl, { terrain, gpu: ledger }, 1);
  point.ensureShader(SHADER_DATA);
  line.ensureShader(SHADER_DATA);
  polygon.ensureShader(SHADER_DATA);
  const renderers: RetainedRendererSet = {
    point,
    line,
    polygon,
    styles: createTestDrawer(),
    viewport: () => [gl.drawingBufferWidth, gl.drawingBufferHeight],
    // The run of the retained draws, as the engine gives it (BatchManager.getRetainedRenderers)
    run: retainedDrawRun(gl),
  };
  const camera = (zoom: number, projectionData: ProjectionData): void => {
    const offset = calculateOffsetUniforms(CENTER, projectionData);
    point.setOffsetUniforms(offset);
    point.setProjectionData(projectionData);
    line.setOffsetUniforms(offset);
    polygon.setOffsetUniforms(offset);
    void zoom;
  };
  return { renderers, ledger, camera, point, line, polygon, run: renderers.run };
}

function drawCount(counts: Map<string, number>): number {
  return (counts.get('drawArraysInstanced') ?? 0) + (counts.get('drawElements') ?? 0);
}

function total(counts: Map<string, number>): number {
  let sum = 0;
  for (const value of counts.values()) sum += value;
  return sum;
}

function breakdown(counts: Map<string, number>, draws: number): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => `${name} ${(value / draws).toFixed(2)}`)
    .join(', ');
}

describe('the GL calls per draw', () => {
  it('of 10,000 mixed features held as rows', () => {
    const n = 10_000;
    const features: Feature[] = [];
    for (let i = 0; i < n; i++) features.push(mixedFeature(n, i));
    const { internals, table } = tablesOfFeatures('layer', features);
    const mock = countingGL();
    const terrain = new TerrainContext();
    const { renderers, camera, ledger } = realRenderers(mock.gl, terrain);
    const deps: StoreRetainedDrawDeps = {
      renderers,
      batchManager: { beginFrame: () => {}, processFeature: () => true, endFrame: () => {} },
      customRenderers: new Map(),
      customRendererContext: {} as never,
      companions: createFeatureCompanionRegistry(),
    };
    const tableRenderer = new TableLayerRenderer({
      ledger: new GpuLedger(),
      gl: mock.gl,
      terrain,
      requestRepaint: () => {},
      buildBudgetMs: Number.POSITIVE_INFINITY,
    });
    const frame = (): void => {
      beginRenderFrame();
      const projectionData = projection();
      camera(14, projectionData);
      tableRenderer.beginFrame();
      tableRenderer.drawLayer(
        internals,
        table,
        LAYER,
        { projectionData, zoom: 14, bounds: undefined },
        deps,
      );
      tableRenderer.endFrame();
    };
    frame(); // builds
    mock.start();
    frame();
    const counts = mock.stop();
    const draws = drawCount(counts);
    const perDraw = total(counts) / draws;
    const held = ledger.snapshot().byOwner;
    console.log(
      `[rows] GPU held: lines ${held.lines} B, points ${held.points} B, polygons ${held.polygons} B`,
    );
    console.log(
      `[rows] draws ${draws}, GL calls ${total(counts)}, per draw ${perDraw.toFixed(2)}\n  ${breakdown(counts, draws)}`,
    );
    expect(draws).toBe(7500);
    // A draw of a range: its program (the kinds alternate), its vertex array, the shift of its
    // origin, the draw, and for a line its coordinates (26 calls before the run and the records)
    expect(perDraw).toBeLessThan(5);
  });

  it('of 10,000 mixed features held as rows, drawn in one draw per chunk', () => {
    const n = 10_000;
    const features: Feature[] = [];
    for (let i = 0; i < n; i++) features.push(mixedFeature(n, i));
    const { internals, table } = tablesOfFeatures('layer', features);
    const mock = countingGL();
    const terrain = new TerrainContext();
    const { renderers, camera, ledger } = realRenderers(mock.gl, terrain);
    const rows = new RowsRenderer(null, mock.gl, ledger, 1, terrain);
    rows.ensureShader(SHADER_DATA);
    const deps: StoreRetainedDrawDeps = {
      renderers: { ...renderers, rows },
      batchManager: { beginFrame: () => {}, processFeature: () => true, endFrame: () => {} },
      customRenderers: new Map(),
      customRendererContext: {} as never,
      companions: createFeatureCompanionRegistry(),
    };
    const tableRenderer = new TableLayerRenderer({
      gl: mock.gl,
      terrain,
      ledger,
      requestRepaint: () => {},
      buildBudgetMs: Number.POSITIVE_INFINITY,
    });
    const frame = (): void => {
      tableRenderer.prerender();
      beginRenderFrame();
      const projectionData = projection();
      camera(14, projectionData);
      rows.setOffsetUniforms(calculateOffsetUniforms(CENTER, projectionData));
      tableRenderer.beginFrame();
      tableRenderer.drawLayer(
        internals,
        table,
        LAYER,
        { projectionData, zoom: 14, bounds: undefined },
        deps,
      );
      tableRenderer.endFrame();
    };
    frame(); // packs
    frame(); // writes before the main pass, draws
    mock.start();
    frame();
    const counts = mock.stop();
    const draws = drawCount(counts);
    const held = ledger.snapshot().byOwner;
    console.log(
      `[one draw] GPU held: rows ${held.rows} B, row-state ${held['row-state'] ?? 0} B, by kind ${(held.points ?? 0) + (held.lines ?? 0) + (held.polygons ?? 0)} B`,
    );
    console.log(
      `[one draw] draws ${draws}, GL calls ${total(counts)}, per draw ${(total(counts) / draws).toFixed(2)}\n  ${breakdown(counts, draws)}`,
    );
    // The textures of the state of the rows are counted
    expect(held['row-state'] ?? 0).toBeGreaterThan(0);
    // A chunk per 40,000 coordinates or per group: a few draws rather than 7,500
    expect(draws).toBeGreaterThan(0);
    expect(draws).toBeLessThan(20);
    // Nothing is held by the renderers by kind for the rows
    expect(held.lines ?? 0).toBeLessThan(10_000);
    expect(held.polygons ?? 0).toBe(0);
  });

  it('of the retained batches of the Store and the datasets, interleaved', () => {
    const mock = countingGL();
    const terrain = new TerrainContext();
    const { point, line, polygon, camera, run } = realRenderers(mock.gl, terrain);
    const n = 3_000;
    const batches: Array<() => void> = [];
    let projectionData = projection();
    for (let i = 0; i < n; i++) {
      const f = mixedFeature(n, i);
      const at = (i % 4) as 0 | 1 | 2 | 3;
      if (at === 0) {
        const coord = (f.geometry as { coordinates: unknown }).coordinates as [number, number];
        const batch = point.buildRetained(
          [
            {
              coord,
              fillColor: [1, 0, 0, 1],
              fillSize: 4,
              strokeColor: [0, 0, 0, 1],
              strokeWidth: 1,
            },
          ],
          'circle',
        );
        if (batch) batches.push(() => point.drawRetained(batch, projectionData));
      } else if (at === 1) {
        const coords = (f.geometry as { coordinates: unknown }).coordinates as [number, number][];
        const batch = line.buildRetainedBatch(
          [
            {
              coords,
              featureId: f.id,
              closed: false,
              strokeWidth: -2,
              createdZoom: 0,
              color: [0, 0, 1, 1],
              opacity: 1,
            },
          ],
          { lineStyle: 'solid' },
        );
        if (batch) batches.push(() => line.drawRetainedBatch(batch, 14, projectionData));
      } else {
        const ring = (
          (f.geometry as { coordinates: unknown }).coordinates as [number, number][][]
        )[0];
        const batch = polygon.buildRetained([
          {
            coordinates: [ring],
            style: {
              fillColor: [0, 1, 0, 1],
              fillOpacity: 0.5,
              strokeColor: [0, 0, 0, 1],
              strokeWidth: -1,
              strokeOpacity: 1,
            },
            createdZoom: 0,
            featureId: f.id,
          },
        ]);
        if (batch) {
          batches.push(() => polygon.drawRetained(batch, 14, projectionData, [1280, 800]));
        }
      }
    }
    const frame = (): void => {
      beginRenderFrame();
      projectionData = projection();
      camera(14, projectionData);
      // As the Store and the datasets draw the chunks of a layer: as one run
      run?.begin();
      for (const draw of batches) draw();
      run?.end();
    };
    frame();
    mock.start();
    frame();
    const counts = mock.stop();
    const draws = drawCount(counts);
    console.log(
      `[store] draws ${draws}, GL calls ${total(counts)}, per draw ${(total(counts) / draws).toFixed(2)}\n  ${breakdown(counts, draws)}`,
    );
    expect(draws).toBe(n);
    // 5.5 calls per draw before the run (the vertex array unbound after every draw)
    expect(total(counts) / draws).toBeLessThan(4.5);
  });
});
