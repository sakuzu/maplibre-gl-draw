// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the points delegated to an external renderer (externalPointRender)
 *
 * They check that core "draws on no path at all" a `Point` for which the predicate returns true.
 * There are three rendering paths (retained, immediate, selection) and missing any one of them
 * produces a disagreement such as "the circle comes back only when it is selected". That nothing
 * at all changes from before when no predicate is passed is pinned down as well.
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { BoundingBox, Feature } from '../store/types.js';
import { toRow } from '../test-utils.js';
import type {
  PointInstanceDataFull,
  RetainedPointBatch,
} from '../view/renderers/point/point-instance.js';
import type { RetainedRendererSet } from '../view/renderers/retained.js';
import type { DisplayBatchTarget } from './dataset.js';
import { createDatasetManager, type DatasetManager } from './manager.js';
import type { DatasetRow } from './types.js';

/** Viewport covering the whole globe */
const WORLD: BoundingBox = { minX: -180, minY: -85, maxX: 180, maxY: 85 };

function point(id: string, coord: [number, number], extra?: Partial<Feature>): DatasetRow {
  return toRow({ id, type: 'Point', coordinates: coord, ...extra });
}

function multiPoint(id: string, coords: [number, number][]): DatasetRow {
  return toRow({ id, type: 'MultiPoint', coordinates: coords });
}

function createManager(): DatasetManager {
  return createDatasetManager({
    getViewportBounds: () => WORLD,
    getZoom: () => 10,
    onViewportChange: () => () => {},
    requestRepaint: () => {},
  });
}

/** The receiver of immediate mode (it records the features pushed per frame) */
function createBatchTarget(): { target: DisplayBatchTarget; frames: Feature[][] } {
  const frames: Feature[][] = [];
  let current: Feature[] = [];

  const target: DisplayBatchTarget = {
    beginFrame: (): void => {
      current = [];
    },
    processFeature: (feature: Feature): boolean => {
      current.push(feature);
      return false;
    },
    endFrame: (): void => {
      frames.push(current);
      current = [];
    },
  };

  return { target, frames };
}

/**
 * The receiver of retained mode
 *
 * It records the instances pushed onto the retained batches of the points. A feature that went to
 * immediate mode (fallback) appears in frames.
 */
function createRetainedTarget(): {
  target: DisplayBatchTarget;
  frames: Feature[][];
  points: PointInstanceDataFull[];
} {
  const { target: immediate, frames } = createBatchTarget();
  const points: PointInstanceDataFull[] = [];

  const renderers = {
    polygon: {
      buildRetained: () => ({}) as never,
      drawRetained: () => {},
      disposeRetained: () => {},
    },
    line: {
      buildRetainedBatch: () => ({}) as never,
      drawRetainedBatch: () => {},
      disposeRetainedBatch: () => {},
    },
    point: {
      buildRetained: (items: PointInstanceDataFull[]): RetainedPointBatch => {
        for (const item of items) points.push({ ...item });
        return {} as RetainedPointBatch;
      },
      drawRetained: () => {},
      disposeRetained: () => {},
    },
    styles: {
      getPointStyle: () => ({
        shape: 'circle' as const,
        size: 12,
        fillColor: [1, 0, 0, 1] as [number, number, number, number],
        fillOpacity: 1,
        strokeColor: [1, 1, 1, 1] as [number, number, number, number],
        strokeWidth: 2,
        strokeOpacity: 1,
      }),
      getLineStringStrokeStyle: () => ({
        color: [1, 0, 0, 1] as [number, number, number, number],
        width: 2,
        opacity: 1,
        lineStyle: 'solid' as const,
      }),
      getPolygonStyles: () => ({
        fillColor: [1, 0, 0, 0.5] as [number, number, number, number],
        strokeStyle: {
          color: [0, 0, 1, 1] as [number, number, number, number],
          width: 2,
          opacity: 1,
          lineStyle: 'solid' as const,
        },
      }),
    },
    viewport: (): [number, number] => [800, 600],
  } as unknown as RetainedRendererSet;

  const target: DisplayBatchTarget = {
    ...immediate,
    getRetainedRenderers: () => renderers,
  };

  return { target, frames, points };
}

/** Draws once in immediate mode */
function drawImmediate(manager: DatasetManager): Feature[][] {
  const { target, frames } = createBatchTarget();
  manager.draw('below-store', target, {} as ProjectionData, 10);
  return frames;
}

/** Draws once in retained mode */
function drawRetained(manager: DatasetManager): {
  frames: Feature[][];
  points: PointInstanceDataFull[];
} {
  const { target, frames, points } = createRetainedTarget();
  manager.draw('below-store', target, {} as ProjectionData, 10);
  return { frames, points };
}

describe('externalPointRender (the retained path)', () => {
  it('a point for which it returns true is not pushed onto a retained batch', () => {
    const manager = createManager();
    manager.add({
      id: 'c1',
      rows: [point('plain', [0, 0]), point('icon', [1, 1])],
      externalPointRender: (feature) => feature.id === 'icon',
    });

    const { points } = drawRetained(manager);

    expect(points).toHaveLength(1);
    expect(points[0].coord).toEqual([0, 0]);
  });

  it('a point for which it returns true does not go to the immediate list (fallback)', () => {
    const manager = createManager();
    manager.add({
      id: 'c1',
      rows: [point('icon', [1, 1])],
      externalPointRender: () => true,
    });

    const { frames, points } = drawRetained(manager);

    expect(points).toHaveLength(0);
    // There is nothing to draw, so no frame is opened
    expect(frames).toEqual([]);
  });

  it('every point is pushed onto a retained batch when there is no predicate', () => {
    const manager = createManager();
    manager.add({ id: 'c1', rows: [point('a', [0, 0]), point('b', [1, 1])] });

    const { points } = drawRetained(manager);

    expect(points.map((p) => p.coord)).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('MultiPoint is out of scope for the predicate (core draws all of them)', () => {
    const manager = createManager();
    manager.add({
      id: 'c1',
      rows: [
        multiPoint('m', [
          [0, 0],
          [1, 1],
        ]),
      ],
      externalPointRender: () => true,
    });

    const { points } = drawRetained(manager);

    expect(points).toHaveLength(2);
  });

  it('lines and polygons are out of scope for the predicate', () => {
    const manager = createManager();
    manager.add({
      id: 'c1',
      rows: [
        toRow({
          id: 'l',
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        }),
        point('icon', [2, 2]),
      ],
      externalPointRender: () => true,
    });

    const { frames, points } = drawRetained(manager);

    // The point disappears and the line is pushed onto a retained batch (fallback is not opened)
    expect(points).toHaveLength(0);
    expect(frames).toEqual([]);
  });
});

describe('externalPointRender (the immediate path)', () => {
  it('a point for which it returns true is not drawn in immediate mode either', () => {
    const manager = createManager();
    manager.add({
      id: 'c1',
      rows: [point('plain', [0, 0]), point('icon', [1, 1])],
      externalPointRender: (feature) => feature.id === 'icon',
    });

    expect(drawImmediate(manager)[0].map((f) => f.id)).toEqual(['plain']);
  });

  it('no frame is opened when everything goes to the external renderer', () => {
    const manager = createManager();
    manager.add({
      id: 'c1',
      rows: [point('icon', [0, 0])],
      externalPointRender: () => true,
    });

    expect(drawImmediate(manager)).toEqual([]);
  });

  it('every point is pushed as before when there is no predicate', () => {
    const manager = createManager();
    manager.add({ id: 'c1', rows: [point('a', [0, 0]), point('b', [1, 1])] });

    expect(drawImmediate(manager)[0].map((f) => f.id)).toEqual(['a', 'b']);
  });
});

describe('setExternalPointRender (replacing it afterwards)', () => {
  it('a predicate set afterwards affects the retained batches (the old ones drop)', () => {
    const manager = createManager();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('plain', [0, 0]), point('icon', [1, 1])],
    });

    // Draw once to have the retained batches built (no predicate yet, so both points go in)
    expect(drawRetained(manager).points).toHaveLength(2);

    dataset.setExternalPointRender((feature) => feature.id === 'icon');

    // Without dropping them there would be no rebuild and the second record would be empty
    const { points } = drawRetained(manager);
    expect(points).toHaveLength(1);
    expect(points[0].coord).toEqual([0, 0]);
  });

  it('clearing it with undefined brings every point back', () => {
    const manager = createManager();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('plain', [0, 0]), point('icon', [1, 1])],
      externalPointRender: (feature) => feature.id === 'icon',
    });

    expect(drawRetained(manager).points).toHaveLength(1);

    dataset.setExternalPointRender(undefined);

    expect(drawRetained(manager).points).toHaveLength(2);
  });

  it('the same test takes effect on the immediate path too', () => {
    const manager = createManager();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('plain', [0, 0]), point('icon', [1, 1])],
    });

    expect(drawImmediate(manager)[0].map((f) => f.id)).toEqual(['plain', 'icon']);

    dataset.setExternalPointRender((feature) => feature.id === 'icon');

    expect(drawImmediate(manager)[0].map((f) => f.id)).toEqual(['plain']);
  });

  it('the same test takes effect on the selection path too (the overpaint stops)', () => {
    const manager = createManager();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('icon', [0, 0], { style: { pointColor: '#0000ff', pointRadius: 5 } })],
    });
    dataset.setSelectedIds(['icon']);

    // While there is no predicate, the original point is drawn over the halo
    expect(drawImmediate(manager)[1]).toHaveLength(2);

    dataset.setExternalPointRender(() => true);

    const frames = drawImmediate(manager);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(1);
  });

  it('the change is reported with change (reason: style)', () => {
    const manager = createManager();
    const dataset = manager.add({ id: 'c1', rows: [point('a', [0, 0])] });
    const reasons: string[] = [];
    dataset.on('change', (payload) => reasons.push(payload.reason));

    dataset.setExternalPointRender(() => true);

    expect(reasons).toEqual(['style']);
  });
});

describe('externalPointRender (the selection path)', () => {
  it('a point for which it returns true gets only the halo, with no overpaint', () => {
    const manager = createManager();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('icon', [0, 0], { style: { pointColor: '#0000ff', pointRadius: 5 } })],
      externalPointRender: () => true,
    });

    dataset.setSelectedIds(['icon']);
    const frames = drawImmediate(manager);

    // There is no ordinary drawing; only the frame of the overpaint is opened
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(1);
    expect(frames[0][0].style?.pointColor).toBe('#FF2D55');
    expect(frames[0][0].style?.pointRadius).toBe(8);
  });

  it('the original point is drawn over the halo as before when there is no predicate', () => {
    const manager = createManager();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('a', [0, 0], { style: { pointColor: '#0000ff', pointRadius: 5 } })],
    });

    dataset.setSelectedIds(['a']);
    const highlighted = drawImmediate(manager)[1];

    expect(highlighted).toHaveLength(2);
    expect(highlighted[0].style?.pointColor).toBe('#FF2D55');
    expect(highlighted[1].style).toEqual({ pointColor: '#0000ff', pointRadius: 5 });
  });

  it('the selection of a point for which it returns false is overpainted as before', () => {
    const manager = createManager();
    const dataset = manager.add({
      id: 'c1',
      rows: [point('plain', [0, 0]), point('icon', [1, 1])],
      externalPointRender: (feature) => feature.id === 'icon',
    });

    dataset.setSelectedIds(['plain', 'icon']);
    const highlighted = drawImmediate(manager)[1];

    // 2 halos + the overpaint is only the one for plain
    expect(highlighted.map((f) => f.id)).toEqual(['plain', 'plain', 'icon']);
  });
});
