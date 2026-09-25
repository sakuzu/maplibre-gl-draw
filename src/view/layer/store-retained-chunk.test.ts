// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the building and releasing of the batch of a retained chunk
 */

import { describe, expect, it } from 'vitest';
import type { Feature } from '../../store/types.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import { buildChunkBatch, createChunkEntry, disposeChunkBatches } from './store-retained-chunk.js';

function makeFeature(id: string, type: Feature['type'], coordinates: unknown): Feature {
  return {
    id,
    type,
    coordinates,
    layerId: 'layer-1',
    properties: {},
    locked: false,
    visible: true,
  } as Feature;
}

const LINE = makeFeature('l', 'LineString', [
  [0, 0],
  [1, 1],
]);

interface Probe {
  renderers: RetainedRendererSet;
  calls: string[];
}

/**
 * @param buildable Whether a batch can be built (false imitates shaders not initialized yet)
 */
function createProbe(buildable = true): Probe {
  const calls: string[] = [];
  const build = (name: string) => () => {
    calls.push(`build:${name}`);
    return buildable ? ({ name } as never) : null;
  };
  const dispose = (name: string) => () => {
    calls.push(`dispose:${name}`);
  };
  const stroke = { width: 2, color: [0, 0, 0, 1], opacity: 1, lineStyle: 'solid' };
  const renderers = {
    line: {
      buildRetainedBatch: build('line'),
      drawRetainedBatch: () => {},
      disposeRetainedBatch: dispose('line'),
    },
    polygon: {
      buildRetained: build('polygon'),
      drawRetained: () => {},
      disposeRetained: dispose('polygon'),
    },
    point: {
      buildRetained: build('point'),
      drawRetained: () => {},
      disposeRetained: dispose('point'),
    },
    styles: {
      getPointStyle: () => ({
        shape: 'circle',
        size: 10,
        fillColor: [1, 0, 0, 1],
        fillOpacity: 1,
        strokeColor: [0, 0, 0, 1],
        strokeWidth: 1,
        strokeOpacity: 1,
      }),
      getLineStringStrokeStyle: () => stroke,
      getPolygonStyles: () => ({ fillColor: [0, 0, 1, 1], strokeStyle: stroke }),
    },
    viewport: () => [800, 600],
  } as unknown as RetainedRendererSet;
  return { renderers, calls };
}

describe('createChunkEntry', () => {
  it('starts dirty and without a batch', () => {
    const chunk = createChunkEntry('line');
    expect(chunk).toMatchObject({ kind: 'line', dirty: true, line: null, bbox: null });
    expect(chunk.rebasedFrame).toBe(-1);
  });
});

describe('buildChunkBatch', () => {
  it('builds a line batch and its coordinate slots', () => {
    const { renderers } = createProbe();
    const chunk = createChunkEntry('line');
    expect(buildChunkBatch(chunk, [LINE], undefined, [0, 0], renderers)).toBe('built');
    expect(chunk.line).not.toBeNull();
    expect(chunk.lineOffsets?.get('l')).toEqual({ offset: 0, count: 2 });
  });

  it('builds the batch of the kind of the chunk', () => {
    const { renderers, calls } = createProbe();
    const point = makeFeature('p', 'Point', [0, 0]);
    const polygon = makeFeature('g', 'Polygon', [
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    ]);
    buildChunkBatch(createChunkEntry('point-square'), [point], undefined, [0, 0], renderers);
    buildChunkBatch(createChunkEntry('polygon'), [polygon], undefined, [0, 0], renderers);
    expect(calls).toEqual(['build:point', 'build:polygon']);
  });

  it('reports empty when nothing can be drawn and retry when the batch cannot be made', () => {
    const short = makeFeature('s', 'LineString', [[0, 0]]);
    expect(
      buildChunkBatch(
        createChunkEntry('line'),
        [short],
        undefined,
        [0, 0],
        createProbe().renderers,
      ),
    ).toBe('empty');
    expect(
      buildChunkBatch(
        createChunkEntry('line'),
        [LINE],
        undefined,
        [0, 0],
        createProbe(false).renderers,
      ),
    ).toBe('retry');
    expect(
      buildChunkBatch(
        createChunkEntry('immediate'),
        [LINE],
        undefined,
        [0, 0],
        createProbe().renderers,
      ),
    ).toBe('empty');
  });
});

describe('disposeChunkBatches', () => {
  it('releases the batch and drops the patch state', () => {
    const { renderers, calls } = createProbe();
    const chunk = createChunkEntry('line');
    buildChunkBatch(chunk, [LINE], undefined, [0, 0], renderers);
    chunk.pendingCoordPatches = [{ coordIndex: 0, lngLat: [0, 0] }];

    disposeChunkBatches(chunk, renderers);

    expect(calls).toEqual(['build:line', 'dispose:line']);
    expect(chunk.line).toBeNull();
    expect(chunk.lineOffsets).toBeNull();
    expect(chunk.pendingCoordPatches).toBeNull();
  });

  it('only drops the references when there is nowhere to release them', () => {
    const { renderers, calls } = createProbe();
    const chunk = createChunkEntry('line');
    buildChunkBatch(chunk, [LINE], undefined, [0, 0], renderers);
    disposeChunkBatches(chunk, null);
    expect(calls).toEqual(['build:line']);
    expect(chunk.line).toBeNull();
  });
});
