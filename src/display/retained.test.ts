// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the retained-mode rendering of a dataset
 *
 * The GPU resources are counted with mock renderers. What is pinned down here is "when things
 * are built", "what is drawn" and "when things are released", not the GL calls themselves (it is
 * kept to what can be verified in an environment without GL).
 */

import type { ProjectionData } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../shared/config/feature-style.js';
import { SELECTION_HIGHLIGHT_COLOR } from '../shared/config/selection-highlight.js';
import type { PixelRatioInput } from '../shared/utils/pixel-ratio.js';
import { createPixelRatioSource } from '../shared/utils/pixel-ratio.js';
import type { BoundingBox, Feature, StyleRule } from '../store/types.js';
import type { RetainedDrawFactors } from '../view/renderers/draw-factors.js';
import { FeatureDrawer } from '../view/renderers/drawer.js';
import type { ImageRenderer } from '../view/renderers/image.js';
import type { LineBatchItem, RetainedLineBatch } from '../view/renderers/line/line-types.js';
import type { SDFLineRenderer } from '../view/renderers/line/sdf-line.js';
import type {
  PointInstanceDataFull,
  PointShape,
  RetainedPointBatch,
} from '../view/renderers/point/point-instance.js';
import type { PointShapeRenderer } from '../view/renderers/point/point-shape.js';
import type {
  RetainedPolygonBatch,
  SDFPolygonBatchData,
} from '../view/renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet } from '../view/renderers/retained.js';
import { clearAnchorFrame, setAnchorFrame } from '../view/terrain/anchor.js';
import { TerrainContext } from '../view/terrain/context.js';
import type { TerrainLike } from '../view/terrain/detect.js';
import { setDrapePaintedDatasets } from '../view/terrain/state.js';
import type { DisplayBatchTarget } from './dataset.js';

/** The terrain state of the draw instance the probes draw into */
const terrain = new TerrainContext();

import { createDatasetManager, type DatasetManager } from './manager.js';
import {
  collectFeatureArray,
  createChunkBuildJob,
  PackedLinesBuilder,
  unpackLines,
} from './retained.js';
import type { DatasetFeatureInput, DatasetOptions } from './types.js';
import { normalizeDisplayFeature } from './types.js';

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

/** Viewport covering the whole globe */
const WORLD: BoundingBox = { minX: -180, minY: -85, maxX: 180, maxY: 85 };

/** Mock of a retained batch */
interface MockBatch {
  kind: 'polygon' | 'line' | 'point';
  /** The features that went onto the batch (a point only has a style, so just the count) */
  ids: string[];
  count: number;
  origin: [number, number] | undefined;
}

/**
 * A mock of the full set of retained-mode renderers, and the draw target that returns it
 */
interface RetainedProbe {
  target: DisplayBatchTarget;
  /** The mock set of renderers (for tests that call the build directly) */
  renderers: RetainedRendererSet;
  /** The batches that were built (in build order) */
  built: MockBatch[];
  /** The batches that were released (in release order) */
  disposed: MockBatch[];
  /** The batches that were drawn (in draw order; they accumulate across frames) */
  drawn: MockBatch[];
  /** The factors passed at draw time (in the same order as drawn) */
  drawnFactors: Array<RetainedDrawFactors | undefined>;
  /** The features that went to immediate mode */
  immediate: Feature[];
  /** Clears the records (the records of the builds are kept) */
  resetDrawn(): void;
}

function createRetainedProbe(): RetainedProbe {
  const built: MockBatch[] = [];
  const disposed: MockBatch[] = [];
  const drawn: MockBatch[] = [];
  const drawnFactors: Array<RetainedDrawFactors | undefined> = [];
  const immediate: Feature[] = [];

  const record = (batch: MockBatch): MockBatch => {
    built.push(batch);
    return batch;
  };

  const renderers: RetainedRendererSet = {
    polygon: {
      buildRetained: (polygons: SDFPolygonBatchData[], options): RetainedPolygonBatch =>
        record({
          kind: 'polygon',
          ids: polygons.map((p) => p.featureId ?? ''),
          count: polygons.length,
          origin: options?.origin,
        }) as unknown as RetainedPolygonBatch,
      drawRetained: (batch, _zoom, _projectionData, _viewport, factors): void => {
        drawn.push(batch as unknown as MockBatch);
        drawnFactors.push(factors);
      },
      disposeRetained: (batch): void => {
        disposed.push(batch as unknown as MockBatch);
      },
    },
    line: {
      buildRetainedBatch: (items: LineBatchItem[], _shape, options): RetainedLineBatch =>
        record({
          kind: 'line',
          ids: items.map((item) => item.featureId),
          count: items.length,
          origin: options?.origin,
        }) as unknown as RetainedLineBatch,
      drawRetainedBatch: (batch, _zoom, _projectionData, factors): void => {
        drawn.push(batch as unknown as MockBatch);
        drawnFactors.push(factors);
      },
      disposeRetainedBatch: (batch): void => {
        disposed.push(batch as unknown as MockBatch);
      },
    },
    point: {
      buildRetained: (points: PointInstanceDataFull[], _shape: PointShape, options) =>
        record({
          kind: 'point',
          ids: [],
          count: points.length,
          origin: options?.origin,
        }) as unknown as RetainedPointBatch,
      drawRetained: (batch, _zoom, _projectionData, factors): void => {
        drawn.push(batch as unknown as MockBatch);
        drawnFactors.push(factors);
      },
      disposeRetained: (batch): void => {
        disposed.push(batch as unknown as MockBatch);
      },
    },
    styles: new FeatureDrawer({
      gl: createStubGL(),
      map: {} as never,
      sdfLineRenderer: {} as SDFLineRenderer,
      pointShapeRenderer: {} as PointShapeRenderer,
      imageRenderer: {} as ImageRenderer,
      featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
    }),
    viewport: (): [number, number] => [800, 600],
  };

  const target: DisplayBatchTarget = {
    beginFrame: vi.fn(),
    processFeature: (feature: Feature): boolean => {
      immediate.push(feature);
      return false;
    },
    endFrame: vi.fn(),
    getRetainedRenderers: () => renderers,
    getTerrain: () => terrain,
  };

  return {
    renderers,
    target,
    built,
    disposed,
    drawn,
    drawnFactors,
    immediate,
    resetDrawn: (): void => {
      drawn.length = 0;
      drawnFactors.length = 0;
      immediate.length = 0;
    },
  };
}

function createManager(
  bounds: BoundingBox = WORLD,
  pixelRatio?: PixelRatioInput,
): {
  manager: DatasetManager;
  setBounds: (next: BoundingBox) => void;
  viewportChanged: () => void;
} {
  let currentBounds = bounds;
  let handler: (() => void) | null = null;

  const manager = createDatasetManager({
    getViewportBounds: () => currentBounds,
    getZoom: () => 10,
    onViewportChange: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    requestRepaint: () => {},
    providerDebounceMs: 0,
    pixelRatio,
  });

  return {
    manager,
    setBounds: (next: BoundingBox) => {
      currentBounds = next;
    },
    viewportChanged: () => handler?.(),
  };
}

/** Waits for the debounce and the resolution of the promises */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await Promise.resolve();
}

function add(manager: DatasetManager, options: DatasetOptions): ReturnType<DatasetManager['add']> {
  return manager.add(options);
}

/** Draws one frame */
function drawFrame(manager: DatasetManager, probe: RetainedProbe): void {
  manager.draw('below-store', probe.target, {} as ProjectionData, 10);
}

/** A small square polygon */
function polygon(id: string, lng: number, lat = 0, extra?: Partial<Feature>): DatasetFeatureInput {
  return {
    id,
    type: 'Polygon',
    coordinates: [
      [
        [lng, lat],
        [lng + 0.5, lat],
        [lng + 0.5, lat + 0.5],
        [lng, lat + 0.5],
        [lng, lat],
      ],
    ],
    ...extra,
  };
}

function point(id: string, lng: number, lat = 0): DatasetFeatureInput {
  return { id, type: 'Point', coordinates: [lng, lat] };
}

function line(id: string, lng: number, extra?: Partial<Feature>): DatasetFeatureInput {
  return {
    id,
    type: 'LineString',
    coordinates: [
      [lng, 0],
      [lng + 1, 1],
    ],
    ...extra,
  };
}

/** Polygons in a grid (enough of them to cause a chunk split) */
function createGrid(count: number, columns = 40): DatasetFeatureInput[] {
  const features: DatasetFeatureInput[] = new Array(count);
  for (let i = 0; i < count; i++) {
    features[i] = polygon(`f${i}`, (i % columns) * 1, Math.floor(i / columns) * 1);
  }
  return features;
}

describe('the build and drawing of retained mode', () => {
  it('the build happens once and a frame only draws', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: [polygon('a', 0), polygon('b', 1)] });

    drawFrame(manager, probe);
    const buildsAfterFirst = probe.built.length;
    const drawsAfterFirst = probe.drawn.length;

    drawFrame(manager, probe);
    drawFrame(manager, probe);

    expect(buildsAfterFirst).toBe(1);
    expect(probe.built).toHaveLength(1);
    expect(probe.drawn).toHaveLength(drawsAfterFirst * 3);
  });

  it('the batches are split per kind and drawn in the order polygon → line → point', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: [point('pt', 0), line('ln', 0), polygon('pg', 0)] });

    drawFrame(manager, probe);

    expect(probe.drawn.map((b) => b.kind)).toEqual(['polygon', 'line', 'point']);
    expect(probe.drawn[0].ids).toEqual(['pg']);
    expect(probe.drawn[1].ids).toEqual(['ln']);
    expect(probe.drawn[2].count).toBe(1);
  });

  it('a feature with visible: false does not go onto a batch', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, {
      id: 'c1',
      features: [polygon('hidden', 0, 0, { visible: false }), polygon('shown', 1)],
    });

    drawFrame(manager, probe);

    expect(probe.drawn).toHaveLength(1);
    expect(probe.drawn[0].ids).toEqual(['shown']);
  });

  it('the colors of the style rule are resolved at build time', () => {
    const rule: StyleRule = { kind: 'single', color: '#ff0000' };
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', styleRule: rule, features: [polygon('p', 0)] });

    drawFrame(manager, probe);

    // The rule color goes onto the fill (#ff0000)
    const built = probe.built[0] as unknown as MockBatch;
    expect(built.kind).toBe('polygon');
    expect(built.ids).toEqual(['p']);
  });

  it('a feature that cannot be retained (a dashed line) goes to immediate mode', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, {
      id: 'c1',
      features: [line('dashed', 0, { style: { lineStyle: 'dashed' } }), line('solid', 5)],
    });

    drawFrame(manager, probe);

    expect(probe.immediate.map((f) => f.id)).toEqual(['dashed']);
    const lineBatches = probe.drawn.filter((b) => b.kind === 'line');
    expect(lineBatches).toHaveLength(1);
    expect(lineBatches[0].ids).toEqual(['solid']);
  });

  it('a MultiPolygon goes onto the batch part by part', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, {
      id: 'c1',
      features: [
        {
          id: 'multi',
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
            [
              [
                [10, 0],
                [11, 0],
                [11, 1],
                [10, 0],
              ],
            ],
          ],
        },
      ],
    });

    drawFrame(manager, probe);

    expect(probe.drawn).toHaveLength(1);
    expect(probe.drawn[0].ids).toEqual(['multi', 'multi']);
  });
});

describe('the chunk culling of retained mode', () => {
  it('only the chunks that intersect the viewport are drawn', () => {
    const features = createGrid(1600);
    const { manager } = createManager({ minX: -0.1, minY: -0.1, maxX: 1, maxY: 1 });
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features });

    drawFrame(manager, probe);

    const drawnFeatures = probe.drawn.reduce((sum, batch) => sum + batch.count, 0);
    // Only the chunks that intersect are drawn, far fewer than all of them
    expect(drawnFeatures).toBeGreaterThan(0);
    expect(drawnFeatures).toBeLessThan(features.length / 2);
    // Only the visible chunks are built (an invisible chunk is not even built)
    expect(probe.built.length).toBeLessThan(4);
  });

  it('moving the viewport changes which chunks are drawn', () => {
    const features = createGrid(1600);
    const { manager, setBounds } = createManager({ minX: -0.1, minY: -0.1, maxX: 1, maxY: 1 });
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features });

    drawFrame(manager, probe);
    const first = probe.drawn.map((b) => b.ids[0]);

    probe.resetDrawn();
    setBounds({ minX: 38, minY: 38, maxX: 39, maxY: 39 });
    drawFrame(manager, probe);
    const second = probe.drawn.map((b) => b.ids[0]);

    expect(second.length).toBeGreaterThan(0);
    expect(second).not.toEqual(first);
  });

  it('nothing is drawn when everything is outside the viewport', () => {
    const { manager } = createManager({ minX: 170, minY: 70, maxX: 179, maxY: 80 });
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: createGrid(1600) });

    drawFrame(manager, probe);

    expect(probe.drawn).toHaveLength(0);
    expect(probe.built).toHaveLength(0);
  });

  it('the origin of a chunk is the center of the bbox of the chunk', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: [polygon('a', 0, 0), polygon('b', 1.5, 1.5)] });

    drawFrame(manager, probe);

    // The bbox is [0, 0] - [2, 2], so the center is [1, 1]
    expect(probe.built[0].origin).toEqual([1, 1]);
  });
});

describe('the invalidation and release of retained mode', () => {
  it('setFeatures releases the retained batches and rebuilds them', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    const dataset = add(manager, { id: 'c1', features: [polygon('a', 0)] });

    drawFrame(manager, probe);
    expect(probe.built).toHaveLength(1);
    expect(probe.disposed).toHaveLength(0);

    dataset.setFeatures([polygon('b', 0), polygon('c', 1)]);
    expect(probe.disposed).toHaveLength(1);

    probe.resetDrawn();
    drawFrame(manager, probe);

    expect(probe.built).toHaveLength(2);
    expect(probe.drawn[0].ids).toEqual(['b', 'c']);
  });

  it('setStyleRule releases the retained batches and rebuilds them', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    const dataset = add(manager, { id: 'c1', features: [polygon('a', 0)] });

    drawFrame(manager, probe);
    dataset.setStyleRule({ kind: 'single', color: '#00ff00' });

    expect(probe.disposed).toHaveLength(1);

    drawFrame(manager, probe);
    expect(probe.built).toHaveLength(2);
  });

  it('applying a provider result releases the retained batches and rebuilds them', async () => {
    const { manager, setBounds, viewportChanged } = createManager({
      minX: -1,
      minY: -1,
      maxX: 1,
      maxY: 1,
    });
    const probe = createRetainedProbe();
    const provider = vi.fn(async () => [polygon('remote', 0)]);
    add(manager, { id: 'c1', provider });

    // Wait for the first fetch to be applied
    await flush();
    expect(provider).toHaveBeenCalledTimes(1);

    drawFrame(manager, probe);
    expect(probe.built).toHaveLength(1);
    expect(probe.drawn[0].ids).toEqual(['remote']);

    // A change of the displayed range calls the provider again, and applying it rebuilds them
    provider.mockImplementation(async () => [polygon('remote2', 50)]);
    setBounds({ minX: 49, minY: -1, maxX: 51, maxY: 1 });
    viewportChanged();
    await flush();

    expect(provider).toHaveBeenCalledTimes(2);
    expect(probe.disposed).toHaveLength(1);

    probe.resetDrawn();
    drawFrame(manager, probe);
    expect(probe.built).toHaveLength(2);
    expect(probe.drawn[0].ids).toEqual(['remote2']);
  });

  it('remove() releases the GPU resources of every chunk (builds and releases match)', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    const dataset = add(manager, { id: 'c1', features: createGrid(1600) });

    drawFrame(manager, probe);
    expect(probe.built.length).toBeGreaterThan(1);

    dataset.remove();

    expect(probe.disposed).toHaveLength(probe.built.length);
    expect(new Set(probe.disposed)).toEqual(new Set(probe.built));
  });

  it('the builds and releases match with manager.destroy() too', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: createGrid(1600) });
    add(manager, { id: 'c2', features: [point('p', 0)] });

    drawFrame(manager, probe);
    manager.destroy();

    expect(probe.disposed).toHaveLength(probe.built.length);
  });

  it('disposeRetained() releases only the GPU resources and rebuilds on the next draw', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: [polygon('a', 0)] });

    drawFrame(manager, probe);
    manager.disposeRetained();

    expect(probe.disposed).toHaveLength(1);

    probe.resetDrawn();
    drawFrame(manager, probe);

    expect(probe.built).toHaveLength(2);
    expect(probe.drawn[0].ids).toEqual(['a']);
  });

  it('a change of devicePixelRatio rebuilds them', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: [polygon('a', 0)] });

    drawFrame(manager, probe);
    expect(probe.built).toHaveLength(1);

    // A change of the display scale changes the conversion to physical pixels, so it is rebuilt
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    try {
      drawFrame(manager, probe);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(probe.disposed).toHaveLength(1);
    expect(probe.built).toHaveLength(2);
  });

  it('a change of the factor of the rendering pixel ratio (renderScale) rebuilds them', () => {
    const source = createPixelRatioSource(3.125);
    const { manager } = createManager(WORLD, source.resolve);
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: [polygon('a', 0)] });

    drawFrame(manager, probe);
    expect(probe.built).toHaveLength(1);

    // Nothing is rebuilt while the factor stays the same
    drawFrame(manager, probe);
    expect(probe.built).toHaveLength(1);

    source.setRenderScale(0.5);
    drawFrame(manager, probe);
    expect(probe.disposed).toHaveLength(1);
    expect(probe.built).toHaveLength(2);
  });

  it('nothing is rebuilt on a devicePixelRatio change when the ratio is injected', () => {
    const { manager } = createManager(WORLD, 3.125);
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: [polygon('a', 0)] });

    drawFrame(manager, probe);
    expect(probe.built).toHaveLength(1);

    vi.stubGlobal('window', { devicePixelRatio: 2 });
    try {
      drawFrame(manager, probe);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(probe.disposed).toHaveLength(0);
    expect(probe.built).toHaveLength(1);
  });

  it('repeated drawing does not add builds from a missed release', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    const dataset = add(manager, { id: 'c1', features: [polygon('a', 0)] });

    for (let i = 0; i < 5; i++) {
      drawFrame(manager, probe);
    }
    dataset.remove();

    expect(probe.built).toHaveLength(1);
    expect(probe.disposed).toHaveLength(1);
  });
});

describe('retained batches and the visibility control', () => {
  it('hiding it releases no retained batch and runs no drawing', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    const dataset = add(manager, { id: 'c1', features: [polygon('a', 0)] });

    drawFrame(manager, probe);
    expect(probe.built).toHaveLength(1);
    expect(probe.drawn).toHaveLength(1);

    dataset.setVisible(false);
    probe.resetDrawn();
    drawFrame(manager, probe);

    // It is not drawn, but the GPU resources are kept
    expect(probe.drawn).toHaveLength(0);
    expect(probe.disposed).toHaveLength(0);
  });

  it('showing it again does not rebuild the retained batches', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    const dataset = add(manager, { id: 'c1', features: [polygon('a', 0)] });

    drawFrame(manager, probe);
    dataset.setVisible(false);
    drawFrame(manager, probe);
    dataset.setVisible(true);
    probe.resetDrawn();
    drawFrame(manager, probe);

    expect(probe.built).toHaveLength(1);
    expect(probe.disposed).toHaveLength(0);
    expect(probe.drawn[0].ids).toEqual(['a']);
  });

  it('removing it while hidden releases the retained batches', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    const dataset = add(manager, { id: 'c1', features: [polygon('a', 0)] });

    drawFrame(manager, probe);
    dataset.setVisible(false);
    dataset.remove();

    expect(probe.disposed).toHaveLength(1);
  });
});

describe('retained batches and the reordering', () => {
  it('moving it within the same side does not rebuild the retained batches', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: [polygon('a', 0)] });
    add(manager, { id: 'c2', features: [polygon('b', 1)] });

    drawFrame(manager, probe);
    expect(probe.built).toHaveLength(2);

    manager.move('c1', { index: 1 });
    probe.resetDrawn();
    drawFrame(manager, probe);

    expect(probe.built).toHaveLength(2);
    expect(probe.disposed).toHaveLength(0);
    // Only the draw order is swapped
    expect(probe.drawn.map((batch) => batch.ids[0])).toEqual(['b', 'a']);
  });

  it('changing the side does not rebuild the retained batches', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: [polygon('a', 0)] });

    drawFrame(manager, probe);
    expect(probe.built).toHaveLength(1);

    manager.move('c1', { order: 'above-store' });
    probe.resetDrawn();
    drawFrame(manager, probe);
    // It disappears from the below-store side
    expect(probe.drawn).toHaveLength(0);

    manager.draw('above-store', probe.target, {} as ProjectionData, 10);

    expect(probe.built).toHaveLength(1);
    expect(probe.disposed).toHaveLength(0);
    expect(probe.drawn.map((batch) => batch.ids[0])).toEqual(['a']);
  });

  it('moving it while hidden does not rebuild it when it is shown again', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    const dataset = add(manager, { id: 'c1', features: [polygon('a', 0)] });

    drawFrame(manager, probe);
    dataset.setVisible(false);
    manager.move('c1', { order: 'above-store' });

    expect(dataset.visible).toBe(false);

    dataset.setVisible(true);
    probe.resetDrawn();
    manager.draw('above-store', probe.target, {} as ProjectionData, 10);

    expect(probe.built).toHaveLength(1);
    expect(probe.disposed).toHaveLength(0);
    expect(probe.drawn.map((batch) => batch.ids[0])).toEqual(['a']);
  });
});

describe('the zoom-dependent drawing factors (zoomScale)', () => {
  /** A dataset with one polygon, one line and one point (it makes 3 batches) */
  const trio = (): DatasetFeatureInput[] => [polygon('pg', 0), line('ln', 0), point('pt', 0)];

  it('without one, a scale of 1 and an opacity of 1 are passed (the look as before)', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: trio() });

    drawFrame(manager, probe);

    expect(probe.drawnFactors).toHaveLength(3);
    for (const factors of probe.drawnFactors) {
      expect(factors).toEqual({ scale: 1, opacity: 1 });
    }
  });

  it('it is evaluated once per frame and the result goes to the polygon, line and point', () => {
    const seenZooms: number[] = [];
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, {
      id: 'c1',
      features: trio(),
      zoomScale: (zoom) => {
        seenZooms.push(zoom);
        return { scale: 0.5, opacity: 0.4 };
      },
    });

    drawFrame(manager, probe);

    expect(seenZooms).toEqual([10]);
    expect(probe.drawn.map((batch) => batch.kind)).toEqual(['polygon', 'line', 'point']);
    for (const factors of probe.drawnFactors) {
      expect(factors).toEqual({ scale: 0.5, opacity: 0.4 });
    }
  });

  it('setZoomScale does not rebuild the retained batches and takes effect next frame', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    const dataset = add(manager, { id: 'c1', features: [polygon('a', 0)] });

    drawFrame(manager, probe);
    expect(probe.built).toHaveLength(1);

    dataset.setZoomScale(() => ({ scale: 2, opacity: 0.5 }));
    probe.resetDrawn();
    drawFrame(manager, probe);

    expect(probe.built).toHaveLength(1);
    expect(probe.disposed).toHaveLength(0);
    expect(probe.drawnFactors).toEqual([{ scale: 2, opacity: 0.5 }]);

    // Clearing it with null goes back to no factors
    dataset.setZoomScale(null);
    probe.resetDrawn();
    drawFrame(manager, probe);

    expect(probe.drawnFactors).toEqual([{ scale: 1, opacity: 1 }]);
  });

  it('at a zoom with an opacity of 0 the drawing itself does not happen', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, {
      id: 'c1',
      features: trio(),
      zoomScale: () => ({ scale: 1, opacity: 0 }),
    });

    drawFrame(manager, probe);

    expect(probe.drawn).toHaveLength(0);
    expect(probe.immediate).toHaveLength(0);
  });

  it('NaN, infinite and out-of-range factors are clamped to safe values', () => {
    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, {
      id: 'c1',
      features: [polygon('a', 0)],
      zoomScale: () => ({ scale: Number.NaN, opacity: 5 }),
    });
    add(manager, {
      id: 'c2',
      features: [polygon('b', 0)],
      zoomScale: () => ({ scale: -2, opacity: Number.POSITIVE_INFINITY }),
    });

    drawFrame(manager, probe);

    expect(probe.drawnFactors).toEqual([
      { scale: 1, opacity: 1 },
      { scale: 1, opacity: 1 },
    ]);
  });
});

describe('following the changes of the DEM coverage', () => {
  /**
   * A stand-in for the terrain that only returns elevations (the same shape as anchor.test.ts)
   */
  function createTerrain(tiles: Array<{ x: number; y: number; z: number }>): TerrainLike {
    return {
      getTerrainData: () => null,
      getElevationForLngLatZoom: (): number => 100,
      tileManager: {
        getRenderableTiles: () => tiles.map((t) => ({ tileID: { canonical: { ...t } } })),
      },
    } as unknown as TerrainLike;
  }

  /** Replaces the DEM coverage and advances the generation */
  function applyCoverage(tiles: Array<{ x: number; y: number; z: number }>): void {
    setAnchorFrame(terrain, {
      terrain: createTerrain(tiles),
      zoom: 14,
      elevationScale: 1e-3,
      mainMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 4, 1, 0, 0, 0, 0, 1],
      offsetUniforms: {
        centerLngLat: [0, 0],
        centerLngLat64: [0, 0],
        centerMercator: [0.5, 0.5],
        projectionCenter: [0, 0, 0, 1],
        unitsPerDegree: [1, 1, 1],
        unitsPerDegree2: [0, 0, 0],
      },
      width: 800,
      height: 600,
    });
  }

  afterEach(() => {
    clearAnchorFrame(terrain);
  });

  it('a change of the DEM coverage keeps the retained batches of polygons and lines', () => {
    // Polygons and lines do not refer to the terrain elevation, so there is no reason to rebuild
    // them. Back when they were discarded regardless of the type, a map of 8,172 administrative
    // boundaries ran a full rebuild from earcut on every pan and stalled the main thread for
    // seconds
    applyCoverage([{ x: 0, y: 0, z: 0 }]);

    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: [polygon('pg', 0), line('ln', 0), point('pt', 0)] });

    drawFrame(manager, probe);
    const builtFirst = probe.built.map((b) => b.kind);
    expect(builtFirst).toEqual(['polygon', 'line', 'point']);
    probe.disposed.length = 0;
    probe.built.length = 0;

    // The DEM coverage changes (it happens on every pan, zoom and pitch)
    applyCoverage([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 1 },
    ]);
    drawFrame(manager, probe);

    // Only the points were rebuilt and only they were discarded
    expect(probe.built.map((b) => b.kind)).toEqual(['point']);
    expect(probe.disposed.map((b) => b.kind)).toEqual(['point']);
  });

  it('a dataset without points does nothing when the DEM coverage changes', () => {
    applyCoverage([{ x: 0, y: 0, z: 0 }]);

    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: [polygon('a', 0), polygon('b', 1)] });

    drawFrame(manager, probe);
    probe.built.length = 0;
    probe.disposed.length = 0;

    applyCoverage([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 1 },
    ]);
    drawFrame(manager, probe);

    expect(probe.built).toHaveLength(0);
    expect(probe.disposed).toHaveLength(0);
  });

  it('a rebuilt point batch uses the same origin of the relative coordinates as the build', () => {
    // If the origin shifted, only the re-baked points would be translated as a whole
    applyCoverage([{ x: 0, y: 0, z: 0 }]);

    const { manager } = createManager();
    const probe = createRetainedProbe();
    add(manager, { id: 'c1', features: [point('pt', 10, 20), polygon('pg', 0)] });

    drawFrame(manager, probe);
    const firstPoint = probe.built.find((b) => b.kind === 'point');
    probe.built.length = 0;

    applyCoverage([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 1 },
    ]);
    drawFrame(manager, probe);

    const rebuilt = probe.built.find((b) => b.kind === 'point');
    expect(rebuilt?.origin).toEqual(firstPoint?.origin);
    expect(rebuilt?.count).toBe(firstPoint?.count);
  });
});

describe('the time-sliced build of the retained batches', () => {
  /** A square polygon with n vertices */
  const polygonOf = (id: string, n: number): Feature => {
    const ring: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) ring.push([139.5 + i * 1e-6, 35.6 + (i % 2) * 1e-6]);
    ring.push(ring[0]);
    return normalizeDisplayFeature({ id, type: 'Polygon', coordinates: [ring] });
  };

  it('it yields to the next frame once the budget is exceeded (one bundle at a time)', () => {
    const probe = createRetainedProbe();
    // It exceeds the target of a bundle (2,000 vertices), so it becomes several bundles
    const features = [polygonOf('a', 1500), polygonOf('b', 1500), polygonOf('c', 1500)];

    const job = createChunkBuildJob(collectFeatureArray(features), probe.renderers, [139.5, 35.6]);

    // Advancing while the deadline has always passed = one bundle at a time
    const now = 0;
    const clock = (): number => now;
    const doneFirst = job.step(-1, clock);
    expect(doneFirst).toBe(false);
    expect(job.take()).toBeNull();
    expect(probe.built).toHaveLength(1);

    // Advance through the rest
    let guard = 0;
    while (!job.step(-1, clock) && guard++ < 10) {
      /* advance */
    }
    expect(job.take()).not.toBeNull();
    expect(probe.built.length).toBeGreaterThan(1);
  });

  it('it finishes in one frame when the budget is enough', () => {
    const probe = createRetainedProbe();
    const features = [polygonOf('a', 1500), polygonOf('b', 1500), polygonOf('c', 1500)];

    const job = createChunkBuildJob(collectFeatureArray(features), probe.renderers, [139.5, 35.6]);
    // It does not stop while the deadline is still ahead
    expect(job.step(Number.POSITIVE_INFINITY, () => 0)).toBe(true);
    expect(job.take()).not.toBeNull();
  });

  it('discarding a half-built one releases the GPU resources built so far', () => {
    const probe = createRetainedProbe();
    const features = [polygonOf('a', 1500), polygonOf('b', 1500)];

    const job = createChunkBuildJob(collectFeatureArray(features), probe.renderers, [139.5, 35.6]);
    job.step(-1, () => 0);
    expect(probe.built.length).toBeGreaterThan(0);

    job.dispose(probe.renderers);
    expect(probe.disposed.length).toBe(probe.built.length);
  });

  // The build of a frame that hands the polygons and lines to the analytic drape
  describe('handing the polygons and lines to the analytic drape', () => {
    const lineOf = (id: string): Feature =>
      normalizeDisplayFeature({
        id,
        type: 'LineString',
        coordinates: [
          [139.5, 35.6],
          [139.6, 35.7],
        ],
      });
    const pointOf = (id: string): Feature =>
      normalizeDisplayFeature({ id, type: 'Point', coordinates: [139.5, 35.6] });

    it('a frame that handed them over does not push the solid polygons and lines', () => {
      const probe = createRetainedProbe();
      const features = [polygonOf('a', 8), lineOf('b'), pointOf('c')];

      const job = createChunkBuildJob(
        collectFeatureArray(features, { skipDrapedFills: true }),
        probe.renderers,
        [139.5, 35.6],
      );
      expect(job.step(Number.POSITIVE_INFINITY, () => 0)).toBe(true);
      const batches = job.take();
      expect(batches).not.toBeNull();
      expect(batches?.polygons).toHaveLength(0);
      expect(batches?.lines).toHaveLength(0);
      // The points go onto the retained batch as before
      expect(batches?.points).toHaveLength(1);
    });

    it('a frame that did not hand them over pushes everything as before', () => {
      const probe = createRetainedProbe();
      const features = [polygonOf('a', 8), lineOf('b'), pointOf('c')];

      const job = createChunkBuildJob(
        collectFeatureArray(features),
        probe.renderers,
        [139.5, 35.6],
      );
      expect(job.step(Number.POSITIVE_INFINITY, () => 0)).toBe(true);
      const batches = job.take();
      expect(batches?.polygons.length).toBeGreaterThan(0);
      expect(batches?.lines.length).toBeGreaterThan(0);
      expect(batches?.points).toHaveLength(1);
    });
  });
});

describe('the selection highlight and the hand-over to the analytic drape', () => {
  /** The ids of the features pushed by the overpaint (in the order they went to immediate mode) */
  function highlightedIds(probe: RetainedProbe): string[] {
    return probe.immediate
      .filter((feature) => feature.style?.strokeColor === SELECTION_HIGHLIGHT_COLOR)
      .map((feature) => feature.id);
  }

  it('while nothing is handed over, polygons and lines are overpainted in immediate mode', () => {
    const probe = createRetainedProbe();
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      features: [polygon('poly', 0), line('line', 10)],
    });
    dataset.setSelectedIds(['poly', 'line']);

    drawFrame(manager, probe);

    expect(highlightedIds(probe)).toEqual(['poly', 'line']);
  });

  it('while handed over, the overpaint of solid polygons and lines is left to the drape', () => {
    const probe = createRetainedProbe();
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      features: [polygon('poly', 0), line('line', 10)],
    });
    dataset.setSelectedIds(['poly', 'line']);
    manager.setDrapedDatasets(new Set(['c1']));

    drawFrame(manager, probe);

    // Drawing in immediate mode would leave everything outside the region of the subdivision as
    // flat triangles and raise a vertical wall
    expect(highlightedIds(probe)).toEqual([]);
  });

  it('before the hand-over decision comes back, a painting drape takes the overpaint', () => {
    const probe = createRetainedProbe();
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      features: [polygon('poly', 0), line('line', 10)],
    });
    dataset.setSelectedIds(['poly', 'line']);
    // The hand-over decision waits until things settle, so for a few frames right after the
    // drape starts painting it has not come back yet. If immediate mode overpaints in that
    // window it becomes a plate
    manager.setDrapedDatasets(null);
    setDrapePaintedDatasets(terrain, new Set(['c1']));

    try {
      drawFrame(manager, probe);
      expect(highlightedIds(probe)).toEqual([]);
    } finally {
      setDrapePaintedDatasets(terrain, null);
    }
  });

  it('in a frame where the drape is not painting, immediate mode overpaints', () => {
    const probe = createRetainedProbe();
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [polygon('poly', 0)] });
    dataset.setSelectedIds(['poly']);
    manager.setDrapedDatasets(null);
    setDrapePaintedDatasets(terrain, new Set(['other']));

    try {
      drawFrame(manager, probe);
      expect(highlightedIds(probe)).toEqual(['poly']);
    } finally {
      setDrapePaintedDatasets(terrain, null);
    }
  });

  it('even when handed over, a point is overpainted by immediate mode (not on the drape)', () => {
    const probe = createRetainedProbe();
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [point('pt', 0)] });
    dataset.setSelectedIds(['pt']);
    manager.setDrapedDatasets(new Set(['c1']));

    drawFrame(manager, probe);

    expect(
      probe.immediate.some(
        (f) => f.id === 'pt' && f.style?.pointColor === SELECTION_HIGHLIGHT_COLOR,
      ),
    ).toBe(true);
  });

  it('even when handed over, a dashed outline is overpainted by immediate mode', () => {
    const probe = createRetainedProbe();
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      features: [
        polygon('poly', 0, 0, { style: { lineStyle: 'dashed' } }),
        line('line', 10, { style: { lineStyle: 'dashed' } }),
      ],
    });
    dataset.setSelectedIds(['poly', 'line']);
    manager.setDrapedDatasets(new Set(['c1']));

    drawFrame(manager, probe);

    expect(highlightedIds(probe)).toEqual(['poly', 'line']);
  });

  it('releasing the hand-over brings the overpaint back to immediate mode', () => {
    const probe = createRetainedProbe();
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [polygon('poly', 0)] });
    dataset.setSelectedIds(['poly']);

    manager.setDrapedDatasets(new Set(['c1']));
    drawFrame(manager, probe);
    expect(highlightedIds(probe)).toEqual([]);

    probe.resetDrawn();
    manager.setDrapedDatasets(null);
    drawFrame(manager, probe);
    expect(highlightedIds(probe)).toEqual(['poly']);
  });
});

describe('the origin of a chunk seen at high zoom', () => {
  it('builds the chunk again around the view when its origin would leave over 0.1 px', () => {
    const { manager, setBounds } = createManager();
    const probe = createRetainedProbe();
    // One chunk from Osaka to Tokyo (its center is about 2 degrees from either)
    add(manager, {
      id: 'c1',
      features: [polygon('osaka', 135.5, 34.69), polygon('tokyo', 139.7, 35.68)],
    });
    drawFrame(manager, probe);
    expect(probe.built[0].origin).toEqual([137.85, 35.435]);

    probe.built.length = 0;
    setBounds({ minX: 135.6, minY: 34.8, maxX: 135.6002, maxY: 34.8002 });
    manager.draw('below-store', probe.target, {} as ProjectionData, 22);

    const origin = probe.built[0]?.origin as [number, number];
    expect(origin[0]).toBeCloseTo(135.6001, 6);
    expect(origin[1]).toBeCloseTo(34.8001, 6);

    // The rebuilt batch stays while the view stays there
    probe.built.length = 0;
    manager.draw('below-store', probe.target, {} as ProjectionData, 22);
    expect(probe.built).toEqual([]);
  });
});

describe('the packed lines', () => {
  const color = [1, 0, 0, 1];

  it('reads the lines of one buffer without a copy', () => {
    const coords = Float64Array.of(0, 0, 1, 1, 2, 2, 3, 3);
    const builder = new PackedLinesBuilder();
    builder.push(coords, 2, 0, 2, 3, 0, color);
    builder.push(coords, 2, 2, 4, 3, 0, color);
    expect(builder.view().coords).toBe(coords);
    expect(unpackLines(builder.view()).map((line) => line.coords)).toEqual([
      [
        [0, 0],
        [1, 1],
      ],
      [
        [2, 2],
        [3, 3],
      ],
    ]);
  });

  it('copies the lines in their order once they come from several buffers', () => {
    const xy = Float64Array.of(0, 0, 1, 1, 2, 2);
    const xyz = Float64Array.of(5, 5, 9, 6, 6, 9, 7, 7, 9);
    const builder = new PackedLinesBuilder();
    builder.push(xy, 2, 0, 2, 1, 0, color);
    builder.push(xyz, 3, 1, 3, 2, 12, color);
    builder.push(xy, 2, 1, 3, 3, 0, color);
    const lines = unpackLines(builder.view());
    expect(lines.map((line) => line.coords)).toEqual([
      [
        [0, 0],
        [1, 1],
      ],
      [
        [6, 6],
        [7, 7],
      ],
      [
        [1, 1],
        [2, 2],
      ],
    ]);
    expect(lines.map((line) => [line.strokeWidth, line.createdZoom])).toEqual([
      [1, 0],
      [2, 12],
      [3, 0],
    ]);
    // The buffers of the caller are left as they are
    expect(Array.from(xy)).toEqual([0, 0, 1, 1, 2, 2]);
  });
});
