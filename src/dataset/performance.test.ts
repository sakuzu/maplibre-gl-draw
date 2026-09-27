// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cost suite of the datasets
 *
 * With a static dataset of 50,000 features, it confirms the shape of the cost of retained
 * mode: the first frame builds batches only for the chunks in view, and the frames after it
 * build nothing and only draw the batches already built. The cost is judged by counting the
 * builds, the features handed to the builds and the draws, not by wall-clock time, so the
 * result does not depend on the machine or on the load of parallel test runs.
 *
 * The building of the chunks is sliced by a time budget, so the clock is frozen: every visible
 * chunk is then built in the first frame, whatever the speed of the machine.
 */

import type { ProjectionData } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../shared/config/feature-style.js';
import type { BoundingBox, StyleRule } from '../store/types.js';
import { toRow } from '../test-utils.js';
import { FeatureDrawer } from '../view/renderers/drawer.js';
import type { ImageRenderer } from '../view/renderers/image.js';
import type { RetainedLineBatch } from '../view/renderers/line/line-types.js';
import type { SDFLineRenderer } from '../view/renderers/line/sdf-line.js';
import type { RetainedPointBatch } from '../view/renderers/point/point-instance.js';
import type { PointShapeRenderer } from '../view/renderers/point/point-shape.js';
import type {
  RetainedPolygonBatch,
  SDFPolygonBatchData,
} from '../view/renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet } from '../view/renderers/retained.js';
import type { DisplayBatchTarget } from './dataset.js';
import { createDatasetManager } from './manager.js';
import type { DatasetRow } from './types.js';

/**
 * A stub that has only the GL that StrokeRenderer / FillShaderManager call when FeatureDrawer is
 * built
 */
function createStubGL(): WebGL2RenderingContext {
  return {
    createBuffer: (): object => ({}),
    createVertexArray: (): object => ({}),
    bindBuffer: (): void => {},
    bindVertexArray: (): void => {},
    enableVertexAttribArray: (): void => {},
    vertexAttribPointer: (): void => {},
  } as unknown as WebGL2RenderingContext;
}

/** Total number of features */
const TOTAL = 50_000;
/** Number of columns of the grid (TOTAL / COLUMNS becomes the number of rows) */
const COLUMNS = 250;
/** Spacing of the grid (degrees) */
const STEP = 0.1;
/** The columns and rows assumed to be inside the viewport */
const VISIBLE_COLUMNS = 50;
const VISIBLE_ROWS = 100;

/**
 * Generates small polygons laid out in a grid
 *
 * The attribute pop is used to evaluate the style rule (graduated).
 */
function createGrid(): DatasetRow[] {
  const features: DatasetRow[] = new Array(TOTAL);
  const half = STEP * 0.4;

  for (let i = 0; i < TOTAL; i++) {
    const col = i % COLUMNS;
    const row = Math.floor(i / COLUMNS);
    const lng = col * STEP;
    const lat = row * STEP;

    features[i] = toRow({
      id: `f${i}`,
      type: 'Polygon',
      coordinates: [
        [
          [lng, lat],
          [lng + half, lat],
          [lng + half, lat + half],
          [lng, lat + half],
          [lng, lat],
        ],
      ],
      properties: { pop: i % 1000 },
    });
  }

  return features;
}

/**
 * A retained-mode draw target without GPU resources (it counts the builds, the features handed
 * to the builds, the draws and the features drawn)
 */
function createRetainedTarget(): {
  target: DisplayBatchTarget;
  builds: () => number;
  builtFeatures: () => number;
  drawnBatches: () => number;
  drawnFeatures: () => number;
  immediateFeatures: () => number;
  reset: () => void;
} {
  let builds = 0;
  let builtFeatures = 0;
  let drawnBatches = 0;
  let drawnFeatures = 0;

  const renderers: RetainedRendererSet = {
    polygon: {
      buildRetained: (polygons: SDFPolygonBatchData[]): RetainedPolygonBatch => {
        builds++;
        builtFeatures += polygons.length;
        return { indexCount: polygons.length } as unknown as RetainedPolygonBatch;
      },
      drawRetained: (batch): void => {
        drawnBatches++;
        drawnFeatures += (batch as unknown as { indexCount: number }).indexCount;
      },
      disposeRetained: (): void => {},
    },
    line: {
      buildRetainedBatch: (): RetainedLineBatch => {
        builds++;
        return {} as RetainedLineBatch;
      },
      drawRetainedBatch: (): void => {
        drawnBatches++;
      },
      disposeRetainedBatch: (): void => {},
    },
    point: {
      buildRetained: (): RetainedPointBatch => {
        builds++;
        return {} as RetainedPointBatch;
      },
      drawRetained: (): void => {
        drawnBatches++;
      },
      disposeRetained: (): void => {},
    },
    styles: new FeatureDrawer({
      gl: createStubGL(),
      map: {} as never,
      sdfLineRenderer: {} as SDFLineRenderer,
      pointShapeRenderer: {} as PointShapeRenderer,
      imageRenderer: {} as ImageRenderer,
      featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
    }),
    viewport: (): [number, number] => [1920, 1080],
  };

  const target: DisplayBatchTarget = {
    beginFrame: vi.fn(),
    processFeature: vi.fn(() => false),
    endFrame: vi.fn(),
    getRetainedRenderers: () => renderers,
  };

  return {
    target,
    builds: () => builds,
    builtFeatures: () => builtFeatures,
    drawnBatches: () => drawnBatches,
    drawnFeatures: () => drawnFeatures,
    immediateFeatures: () => vi.mocked(target.processFeature).mock.calls.length,
    reset: () => {
      drawnBatches = 0;
      drawnFeatures = 0;
    },
  };
}

describe('the cost of a dataset', () => {
  // Freeze the clock that slices the chunk builds, so that the first frame builds every visible
  // chunk regardless of the speed of the machine
  beforeEach(() => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rule: StyleRule = {
    kind: 'graduated',
    property: 'pop',
    breaks: [200, 400, 600, 800],
    colors: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b'],
    other: '#cccccc',
  };

  it(`${TOTAL} features: only the chunks in view are built, and later frames only draw`, () => {
    // The viewport covers only a part of the grid (5,000 features are expected to be visible)
    const bounds: BoundingBox = {
      minX: -0.01,
      minY: -0.01,
      maxX: (VISIBLE_COLUMNS - 1) * STEP + 0.01,
      maxY: (VISIBLE_ROWS - 1) * STEP + 0.01,
    };

    const manager = createDatasetManager({
      getViewportBounds: () => bounds,
      getZoom: () => 10,
      onViewportChange: () => () => {},
      requestRepaint: () => {},
    });

    const probe = createRetainedTarget();
    manager.add({ id: 'bulk', rows: createGrid(), styleRule: rule });

    // The first frame (the retained batches of the visible chunks are built)
    manager.draw('below-store', probe.target, {} as ProjectionData, 10);
    const builds = probe.builds();
    const builtFeatures = probe.builtFeatures();
    const drawnBatches = probe.drawnBatches();
    const drawnFeatures = probe.drawnFeatures();

    // Every batch built is drawn, and only the features of the chunks in view are handed to the
    // builds. The culling is per chunk, so it is a coarse set that contains the 5,000 visible
    // features but stays far from the whole dataset
    expect(builds).toBeGreaterThan(0);
    expect(drawnBatches).toBe(builds);
    expect(drawnFeatures).toBe(builtFeatures);
    expect(builtFeatures).toBeGreaterThanOrEqual(VISIBLE_COLUMNS * VISIBLE_ROWS);
    expect(builtFeatures).toBeLessThan(TOTAL / 2);
    expect(probe.immediateFeatures()).toBe(0);

    // The frames after it build nothing and draw the same batches (no per-feature work)
    for (let i = 0; i < 3; i++) {
      probe.reset();
      manager.draw('below-store', probe.target, {} as ProjectionData, 10);
      expect(probe.builds()).toBe(builds);
      expect(probe.builtFeatures()).toBe(builtFeatures);
      expect(probe.drawnBatches()).toBe(drawnBatches);
      expect(probe.drawnFeatures()).toBe(drawnFeatures);
    }
    expect(probe.immediateFeatures()).toBe(0);
  });

  it(`nothing is built or drawn outside the view even with ${TOTAL} features`, () => {
    const bounds: BoundingBox = { minX: 170, minY: 70, maxX: 179, maxY: 80 };
    const manager = createDatasetManager({
      getViewportBounds: () => bounds,
      getZoom: () => 10,
      onViewportChange: () => () => {},
      requestRepaint: () => {},
    });
    manager.add({ id: 'bulk', rows: createGrid(), styleRule: rule });

    const probe = createRetainedTarget();
    manager.draw('below-store', probe.target, {} as ProjectionData, 10);

    expect(probe.builds()).toBe(0);
    expect(probe.builtFeatures()).toBe(0);
    expect(probe.drawnBatches()).toBe(0);
    expect(probe.immediateFeatures()).toBe(0);
  });
});
