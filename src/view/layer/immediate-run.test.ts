// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The features drawn at once in the middle of a run of retained draws
 *
 * The features that cannot be retained are drawn at once among the retained chunks of a layer.
 * Some of the renderers drawing them use their program directly, without the run of the retained
 * draws (`draw-run.ts`) knowing: a dashed line, the fill of a polygon with a dashed outline and
 * then its outline make line, fill, line. Every draw must be made with the program of the
 * renderer that makes it, whatever the run remembered before.
 *
 * The real renderers and the real immediate mode draw on a GL that records its calls, through
 * the three places that draw at once in the middle of a run: the chunks of the Store, the chunks
 * of rows drawn by kind, and the chunks of rows drawn by kind while those drawn in one draw are
 * not built yet.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { FrameDrawContext } from '../../extension/index.js';
import type { Store } from '../../store/store.js';
import type { Feature, Layer } from '../../store/types.js';
import { createTestDrawer, feature, tablesOfFeatures } from '../../test-utils.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { createBatchManager } from '../renderers/batch-manager.js';
import { SDFLineRenderer } from '../renderers/line/sdf-line.js';
import { PointInstanceRenderer } from '../renderers/point/point-instance.js';
import { PolygonBatchRenderer } from '../renderers/polygon/batch.js';
import { SDFPolygonRenderer } from '../renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import { RowsRenderer } from '../renderers/rows/rows-renderer.js';
import { beginRenderFrame } from '../shaders/frame.js';
import { calculateOffsetUniforms, type ShaderData } from '../shaders/helpers.js';
import { TerrainContext } from '../terrain/context.js';
import { StoreRetainedCache, type StoreRetainedDrawDeps } from './store-retained.js';
import { TableLayerRenderer } from './table-retained.js';

const SHADER_DATA: ShaderData = { vertexShaderPrelude: '', define: '', variantName: 'mercator' };

const CENTER: [number, number] = [139.7, 35.68];

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

interface Call {
  name: string;
  args: unknown[];
  result: unknown;
}

/** A GL that records its calls in order, with what they returned */
function recordingGL() {
  const calls: Call[] = [];
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
      const fn = (...args: unknown[]): unknown => {
        const result = prop.startsWith('create')
          ? { id: next++, kind: prop }
          : (results[prop]?.(...args) ?? undefined);
        calls.push({ name: prop, args, result });
        return result;
      };
      t[prop] = fn;
      return fn;
    },
  }) as unknown as WebGL2RenderingContext;
  return { gl, calls };
}

type Recording = ReturnType<typeof recordingGL>;

/** The programs created while `make` runs */
function programsOf(mock: Recording, make: () => void): Set<unknown> {
  const from = mock.calls.length;
  make();
  return new Set(
    mock.calls
      .slice(from)
      .filter((call) => call.name === 'createProgram')
      .map((call) => call.result),
  );
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

/** The real renderers and the real immediate mode on the recording GL */
function setup(options: { rows?: boolean } = {}) {
  const mock = recordingGL();
  const gl = mock.gl;
  const terrain = new TerrainContext();
  const point = new PointInstanceRenderer({} as MapLibreMap, gl, 1, terrain);
  const line = new SDFLineRenderer({} as MapLibreMap, gl, 1, terrain);
  const polygon = new SDFPolygonRenderer(gl, 1, { terrain });
  const fill = new PolygonBatchRenderer(gl, { terrain });
  point.ensureShader(SHADER_DATA);
  const linePrograms = programsOf(mock, () => line.ensureShader(SHADER_DATA));
  polygon.ensureShader(SHADER_DATA);
  const fillPrograms = programsOf(mock, () => fill.ensureShader(SHADER_DATA));
  const rows = options.rows ? new RowsRenderer(null, gl, 1, terrain) : undefined;
  rows?.ensureShader(SHADER_DATA);
  const manager = createBatchManager({
    gl,
    featureDrawer: createTestDrawer(),
    pointInstanceRenderer: point,
    sdfLineRenderer: line,
    polygonBatchRenderer: fill,
    sdfPolygonRenderer: polygon,
    rowsRenderer: rows,
    terrain,
  });
  const renderers = manager.getRetainedRenderers() as RetainedRendererSet;
  const deps: StoreRetainedDrawDeps = {
    renderers,
    batchManager: manager,
    customRenderers: new Map(),
    customRendererContext: {} as FrameDrawContext,
    companions: createFeatureCompanionRegistry(),
  };
  const camera = (projectionData: ProjectionData): void => {
    const offset = calculateOffsetUniforms(
      CENTER,
      projectionData.mainMatrix as unknown as Float32Array,
    );
    point.setOffsetUniforms(offset);
    point.setProjectionData(projectionData);
    line.setOffsetUniforms(offset);
    polygon.setOffsetUniforms(offset);
    fill.setOffsetUniforms(offset);
    rows?.setOffsetUniforms(offset);
  };

  /**
   * The draws made since the call `from`, each with whether the program in use at the draw is
   * the one of the renderer that makes it (lines draw instanced, the fills in elements)
   */
  const draws = (from: number) => {
    let program: unknown = null;
    const made: Array<{ kind: 'line' | 'fill'; own: boolean }> = [];
    mock.calls.forEach((call, i) => {
      if (call.name === 'useProgram') program = call.args[0];
      if (i < from) return;
      if (call.name === 'drawArraysInstanced') {
        made.push({ kind: 'line', own: linePrograms.has(program) });
      } else if (call.name === 'drawElements') {
        made.push({ kind: 'fill', own: fillPrograms.has(program) });
      }
    });
    return made;
  };

  return { mock, terrain, deps, camera, draws };
}

/** A dashed line, a dotted line and a polygon with a dashed outline, in this order */
function scene(): Feature[] {
  const [x, y] = CENTER;
  return [
    feature(
      'dashed',
      'LineString',
      [
        [x - 0.01, y],
        [x + 0.01, y],
      ],
      { style: { lineStyle: 'dashed', strokeWidth: 4 } },
    ),
    feature(
      'dotted',
      'LineString',
      [
        [x - 0.01, y + 0.005],
        [x + 0.01, y + 0.005],
      ],
      { style: { lineStyle: 'dotted', strokeWidth: 6 } },
    ),
    feature(
      'polygon',
      'Polygon',
      [
        [
          [x - 0.01, y - 0.01],
          [x + 0.01, y - 0.01],
          [x + 0.01, y - 0.005],
          [x - 0.01, y - 0.005],
          [x - 0.01, y - 0.01],
        ],
      ],
      { style: { lineStyle: 'dashed', fillColor: '#ff0000', fillOpacity: 0.5 } },
    ),
  ];
}

/** The draws of the scene (the two lines, the fill, the dashed outline), each with its program */
const SCENE_DRAWS = [
  { kind: 'line', own: true },
  { kind: 'fill', own: true },
  { kind: 'line', own: true },
];

describe('the features drawn at once among the retained chunks', () => {
  it('of the Store are drawn each with the program of its renderer', () => {
    const { mock, deps, camera, draws } = setup();
    const features = scene();
    const store = {
      getFeature: (id: string) => features.find((f) => f.id === id),
      listFeaturesInOrder: () => [...features],
      getLayer: () => LAYER,
      getGroup: () => undefined,
      isHidden: () => false,
      listHidden: () => new Set<string>(),
    } as unknown as Store;
    const cache = new StoreRetainedCache(store);
    const frame = (): number => {
      beginRenderFrame();
      const projectionData = projection();
      camera(projectionData);
      const from = mock.calls.length;
      cache.beginFrame(deps.companions);
      cache.drawLayer('layer', LAYER, projectionData, 14, deps);
      return from;
    };
    frame();
    const made = draws(frame());
    expect(made).toEqual(SCENE_DRAWS);
  });

  it('of the rows drawn by kind are drawn each with the program of its renderer', () => {
    const { mock, terrain, deps, camera, draws } = setup();
    const { internals, table } = tablesOfFeatures('layer', scene());
    const tableRenderer = new TableLayerRenderer({
      gl: mock.gl,
      terrain,
      requestRepaint: () => {},
      buildBudgetMs: Number.POSITIVE_INFINITY,
    });
    const frame = (): number => {
      beginRenderFrame();
      const projectionData = projection();
      camera(projectionData);
      const from = mock.calls.length;
      tableRenderer.beginFrame();
      tableRenderer.drawLayer(
        internals,
        table,
        LAYER,
        { projectionData, zoom: 14, bounds: undefined },
        deps,
      );
      tableRenderer.endFrame();
      return from;
    };
    frame();
    const made = draws(frame());
    expect(made).toEqual(SCENE_DRAWS);
  });

  it('of the rows drawn by kind while those in one draw are built are drawn each with the program of its renderer', () => {
    const { mock, terrain, deps, camera, draws } = setup({ rows: true });
    const { internals, table } = tablesOfFeatures('layer', scene());
    const tableRenderer = new TableLayerRenderer({
      gl: mock.gl,
      terrain,
      requestRepaint: () => {},
      buildBudgetMs: Number.POSITIVE_INFINITY,
    });
    const frame = (): number => {
      tableRenderer.prerender();
      beginRenderFrame();
      const projectionData = projection();
      camera(projectionData);
      const from = mock.calls.length;
      tableRenderer.beginFrame();
      tableRenderer.drawLayer(
        internals,
        table,
        LAYER,
        { projectionData, zoom: 14, bounds: undefined },
        deps,
      );
      tableRenderer.endFrame();
      return from;
    };
    // The rows are drawn by kind, then in one draw: the first frame of the drawing in one draw
    // builds its chunks and draws the group with the chunks by kind, as they are
    tableRenderer.setDrawingByKind(true);
    frame();
    tableRenderer.setDrawingByKind(false);
    const made = draws(frame());
    expect(made).toEqual(SCENE_DRAWS);
  });
});
