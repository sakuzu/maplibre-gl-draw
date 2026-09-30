// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the incremental update of the coordinate texture of a line chunk
 */

import { describe, expect, it } from 'vitest';
import { geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import type { Coordinate, Feature } from '../../store/types.js';
import type { RetainedLineBatch } from '../renderers/line/line-types.js';
import type { RetainedLineRenderer } from '../renderers/retained.js';
import {
  type CoordPatch,
  flushCoordPatches,
  MAX_PATCHED_VERTICES,
  type PatchableLineChunk,
  queueCoordPatch,
} from './store-retained-coord-patch.js';

/** Shared, so that an update that only moves vertices keeps the same properties object */
const PROPERTIES = {};

const COORDS: Coordinate[] = [
  [0, 0],
  [1, 1],
  [2, 2],
];

function makeLine(id: string, coordinates: Coordinate[], type: Feature['type'] = 'LineString') {
  return {
    id,
    type,
    geometry: geometryFromCoordinates(type, coordinates),
    layerId: 'layer-1',
    properties: PROPERTIES,
    locked: false,
    visible: true,
    style: {},
  } as Feature;
}

function makeChunk(overrides: Partial<PatchableLineChunk> = {}): PatchableLineChunk {
  return {
    kind: 'line',
    line: {} as RetainedLineBatch,
    dirty: false,
    lineOffsets: new Map([['a', { offset: 5, count: COORDS.length }]]),
    pendingCoordPatches: null,
    bbox: [0, 0, 2, 2],
    ...overrides,
  };
}

function makeRenderer(patched: CoordPatch[][] | null): RetainedLineRenderer {
  const renderer = {
    buildRetainedBatch: () => null,
    drawRetainedBatch: () => {},
    disposeRetainedBatch: () => {},
  } as unknown as RetainedLineRenderer & {
    patchRetainedBatchCoords?: (batch: RetainedLineBatch, updates: CoordPatch[]) => void;
  };
  if (patched) {
    renderer.patchRetainedBatchCoords = (_batch, updates) => {
      patched.push([...updates]);
    };
  }
  return renderer;
}

describe('queueCoordPatch', () => {
  const previous = makeLine('a', COORDS);
  const moved = makeLine('a', [COORDS[0], [5, 1], COORDS[2]]);

  it('queues the moved vertex at its texel and grows the bbox', () => {
    const chunk = makeChunk();
    expect(queueCoordPatch(chunk, moved, previous, makeRenderer([]))).toBe(true);
    expect(chunk.pendingCoordPatches).toEqual([{ coordIndex: 6, lngLat: [5, 1] }]);
    expect(chunk.bbox).toEqual([0, 0, 5, 2]);
  });

  it('refuses when the chunk cannot take a patch', () => {
    const renderer = makeRenderer([]);
    expect(queueCoordPatch(undefined, moved, previous, renderer)).toBe(false);
    expect(queueCoordPatch(makeChunk({ dirty: true }), moved, previous, renderer)).toBe(false);
    expect(queueCoordPatch(makeChunk({ line: null }), moved, previous, renderer)).toBe(false);
    expect(queueCoordPatch(makeChunk({ kind: 'polygon' }), moved, previous, renderer)).toBe(false);
    expect(queueCoordPatch(makeChunk({ lineOffsets: new Map() }), moved, previous, renderer)).toBe(
      false,
    );
  });

  it('refuses when the renderer has no partial update', () => {
    expect(queueCoordPatch(makeChunk(), moved, previous, makeRenderer(null))).toBe(false);
    expect(queueCoordPatch(makeChunk(), moved, previous, null)).toBe(false);
  });

  it('refuses a change that is not a small vertex move', () => {
    const renderer = makeRenderer([]);
    const withProps = { ...moved, properties: { color: 'red' } };
    expect(queueCoordPatch(makeChunk(), withProps, previous, renderer)).toBe(false);
    expect(queueCoordPatch(makeChunk(), previous, previous, renderer)).toBe(false);
    const added = makeLine('a', [...COORDS, [3, 3]]);
    expect(queueCoordPatch(makeChunk(), added, previous, renderer)).toBe(false);
    const polygon = { ...moved, type: 'MultiLineString' } as Feature;
    expect(queueCoordPatch(makeChunk(), polygon, previous, renderer)).toBe(false);
  });

  it('refuses more moved vertices than the limit', () => {
    const many: Coordinate[] = Array.from({ length: MAX_PATCHED_VERTICES + 1 }, (_, i) => [i, 0]);
    const next = makeLine(
      'a',
      many.map(([x, y]) => [x, y + 1]),
    );
    const chunk = makeChunk({
      lineOffsets: new Map([['a', { offset: 0, count: many.length }]]),
    });
    expect(queueCoordPatch(chunk, next, makeLine('a', many), makeRenderer([]))).toBe(false);
  });
});

describe('flushCoordPatches', () => {
  it('writes the queued patches once and clears the queue', () => {
    const patched: CoordPatch[][] = [];
    const chunk = makeChunk({ pendingCoordPatches: [{ coordIndex: 1, lngLat: [1, 2] }] });
    flushCoordPatches(chunk, makeRenderer(patched));
    flushCoordPatches(chunk, makeRenderer(patched));
    expect(patched).toEqual([[{ coordIndex: 1, lngLat: [1, 2] }]]);
    expect(chunk.pendingCoordPatches).toBeNull();
  });

  it('marks the chunk dirty when the renderer lost the partial update', () => {
    const chunk = makeChunk({ pendingCoordPatches: [{ coordIndex: 1, lngLat: [1, 2] }] });
    flushCoordPatches(chunk, makeRenderer(null));
    expect(chunk.dirty).toBe(true);
    expect(chunk.pendingCoordPatches).toBeNull();
  });
});
