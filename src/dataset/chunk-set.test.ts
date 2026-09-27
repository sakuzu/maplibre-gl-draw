// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the retained chunks of a dataset (DisplayChunkSet)
 *
 * The chunk set is driven directly with a stub host and renderers without GPU resources. The
 * builds, the draws and the releases are counted; the clock is frozen so that every visible chunk
 * is built in the first frame.
 */

import type { ProjectionData } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../shared/config/feature-style.js';
import type { BoundingBox, Feature } from '../shared/types/model.js';
import { displayFeature } from '../test-utils.js';
import { FeatureDrawer } from '../view/renderers/drawer.js';
import type { ImageRenderer } from '../view/renderers/image.js';
import type { RetainedLineBatch } from '../view/renderers/line/line-types.js';
import type { SDFLineRenderer } from '../view/renderers/line/sdf-line.js';
import type { RetainedPointBatch } from '../view/renderers/point/point-instance.js';
import type { PointShapeRenderer } from '../view/renderers/point/point-shape.js';
import type { RetainedPolygonBatch } from '../view/renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet } from '../view/renderers/retained.js';
import { TerrainContext } from '../view/terrain/context.js';
import { chunkTargetSizeFor, type DisplayChunk, partitionIntoChunks } from './chunk.js';
import { type DisplayChunkFrame, DisplayChunkSet, type DisplayChunkSetHost } from './chunk-set.js';
import { type ChunkCollector, collectFeatures } from './retained.js';
import type { DrawnRowMask } from './thinning.js';

const PROJECTION = {} as ProjectionData;

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

/**
 * Renderers that count the builds, the draws and the releases of the point batches (and the
 * builds of the polygon batches)
 */
function createRenderers(): {
  renderers: RetainedRendererSet;
  counts: { builds: number; draws: number; disposes: number; polygonBuilds: number };
} {
  const counts = { builds: 0, draws: 0, disposes: 0, polygonBuilds: 0 };
  const renderers: RetainedRendererSet = {
    polygon: {
      buildRetained: () => {
        counts.polygonBuilds++;
        return {} as RetainedPolygonBatch;
      },
      drawRetained: (): void => {},
      disposeRetained: (): void => {},
    },
    line: {
      buildRetainedBatch: () => ({}) as RetainedLineBatch,
      drawRetainedBatch: (): void => {},
      disposeRetainedBatch: (): void => {},
    },
    point: {
      buildRetained: (): RetainedPointBatch => {
        counts.builds++;
        return {} as RetainedPointBatch;
      },
      drawRetained: (): void => {
        counts.draws++;
      },
      disposeRetained: (): void => {
        counts.disposes++;
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
    viewport: (): [number, number] => [1920, 1080],
  };
  return { renderers, counts };
}

/** Two groups of points far apart (they fall into different chunks) */
function createFeatures(): Feature[] {
  const features: Feature[] = [];
  for (let i = 0; i < 200; i++) {
    const lng = i < 100 ? i * 0.001 : 100 + i * 0.001;
    features.push(displayFeature({ id: `p${i}`, type: 'Point', coordinates: [lng, 0] }));
  }
  return features;
}

/** The features every test splits (the host collects the rows of a chunk from them) */
const FEATURES = createFeatures();

/** The chunks of the features */
function chunksOf(features: Feature[]): DisplayChunk[] {
  return partitionIntoChunks(features, chunkTargetSizeFor(features.length));
}

/** A collector of the rows of `features` that skips the rows not drawn */
function collectorOf(features: Feature[]): DisplayChunkSetHost['collector'] {
  return (rows, options, drawn) =>
    collectFeatures(
      rows.length,
      (i) => (drawn === null || drawn[rows[i]] === 1 ? features[rows[i]] : null),
      options,
    );
}

function createHost(overrides: Partial<DisplayChunkSetHost> = {}): DisplayChunkSetHost {
  return {
    collector: collectorOf(FEATURES),
    drawnRows: () => null,
    externalPointFilter: () => undefined,
    drapedFills: () => false,
    requestRepaint: vi.fn(),
    onInvalidateAll: vi.fn(),
    pixelRatio: 1,
    ...overrides,
  };
}

function frameFor(renderers: RetainedRendererSet, bounds: BoundingBox): DisplayChunkFrame {
  return {
    target: { beginFrame: vi.fn(), processFeature: vi.fn(() => false), endFrame: vi.fn() },
    renderers,
    terrain: new TerrainContext(),
    projectionData: PROJECTION,
    zoom: 10,
    bounds,
    factors: { scale: 1, opacity: 1 },
  };
}

/** The viewport over the first group only */
const LEFT: BoundingBox = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
/** The viewport over both groups */
const BOTH: BoundingBox = { minX: -1, minY: -1, maxX: 101, maxY: 1 };

describe('DisplayChunkSet', () => {
  beforeEach(() => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the generation advances on every replacement of the contents', () => {
    const set = new DisplayChunkSet(createHost());
    const features = FEATURES;
    expect(set.generation).toBe(0);
    set.replace(chunksOf(features));
    set.replace(chunksOf(features));
    expect(set.generation).toBe(2);
  });

  it('only the chunks in view are built, and the next frame only draws', () => {
    const { renderers, counts } = createRenderers();
    const set = new DisplayChunkSet(createHost());
    const features = FEATURES;
    set.replace(chunksOf(features));

    set.draw(frameFor(renderers, LEFT));
    const firstBuilds = counts.builds;
    expect(firstBuilds).toBeGreaterThan(0);

    set.draw(frameFor(renderers, LEFT));
    expect(counts.builds).toBe(firstBuilds);
    expect(counts.draws).toBe(2 * firstBuilds);

    // Widening the view builds the chunks of the other group only
    set.draw(frameFor(renderers, BOTH));
    expect(counts.builds).toBeGreaterThan(firstBuilds);
  });

  it('the host collects the rows of the chunks in view', () => {
    const { renderers } = createRenderers();
    const collected: number[] = [];
    const set = new DisplayChunkSet(
      createHost({
        collector: (rows, options) => {
          collected.push(...rows);
          return collectFeatures(rows.length, (i) => FEATURES[rows[i]], options);
        },
      }),
    );
    set.replace(chunksOf(FEATURES));

    set.draw(frameFor(renderers, LEFT));
    expect(collected.length).toBeGreaterThan(0);
    // Only the first group is in view
    expect(collected.every((row) => row < 100)).toBe(true);
  });

  it('the walk of the rows is part of the budget of the frame', () => {
    const { renderers } = createRenderers();
    // Every look at the clock is 100 ms later: the budget is spent after the first chunk
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 100;
      return clock;
    });
    let walked = 0;
    const set = new DisplayChunkSet(
      createHost({
        collector: (rows, options): ChunkCollector => {
          const inner = collectFeatures(rows.length, (i) => FEATURES[rows[i]], options);
          return {
            collect: (...args) => {
              walked++;
              return inner.collect(...args);
            },
          };
        },
      }),
    );
    const chunks = chunksOf(FEATURES);
    const inView = chunks.filter((chunk) => chunk.bounds.maxX <= 1).length;
    expect(inView).toBeGreaterThan(1);
    set.replace(chunks);

    set.draw(frameFor(renderers, LEFT));
    // Only one chunk is walked in the first frame; the others wait for the next frames
    expect(walked).toBe(1);
    expect(set.hasPendingBuild).toBe(true);

    for (let frame = 0; frame < 10 && set.hasPendingBuild; frame++) {
      set.draw(frameFor(renderers, LEFT));
    }
    expect(set.hasPendingBuild).toBe(false);
    expect(walked).toBe(inView);
  });

  it('invalidating tells the host, releases the batches and rebuilds them on the next draw', () => {
    const { renderers, counts } = createRenderers();
    const host = createHost();
    const set = new DisplayChunkSet(host);
    const features = FEATURES;
    set.replace(chunksOf(features));
    set.draw(frameFor(renderers, LEFT));
    const built = counts.builds;
    vi.mocked(host.onInvalidateAll).mockClear();

    set.invalidateAll();
    expect(host.onInvalidateAll).toHaveBeenCalledTimes(1);
    expect(counts.disposes).toBe(built);

    set.draw(frameFor(renderers, LEFT));
    expect(counts.builds).toBe(2 * built);
  });

  it('a change of the drawn rows rebuilds only the point part of the chunks drawn, while the camera moves too', () => {
    // The first group gets a polygon next to its points, so its chunks hold both
    const square = displayFeature({
      id: 'square',
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [0.01, 0],
          [0.01, 0.01],
          [0, 0],
        ],
      ],
    });
    const features = [...FEATURES, square];
    const { renderers, counts } = createRenderers();
    let drawn: DrawnRowMask = null;
    const host = createHost({ collector: collectorOf(features), drawnRows: () => drawn });
    const set = new DisplayChunkSet(host);
    const chunks = chunksOf(features);
    set.replace(chunks);
    set.draw(frameFor(renderers, LEFT));
    const pointBuilds = counts.builds;
    const polygonBuilds = counts.polygonBuilds;
    expect(polygonBuilds).toBe(1);
    vi.mocked(host.onInvalidateAll).mockClear();

    // Thin away the first point only: one chunk has a point that changed
    const mask = new Uint8Array(features.length).fill(1);
    mask[0] = 0;
    drawn = mask;
    const moving = frameFor(renderers, LEFT);
    moving.terrain.cameraMoving = true;
    const drawsBefore = counts.draws;
    set.draw(moving);
    expect(counts.builds).toBe(pointBuilds + 1);
    expect(counts.disposes).toBe(1);
    // The polygons are untouched and nothing is discarded as a whole
    expect(counts.polygonBuilds).toBe(polygonBuilds);
    expect(host.onInvalidateAll).not.toHaveBeenCalled();
    // Every chunk in view is still drawn in that frame
    expect(counts.draws - drawsBefore).toBe(pointBuilds);
    expect(set.hasPendingBuild).toBe(false);

    // The same rows in another mask rebuild nothing
    drawn = mask.slice();
    set.draw(moving);
    expect(counts.builds).toBe(pointBuilds + 1);

    // A chunk entering the view while moving is not built (it waits for the camera to stop)
    set.draw({ ...moving, bounds: BOTH });
    expect(counts.builds).toBe(pointBuilds + 1);
    expect(set.hasPendingBuild).toBe(true);
  });

  it('the points drawn in immediate mode follow the drawn rows too, after the other features', () => {
    // A point shape without instancing goes to immediate mode
    const { renderers } = createRenderers();
    const styles = renderers.styles;
    const iconRenderers: RetainedRendererSet = {
      ...renderers,
      styles: {
        getPointStyle: (feature) => ({ ...styles.getPointStyle(feature), shape: 'icon' }),
        getLineStringStrokeStyle: (feature) => ({
          ...styles.getLineStringStrokeStyle(feature),
          lineStyle: 'dashed',
        }),
        getPolygonStyles: (feature) => styles.getPolygonStyles(feature),
      },
    };
    const dashed = displayFeature({
      id: 'dashed',
      type: 'LineString',
      coordinates: [
        [0, 0],
        [0.001, 0.001],
      ],
    });
    const features = [...FEATURES.slice(0, 3), dashed];
    let drawn: DrawnRowMask = null;
    const set = new DisplayChunkSet(
      createHost({ collector: collectorOf(features), drawnRows: () => drawn }),
    );
    set.replace(chunksOf(features));
    const drawnIds = (): string[] => {
      const frame = frameFor(iconRenderers, LEFT);
      frame.terrain.cameraMoving = drawn !== null;
      set.draw(frame);
      return vi.mocked(frame.target.processFeature).mock.calls.map(([feature]) => feature.id);
    };

    expect(drawnIds()).toEqual(['dashed', 'p0', 'p1', 'p2']);
    drawn = Uint8Array.from([1, 0, 1, 1]);
    expect(drawnIds()).toEqual(['dashed', 'p0', 'p2']);
  });

  it('a build takes the drawn rows of the moment it starts', () => {
    const { renderers } = createRenderers();
    let drawn: DrawnRowMask = null;
    const seen: DrawnRowMask[] = [];
    const host = createHost({
      drawnRows: () => drawn,
      collector: (rows, options, mask) => {
        seen.push(mask);
        return collectorOf(FEATURES)(rows, options, mask);
      },
    });
    const set = new DisplayChunkSet(host);
    set.replace(chunksOf(FEATURES));
    drawn = new Uint8Array(FEATURES.length).fill(1);
    set.draw(frameFor(renderers, LEFT));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((mask) => mask === drawn)).toBe(true);
  });

  it('a change of the hand-over to the drape re-bakes the chunks already built', () => {
    const { renderers, counts } = createRenderers();
    let draped = false;
    const set = new DisplayChunkSet(createHost({ drapedFills: () => draped }));
    const features = FEATURES;
    set.replace(chunksOf(features));
    set.draw(frameFor(renderers, LEFT));
    const built = counts.builds;

    draped = true;
    set.draw(frameFor(renderers, LEFT));
    expect(counts.builds).toBe(2 * built);
    // The old version is released only after the new one is complete
    expect(counts.disposes).toBe(built);
  });

  it('releasing the GPU resources forgets the renderers and keeps the chunks', () => {
    const { renderers, counts } = createRenderers();
    const set = new DisplayChunkSet(createHost());
    const features = FEATURES;
    set.replace(chunksOf(features));
    set.draw(frameFor(renderers, LEFT));
    expect(set.retainedRenderers).toBe(renderers);

    set.releaseRetained();
    expect(set.retainedRenderers).toBeNull();

    const before = counts.builds;
    set.draw(frameFor(renderers, LEFT));
    expect(counts.builds).toBe(2 * before);
  });

  it('a change of the rendering pixel ratio invalidates every chunk', () => {
    const { renderers, counts } = createRenderers();
    let ratio = 1;
    const host = createHost({ pixelRatio: () => ratio });
    const set = new DisplayChunkSet(host);
    const features = FEATURES;
    set.replace(chunksOf(features));
    set.draw(frameFor(renderers, LEFT));
    const built = counts.builds;
    vi.mocked(host.onInvalidateAll).mockClear();

    ratio = 2;
    set.draw(frameFor(renderers, LEFT));
    expect(host.onInvalidateAll).toHaveBeenCalledTimes(1);
    expect(counts.builds).toBe(2 * built);
  });
});
