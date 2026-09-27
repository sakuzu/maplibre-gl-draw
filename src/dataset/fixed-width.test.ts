// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the declaration of a "fixed line width" in a dataset
 *
 * A feature without a `createdZoom` wants a constant width on screen. A retained batch declares
 * that with a negative line width (the shader reads a negative value as a zoom-independent fixed
 * width). Only with this declaration does the factor of the rendering pixel ratio (renderScale)
 * apply, so with the older way of writing it (a positive value fixed with `widthZoom = 0`) the
 * lines of a data row alone would stop shrinking in the print preview ("the two ratios" in
 * shared/utils/pixel-ratio.ts).
 */

import { describe, expect, it } from 'vitest';
import type { Coordinate, Feature } from '../store/types.js';
import type { LineBatchItem, RetainedLineBatch } from '../view/renderers/line/line-types.js';
import type {
  PointInstanceDataFull,
  RetainedPointBatch,
} from '../view/renderers/point/point-instance.js';
import type {
  RetainedPolygonBatch,
  SDFPolygonBatchData,
} from '../view/renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet } from '../view/renderers/retained.js';
import { buildChunkBatches } from './retained.js';

const LINE_COORDS: Coordinate[] = [
  [0, 0],
  [1, 1],
];
const RING: Coordinate[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

function feature(partial: Partial<Feature> & Pick<Feature, 'id' | 'type'>): Feature {
  return {
    visible: true,
    coordinates: [],
    properties: {},
    style: {},
    ...partial,
  } as Feature;
}

interface Captured {
  renderers: RetainedRendererSet;
  polygons: SDFPolygonBatchData[][];
  lines: LineBatchItem[][];
}

function createCapturingRenderers(): Captured {
  const polygons: SDFPolygonBatchData[][] = [];
  const lines: LineBatchItem[][] = [];

  const renderers = {
    polygon: {
      buildRetained: (items: SDFPolygonBatchData[]): RetainedPolygonBatch => {
        polygons.push(items.map((item) => structuredClone(item)));
        return {} as RetainedPolygonBatch;
      },
      drawRetained: () => {},
      disposeRetained: () => {},
    },
    line: {
      buildRetainedBatch: (items: LineBatchItem[]): RetainedLineBatch => {
        lines.push(items.map((item) => ({ ...item })));
        return {} as RetainedLineBatch;
      },
      drawRetainedBatch: () => {},
      disposeRetainedBatch: () => {},
    },
    point: {
      buildRetained: (points: PointInstanceDataFull[]): RetainedPointBatch => {
        void points;
        return {} as RetainedPointBatch;
      },
      drawRetained: () => {},
      disposeRetained: () => {},
    },
    styles: {
      getPointStyle: () => ({}) as never,
      getLineStringStrokeStyle: () => ({
        color: [1, 0, 0, 1] as [number, number, number, number],
        width: 3,
        opacity: 1,
        lineStyle: 'solid' as const,
      }),
      getPolygonStyles: () => ({
        fillColor: [1, 0, 0, 0.5] as [number, number, number, number],
        strokeStyle: {
          color: [0, 0, 1, 1] as [number, number, number, number],
          width: 5,
          opacity: 1,
          lineStyle: 'solid' as const,
        },
      }),
    },
    viewport: (): [number, number] => [800, 600],
  } as unknown as RetainedRendererSet;

  return { renderers, polygons, lines };
}

describe('the declaration of a fixed line width (the negative convention)', () => {
  it('a line without createdZoom is pushed with a negative value', () => {
    const { renderers, lines } = createCapturingRenderers();
    buildChunkBatches(
      [
        feature({
          id: 'a',
          type: 'LineString',
          geometry: { type: 'LineString', coordinates: LINE_COORDS },
        }),
      ],
      renderers,
      [0, 0],
    );

    expect(lines).toHaveLength(1);
    expect(lines[0][0].strokeWidth).toBe(-3);
  });

  it('a line with createdZoom is pushed with a positive value', () => {
    const { renderers, lines } = createCapturingRenderers();
    buildChunkBatches(
      [
        feature({
          id: 'a',
          type: 'LineString',
          geometry: { type: 'LineString', coordinates: LINE_COORDS },
          properties: { createdZoom: 12 },
        }),
      ],
      renderers,
      [0, 0],
    );

    expect(lines[0][0].strokeWidth).toBe(3);
    expect(lines[0][0].createdZoom).toBe(12);
  });

  it('the outline of a polygon without createdZoom is pushed with a negative value', () => {
    const { renderers, polygons } = createCapturingRenderers();
    buildChunkBatches(
      [feature({ id: 'p', type: 'Polygon', geometry: { type: 'Polygon', coordinates: [RING] } })],
      renderers,
      [0, 0],
    );

    expect(polygons).toHaveLength(1);
    expect(polygons[0][0].style.strokeWidth).toBe(-5);
  });

  it('the outline of a polygon with createdZoom is pushed with a positive value', () => {
    const { renderers, polygons } = createCapturingRenderers();
    buildChunkBatches(
      [
        feature({
          id: 'p',
          type: 'Polygon',
          geometry: { type: 'Polygon', coordinates: [RING] },
          properties: { createdZoom: 10 },
        }),
      ],
      renderers,
      [0, 0],
    );

    expect(polygons[0][0].style.strokeWidth).toBe(5);
    expect(polygons[0][0].createdZoom).toBe(10);
  });
});
