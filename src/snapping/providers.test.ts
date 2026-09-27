// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the built-in snapping providers (the vertices, edges and intersections of
 * the Store, and the guides)
 *
 * They verify the listing of candidates per type (LineString / the hole of a Polygon /
 * the Multi variants), the rules of exclusion (the vertex being dragged and the edges
 * touching it, and the excluded features), the handling of hiding, the delegation to
 * getSnapTargets for a custom type, and the generation of guides while drawing.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { initialBearingDegrees } from '../geometry/distance.js';
import { coordinatesOf, geometryFromCoordinates } from '../shared/utils/coordinates.js';
import { MemoryStore } from '../store/memory.js';
import { RBushSpatialIndex } from '../store/spatial/spatial-index.js';
import type {
  Coordinate,
  Feature,
  FeatureCoordinates,
  Layer,
  TentativeState,
} from '../store/types.js';
import { createSnapTargetsRegistry, type SnapTargetsRegistry } from './custom-targets.js';
import { degreesPerPixel } from './geometry.js';
import { createGuideSnapProvider } from './providers/guide.js';
import { createStoreIntersectionSnapProvider } from './providers/intersection.js';
import {
  createBuiltInSnapProviders,
  createStoreEdgeSnapProvider,
  createStoreVertexSnapProvider,
} from './providers/store.js';
import type {
  SnapCandidate,
  SnapPointCandidate,
  SnapProviderContext,
  SnapSegmentCandidate,
} from './types.js';
import { isSegmentCandidate } from './types.js';

const ZOOM = 14;

let store: MemoryStore;
let spatialIndex: RBushSpatialIndex;
let snapTargets: SnapTargetsRegistry;

function makeLayer(id: string, visible = true): Layer {
  return {
    id,
    name: id,
    visible,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  };
}

function addFeature(
  id: string,
  type: string,
  coordinates: FeatureCoordinates,
  overrides: Partial<Feature> = {},
): Feature {
  const feature: Feature = {
    id,
    type,
    geometry: geometryFromCoordinates(type, coordinates),
    layerId: 'l1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
    ...overrides,
  };
  store.createFeature(feature);
  const layer = store.getLayer(feature.layerId);
  if (layer) {
    store.updateLayer(layer.id, { items: [...layer.items, feature.id] });
  }
  spatialIndex.insert(feature);
  return feature;
}

/** A bbox and a context wide enough to contain every feature */
function providerContext(overrides: Partial<SnapProviderContext> = {}): SnapProviderContext {
  return {
    zoom: ZOOM,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    lngLat: { lng: 0, lat: 0 },
    point: { x: 0, y: 0 },
    tolerancePx: 10,
    toleranceLngDeg: 1,
    toleranceLatDeg: 1,
    ...overrides,
  };
}

const WIDE_BBOX = { minX: -1, minY: -1, maxX: 1, maxY: 1 };

function vertexCandidates(ctx: SnapProviderContext = providerContext()): SnapCandidate[] {
  return createStoreVertexSnapProvider({ store, spatialIndex, snapTargets }).candidates(
    WIDE_BBOX,
    ctx,
  );
}

function edgeCandidates(ctx: SnapProviderContext = providerContext()): SnapSegmentCandidate[] {
  return createStoreEdgeSnapProvider({ store, spatialIndex, snapTargets })
    .candidates(WIDE_BBOX, ctx)
    .filter(isSegmentCandidate);
}

function intersectionCandidates(
  ctx: SnapProviderContext = providerContext(),
  bbox = WIDE_BBOX,
): SnapPointCandidate[] {
  return createStoreIntersectionSnapProvider({ store, spatialIndex, snapTargets })
    .candidates(bbox, ctx)
    .filter((c): c is SnapPointCandidate => !isSegmentCandidate(c));
}

/** Takes out only the coordinates of the candidates */
function coordsOf(candidates: SnapCandidate[]): Coordinate[] {
  return candidates.map((c) => (isSegmentCandidate(c) ? c.start : c.coordinate));
}

beforeEach(() => {
  store = new MemoryStore();
  spatialIndex = new RBushSpatialIndex();
  store.createLayer(makeLayer('l1'));
  // The snapping candidates of the custom types of this draw instance
  snapTargets = createSnapTargetsRegistry();
});

describe('the built-in vertex provider', () => {
  it('lists every vertex of a LineString', () => {
    addFeature('f1', 'LineString', [
      [0, 0],
      [0.1, 0],
      [0.1, 0.1],
    ]);

    const candidates = vertexCandidates();

    expect(candidates).toHaveLength(3);
    expect(candidates.every((c) => c.kind === 'vertex')).toBe(true);
    expect(coordsOf(candidates)).toEqual([
      [0, 0],
      [0.1, 0],
      [0.1, 0.1],
    ]);
    expect(candidates.every((c) => c.featureId === 'f1')).toBe(true);
  });

  it('makes the coordinate of a Point a candidate as well', () => {
    addFeature('p1', 'Point', [0.2, 0.2]);

    expect(coordsOf(vertexCandidates())).toEqual([[0.2, 0.2]]);
  });

  it('lists the vertices of the outer ring and the inner ring (the hole) of a Polygon, without duplicating the closing point', () => {
    addFeature('poly', 'Polygon', [
      [
        [0, 0],
        [0.4, 0],
        [0.4, 0.4],
        [0, 0.4],
        [0, 0],
      ],
      [
        [0.1, 0.1],
        [0.2, 0.1],
        [0.2, 0.2],
        [0.1, 0.2],
        [0.1, 0.1],
      ],
    ]);

    const candidates = vertexCandidates();

    // 4 on the outer ring + 4 on the inner ring (the closing points excluded)
    expect(candidates).toHaveLength(8);
    const holeVertices = candidates.filter((c) => !isSegmentCandidate(c) && c.vertex?.ring === 1);
    expect(holeVertices).toHaveLength(4);
    expect(coordsOf(holeVertices)).toContainEqual([0.2, 0.2]);
  });

  it('lists the vertices of every part of the Multi variants with the part number', () => {
    addFeature('mp', 'MultiPoint', [
      [0, 0],
      [0.1, 0.1],
    ]);
    addFeature('mls', 'MultiLineString', [
      [
        [0.2, 0],
        [0.3, 0],
      ],
      [
        [0.2, 0.2],
        [0.3, 0.2],
      ],
    ]);
    addFeature('mpoly', 'MultiPolygon', [
      [
        [
          [0.5, 0],
          [0.6, 0],
          [0.6, 0.1],
          [0.5, 0],
        ],
      ],
    ]);

    const candidates = vertexCandidates().filter(
      (c): c is SnapPointCandidate => !isSegmentCandidate(c),
    );
    const byFeature = (id: string) => candidates.filter((c) => c.featureId === id);

    expect(byFeature('mp')).toHaveLength(2);
    expect(byFeature('mp')[1].vertex).toEqual({ part: 1, ring: 0, index: 0 });
    expect(byFeature('mls')).toHaveLength(4);
    expect(byFeature('mls')[2].vertex).toEqual({ part: 1, ring: 0, index: 0 });
    // 3 vertices with the closing point excluded
    expect(byFeature('mpoly')).toHaveLength(3);
    expect(byFeature('mpoly')[0].vertex).toEqual({ part: 0, ring: 0, index: 0 });
  });

  it('excludes only the vertex being dragged and keeps the other vertices of the same feature', () => {
    addFeature('f1', 'LineString', [
      [0, 0],
      [0.1, 0],
      [0.2, 0],
    ]);

    const candidates = vertexCandidates(
      providerContext({ excludeVertex: { featureId: 'f1', vertex: { ring: 0, index: 1 } } }),
    );

    expect(coordsOf(candidates)).toEqual([
      [0, 0],
      [0.2, 0],
    ]);
  });

  it('applies the exclusion only to the feature that was given', () => {
    addFeature('f1', 'LineString', [
      [0, 0],
      [0.1, 0],
    ]);
    addFeature('f2', 'LineString', [
      [0, 0],
      [0.1, 0],
    ]);

    const candidates = vertexCandidates(
      providerContext({ excludeVertex: { featureId: 'f1', vertex: { ring: 0, index: 0 } } }),
    );

    expect(candidates.filter((c) => c.featureId === 'f1')).toHaveLength(1);
    expect(candidates.filter((c) => c.featureId === 'f2')).toHaveLength(2);
  });

  it('drops the feature of excludeFeatureId entirely', () => {
    addFeature('f1', 'LineString', [
      [0, 0],
      [0.1, 0],
    ]);

    expect(vertexCandidates(providerContext({ excludeFeatureId: 'f1' }))).toHaveLength(0);
  });

  it('drops the features of excludeFeatureIds entirely (the features being moved in a drag)', () => {
    addFeature('f1', 'LineString', [
      [0, 0],
      [0.1, 0],
    ]);
    addFeature('f2', 'LineString', [
      [0, 0.1],
      [0.1, 0.1],
    ]);

    const candidates = vertexCandidates(providerContext({ excludeFeatureIds: new Set(['f1']) }));

    expect(candidates.filter((c) => c.featureId === 'f1')).toHaveLength(0);
    expect(candidates.filter((c) => c.featureId === 'f2')).toHaveLength(2);
  });

  it('leaves out hidden features, layers and groups', () => {
    addFeature('hidden', 'Point', [0, 0], { visible: false });
    store.createLayer(makeLayer('l2', false));
    addFeature('inHiddenLayer', 'Point', [0.1, 0], { layerId: 'l2' });
    store.createGroup({
      id: 'g1',
      layerId: 'l1',
      name: 'g1',
      featureIds: ['inHiddenGroup'],
      locked: false,
      visible: false,
    });
    addFeature('inHiddenGroup', 'Point', [0.2, 0], { groupId: 'g1' });
    addFeature('visible', 'Point', [0.3, 0]);

    const candidates = vertexCandidates();

    expect(candidates.map((c) => c.featureId)).toEqual(['visible']);
  });

  it('leaves out locally hidden features as well', () => {
    addFeature('f1', 'Point', [0, 0]);
    store.setLocallyHidden('f1', true);

    expect(vertexCandidates()).toHaveLength(0);
  });

  it('delegates a custom type to the registered getSnapTargets', () => {
    addFeature('marker', 'Marker', [0.1, 0.1]);
    snapTargets.register('Marker', (feature) => {
      const coord = coordinatesOf(feature) as Coordinate;
      return [
        { kind: 'vertex', coordinate: coord, description: 'marker-center' },
        { kind: 'edge', start: coord, end: [coord[0] + 0.01, coord[1]] },
      ];
    });

    const candidates = vertexCandidates();

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({
      kind: 'vertex',
      coordinate: [0.1, 0.1],
      description: 'marker-center',
      featureId: 'marker',
    });
    expect(isSegmentCandidate(candidates[1])).toBe(true);
  });

  it('does not see the getSnapTargets registered in another draw instance', () => {
    addFeature('marker', 'Marker', [0.1, 0.1]);
    const other = createSnapTargetsRegistry();
    other.register('Marker', () => [
      { kind: 'vertex', coordinate: [0.5, 0.5], description: 'other-instance' },
    ]);

    // This instance has no registration for Marker, so the other instance's candidate is absent
    expect(coordsOf(vertexCandidates())).toEqual([]);

    // Registering it here (this instance) makes it appear
    snapTargets.register('Marker', () => [
      { kind: 'vertex', coordinate: [0.2, 0.2], description: 'this-instance' },
    ]);
    expect(coordsOf(vertexCandidates())).toEqual([[0.2, 0.2]]);
  });

  it('applies the exclusion to the vertices returned by getSnapTargets as well', () => {
    addFeature('marker', 'Marker', [0.1, 0.1]);
    snapTargets.register('Marker', (feature) => [
      {
        kind: 'vertex',
        coordinate: coordinatesOf(feature) as Coordinate,
        vertex: { ring: 0, index: 0 },
      },
    ]);

    const candidates = vertexCandidates(
      providerContext({ excludeVertex: { featureId: 'marker', vertex: { ring: 0, index: 0 } } }),
    );

    expect(candidates).toHaveLength(0);
  });
});

describe('the built-in edge provider', () => {
  it('lists the segments of a LineString', () => {
    addFeature('f1', 'LineString', [
      [0, 0],
      [0.1, 0],
      [0.1, 0.1],
    ]);

    const candidates = edgeCandidates();

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({
      kind: 'edge',
      start: [0, 0],
      end: [0.1, 0],
      startRef: { ring: 0, index: 0 },
      endRef: { ring: 0, index: 1 },
      featureId: 'f1',
    });
  });

  it('attaches the vertex references of both ends to a segment candidate (the closing point is normalized to index 0)', () => {
    addFeature('poly', 'Polygon', [
      [
        [0, 0],
        [0.4, 0],
        [0.4, 0.4],
        [0, 0],
      ],
    ]);

    const candidates = edgeCandidates();

    expect(candidates).toHaveLength(3);
    expect(candidates[2]).toMatchObject({
      start: [0.4, 0.4],
      end: [0, 0],
      startRef: { ring: 0, index: 2 },
      endRef: { ring: 0, index: 0 },
    });
  });

  it('attaches vertex references with the part number to the segment candidates of a MultiPolygon', () => {
    addFeature('mpoly', 'MultiPolygon', [
      [
        [
          [0, 0],
          [0.1, 0],
          [0.1, 0.1],
          [0, 0],
        ],
      ],
    ]);

    const candidates = edgeCandidates();

    expect(candidates[0].startRef).toEqual({ part: 0, ring: 0, index: 0 });
    expect(candidates[0].endRef).toEqual({ part: 0, ring: 0, index: 1 });
  });

  it('lists the edges of the outer ring and the inner ring of a Polygon, including the closing ones', () => {
    addFeature('poly', 'Polygon', [
      [
        [0, 0],
        [0.4, 0],
        [0.4, 0.4],
        [0, 0],
      ],
      [
        [0.1, 0.1],
        [0.2, 0.1],
        [0.2, 0.2],
        [0.1, 0.1],
      ],
    ]);

    const candidates = edgeCandidates();

    // 2 triangles = 3 edges x 2
    expect(candidates).toHaveLength(6);
  });

  it('lists a MultiPolygon across parts and rings', () => {
    addFeature('mpoly', 'MultiPolygon', [
      [
        [
          [0, 0],
          [0.1, 0],
          [0.1, 0.1],
          [0, 0],
        ],
      ],
      [
        [
          [0.5, 0.5],
          [0.6, 0.5],
          [0.6, 0.6],
          [0.5, 0.5],
        ],
      ],
    ]);

    expect(edgeCandidates()).toHaveLength(6);
  });

  it('leaves points, circles and freehand curves out of the edges', () => {
    addFeature('p1', 'Point', [0, 0]);
    addFeature('c1', 'Circle', [0.1, 0], { properties: { 'maplibre-gl-draw:radiusMeters': 100 } });
    addFeature('fh', 'Freehand', [
      [0.2, 0],
      [0.3, 0],
    ]);

    expect(edgeCandidates()).toHaveLength(0);
  });

  it('excludes the edges touching the vertex being dragged (because they pass over the cursor)', () => {
    addFeature('f1', 'LineString', [
      [0, 0],
      [0.1, 0],
      [0.2, 0],
      [0.3, 0],
    ]);

    const candidates = edgeCandidates(
      providerContext({ excludeVertex: { featureId: 'f1', vertex: { ring: 0, index: 1 } } }),
    );

    // The 2 edges touching vertex 1 disappear, and only [0.2,0]-[0.3,0] is left
    expect(candidates).toHaveLength(1);
    expect(candidates[0].start).toEqual([0.2, 0]);
  });

  it('makes the closing point at the end of a closed ring count as the first vertex for the exclusion', () => {
    addFeature('poly', 'Polygon', [
      [
        [0, 0],
        [0.4, 0],
        [0.4, 0.4],
        [0, 0],
      ],
    ]);

    const candidates = edgeCandidates(
      providerContext({ excludeVertex: { featureId: 'poly', vertex: { ring: 0, index: 0 } } }),
    );

    // The 2 edges touching vertex 0 (the first one and the closing one) disappear
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ start: [0.4, 0], end: [0.4, 0.4] });
  });

  it('does not return segments that fall outside the bbox', () => {
    addFeature('f1', 'LineString', [
      [0, 0],
      [0.1, 0],
      [5, 5],
      [6, 6],
    ]);

    const candidates = createStoreEdgeSnapProvider({ store, spatialIndex })
      .candidates({ minX: -0.01, minY: -0.01, maxX: 0.01, maxY: 0.01 }, providerContext())
      .filter(isSegmentCandidate);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].start).toEqual([0, 0]);
  });

  it('does not handle a custom type in the edge provider', () => {
    addFeature('marker', 'Marker', [
      [0, 0],
      [0.1, 0],
    ]);
    snapTargets.register('Marker', () => []);

    expect(edgeCandidates()).toHaveLength(0);
  });
});

describe('the built-in intersection provider', () => {
  /** 2 lines that cross (the intersection is the origin) */
  function addCrossingLines(): void {
    addFeature('h', 'LineString', [
      [-0.1, 0],
      [0.1, 0],
    ]);
    addFeature('v', 'LineString', [
      [0, -0.1],
      [0, 0.1],
    ]);
  }

  it('returns the intersections between the edges of different features', () => {
    addCrossingLines();

    const candidates = intersectionCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('intersection');
    expect(candidates[0].coordinate[0]).toBeCloseTo(0, 12);
    expect(candidates[0].coordinate[1]).toBeCloseTo(0, 12);
    // The feature ID of one of them and the description are attached
    expect(candidates[0].featureId).toBe('h');
    expect(candidates[0].description).toBe('Intersection');
  });

  it('takes the description from the messages table given to it', () => {
    addCrossingLines();

    const candidates = createStoreIntersectionSnapProvider({
      store,
      spatialIndex,
      snapTargets,
      messages: { snapIntersection: '交点' },
    })
      .candidates(WIDE_BBOX, providerContext())
      .filter((c): c is SnapPointCandidate => !isSegmentCandidate(c));

    expect(candidates.map((c) => c.description)).toEqual(['交点']);
  });

  it('receives the messages table given to the full set of built-in providers', () => {
    addCrossingLines();

    const descriptions = createBuiltInSnapProviders(
      { store, spatialIndex, snapTargets },
      { messages: { snapIntersection: '交点' } },
    )
      .flatMap((provider) => provider.candidates(WIDE_BBOX, providerContext()))
      .filter((c) => c.kind === 'intersection')
      .map((c) => c.description);

    expect(descriptions).toEqual(['交点']);
  });

  it('makes intersections with the edges of a Polygon as well', () => {
    addFeature('poly', 'Polygon', [
      [
        [0, 0],
        [0.2, 0],
        [0.2, 0.2],
        [0, 0.2],
        [0, 0],
      ],
    ]);
    // A line crossing the left and right edges of the polygon
    addFeature('line', 'LineString', [
      [-0.1, 0.1],
      [0.3, 0.1],
    ]);

    const coords = intersectionCandidates().map((c) => c.coordinate);

    expect(coords).toHaveLength(2);
    const xs = coords.map((c) => c[0]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0, 10);
    expect(xs[1]).toBeCloseTo(0.2, 10);
    expect(coords.every((c) => Math.abs(c[1] - 0.1) < 1e-10)).toBe(true);
  });

  it('does not make a self-intersection of the same feature into an intersection', () => {
    addFeature('bowtie', 'LineString', [
      [-0.1, -0.1],
      [0.1, 0.1],
      [0.1, -0.1],
      [-0.1, 0.1],
    ]);

    expect(intersectionCandidates()).toHaveLength(0);
  });

  it('does not make a candidate from a pair of edges that do not cross', () => {
    addFeature('a', 'LineString', [
      [-0.1, 0],
      [0.1, 0],
    ]);
    addFeature('b', 'LineString', [
      [-0.1, 0.1],
      [0.1, 0.1],
    ]);

    expect(intersectionCandidates()).toHaveLength(0);
  });

  it('does not use the edges of the feature of excludeFeatureId in the computation of intersections', () => {
    addCrossingLines();

    expect(intersectionCandidates(providerContext({ excludeFeatureId: 'v' }))).toHaveLength(0);
  });

  it('does not use the edges touching the vertex being dragged in the computation of intersections', () => {
    addCrossingLines();

    const candidates = intersectionCandidates(
      providerContext({ excludeVertex: { featureId: 'v', vertex: { ring: 0, index: 0 } } }),
    );

    expect(candidates).toHaveLength(0);
  });

  it('does not use the edges that fall outside the bbox in the computation of intersections', () => {
    addCrossingLines();
    // In a bbox away from the intersection, neither edge falls within it, so no
    // candidate comes out
    const far = { minX: 0.05, minY: 0.05, maxX: 0.07, maxY: 0.07 };

    expect(intersectionCandidates(providerContext(), far)).toHaveLength(0);
  });

  it('leaves points, circles, freehand curves and custom types out of the intersections', () => {
    addFeature('line', 'LineString', [
      [-0.1, 0],
      [0.1, 0],
    ]);
    addFeature('p1', 'Point', [0, 0]);
    addFeature('c1', 'Circle', [0, 0], { properties: { 'maplibre-gl-draw:radiusMeters': 100 } });
    addFeature('marker', 'Marker', [
      [0, -0.1],
      [0, 0.1],
    ]);
    snapTargets.register('Marker', () => []);

    expect(intersectionCandidates()).toHaveLength(0);
  });

  it('leaves hidden features out of the intersections', () => {
    addCrossingLines();
    store.updateFeature('v', { visible: false });

    expect(intersectionCandidates()).toHaveLength(0);
  });

  it('merges the same point into one even when it comes out of several pairs', () => {
    // 3 lines cross at the same point (there are 3 pairs)
    addFeature('a', 'LineString', [
      [-0.1, 0],
      [0.1, 0],
    ]);
    addFeature('b', 'LineString', [
      [0, -0.1],
      [0, 0.1],
    ]);
    addFeature('c', 'LineString', [
      [-0.1, -0.1],
      [0.1, 0.1],
    ]);

    expect(intersectionCandidates()).toHaveLength(1);
  });
});

describe('the built-in guide provider', () => {
  /** Sets up a drawing mode and a Tentative and takes the guide candidates */
  function guideCandidates(
    tentative: TentativeState | null,
    mode = 'draw_line',
    options?: { northStepDegrees?: number },
  ): SnapSegmentCandidate[] {
    store.setMode(mode);
    store.setTentative(tentative);
    return createGuideSnapProvider({ store }, options)
      .candidates(WIDE_BBOX, providerContext())
      .filter(isSegmentCandidate);
  }

  /** Narrows the candidates down by description */
  function byDescription(
    candidates: SnapSegmentCandidate[],
    description: string,
  ): SnapSegmentCandidate[] {
    return candidates.filter((c) => c.description === description);
  }

  /** The Tentative of a line (LineString). The last item is the cursor position */
  function lineTentative(coords: Coordinate[], confirmedCount: number): TentativeState {
    return { type: 'LineString', coordinates: coords, layerId: 'l1', confirmedCount };
  }

  it('produces no candidates outside a drawing mode', () => {
    const tentative = lineTentative(
      [
        [0, 0],
        [0, 0.1],
      ],
      1,
    );

    expect(guideCandidates(tentative, 'select')).toHaveLength(0);
    expect(guideCandidates(tentative, 'draw_circle')).toHaveLength(0);
    expect(guideCandidates(tentative, 'draw_line').length).toBeGreaterThan(0);
    expect(guideCandidates(tentative, 'draw_polygon').length).toBeGreaterThan(0);
  });

  it('produces no candidates when there is no Tentative', () => {
    expect(guideCandidates(null)).toHaveLength(0);
  });

  it('returns only the north-based guide, at every bearing in steps of 45 degrees, with 1 confirmed point', () => {
    const candidates = guideCandidates(
      lineTentative(
        [
          [0, 0],
          [0.05, 0.05],
        ],
        1,
      ),
    );

    expect(candidates).toHaveLength(8);
    expect(candidates.every((c) => c.kind === 'guide')).toBe(true);
    expect(candidates.every((c) => c.description === 'North')).toBe(true);

    // Every bearing is lined up in steps of 45 degrees (the start point is the anchor)
    const bearings = candidates
      .map((c) => Math.round(initialBearingDegrees(c.start, c.end)))
      .sort((a, b) => a - b);
    expect(bearings).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
    expect(candidates.every((c) => c.start[0] === 0 && c.start[1] === 0)).toBe(true);
  });

  it('makes the north-based guide work on the first point of a Polygon as well (a Tentative whose type is Point)', () => {
    const candidates = guideCandidates(
      { type: 'Point', coordinates: [0.2, 0.1], layerId: 'l1' },
      'draw_polygon',
    );

    expect(candidates).toHaveLength(8);
    expect(candidates.every((c) => c.start[0] === 0.2 && c.start[1] === 0.1)).toBe(true);
  });

  it('takes the descriptions from the messages table given to it', () => {
    store.setMode('draw_line');
    store.setTentative(
      lineTentative(
        [
          [0, 0],
          [0.1, 0],
          [0.15, 0.02],
        ],
        2,
      ),
    );
    const candidates = createGuideSnapProvider(
      { store },
      { messages: { snapNorth: '北基準', snapExtension: '延長線' } },
    )
      .candidates(WIDE_BBOX, providerContext())
      .filter(isSegmentCandidate);

    expect(byDescription(candidates, '北基準')).toHaveLength(8);
    expect(byDescription(candidates, '延長線')).toHaveLength(1);
    // The entry left out keeps the English default
    expect(byDescription(candidates, 'Perpendicular')).toHaveLength(1);
  });

  it('adds the extension and the perpendicular with 2 confirmed points', () => {
    // The state after drawing the first segment from west to east (a bearing of 90
    // degrees)
    const candidates = guideCandidates(
      lineTentative(
        [
          [0, 0],
          [0.1, 0],
          [0.15, 0.02],
        ],
        2,
      ),
    );

    expect(candidates).toHaveLength(10);

    const extension = byDescription(candidates, 'Extension');
    expect(extension).toHaveLength(1);
    // It extends forward only, from the anchor towards the bearing of the previous
    // segment (east)
    expect(extension[0].start).toEqual([0.1, 0]);
    expect(initialBearingDegrees(extension[0].start, extension[0].end)).toBeCloseTo(90, 0);

    const perpendicular = byDescription(candidates, 'Perpendicular');
    expect(perpendicular).toHaveLength(1);
    // A single line extending across the anchor from the north (the bearing -90 degrees
    // side) to the south (the bearing +90 degrees side)
    expect(initialBearingDegrees(perpendicular[0].start, perpendicular[0].end)).toBeCloseTo(180, 0);
    expect(perpendicular[0].start[1]).toBeGreaterThan(0);
    expect(perpendicular[0].end[1]).toBeLessThan(0);
    expect(perpendicular[0].start[0]).toBeCloseTo(0.1, 6);
  });

  it('does not use an unconfirmed vertex (the cursor) as the reference', () => {
    // There are 2 confirmed points, but the coordinate sequence also contains the cursor
    // position
    const candidates = guideCandidates(
      lineTentative(
        [
          [0, 0],
          [0.1, 0],
          [0.1, 0.3],
        ],
        2,
      ),
    );

    // The anchor is the 2nd point, and the previous segment is the 1st -> 2nd point (a
    // bearing of 90 degrees)
    const extension = byDescription(candidates, 'Extension')[0];
    expect(extension.start).toEqual([0.1, 0]);
    expect(initialBearingDegrees(extension.start, extension.end)).toBeCloseTo(90, 0);
  });

  it('reads the first confirmedCount items of the closed ring of a Polygon as the confirmed vertices', () => {
    // 2 confirmed points + the cursor + the closing point
    const ring: Coordinate[] = [
      [0, 0],
      [0.1, 0],
      [0.1, 0.1],
      [0, 0],
    ];
    const candidates = guideCandidates(
      { type: 'Polygon', coordinates: [ring], layerId: 'l1', confirmedCount: 2 },
      'draw_polygon',
    );

    expect(candidates).toHaveLength(10);
    const extension = byDescription(candidates, 'Extension')[0];
    expect(extension.start).toEqual([0.1, 0]);
    expect(initialBearingDegrees(extension.start, extension.end)).toBeCloseTo(90, 0);
  });

  it('allows the step angle of the north-based guide to be changed with a build argument', () => {
    const candidates = guideCandidates(
      lineTentative(
        [
          [0, 0],
          [0.05, 0.05],
        ],
        1,
      ),
      'draw_line',
      { northStepDegrees: 90 },
    );

    expect(candidates).toHaveLength(4);
    const bearings = candidates
      .map((c) => Math.round(initialBearingDegrees(c.start, c.end)))
      .sort((a, b) => a - b);
    expect(bearings).toEqual([0, 90, 180, 270]);
  });

  it('cuts a guide off at the equivalent of 4096 pixels on screen (it is not an infinite line)', () => {
    const candidates = guideCandidates(
      lineTentative(
        [
          [0, 0],
          [0.05, 0.05],
        ],
        1,
      ),
    );

    // The length of the guide towards true north becomes the latitude difference
    // equivalent to 4096px
    const north = candidates.find((c) => Math.round(initialBearingDegrees(c.start, c.end)) === 0);
    const expected = degreesPerPixel(0, ZOOM).lat * 4096;
    expect(north?.end[1]).toBeCloseTo(expected, 6);
  });
});

describe('the step angle of the built-in guide provider', () => {
  const FIRST_POINT: TentativeState = {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [0.05, 0.05],
    ],
    layerId: 'l1',
    confirmedCount: 1,
  };

  /** The rounded bearings of the north-based guides of the built-in set */
  function builtInGuideBearings(getNorthStepDegrees?: () => number): number[] {
    store.setMode('draw_line');
    store.setTentative(FIRST_POINT);
    const guide = createBuiltInSnapProviders(
      { store, spatialIndex, snapTargets },
      { getNorthStepDegrees },
    )[3];
    return guide
      .candidates(WIDE_BBOX, providerContext())
      .filter(isSegmentCandidate)
      .map((c) => Math.round(initialBearingDegrees(c.start, c.end)))
      .map((bearing) => (bearing + 360) % 360)
      .sort((a, b) => a - b);
  }

  it('produces 8 guides every 45 degrees by default', () => {
    expect(builtInGuideBearings()).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
  });

  it('produces 24 guides every 15 degrees when the step is 15', () => {
    const bearings = builtInGuideBearings(() => 15);

    expect(bearings).toHaveLength(24);
    expect(bearings).toEqual(Array.from({ length: 24 }, (_, i) => i * 15));
  });

  it('reads the step at every query, so a change applies without rebuilding the provider', () => {
    let step = 45;
    store.setMode('draw_line');
    store.setTentative(FIRST_POINT);
    const guide = createBuiltInSnapProviders(
      { store, spatialIndex, snapTargets },
      { getNorthStepDegrees: () => step },
    )[3];

    expect(guide.candidates(WIDE_BBOX, providerContext())).toHaveLength(8);
    step = 15;
    expect(guide.candidates(WIDE_BBOX, providerContext())).toHaveLength(24);
  });

  it.each([0, -15, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the default 45 degrees for an invalid step (%s)',
    (step) => {
      expect(builtInGuideBearings(() => step)).toHaveLength(8);
      store.setMode('draw_line');
      store.setTentative(FIRST_POINT);
      expect(
        createGuideSnapProvider({ store }, { northStepDegrees: step }).candidates(
          WIDE_BBOX,
          providerContext(),
        ),
      ).toHaveLength(8);
    },
  );
});
