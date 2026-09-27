// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the splitting into spatial chunks
 *
 * Retained-mode rendering stands on the structure "build per chunk and cull per chunk". These
 * tests look at the target number of chunks, the rule that preserves the draw order, and the
 * composition of the bboxes.
 */

import { describe, expect, it } from 'vitest';
import type { Feature } from '../store/types.js';
import { displayFeature } from '../test-utils.js';
import type { RenderableTerrainTile } from '../view/terrain/detect.js';
import { mercatorX, mercatorY, type TessellationStep } from '../view/terrain/tessellation.js';
import { buildTessellationTiling, tilingSignature } from '../view/terrain/tiling.js';
import {
  boundsIntersect,
  CHUNK_TARGET_SIZE,
  chunkTargetSizeFor,
  LARGE_CHUNK_TARGET_SIZE,
  LARGE_DATASET_THRESHOLD,
  partitionIntoChunks,
} from './chunk.js';
import { needsRetessellation } from './dataset.js';

/** Tile (x, y) at zoom z. tileID is not used to compute the fingerprint */
const tile = (z: number, x: number, y: number): RenderableTerrainTile =>
  ({ z, x, y, tileID: null }) as unknown as RenderableTerrainTile;

/** Builds points laid out in a grid (the order of the array = the draw order) */
function createPoints(count: number, step = 1): Feature[] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const features: Feature[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    features[i] = displayFeature({
      id: `f${i}`,
      type: 'Point',
      coordinates: [col * step, row * step],
    });
  }

  return features;
}

describe('the number of chunks', () => {
  it('everything up to the target count is gathered into one chunk', () => {
    expect(partitionIntoChunks(createPoints(1))).toHaveLength(1);
    expect(partitionIntoChunks(createPoints(CHUNK_TARGET_SIZE))).toHaveLength(1);
  });

  it('512 features are not split into chunks', () => {
    const chunks = partitionIntoChunks(createPoints(CHUNK_TARGET_SIZE));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].rows).toHaveLength(CHUNK_TARGET_SIZE);
  });

  it('513 features are split into chunks', () => {
    const chunks = partitionIntoChunks(createPoints(CHUNK_TARGET_SIZE + 1));

    expect(chunks.length).toBeGreaterThan(1);
    const total = chunks.reduce((sum, chunk) => sum + chunk.rows.length, 0);
    expect(total).toBe(CHUNK_TARGET_SIZE + 1);
  });

  it('no chunk exceeds the target count (because it is halved at the median)', () => {
    const chunks = partitionIntoChunks(createPoints(5_000));

    for (const chunk of chunks) {
      expect(chunk.rows.length).toBeLessThanOrEqual(CHUNK_TARGET_SIZE);
      expect(chunk.rows.length).toBeGreaterThan(0);
    }
  });

  it('the counts stay even even with one extremely wide feature mixed in', () => {
    // 2,000 features packed into a narrow range + 1 the size of the world
    const features: Feature[] = [];
    for (let i = 0; i < 2_000; i++) {
      features.push(
        displayFeature({
          id: `p${i}`,
          type: 'Point',
          coordinates: [139.5 + (i % 50) * 0.001, 35.6 + Math.floor(i / 50) * 0.001],
        }),
      );
    }
    features.push(
      displayFeature({
        id: 'world',
        type: 'LineString',
        coordinates: [
          [-179, -60],
          [179, 70],
        ],
      }),
    );

    const chunks = partitionIntoChunks(features);

    // Back when it was cut with a grid, the whole bbox spread to the size of the world and the
    // whole packed part fell into a single cell
    for (const chunk of chunks) {
      expect(chunk.rows.length).toBeLessThanOrEqual(CHUNK_TARGET_SIZE);
    }
    expect(chunks.length).toBeGreaterThanOrEqual(4);
  });

  it('the target count of the splitting can be given', () => {
    const chunks = partitionIntoChunks(createPoints(100), 10);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.rows.length).toBeGreaterThan(0);
    }
  });

  it('empty input builds no chunk', () => {
    expect(partitionIntoChunks([])).toEqual([]);
  });
});

describe('the target count for the total number of features', () => {
  it('the default target count is used up to the threshold', () => {
    expect(chunkTargetSizeFor(0)).toBe(CHUNK_TARGET_SIZE);
    expect(chunkTargetSizeFor(LARGE_DATASET_THRESHOLD)).toBe(CHUNK_TARGET_SIZE);
  });

  it('the target count is raised beyond the threshold', () => {
    expect(chunkTargetSizeFor(LARGE_DATASET_THRESHOLD + 1)).toBe(LARGE_CHUNK_TARGET_SIZE);
    expect(chunkTargetSizeFor(260_000)).toBe(LARGE_CHUNK_TARGET_SIZE);
  });

  it('260,000 features keep the chunk count in two digits thanks to the raise', () => {
    // With the default target it would be 260,000 / 192 = 1,354 chunks
    expect(Math.ceil(260_000 / CHUNK_TARGET_SIZE)).toBeGreaterThan(1_000);
    expect(Math.ceil(260_000 / chunkTargetSizeFor(260_000))).toBe(64);
  });
});

describe('the draw order of the chunks', () => {
  it('the order of the original array is kept inside a chunk', () => {
    const features = createPoints(200, 1);
    const chunks = partitionIntoChunks(features, 10);

    for (const chunk of chunks) {
      const indices = Array.from(chunk.rows);
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
      expect(indices.map((i) => features[i].id)).toEqual(indices.map((i) => `f${i}`));
    }
  });

  it('the chunks are ordered by "the original index of the first feature"', () => {
    const chunks = partitionIntoChunks(createPoints(200, 1), 10);

    const firsts = chunks.map((chunk) => chunk.firstIndex);
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
    expect(firsts[0]).toBe(0);
  });

  it('concatenating every chunk makes each feature appear exactly once', () => {
    const features = createPoints(300, 1);
    const chunks = partitionIntoChunks(features, 10);

    const ids = chunks.flatMap((chunk) => Array.from(chunk.rows, (row) => features[row].id));
    expect(new Set(ids).size).toBe(features.length);
    expect(ids).toHaveLength(features.length);
  });
});

describe('the bbox of a chunk', () => {
  it('it is the union of the bboxes of the features contained', () => {
    const features = [
      displayFeature({ id: 'a', type: 'Point', coordinates: [0, 0] }),
      displayFeature({ id: 'b', type: 'Point', coordinates: [10, 5] }),
    ];

    const [chunk] = partitionIntoChunks(features);

    expect(chunk.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 5 });
  });

  it('the splitting does not break even when everything is at the same coordinate', () => {
    const features: Feature[] = [];
    for (let i = 0; i < 600; i++) {
      features.push(displayFeature({ id: `f${i}`, type: 'Point', coordinates: [1, 2] }));
    }

    const chunks = partitionIntoChunks(features);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].rows).toHaveLength(600);
    expect(chunks[0].bounds).toEqual({ minX: 1, minY: 2, maxX: 1, maxY: 2 });
  });

  it('the bboxes of the chunks may overlap (the assignment is decided by the center)', () => {
    const chunks = partitionIntoChunks(createPoints(200, 1), 10);

    // The union of the bboxes of every chunk equals the whole bbox
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    for (const chunk of chunks) {
      minX = Math.min(minX, chunk.bounds.minX);
      maxX = Math.max(maxX, chunk.bounds.maxX);
    }
    expect(minX).toBe(0);
    expect(maxX).toBe(14);
  });
});

describe('the bbox intersection test', () => {
  const base = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

  it('true when they overlap', () => {
    expect(boundsIntersect(base, { minX: 5, minY: 5, maxX: 20, maxY: 20 })).toBe(true);
  });

  it('true when they touch at an edge', () => {
    expect(boundsIntersect(base, { minX: 10, minY: 10, maxX: 20, maxY: 20 })).toBe(true);
  });

  it('false when they are apart', () => {
    expect(boundsIntersect(base, { minX: 10.1, minY: 0, maxX: 20, maxY: 10 })).toBe(false);
    expect(boundsIntersect(base, { minX: 0, minY: -20, maxX: 10, maxY: -0.1 })).toBe(false);
  });
});

describe('the re-bake decision of the terrain subdivision', () => {
  const chunk = {
    rows: new Int32Array(0),
    bounds: { minX: 139.5, minY: 35.6, maxX: 139.6, maxY: 35.7 },
    firstIndex: 0,
  };
  const meshSize = 128;
  /** One z13 tile covering the chunk */
  const coarseTiles = [
    tile(13, 7266, 3226),
    tile(13, 7267, 3226),
    tile(13, 7266, 3227),
    tile(13, 7267, 3227),
  ];
  /** A tile covering the same place at z14 */
  const fineTiles = [
    tile(14, 14532, 6452),
    tile(14, 14533, 6452),
    tile(14, 14534, 6452),
    tile(14, 14532, 6453),
    tile(14, 14533, 6453),
    tile(14, 14534, 6453),
    tile(14, 14532, 6454),
    tile(14, 14533, 6454),
    tile(14, 14534, 6454),
  ];
  const region = {
    x0: mercatorX(139.4),
    y0: mercatorY(35.8),
    x1: mercatorX(139.7),
    y1: mercatorY(35.5),
  };
  const stepFor = (tiles: RenderableTerrainTile[], coarsen?: number): TessellationStep => ({
    grid: 1 / (2 ** 14 * meshSize),
    maxPoints: 800_000,
    region,
    tiling: buildTessellationTiling(tiles, meshSize, region),
    coarsen,
  });
  const built = (step: TessellationStep) => ({
    builtGrid: step.grid,
    builtTilingKey: tilingSignature(
      step.tiling ?? null,
      step.region ?? null,
      step.coarsen && step.coarsen > 1 ? step.coarsen : 1,
      step.grid,
      mercatorX(chunk.bounds.minX),
      mercatorY(chunk.bounds.maxY),
      mercatorX(chunk.bounds.maxX),
      mercatorY(chunk.bounds.minY),
    ),
    chunk,
  });

  it('nothing is re-baked without terrain', () => {
    expect(needsRetessellation({ builtGrid: 0, builtTilingKey: null, chunk }, null)).toBe(false);
  });

  it('a shape baked without terrain is re-baked once the terrain is alive', () => {
    expect(
      needsRetessellation({ builtGrid: 0, builtTilingKey: null, chunk }, stepFor(coarseTiles)),
    ).toBe(true);
  });

  it('nothing is re-baked while the tile composition is the same', () => {
    const step = stepFor(coarseTiles);
    expect(needsRetessellation(built(step), step)).toBe(false);
  });

  it('it is re-baked when the zoom of the tiles covering its patch changed', () => {
    const before = stepFor(coarseTiles);
    const after = stepFor(fineTiles);
    expect(needsRetessellation(built(before), after)).toBe(true);
  });

  it('it is re-baked when the coarsening factor changed', () => {
    const before = stepFor(coarseTiles);
    const after = stepFor(coarseTiles, 2);
    expect(needsRetessellation(built(before), after)).toBe(true);
  });

  it('moving the region re-bakes nothing while the tile composition is the same', () => {
    const before = stepFor(coarseTiles);
    const moved: TessellationStep = {
      ...before,
      region: {
        x0: region.x0 - 0.0001,
        y0: region.y0 - 0.0001,
        x1: region.x1 - 0.0001,
        y1: region.y1 - 0.0001,
      },
    };
    expect(needsRetessellation(built(before), moved)).toBe(false);
  });
});

describe('the splitting by the amount of work', () => {
  it('a feature with many vertices splits a chunk even below the target count', () => {
    const features: Feature[] = [];
    // 20 small points
    for (let i = 0; i < 20; i++) {
      features.push(
        displayFeature({
          id: `p${i}`,
          type: 'Point',
          coordinates: [139.5 + i * 0.01, 35.6],
        }),
      );
    }
    // 1 line with 50,000 vertices (it exceeds the target vertex count on its own)
    const dense: [number, number][] = [];
    for (let i = 0; i < 50_000; i++) dense.push([139.6 + i * 1e-6, 35.7]);
    features.push(displayFeature({ id: 'big', type: 'LineString', coordinates: dense }));

    const chunks = partitionIntoChunks(features);

    // The count is 21, below the target (96), but it is cut by the vertex count
    expect(chunks.length).toBeGreaterThan(1);
    // The huge single feature becomes a chunk of its own (it cannot be split any further)
    const bigRow = features.findIndex((f) => f.id === 'big');
    const big = chunks.find((chunk) => chunk.rows.includes(bigRow));
    expect(big?.rows).toHaveLength(1);
  });

  it('nothing is cut by the vertex count when only small features are there', () => {
    const chunks = partitionIntoChunks(createPoints(50));

    expect(chunks).toHaveLength(1);
  });
});
