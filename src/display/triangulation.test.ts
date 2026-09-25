// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the time slicing of the triangulation of huge polygons
 *
 * The three things to settle are the following.
 *
 * - A polygon at or below the threshold is triangulated synchronously as before (the behaviour
 *   does not change)
 * - A polygon above the threshold is not run to the end in one slice (it advances across
 *   frames). The clock and the launching of the slices are injected so it can be watched
 *   deterministically
 * - Once it is done it goes into the cache and the waiting side is told
 *
 * The clock is a fake one that "advances by a fixed amount every time it is called". It does not
 * depend on real time.
 */

import earcut from 'earcut';
import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../shared/config/feature-style.js';
import { FeatureDrawer } from '../view/renderers/drawer.js';
import type { RetainedLineBatch } from '../view/renderers/line/line-types.js';
import type { RetainedPointBatch } from '../view/renderers/point/point-instance.js';
import { buildEarcutInput } from '../view/renderers/polygon/earcut-input.js';
import type {
  RetainedPolygonBatch,
  RetainedPolygonBuildOptions,
  SDFPolygonBatchData,
} from '../view/renderers/polygon/sdf-polygon.js';
import type { TriangulationRequest } from '../view/renderers/polygon/triangulator.js';
import type { RetainedRendererSet } from '../view/renderers/retained.js';
import type { DisplayBatchTarget } from './dataset.js';
import { createDatasetManager } from './manager.js';
import {
  ASYNC_TRIANGULATION_VERTEX_THRESHOLD,
  createChunkTriangulator,
  polygonSignature,
  TRIANGULATION_SLICE_MS,
  TriangulationScheduler,
} from './triangulation.js';
import type { DatasetFeatureInput } from './types.js';

/** The fake clock and launching of the slices */
interface FakeRuntime {
  scheduler: TriangulationScheduler;
  /** Runs a scheduled slice exactly once (the return value says whether one ran) */
  runScheduled(): boolean;
  /** Runs until no schedule is left (it returns the number of runs) */
  runAll(limit?: number): number;
  /** The time that passes on each call of now() (ms) */
  tickMs: number;
}

function createRuntime(options: { tickMs?: number; vertexThreshold?: number } = {}): FakeRuntime {
  const tickMs = options.tickMs ?? 3;
  let clock = 0;
  let pending: (() => void) | null = null;

  const scheduler = new TriangulationScheduler({
    now: () => {
      const value = clock;
      clock += tickMs;
      return value;
    },
    schedule: (run) => {
      pending = run;
    },
    vertexThreshold: options.vertexThreshold,
  });

  const runScheduled = (): boolean => {
    const run = pending;
    if (!run) return false;
    pending = null;
    run();
    return true;
  };

  return {
    scheduler,
    runScheduled,
    runAll: (limit = 10_000): number => {
      let count = 0;
      while (runScheduled()) {
        count++;
        if (count > limit) throw new Error('the slices never finish');
      }
      return count;
    },
    tickMs,
  };
}

/** Turns a star-shaped ring (built without self-intersections) into a flat coordinate list */
function starCoords(count: number, seed = 1): number[] {
  const flat: number[] = new Array(count * 2);
  for (let i = 0; i < count; i++) {
    const theta = (i / count) * Math.PI * 2;
    const r = 1 + 0.3 * Math.sin(3 * theta + seed) + 0.1 * Math.sin(11 * theta);
    flat[i * 2] = Math.round(Math.cos(theta) * r * 1e5) / 1e5;
    flat[i * 2 + 1] = Math.round(Math.sin(theta) * r * 1e5) / 1e5;
  }
  return flat;
}

function request(featureId: string, flatCoords: number[], partIndex = 0): TriangulationRequest {
  return { featureId, partIndex, flatCoords, holeIndices: [] };
}

describe('the threshold', () => {
  it('a polygon at or below the threshold is triangulated on the spot and returned', () => {
    const { scheduler } = createRuntime({ vertexThreshold: 100 });
    const flat = starCoords(50);
    const onReady = vi.fn();

    const indices = scheduler.request(request('small', flat), onReady);

    expect(indices).toEqual(earcut(flat, []));
    expect(scheduler.pendingCount).toBe(0);
    expect(onReady).not.toHaveBeenCalled();
  });

  it('a polygon without a feature id is triangulated on the spot even when it is large', () => {
    const { scheduler } = createRuntime({ vertexThreshold: 10 });
    const flat = starCoords(60);

    const indices = scheduler.request(
      { featureId: undefined, partIndex: 0, flatCoords: flat, holeIndices: [] },
      vi.fn(),
    );

    expect(indices).toEqual(earcut(flat, []));
    expect(scheduler.pendingCount).toBe(0);
  });

  it('an infinite threshold makes it always synchronous (the print and thumbnail paths)', () => {
    const { scheduler } = createRuntime({ vertexThreshold: Number.POSITIVE_INFINITY });
    const flat = starCoords(2000);

    const indices = scheduler.request(request('big', flat), vi.fn());

    expect(indices).toEqual(earcut(flat, []));
    expect(scheduler.pendingCount).toBe(0);
  });

  it('the default threshold is 10,000 vertices and one slice is 8ms', () => {
    expect(ASYNC_TRIANGULATION_VERTEX_THRESHOLD).toBe(10_000);
    expect(TRIANGULATION_SLICE_MS).toBe(8);
  });
});

describe('the time slicing', () => {
  it('a polygon above the threshold returns null and is queued as a job', () => {
    const { scheduler } = createRuntime({ vertexThreshold: 10 });
    const flat = starCoords(400);

    expect(scheduler.request(request('big', flat), vi.fn())).toBeNull();
    expect(scheduler.pendingCount).toBe(1);
  });

  it('it does not finish in one slice and completes over several of them', () => {
    // The clock advances 3 ms per call of now(). With a budget of 8 ms, one slice is cut off
    // after a few steps
    const { scheduler, runScheduled, runAll } = createRuntime({ vertexThreshold: 10 });
    const flat = starCoords(2000);
    const onReady = vi.fn();

    expect(scheduler.request(request('big', flat), onReady)).toBeNull();

    // It does not finish in the first slice
    expect(runScheduled()).toBe(true);
    expect(scheduler.pendingCount).toBe(1);
    expect(onReady).not.toHaveBeenCalled();

    // The rest is scheduled
    const slices = runAll();
    expect(slices).toBeGreaterThan(1);
    expect(scheduler.pendingCount).toBe(0);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('the finished result matches the upstream earcut and goes into the cache', () => {
    const { scheduler, runAll } = createRuntime({ vertexThreshold: 10 });
    const flat = starCoords(600);
    scheduler.request(request('big', flat), vi.fn());
    runAll();

    const cached = scheduler.cache.get('big', 0, polygonSignature(flat, []));
    expect(cached).toEqual(earcut(flat, []));

    // The second request returns from the cache at once (no job is queued)
    const again = scheduler.request(request('big', flat), vi.fn());
    expect(again).toEqual(earcut(flat, []));
    expect(scheduler.pendingCount).toBe(0);
  });

  it('however often the same polygon is requested, one job tells all the waiters', () => {
    const { scheduler, runAll } = createRuntime({ vertexThreshold: 10 });
    const flat = starCoords(300);
    const first = vi.fn();
    const second = vi.fn();

    scheduler.request(request('big', flat), first);
    scheduler.request(request('big', flat), second);
    expect(scheduler.pendingCount).toBe(1);

    runAll();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('the same id with a different geometry misses the cache (the fingerprint differs)', () => {
    const { scheduler, runAll } = createRuntime({ vertexThreshold: 10 });
    const flat = starCoords(300, 1);
    scheduler.request(request('big', flat), vi.fn());
    runAll();

    const other = starCoords(300, 2);
    expect(scheduler.cache.get('big', 0, polygonSignature(other, []))).toBeNull();

    // A job for the rebuild is queued (the previous job is thrown away)
    expect(scheduler.request(request('big', other), vi.fn())).toBeNull();
    expect(scheduler.pendingCount).toBe(1);
    runAll();
    expect(scheduler.cache.get('big', 0, polygonSignature(other, []))).toEqual(earcut(other, []));
  });

  it('the parts of a MultiPolygon become separate jobs', () => {
    const { scheduler } = createRuntime({ vertexThreshold: 10 });
    const flat = starCoords(300);
    scheduler.request(request('multi', flat, 0), vi.fn());
    scheduler.request(request('multi', flat, 1), vi.fn());
    expect(scheduler.pendingCount).toBe(2);
  });

  it('a job nobody waits for any more is thrown away', () => {
    const { scheduler } = createRuntime({ vertexThreshold: 10 });
    const flat = starCoords(300);
    const onReady = vi.fn();

    scheduler.request(request('big', flat), onReady);
    expect(scheduler.pendingCount).toBe(1);

    scheduler.forget(onReady);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('a job with a waiter left is not thrown away', () => {
    const { scheduler } = createRuntime({ vertexThreshold: 10 });
    const flat = starCoords(300);
    const first = vi.fn();
    const second = vi.fn();

    scheduler.request(request('big', flat), first);
    scheduler.request(request('big', flat), second);
    scheduler.forget(first);

    expect(scheduler.pendingCount).toBe(1);
  });
});

describe('the receiver for a chunk', () => {
  it('it remembers whether there was anything waiting for triangulation', () => {
    const { scheduler, runAll } = createRuntime({ vertexThreshold: 10 });
    const small = starCoords(5);
    const big = starCoords(300);
    const onReady = vi.fn();
    const triangulator = createChunkTriangulator(onReady, scheduler);

    expect(triangulator.triangulate(request('small', small))).not.toBeNull();
    expect(triangulator.hasDeferred()).toBe(false);

    expect(triangulator.triangulate(request('big', big))).toBeNull();
    expect(triangulator.hasDeferred()).toBe(true);

    runAll();
    expect(onReady).toHaveBeenCalledTimes(1);

    // After the triangulation is finished the receiver returns without waiting
    const next = createChunkTriangulator(vi.fn(), scheduler);
    expect(next.triangulate(request('big', big))).toEqual(earcut(big, []));
    expect(next.hasDeferred()).toBe(false);
  });
});

describe('the wiring with a dataset', () => {
  /**
   * A mock of the retained-mode renderers
   *
   * What is to be seen is only "whether the triangulation of a fill goes through the entry
   * point", "whether the fill stays hidden while it waits" and "whether it is rebuilt once it is
   * done", so it has no GL. As in the real thing, it goes through buildEarcutInput and then to
   * the receiver.
   */
  function createProbe(): {
    target: DisplayBatchTarget;
    /** "The ids of the polygons whose fill came out" on every buildRetained */
    builds: string[][];
  } {
    const builds: string[][] = [];

    const renderers = {
      polygon: {
        buildRetained: (
          polygons: SDFPolygonBatchData[],
          options?: RetainedPolygonBuildOptions,
        ): RetainedPolygonBatch | null => {
          const filled: string[] = [];
          for (const polygon of polygons) {
            const { flatCoords, holeIndices } = buildEarcutInput(polygon.coordinates);
            const indices = options?.triangulator
              ? options.triangulator.triangulate({
                  featureId: polygon.featureId,
                  partIndex: polygon.partIndex ?? 0,
                  flatCoords,
                  holeIndices,
                })
              : [];
            if (indices && indices.length > 0) filled.push(polygon.featureId ?? '');
          }
          builds.push(filled);
          return { indexCount: filled.length } as unknown as RetainedPolygonBatch;
        },
        drawRetained: (): void => {},
        disposeRetained: (): void => {},
      },
      line: {
        buildRetainedBatch: (): RetainedLineBatch => ({}) as RetainedLineBatch,
        drawRetainedBatch: (): void => {},
        disposeRetainedBatch: (): void => {},
      },
      point: {
        buildRetained: (): RetainedPointBatch => ({}) as RetainedPointBatch,
        drawRetained: (): void => {},
        disposeRetained: (): void => {},
      },
      styles: new FeatureDrawer({
        gl: {
          createBuffer: (): object => ({}),
          createVertexArray: (): object => ({}),
          bindBuffer: (): void => {},
          bindVertexArray: (): void => {},
          enableVertexAttribArray: (): void => {},
          vertexAttribPointer: (): void => {},
        } as unknown as WebGL2RenderingContext,
        map: {} as never,
        sdfLineRenderer: {} as never,
        pointShapeRenderer: {} as never,
        imageRenderer: {} as never,
        featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
      }),
      viewport: (): [number, number] => [800, 600],
    } as unknown as RetainedRendererSet;

    return {
      builds,
      target: {
        beginFrame: (): void => {},
        processFeature: (): boolean => false,
        endFrame: (): void => {},
        getRetainedRenderers: () => renderers,
      },
    };
  }

  /** A display feature with a closed star-shaped ring */
  function starPolygon(id: string, count: number): DatasetFeatureInput {
    const flat = starCoords(count);
    const ring: Array<[number, number]> = [];
    for (let i = 0; i < count; i++) ring.push([flat[i * 2], flat[i * 2 + 1]]);
    ring.push(ring[0]);
    return { id, type: 'Polygon', coordinates: [ring] };
  }

  it('no fill until the triangulation is done, then the chunk is rebuilt and filled', () => {
    const { scheduler, runAll } = createRuntime({ vertexThreshold: 10 });
    const repaint = vi.fn();
    const manager = createDatasetManager({
      getViewportBounds: () => ({ minX: -180, minY: -85, maxX: 180, maxY: 85 }),
      getZoom: () => 10,
      onViewportChange: () => () => {},
      requestRepaint: repaint,
      triangulationScheduler: scheduler,
    });
    const probe = createProbe();

    manager.add({ id: 'water', features: [starPolygon('big', 400)] });
    manager.draw('below-store', probe.target, {} as ProjectionData, 10);

    // The first build shows no fill (only the outline)
    expect(probe.builds).toEqual([[]]);
    expect(scheduler.pendingCount).toBe(1);

    repaint.mockClear();
    runAll();

    // The completion of the triangulation requests a repaint
    expect(repaint).toHaveBeenCalled();

    // The next frame shows the fill (the rebuild is instant, from the cache)
    manager.draw('below-store', probe.target, {} as ProjectionData, 10);
    expect(probe.builds).toEqual([[], ['big']]);
  });

  it('removing the dataset throws away the triangulation jobs too', () => {
    const { scheduler } = createRuntime({ vertexThreshold: 10 });
    const manager = createDatasetManager({
      getViewportBounds: () => ({ minX: -180, minY: -85, maxX: 180, maxY: 85 }),
      getZoom: () => 10,
      onViewportChange: () => () => {},
      requestRepaint: () => {},
      triangulationScheduler: scheduler,
    });
    const probe = createProbe();

    manager.add({ id: 'water', features: [starPolygon('big', 400)] });
    manager.draw('below-store', probe.target, {} as ProjectionData, 10);
    expect(scheduler.pendingCount).toBe(1);

    manager.remove('water');
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe('the fingerprint of a geometry', () => {
  it('it matches when the vertex count, the inner rings and the coordinates are the same', () => {
    const flat = starCoords(500);
    expect(polygonSignature(flat, [])).toBe(polygonSignature([...flat], []));
  });

  it('it changes when the position of an inner ring changes', () => {
    const flat = starCoords(500);
    expect(polygonSignature(flat, [100])).not.toBe(polygonSignature(flat, [200]));
  });

  it('it changes when the vertex count changes', () => {
    expect(polygonSignature(starCoords(500), [])).not.toBe(polygonSignature(starCoords(501), []));
  });

  it('it changes when the shape changes', () => {
    expect(polygonSignature(starCoords(500, 1), [])).not.toBe(
      polygonSignature(starCoords(500, 2), []),
    );
  });
});
