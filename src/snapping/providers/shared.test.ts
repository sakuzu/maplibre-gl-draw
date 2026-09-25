// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the bbox-limited listing of the snapping providers
 *
 * They confirm that the listing through the index (collectFeatureSegmentsInBBox /
 * collectVertexCandidatesInBBox) matches the result of a full scan plus a bbox filter
 * exactly (parity). This is done at both scales, below the threshold and at or above
 * it.
 */

import { describe, expect, it } from 'vitest';
import { SEGMENT_INDEX_THRESHOLD } from '../../dispatcher/hit-test/segment-grid.js';
import type { BoundingBox, Coordinate, Feature, FeatureCoordinates } from '../../store/types.js';
import { computeVertexHandles } from '../../view/ui/handles.js';
import {
  collectFeatureSegments,
  collectFeatureSegmentsInBBox,
  collectVertexCandidatesInBBox,
  segmentIntersectsBBox,
} from './shared.js';

/** A seeded pseudo random generator (Math.random is not used, for the determinism of
 * the tests) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds a polyline with a random walk */
function randomPolyline(count: number, seed: number): Coordinate[] {
  const random = mulberry32(seed);
  const coords: Coordinate[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < count; i++) {
    x += random() * 2 - 1;
    y += random() * 2 - 1;
    coords.push([x, y]);
  }
  return coords;
}

/** Appends a copy of the first item to the end to make a closed ring */
function closeRing(coords: Coordinate[]): Coordinate[] {
  return [...coords, [coords[0][0], coords[0][1]]];
}

function makeFeature(type: string, coordinates: FeatureCoordinates): Feature {
  return {
    id: `f-${type}`,
    type,
    coordinates,
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
  };
}

/** All the coordinates of a feature (used as the reference points for placing a bbox) */
function flattenCoords(coordinates: FeatureCoordinates): Coordinate[] {
  const out: Coordinate[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value) && typeof value[0] === 'number') {
      out.push(value as Coordinate);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
    }
  };
  walk(coordinates);
  return out;
}

/**
 * Builds small random bboxes near a feature
 *
 * Some of them are placed away from the feature so that the path that finds nothing is
 * exercised as well.
 */
function randomBBoxes(feature: Feature, count: number, seed: number): BoundingBox[] {
  const coords = flattenCoords(feature.coordinates);
  const random = mulberry32(seed);
  const boxes: BoundingBox[] = [];

  for (let i = 0; i < count; i++) {
    const base = coords[Math.floor(random() * coords.length)];
    const far = i % 10 === 0 ? 500 : 0;
    const cx = base[0] + (random() * 2 - 1) + far;
    const cy = base[1] + (random() * 2 - 1) + far;
    const halfX = 0.05 + random() * 0.5;
    const halfY = 0.05 + random() * 0.5;
    boxes.push({ minX: cx - halfX, minY: cy - halfY, maxX: cx + halfX, maxY: cy + halfY });
  }
  return boxes;
}

/** Turns the result of listing edges into a string for comparison */
function segmentKeys(feature: Feature, bbox: BoundingBox, useIndex: boolean): string[] {
  const keys: string[] = [];
  const visit = (start: Coordinate, end: Coordinate, startRef: unknown, endRef: unknown): void => {
    keys.push(
      `${start[0]},${start[1]}|${end[0]},${end[1]}|${JSON.stringify(startRef)}|${JSON.stringify(endRef)}`,
    );
  };

  if (useIndex) {
    collectFeatureSegmentsInBBox(feature, bbox, visit);
    return keys;
  }

  // The old path: scan everything and then discard by bbox
  collectFeatureSegments(feature, (start, end, startRef, endRef) => {
    if (!segmentIntersectsBBox(start, end, bbox)) return;
    visit(start, end, startRef, endRef);
  });
  return keys;
}

/** Turns the result of listing vertices into a string for comparison */
function vertexKeys(feature: Feature, bbox: BoundingBox, useIndex: boolean): string[] {
  if (useIndex) {
    return collectVertexCandidatesInBBox(feature, bbox).map(
      (c) => `${c.position[0]},${c.position[1]}|${JSON.stringify(c.vertexRef)}`,
    );
  }

  // The old path: narrow down the full listing of computeVertexHandles by bbox
  const keys: string[] = [];
  for (const handle of computeVertexHandles(feature)) {
    const [x, y] = handle.position;
    if (x < bbox.minX || x > bbox.maxX || y < bbox.minY || y > bbox.maxY) continue;
    keys.push(`${x},${y}|${JSON.stringify(handle.vertexRef)}`);
  }
  return keys;
}

/** The features to compare (both below the threshold and at or above it) */
const SMALL = 300;
const LARGE = 3000;

const features: Array<{ name: string; feature: Feature; nonEmptyExpected: boolean }> = [
  {
    name: `LineString (${SMALL} vertices, below the threshold)`,
    feature: makeFeature('LineString', randomPolyline(SMALL, 1)),
    nonEmptyExpected: true,
  },
  {
    name: `LineString (${LARGE} vertices, at or above the threshold)`,
    feature: makeFeature('LineString', randomPolyline(LARGE, 2)),
    nonEmptyExpected: true,
  },
  {
    name: 'LineString (a closed line, at or above the threshold)',
    feature: makeFeature('LineString', closeRing(randomPolyline(LARGE, 3))),
    nonEmptyExpected: true,
  },
  {
    name: `Polygon (a closed ring with ${SMALL} vertices, below the threshold)`,
    feature: makeFeature('Polygon', [closeRing(randomPolyline(SMALL, 4))]),
    nonEmptyExpected: true,
  },
  {
    name: `Polygon (a closed ring with ${LARGE} vertices plus a hole, at or above the threshold)`,
    feature: makeFeature('Polygon', [
      closeRing(randomPolyline(LARGE, 5)),
      closeRing(randomPolyline(SMALL, 6)),
    ]),
    nonEmptyExpected: true,
  },
  {
    name: 'MultiLineString (a mix of below and at or above the threshold)',
    feature: makeFeature('MultiLineString', [
      randomPolyline(SMALL, 7),
      randomPolyline(LARGE, 8),
      randomPolyline(SEGMENT_INDEX_THRESHOLD, 9),
    ]),
    nonEmptyExpected: true,
  },
  {
    name: 'MultiPolygon (2 parts at or above the threshold)',
    feature: makeFeature('MultiPolygon', [
      [closeRing(randomPolyline(LARGE, 10))],
      [closeRing(randomPolyline(LARGE, 11)), closeRing(randomPolyline(SMALL, 12))],
    ]),
    nonEmptyExpected: true,
  },
];

describe('the parity of collectFeatureSegmentsInBBox', () => {
  for (const { name, feature, nonEmptyExpected } of features) {
    it(`matches a full scan plus a bbox filter for ${name}`, () => {
      const boxes = randomBBoxes(feature, 100, 4242);
      let hits = 0;

      for (const bbox of boxes) {
        const expected = segmentKeys(feature, bbox, false);
        const actual = segmentKeys(feature, bbox, true);
        expect(actual).toEqual(expected);
        if (expected.length > 0) hits++;
      }

      if (nonEmptyExpected) expect(hits).toBeGreaterThan(0);
    });
  }

  it('lists nothing for a bbox far from the feature', () => {
    for (const { feature } of features) {
      const bbox: BoundingBox = { minX: 1000, minY: 1000, maxX: 1001, maxY: 1001 };
      expect(segmentKeys(feature, bbox, true)).toEqual([]);
    }
  });
});

describe('the parity of collectVertexCandidatesInBBox', () => {
  for (const { name, feature, nonEmptyExpected } of features) {
    it(`matches computeVertexHandles plus a bbox filter for ${name}`, () => {
      const boxes = randomBBoxes(feature, 100, 777);
      let hits = 0;

      for (const bbox of boxes) {
        const expected = vertexKeys(feature, bbox, false);
        const actual = vertexKeys(feature, bbox, true);
        expect(actual).toEqual(expected);
        if (expected.length > 0) hits++;
      }

      if (nonEmptyExpected) expect(hits).toBeGreaterThan(0);
    });
  }

  it('keeps the last vertex of a closed ring (the closing point) out of the vertex candidates', () => {
    const ring = closeRing(randomPolyline(LARGE, 21));
    const feature = makeFeature('Polygon', [ring]);
    const first = ring[0];
    const bbox: BoundingBox = {
      minX: first[0] - 0.2,
      minY: first[1] - 0.2,
      maxX: first[0] + 0.2,
      maxY: first[1] + 0.2,
    };

    const candidates = collectVertexCandidatesInBBox(feature, bbox);
    const refs = candidates.map((c) => JSON.stringify(c.vertexRef));

    expect(refs).toContain(JSON.stringify({ ring: 0, index: 0 }));
    expect(refs).not.toContain(JSON.stringify({ ring: 0, index: ring.length - 1 }));
    // The same reference does not come out twice (the deduplication through the index)
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('keeps the last vertex of a closed line (LineString) among the candidates as well', () => {
    const coords = closeRing(randomPolyline(LARGE, 22));
    const feature = makeFeature('LineString', coords);
    const first = coords[0];
    const bbox: BoundingBox = {
      minX: first[0] - 0.2,
      minY: first[1] - 0.2,
      maxX: first[0] + 0.2,
      maxY: first[1] + 0.2,
    };

    const refs = collectVertexCandidatesInBBox(feature, bbox).map((c) =>
      JSON.stringify(c.vertexRef),
    );

    expect(refs).toContain(JSON.stringify({ ring: 0, index: 0 }));
    expect(refs).toContain(JSON.stringify({ ring: 0, index: coords.length - 1 }));
  });

  it('simply narrows the vertex handles down by bbox for Point / MultiPoint, as before', () => {
    const point = makeFeature('Point', [1, 1]);
    const inside: BoundingBox = { minX: 0, minY: 0, maxX: 2, maxY: 2 };
    const outside: BoundingBox = { minX: 5, minY: 5, maxX: 6, maxY: 6 };

    expect(collectVertexCandidatesInBBox(point, inside)).toEqual([
      { position: [1, 1], vertexRef: { ring: 0, index: 0 } },
    ]);
    expect(collectVertexCandidatesInBBox(point, outside)).toEqual([]);

    const multi = makeFeature('MultiPoint', [
      [1, 1],
      [9, 9],
    ]);
    expect(collectVertexCandidatesInBBox(multi, inside)).toEqual([
      { position: [1, 1], vertexRef: { part: 0, ring: 0, index: 0 } },
    ]);
  });

  it('does not break for a feature with no vertices at all or a degenerate one', () => {
    const bbox: BoundingBox = { minX: -1, minY: -1, maxX: 1, maxY: 1 };

    expect(collectVertexCandidatesInBBox(makeFeature('LineString', []), bbox)).toEqual([]);
    expect(collectVertexCandidatesInBBox(makeFeature('Polygon', [[]]), bbox)).toEqual([]);

    // A ring with only 1 point is treated as a closing point, and no vertex handle is
    // produced either
    const degenerate = makeFeature('Polygon', [[[0, 0]]]);
    expect(vertexKeys(degenerate, bbox, true)).toEqual(vertexKeys(degenerate, bbox, false));
    expect(collectVertexCandidatesInBBox(degenerate, bbox)).toEqual([]);
  });
});
