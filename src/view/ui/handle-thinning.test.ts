// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the screen-density thinning of the editing handles
 *
 * The thinning only builds "the set of vertex references to display" and never touches the
 * doc. These tests verify how the set is built (the greedy algorithm, the viewport
 * pre-filtering, the conditions for midpoints) and that rendering and hit testing both look
 * at the set in the same way.
 *
 * The projection is a linear stub that treats longitude/latitude directly as pixels, read
 * as 1 degree = 1 px.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SELECTION_CONFIG,
  MIDPOINT_MIN_EDGE_PX,
  MIN_HANDLE_SPACING_PX,
  THINNING_REFRESH_DEBOUNCE_MS,
} from '../../shared/config/selection.js';
import type { CoordinateTransform } from '../../shared/math/index.js';
import type { FeatureCoordinates } from '../../shared/types/model.js';
import { coordinatesOf, geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import type { Coordinate, Feature, VertexRef } from '../../store/types.js';
import { hitTestHandles } from './handle-test.js';
import type { ThinningViewport, VisibleHandleSet } from './handle-thinning.js';
import {
  computeVisibleHandleSet,
  countPotentialHandles,
  includeRequiredVertexRefs,
  shouldThinHandles,
} from './handle-thinning.js';
import { computeMidpointHandles, computeVertexHandles } from './handles.js';
import { createSelectionScope, type SelectionScope } from './selection-scope.js';

/** Projection that treats longitude/latitude directly as pixels */
const project = (coord: Coordinate) => ({ x: coord[0], y: coord[1] });

const NO_VIEWPORT: ThinningViewport = { bounds: null };

function makeFeature(type: string, coordinates: FeatureCoordinates, id = 'f1'): Feature {
  return {
    id,
    type,
    geometry: geometryFromCoordinates(type, coordinates),
    layerId: 'layer-1',
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

/** A line with evenly spaced points along x (y is tilted slightly to avoid zero area) */
function makeLine(count: number, stepX: number, id = 'line-1'): Feature {
  const coords: Coordinate[] = [];
  for (let i = 0; i < count; i++) {
    coords.push([i * stepX, i * 0.05]);
  }
  return makeFeature('LineString', coords, id);
}

/** A polygon whose 20x20 outer ring contains one 10x10 hole */
function polygonWithHole(): Feature {
  return makeFeature('Polygon', [
    [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
      [0, 0],
    ],
    [
      [5, 5],
      [15, 5],
      [15, 15],
      [5, 15],
      [5, 5],
    ],
  ]);
}

/** The selection scope of the draw instance under test (its thinned sets) */
let scope: SelectionScope = createSelectionScope();

afterEach(() => {
  scope = createSelectionScope();
});

describe('countPotentialHandles', () => {
  const cases: Array<[string, Feature]> = [
    ['LineString', makeLine(10, 5)],
    ['closed Polygon (with a hole)', polygonWithHole()],
    [
      'Polygon that is not closed',
      makeFeature('Polygon', [
        [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
      ]),
    ],
    [
      'MultiPoint',
      makeFeature('MultiPoint', [
        [0, 0],
        [10, 10],
        [20, 20],
      ]),
    ],
    [
      'MultiLineString',
      makeFeature('MultiLineString', [
        [
          [0, 0],
          [10, 0],
        ],
        [
          [0, 10],
          [10, 10],
          [20, 10],
        ],
      ]),
    ],
    [
      'MultiPolygon',
      makeFeature('MultiPolygon', [
        [
          [
            [0, 0],
            [20, 0],
            [20, 20],
            [0, 20],
            [0, 0],
          ],
          [
            [5, 5],
            [15, 5],
            [15, 15],
            [5, 15],
            [5, 5],
          ],
        ],
        [
          [
            [100, 100],
            [110, 100],
            [110, 110],
            [100, 100],
          ],
        ],
      ]),
    ],
    ['Point', makeFeature('Point', [0, 0])],
  ];

  for (const [name, feature] of cases) {
    it(`${name} matches the enumerated count`, () => {
      expect(countPotentialHandles(feature)).toBe(
        computeVertexHandles(feature).length + computeMidpointHandles(feature).length,
      );
    });
  }

  it('is 0 for Circle / Freehand / custom features', () => {
    expect(countPotentialHandles(makeFeature('Circle', [0, 0]))).toBe(0);
    expect(
      countPotentialHandles(
        makeFeature('Freehand', [
          [0, 0],
          [1, 1],
        ]),
      ),
    ).toBe(0);
    expect(countPotentialHandles(makeFeature('Marker', [0, 0]))).toBe(0);
  });
});

describe('shouldThinHandles', () => {
  it('does not thin a feature at or below the threshold', () => {
    // 200 vertices + 199 midpoints = 399
    expect(shouldThinHandles(makeLine(200, 8))).toBe(false);
  });

  it('thins a feature above the threshold', () => {
    // 250 vertices + 249 midpoints = 499
    expect(shouldThinHandles(makeLine(250, 8))).toBe(true);
  });

  it('does not thin a type that does not support vertex editing', () => {
    const coords: Coordinate[] = [];
    for (let i = 0; i < 500; i++) coords.push([i, 0]);
    expect(shouldThinHandles(makeFeature('Freehand', coords))).toBe(false);
  });
});

describe('computeVisibleHandleSet (the greedy algorithm for vertices)', () => {
  it('always keeps the screen distance between adopted vertices at least the minimum', () => {
    const feature = makeLine(250, 8);
    const set = computeVisibleHandleSet(feature, project, NO_VIEWPORT);
    const handles = computeVertexHandles(feature, set);

    // Apart from the forced adoption of the endpoints, consecutive adopted pairs are at
    // least the minimum spacing apart
    for (let i = 1; i < handles.length - 1; i++) {
      const a = project(handles[i - 1].position);
      const b = project(handles[i].position);
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      expect(distance).toBeGreaterThanOrEqual(MIN_HANDLE_SPACING_PX);
    }
    // The step is 8px, so every other vertex is adopted
    expect(set.vertexRefs.length).toBeLessThan(250);
  });

  it('always adopts the first vertex of a run and the last vertex of an open line', () => {
    const feature = makeLine(250, 8);
    const set = computeVisibleHandleSet(feature, project, NO_VIEWPORT);

    expect(set.vertexRefs[0]).toEqual({ ring: 0, index: 0 });
    // The last vertex (index 249) is only 8px from the previous adoption, but it is adopted
    // because it is an endpoint
    expect(set.vertexRefs[set.vertexRefs.length - 1]).toEqual({ ring: 0, index: 249 });
  });

  it('resets the state of the greedy algorithm per ring', () => {
    const set = computeVisibleHandleSet(polygonWithHole(), project, NO_VIEWPORT);
    // The first vertex of each ring is always adopted
    expect(set.vertexRefs).toContainEqual({ ring: 0, index: 0 });
    expect(set.vertexRefs).toContainEqual({ ring: 1, index: 0 });
  });

  it('thins a MultiPoint treating all parts as a single run', () => {
    const points: Coordinate[] = [];
    for (let i = 0; i < 100; i++) points.push([i * 8, 0]);
    const feature = makeFeature('MultiPoint', points);

    const set = computeVisibleHandleSet(feature, project, NO_VIEWPORT);
    expect(set.vertexRefs.length).toBeLessThan(points.length);
    expect(set.vertexRefs[0]).toEqual({ part: 0, ring: 0, index: 0 });
    // The step is 8px, so every other one
    expect(set.vertexRefs[1]).toEqual({ part: 2, ring: 0, index: 0 });
    expect(set.midpointRefs).toEqual([]);
  });
});

describe('computeVisibleHandleSet (viewport pre-filtering)', () => {
  it('does not adopt vertices outside the rectangle', () => {
    const feature = makeLine(250, 8);
    const set = computeVisibleHandleSet(feature, project, {
      bounds: { minLng: 100, maxLng: 300, minLat: -100, maxLat: 100 },
    });

    expect(set.vertexRefs.length).toBeGreaterThan(0);
    for (const handle of computeVertexHandles(feature, set)) {
      expect(handle.position[0]).toBeGreaterThanOrEqual(100);
      expect(handle.position[0]).toBeLessThanOrEqual(300);
    }
  });

  it('makes every vertex a candidate when bounds is null', () => {
    const feature = makeLine(250, 8);
    const clipped = computeVisibleHandleSet(feature, project, {
      bounds: { minLng: 100, maxLng: 300, minLat: -100, maxLat: 100 },
    });
    const full = computeVisibleHandleSet(feature, project, NO_VIEWPORT);

    expect(full.vertexRefs.length).toBeGreaterThan(clipped.vertexRefs.length);
    expect(full.vertexRefs[0]).toEqual({ ring: 0, index: 0 });
  });
});

describe('computeVisibleHandleSet (midpoints)', () => {
  it('emits midpoints only for long enough edges whose ends are both adopted', () => {
    // With an 8px step the edges are too short, so no midpoint is emitted
    const dense = makeLine(250, 8);
    expect(computeVisibleHandleSet(dense, project, NO_VIEWPORT).midpointRefs).toEqual([]);

    // With a 40px step every vertex is adopted and the midpoints of all edges are emitted
    const sparse = makeLine(10, 40);
    const set = computeVisibleHandleSet(sparse, project, NO_VIEWPORT);
    expect(set.vertexRefs).toHaveLength(10);
    expect(set.midpointRefs).toHaveLength(9);
  });

  it('emits no midpoint for an edge whose adopted ends are closer than the threshold', () => {
    // The vertices have a 20px step (all adopted), but the edge length is below the
    // midpoint threshold
    expect(20).toBeLessThan(MIDPOINT_MIN_EDGE_PX);
    const feature = makeLine(10, 20);
    const set = computeVisibleHandleSet(feature, project, NO_VIEWPORT);

    expect(set.vertexRefs).toHaveLength(10);
    expect(set.midpointRefs).toEqual([]);
  });

  it('tests the last edge of a closed ring by wrapping back to vertex 0', () => {
    const square = makeFeature('Polygon', [
      [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
        [0, 0],
      ],
    ]);
    const set = computeVisibleHandleSet(square, project, NO_VIEWPORT);

    // The last edge (index 3) lies between vertex 3 and vertex 0. It is 100px long, so a
    // midpoint is emitted
    expect(set.midpointRefs).toEqual([
      { ring: 0, index: 0 },
      { ring: 0, index: 1 },
      { ring: 0, index: 2 },
      { ring: 0, index: 3 },
    ]);
    // The positions match the full-enumeration version
    const thinned = computeMidpointHandles(square, set);
    expect(thinned[3].position).toEqual([0, 50]);
  });

  it('emits no midpoint when the wrapped last edge is short', () => {
    const ring = makeFeature('Polygon', [
      [
        [0, 0],
        [100, 0],
        [100, 100],
        [1, 1],
        [0, 0],
      ],
    ]);
    const set = computeVisibleHandleSet(ring, project, NO_VIEWPORT);

    expect(set.vertexRefs).toHaveLength(4);
    // Vertex 3 (1,1) and vertex 0 (0,0) are only 1.4px apart
    expect(set.midpointRefs).toEqual([
      { ring: 0, index: 0 },
      { ring: 0, index: 1 },
      { ring: 0, index: 2 },
    ]);
  });
});

describe('handle enumeration using a set', () => {
  it('vertex handles are a subset of the full enumeration, matching positions and refs', () => {
    const feature = makeLine(250, 8);
    const set = computeVisibleHandleSet(feature, project, NO_VIEWPORT);

    const all = computeVertexHandles(feature);
    const thinned = computeVertexHandles(feature, set);

    expect(thinned.length).toBeLessThan(all.length);
    for (const handle of thinned) {
      const original = all[handle.vertexRef!.index];
      expect(handle.position).toEqual(original.position);
      expect(handle.vertexRef).toEqual(original.vertexRef);
      expect(handle.type).toBe('vertex');
    }
  });

  it('midpoint handles also match the positions and refs of the full enumeration', () => {
    const feature = makeLine(10, 40);
    const set = computeVisibleHandleSet(feature, project, NO_VIEWPORT);

    const all = computeMidpointHandles(feature);
    const thinned = computeMidpointHandles(feature, set);

    expect(thinned).toEqual(all);
  });

  it('positions match across parts and rings for the Multi types too', () => {
    const multiPolygon = makeFeature('MultiPolygon', [
      [
        [
          [0, 0],
          [100, 0],
          [100, 100],
          [0, 100],
          [0, 0],
        ],
        [
          [20, 20],
          [80, 20],
          [80, 80],
          [20, 80],
          [20, 20],
        ],
      ],
      [
        [
          [200, 200],
          [300, 200],
          [300, 300],
          [200, 200],
        ],
      ],
    ]);
    const set = computeVisibleHandleSet(multiPolygon, project, NO_VIEWPORT);

    expect(computeVertexHandles(multiPolygon, set)).toEqual(computeVertexHandles(multiPolygon));
    expect(computeMidpointHandles(multiPolygon, set)).toEqual(computeMidpointHandles(multiPolygon));
  });
});

describe('includeRequiredVertexRefs', () => {
  const set: VisibleHandleSet = {
    vertexRefs: [
      { ring: 0, index: 0 },
      { ring: 0, index: 4 },
    ],
    midpointRefs: [{ ring: 0, index: 0 }],
  };

  it('appends a vertex that is not in the set', () => {
    const required: VertexRef[] = [{ ring: 0, index: 2 }];
    const merged = includeRequiredVertexRefs(set, required);

    expect(merged.vertexRefs).toEqual([
      { ring: 0, index: 0 },
      { ring: 0, index: 4 },
      { ring: 0, index: 2 },
    ]);
    // Midpoints are not supplemented
    expect(merged.midpointRefs).toBe(set.midpointRefs);
  });

  it('does not duplicate a vertex that is already included', () => {
    const merged = includeRequiredVertexRefs(set, [{ ring: 0, index: 4 }]);
    expect(merged).toBe(set);
  });

  it('treats an omitted part and 0 as the same', () => {
    const merged = includeRequiredVertexRefs(set, [{ part: 0, ring: 0, index: 0 }]);
    expect(merged).toBe(set);
  });

  it('returns the original set as is when the requirement is empty', () => {
    expect(includeRequiredVertexRefs(set, [])).toBe(set);
  });
});

describe('HandleThinningCache', () => {
  const feature = makeLine(250, 8);

  function computeFor(f: Feature): VisibleHandleSet {
    return computeVisibleHandleSet(f, project, NO_VIEWPORT);
  }

  it('keeps the displayed sets of two draw instances apart for the same feature id', () => {
    // A duplicated document holds the same ids; the other instance has displayed nothing
    const other = createSelectionScope();
    scope.thinning.ensureSet(feature, 'sig-a', 0, () => computeFor(feature));

    expect(scope.thinning.getDisplayedSet(feature)).not.toBeNull();
    expect(other.thinning.getDisplayedSet(feature)).toBeNull();
  });

  it('does not recompute for the same camera signature', () => {
    let computed = 0;
    const compute = () => {
      computed++;
      return computeFor(feature);
    };

    const first = scope.thinning.ensureSet(feature, 'sig-a', 0, compute);
    const second = scope.thinning.ensureSet(feature, 'sig-a', 50, compute);

    expect(computed).toBe(1);
    expect(second).toBe(first);
  });

  it('returns the stale set within the debounce even when the signature changes', () => {
    let computed = 0;
    const compute = () => {
      computed++;
      return computeFor(feature);
    };

    const first = scope.thinning.ensureSet(feature, 'sig-a', 0, compute);
    const moving = scope.thinning.ensureSet(feature, 'sig-b', 10, compute);
    const stillMoving = scope.thinning.ensureSet(
      feature,
      'sig-b',
      10 + THINNING_REFRESH_DEBOUNCE_MS - 1,
      compute,
    );

    expect(computed).toBe(1);
    expect(moving).toBe(first);
    expect(stillMoving).toBe(first);
  });

  it('recomputes once the debounce has passed', () => {
    let computed = 0;
    const compute = () => {
      computed++;
      return computeFor(feature);
    };

    scope.thinning.ensureSet(feature, 'sig-a', 0, compute);
    scope.thinning.ensureSet(feature, 'sig-b', 10, compute);
    scope.thinning.ensureSet(feature, 'sig-b', 10 + THINNING_REFRESH_DEBOUNCE_MS, compute);

    expect(computed).toBe(2);
  });

  it('recomputes immediately when the vertex count changes, even for the same signature', () => {
    let computed = 0;
    const compute = () => {
      computed++;
      return computeFor(feature);
    };

    scope.thinning.ensureSet(feature, 'sig-a', 0, compute);
    // A feature with the same id that lost one vertex (equivalent to undo / vertex deletion)
    const shorter = makeLine(249, 8, feature.id);
    scope.thinning.ensureSet(shorter, 'sig-a', 1, compute);

    expect(computed).toBe(2);
  });

  it('getDisplayedSet returns the displayed set without consulting the signature', () => {
    const first = scope.thinning.ensureSet(feature, 'sig-a', 0, () => computeFor(feature));
    scope.thinning.ensureSet(feature, 'sig-b', 10, () => computeFor(feature));

    // The stale set used while the camera moves is precisely "what is displayed now"
    expect(scope.thinning.getDisplayedSet(feature)).toBe(first);
  });

  it('returns no set for a feature whose vertex count changed', () => {
    scope.thinning.ensureSet(feature, 'sig-a', 0, () => computeFor(feature));
    const shorter = makeLine(249, 8, feature.id);

    expect(scope.thinning.getDisplayedSet(shorter)).toBeNull();
  });

  it('returns null for an unregistered feature', () => {
    expect(scope.thinning.getDisplayedSet(makeLine(250, 8, 'other'))).toBeNull();
  });

  it('is discarded by clear', () => {
    scope.thinning.ensureSet(feature, 'sig-a', 0, () => computeFor(feature));
    scope.thinning.clear(feature.id);

    expect(scope.thinning.getDisplayedSet(feature)).toBeNull();
  });

  it('arms a timer that triggers a redraw when a stale set was returned', () => {
    vi.useFakeTimers();
    try {
      let refreshed = 0;
      const onNeedsRefresh = () => {
        refreshed++;
      };

      scope.thinning.ensureSet(feature, 'sig-a', 0, () => computeFor(feature));
      scope.thinning.ensureSet(feature, 'sig-b', 10, () => computeFor(feature), onNeedsRefresh);

      vi.advanceTimersByTime(THINNING_REFRESH_DEBOUNCE_MS);
      expect(refreshed).toBe(0);
      vi.advanceTimersByTime(20);
      expect(refreshed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('consistency with hit testing', () => {
  // The same screen layout as the other tests, on geographic coordinates: the coordinates are
  // divided by 100 and projected at 100 px per degree, so the screen positions (and with them
  // the thinning) do not change, while every longitude stays within the world (the hit test
  // takes a longitude more than 180 degrees from the pointer on its nearest copy)
  const GEO_SCALE = 100;
  const toGeo = (coord: Coordinate): Coordinate => [coord[0] / GEO_SCALE, coord[1] / GEO_SCALE];
  const geoProject = (coord: Coordinate) => ({
    x: coord[0] * GEO_SCALE,
    y: coord[1] * GEO_SCALE,
  });
  const geoTransform: CoordinateTransform = {
    project: geoProject,
    unproject: (point) => ({ lng: point.x / GEO_SCALE, lat: point.y / GEO_SCALE }),
  };
  const geoLine = (count: number, stepX: number, id?: string): Feature => {
    const line = makeLine(count, stepX, id);
    return {
      ...line,
      geometry: {
        type: 'LineString',
        coordinates: (coordinatesOf(line) as Coordinate[]).map(toGeo),
      },
    };
  };

  const feature = geoLine(250, 8);
  const zoom = 10;

  /** Puts the display set into the cache (the same entry point as the rendering path) */
  function displaySet(): VisibleHandleSet {
    return scope.thinning.ensureSet(feature, 'sig-a', 0, () =>
      computeVisibleHandleSet(feature, geoProject, NO_VIEWPORT),
    );
  }

  function hitAt(coord: Coordinate) {
    return hitTestHandles(
      project(coord),
      [feature],
      geoTransform,
      DEFAULT_SELECTION_CONFIG,
      zoom,
      scope,
    );
  }

  it('a displayed vertex can be grabbed', () => {
    const set = displaySet();
    expect(set.vertexRefs).toContainEqual({ ring: 0, index: 2 });

    const hit = hitAt([16, 0.1]);
    expect(hit?.type).toBe('vertex');
    expect(hit?.vertexRef).toEqual({ ring: 0, index: 2 });
  });

  it('a thinned-out vertex cannot be grabbed and becomes a move of the feature', () => {
    const set = displaySet();
    expect(set.vertexRefs).not.toContainEqual({ ring: 0, index: 1 });

    expect(hitAt([8, 0.05])?.type).toBe('move');
  });

  it('every vertex can still be grabbed on a feature that is not thinned (no set)', () => {
    // Hit the same position without putting anything into the cache
    const hit = hitAt([8, 0.05]);
    expect(hit?.type).toBe('vertex');
    expect(hit?.vertexRef).toEqual({ ring: 0, index: 1 });
  });

  it('the returned vertex reference is not the instance stored in the cache', () => {
    const set = displaySet();
    const hit = hitAt([16, 0.1]);

    expect(hit?.vertexRef).toEqual({ ring: 0, index: 2 });
    for (const ref of set.vertexRefs) {
      expect(hit?.vertexRef).not.toBe(ref);
    }
  });

  it('a displayed midpoint can be grabbed while the midpoint of a thinned edge cannot', () => {
    const sparse = geoLine(10, 40, 'sparse-1');
    scope.thinning.ensureSet(sparse, 'sig-a', 0, () => ({
      // Build a state displaying only vertices 0 / 1 / 2 and the midpoint of edge 0
      vertexRefs: [
        { ring: 0, index: 0 },
        { ring: 0, index: 1 },
        { ring: 0, index: 2 },
      ],
      midpointRefs: [{ ring: 0, index: 0 }],
    }));

    const hitVisible = hitTestHandles(
      project([20, 0.025]),
      [sparse],
      geoTransform,
      DEFAULT_SELECTION_CONFIG,
      zoom,
      scope,
    );
    expect(hitVisible?.type).toBe('midpoint');
    expect(hitVisible?.vertexRef).toEqual({ ring: 0, index: 0 });

    // The midpoint of edge 1 (60, 0.075) is not in the set, so it falls through to a move
    const hitHidden = hitTestHandles(
      project([60, 0.075]),
      [sparse],
      geoTransform,
      DEFAULT_SELECTION_CONFIG,
      zoom,
      scope,
    );
    expect(hitHidden?.type).toBe('move');
  });
});
