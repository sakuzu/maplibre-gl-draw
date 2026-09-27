// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Screen-density thinning of the editing handles
 *
 * When a LineString / Polygon (including the Multi types) with thousands to tens of
 * thousands of vertices is selected, the vertex handles and midpoint handles are thinned by
 * screen density to build "the set of vertex references to display". Only the display is
 * thinned; the doc (the coordinate sequence) is never touched.
 *
 * What is visible is the source of truth for what can be manipulated, so hit testing
 * (handle-test.ts) also covers only the set built here. Grabbing a place with no handle
 * still moves the feature itself as before, so moving a dense line as a whole still works.
 */

import {
  HANDLE_THINNING_THRESHOLD,
  MIDPOINT_MIN_EDGE_PX,
  MIN_HANDLE_SPACING_PX,
  THINNING_REFRESH_DEBOUNCE_MS,
} from '../../shared/config/selection.js';
import { mercatorMidpoint } from '../../shared/math/globe-subdivision.js';
import { coordinatesOf, supportsVertexEditing } from '../../shared/utils/coordinates.js';
import { isSameVertexRef } from '../../shared/utils/vertex-ref.js';
import type { Coordinate, Feature, VertexRef } from '../../store/types.js';

/**
 * The set of handles to display
 *
 * It holds no coordinates. Because the set can be reused as is even after the vertices
 * move, the number of handles does not change while dragging.
 */
export interface VisibleHandleSet {
  /** Vertices to display (same VertexRef semantics as computeVertexHandles) */
  vertexRefs: VertexRef[];
  /** Midpoints to display (same VertexRef semantics as computeMidpointHandles) */
  midpointRefs: VertexRef[];
}

/**
 * Viewport used for the pre-filtering of the thinning
 */
export interface ThinningViewport {
  /** lngLat rectangle. When null, pre-filtering is skipped (all vertices are candidates) */
  bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number } | null;
}

/**
 * Scan unit (one line / one ring / a whole MultiPoint)
 *
 * The state of the greedy algorithm is reset per unit.
 */
interface HandleRun {
  /** Raw coordinate sequence (a closed ring includes the trailing closing point) */
  coords: Coordinate[];
  /** Number of vertex handles (excluding the closing point) */
  vertexCount: number;
  /** Whether it has midpoint handles (edges). A MultiPoint does not */
  hasEdges: boolean;
  /**
   * Whether it is an open line (the last vertex is always adopted; endpoints are vital for
   * editing)
   */
  forceLast: boolean;
  /** Builds a VertexRef from a vertex index / edge index */
  makeRef: (index: number) => VertexRef;
}

/**
 * Decomposes a feature into scan units
 *
 * They are ordered so that the scan order of the vertices is exactly the same as in
 * computeVertexHandles and the scan order of the edges exactly the same as in
 * computeMidpointHandles.
 */
function collectHandleRuns(feature: Feature): HandleRun[] {
  const runs: HandleRun[] = [];

  if (feature.type === 'LineString') {
    pushLineRun(runs, coordinatesOf(feature) as Coordinate[]);
  } else if (feature.type === 'Polygon') {
    pushPolygonRuns(runs, coordinatesOf(feature) as Coordinate[][]);
  } else if (feature.type === 'MultiPoint') {
    // Splitting a MultiPoint per part would adopt every point and defeat the thinning, so
    // all parts are scanned as a single sequence
    const points = coordinatesOf(feature) as Coordinate[];
    runs.push({
      coords: points,
      vertexCount: points.length,
      hasEdges: false,
      forceLast: false,
      makeRef: (index) => ({ part: index, ring: 0, index: 0 }),
    });
  } else if (feature.type === 'MultiLineString') {
    const parts = coordinatesOf(feature) as Coordinate[][];
    for (let part = 0; part < parts.length; part++) {
      pushLineRun(runs, parts[part], part);
    }
  } else if (feature.type === 'MultiPolygon') {
    const parts = coordinatesOf(feature) as Coordinate[][][];
    for (let part = 0; part < parts.length; part++) {
      pushPolygonRuns(runs, parts[part], part);
    }
  }

  return runs;
}

/**
 * Adds a line (a single coordinate sequence) as a scan unit
 */
function pushLineRun(runs: HandleRun[], coords: Coordinate[], part?: number): void {
  runs.push({
    coords,
    vertexCount: coords.length,
    hasEdges: true,
    forceLast: true,
    makeRef: (index) => (part === undefined ? { ring: 0, index } : { part, ring: 0, index }),
  });
}

/**
 * Adds a polygon (an array of rings) as scan units
 */
function pushPolygonRuns(runs: HandleRun[], rings: Coordinate[][], part?: number): void {
  for (let ring = 0; ring < rings.length; ring++) {
    const coords = rings[ring];
    if (coords.length === 0) continue;
    runs.push({
      coords,
      vertexCount: countRingVertices(coords),
      hasEdges: true,
      // A closed ring has no endpoints, and in an open ring the edges also end at the last
      // vertex, so nothing is force-adopted
      forceLast: false,
      makeRef: (index) => (part === undefined ? { ring, index } : { part, ring, index }),
    });
  }
}

/**
 * Number of vertex handles of a ring (the vertex count excluding the closing point)
 *
 * The closing-point test is identical to collectPolygonVertexHandles (the first and the
 * last coordinates match).
 */
function countRingVertices(ring: Coordinate[]): number {
  if (ring.length === 0) return 0;
  const isClosed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  return isClosed ? ring.length - 1 : ring.length;
}

/**
 * Counts the total number of handles (vertices + midpoints) without enumerating them all
 *
 * It matches computeVertexHandles(feature).length +
 * computeMidpointHandles(feature).length exactly. Because it is used to decide whether the
 * thinning kicks in and whether the cache is invalidated, it only scans the number of rings
 * and parts.
 */
export function countPotentialHandles(feature: Feature): number {
  if (feature.type === 'Point') return 1;

  if (feature.type === 'LineString') {
    return countLineHandles((coordinatesOf(feature) as Coordinate[]).length);
  }
  if (feature.type === 'Polygon') {
    return countPolygonHandles(coordinatesOf(feature) as Coordinate[][]);
  }
  if (feature.type === 'MultiPoint') {
    // Each coordinate is the vertex handle of one part. There are no edges
    return (coordinatesOf(feature) as Coordinate[]).length;
  }
  if (feature.type === 'MultiLineString') {
    let total = 0;
    for (const part of coordinatesOf(feature) as Coordinate[][]) {
      total += countLineHandles(part.length);
    }
    return total;
  }
  if (feature.type === 'MultiPolygon') {
    let total = 0;
    for (const part of coordinatesOf(feature) as Coordinate[][][]) {
      total += countPolygonHandles(part);
    }
    return total;
  }

  // Circle / Freehand / Image / custom features have no vertex handles
  return 0;
}

/** Number of handles of a single line (n vertices + n-1 edges) */
function countLineHandles(length: number): number {
  return length + Math.max(0, length - 1);
}

/** Number of handles of a single polygon (the sum of vertices + edges over the rings) */
function countPolygonHandles(rings: Coordinate[][]): number {
  let total = 0;
  for (const ring of rings) {
    if (ring.length === 0) continue;
    total += countRingVertices(ring) + Math.max(0, ring.length - 1);
  }
  return total;
}

/**
 * Whether the handles of this feature are thinned
 */
export function shouldThinHandles(feature: Feature): boolean {
  return (
    supportsVertexEditing(feature.type) &&
    countPotentialHandles(feature) > HANDLE_THINNING_THRESHOLD
  );
}

/**
 * Whether the coordinate falls inside the viewport rectangle (always true if bounds is null)
 */
function isInBounds(coord: Coordinate, bounds: ThinningViewport['bounds']): boolean {
  if (!bounds) return true;
  return (
    coord[0] >= bounds.minLng &&
    coord[0] <= bounds.maxLng &&
    coord[1] >= bounds.minLat &&
    coord[1] <= bounds.maxLat
  );
}

/**
 * Computes the set of handles to display (pure function)
 *
 * Vertices are chosen with a greedy algorithm that takes only those whose screen distance
 * from the previously adopted vertex is at least MIN_HANDLE_SPACING_PX. Midpoints are
 * emitted only when both end vertices have been adopted and the screen length of the edge
 * is at least MIDPOINT_MIN_EDGE_PX.
 *
 * @param project Function that projects a longitude/latitude to screen coordinates
 * @param viewport Rectangle for pre-filtering (off-screen vertices are not even projected)
 */
export function computeVisibleHandleSet(
  feature: Feature,
  project: (coord: Coordinate) => { x: number; y: number },
  viewport: ThinningViewport,
): VisibleHandleSet {
  const vertexRefs: VertexRef[] = [];
  const midpointRefs: VertexRef[] = [];
  const minSpacingSq = MIN_HANDLE_SPACING_PX * MIN_HANDLE_SPACING_PX;
  const minEdgeSq = MIDPOINT_MIN_EDGE_PX * MIDPOINT_MIN_EDGE_PX;

  for (const run of collectHandleRuns(feature)) {
    // Screen positions of the adopted vertices (kept so the midpoint test need not reproject)
    const adopted = new Map<number, { x: number; y: number }>();
    let last: { x: number; y: number } | null = null;

    for (let i = 0; i < run.vertexCount; i++) {
      // Off-screen vertices are skipped without being projected (and "the previously
      // adopted point" is not updated either)
      if (!isInBounds(run.coords[i], viewport.bounds)) continue;

      const screen = project(run.coords[i]);
      const isLastVertex = run.forceLast && i === run.vertexCount - 1;
      if (last !== null && !isLastVertex && distanceSq(screen, last) < minSpacingSq) {
        continue;
      }

      vertexRefs.push(run.makeRef(i));
      adopted.set(i, screen);
      last = screen;
    }

    if (!run.hasEdges) continue;

    // The edges are enumerated as in computeMidpointHandles (i = 0..len-2 over the raw
    // coordinates)
    for (let i = 0; i < run.coords.length - 1; i++) {
      const start = adopted.get(i);
      // The last edge of a closed ring wraps back to vertex 0, not to the closing point
      const endIndex = i + 1 < run.vertexCount ? i + 1 : 0;
      const end = adopted.get(endIndex);
      if (!start || !end) continue;
      if (distanceSq(start, end) < minEdgeSq) continue;

      midpointRefs.push(run.makeRef(i));
    }
  }

  return { vertexRefs, midpointRefs };
}

/** The square of the screen distance between two points */
function distanceSq(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Returns the set with the vertex references it does not contain added on the vertex side
 *
 * A rendering-only supplement that prevents a recomputation from hiding the selected or
 * in-operation vertices and producing "it disappeared even though I selected it". The hit
 * testing side does not apply this supplement (the principle that only what is visible can
 * be grabbed is not bent for a single supplemented point; a selected vertex is being
 * dragged, so it need not be grabbed again, which makes this a harmless simplification).
 */
export function includeRequiredVertexRefs(
  set: VisibleHandleSet,
  required: readonly VertexRef[],
): VisibleHandleSet {
  if (required.length === 0) return set;

  const missing = required.filter((ref) => !set.vertexRefs.some((r) => isSameVertexRef(r, ref)));
  if (missing.length === 0) return set;

  return {
    vertexRefs: [...set.vertexRefs, ...missing],
    midpointRefs: set.midpointRefs,
  };
}

/**
 * Extracts the raw coordinate sequence (one line / one ring) the vertex reference belongs to
 */
function getRefCoords(feature: Feature, ref: VertexRef): Coordinate[] | null {
  const part = ref.part ?? 0;

  if (feature.type === 'Point') {
    return [coordinatesOf(feature) as Coordinate];
  }
  if (feature.type === 'LineString') {
    return coordinatesOf(feature) as Coordinate[];
  }
  if (feature.type === 'Polygon') {
    return (coordinatesOf(feature) as Coordinate[][])[ref.ring] ?? null;
  }
  if (feature.type === 'MultiPoint') {
    const point = (coordinatesOf(feature) as Coordinate[])[part];
    return point ? [point] : null;
  }
  if (feature.type === 'MultiLineString') {
    return (coordinatesOf(feature) as Coordinate[][])[part] ?? null;
  }
  if (feature.type === 'MultiPolygon') {
    return (coordinatesOf(feature) as Coordinate[][][])[part]?.[ref.ring] ?? null;
  }
  return null;
}

/**
 * Looks up the coordinate of a vertex handle
 *
 * index is the vertex number excluding the closing point, but it matches the number counted
 * from the head of the raw coordinate sequence (the closing point only ever sits at the
 * end), so it can be used as an index as is.
 */
export function resolveVertexCoordinate(feature: Feature, ref: VertexRef): Coordinate | null {
  const coords = getRefCoords(feature, ref);
  return coords?.[ref.index] ?? null;
}

/**
 * Looks up the coordinate of a midpoint handle
 *
 * The midpoint of edge i is the midpoint on the Mercator plane of the raw coordinates i and
 * i+1, the point halfway along the edge as drawn (the same formula as computeMidpointHandles;
 * `mercatorMidpoint`). For the last edge of a closed ring no wrap-around is needed either,
 * because the trailing closing point has the same coordinate as the first.
 */
export function resolveMidpointCoordinate(feature: Feature, ref: VertexRef): Coordinate | null {
  const coords = getRefCoords(feature, ref);
  const start = coords?.[ref.index];
  const end = coords?.[ref.index + 1];
  if (!start || !end) return null;
  return mercatorMidpoint(start, end);
}

/**
 * Upper bound on the number of cache entries (the selection is effectively single, so 4 is
 * enough)
 */
const MAX_CACHE_ENTRIES = 4;

/** Slack of the timer that triggers a redraw (fires reliably after the debounce expires) */
const REFRESH_TIMER_MARGIN_MS = 20;

interface CacheEntry {
  /**
   * Total number of handles when the set was built (used to detect vertex additions,
   * deletions and undo)
   */
  handleCount: number;
  /** Camera signature when the set was built */
  cameraSig: string;
  set: VisibleHandleSet;
  /** Camera signature waiting for a recomputation */
  pendingSig?: string;
  /** Time when pendingSig was first seen (milliseconds) */
  pendingSince?: number;
}

/**
 * Cache of the thinned sets
 *
 * Rendering (selection-ui-drawer) and hit testing (handle-test) have to look at the same
 * set. One cache belongs to one draw instance (it is part of the SelectionScope that both the
 * CustomLayer and the modes receive), so two instances holding a feature with the same id
 * (a duplicated document, for instance) never share a set or a refresh timer.
 */
export class HandleThinningCache {
  private entries = new Map<string, CacheEntry>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Gets the set from the rendering path (building it if there is none)
   *
   * While the camera is moving the stale set is returned, and it is rebuilt once the camera
   * has been still for THINNING_REFRESH_DEBOUNCE_MS. Only when the vertex count changes is
   * it rebuilt immediately.
   *
   * @param now Current time (passed by the caller for testability)
   * @param compute Function that computes the set
   * @param onNeedsRefresh Hook that triggers a redraw after the camera settles, called when
   *   a stale set was returned
   */
  ensureSet(
    feature: Feature,
    cameraSig: string,
    now: number,
    compute: () => VisibleHandleSet,
    onNeedsRefresh?: () => void,
  ): VisibleHandleSet {
    const handleCount = countPotentialHandles(feature);
    const entry = this.entries.get(feature.id);

    // No entry / the vertex count changed -> rebuild immediately
    if (!entry || entry.handleCount !== handleCount) {
      const set = compute();
      this.store(feature.id, { handleCount, cameraSig, set });
      return set;
    }

    if (entry.cameraSig === cameraSig) {
      entry.pendingSig = undefined;
      entry.pendingSince = undefined;
      return entry.set;
    }

    if (entry.pendingSig !== cameraSig) {
      // A new camera position was seen. The debounce is counted from here
      entry.pendingSig = cameraSig;
      entry.pendingSince = now;
    } else if (now - (entry.pendingSince ?? now) >= THINNING_REFRESH_DEBOUNCE_MS) {
      const set = compute();
      entry.set = set;
      entry.cameraSig = cameraSig;
      entry.pendingSig = undefined;
      entry.pendingSince = undefined;
      return set;
    }

    // Return the stale set. The timer that triggers a redraw is re-armed so that the
    // recomputation runs even if no rendering frame arrives after the camera settles
    this.scheduleRefresh(onNeedsRefresh);
    return entry.set;
  }

  /**
   * Gets "the set currently displayed" from the hit testing path
   *
   * The camera signature is not consulted. The stale set used while moving is precisely the
   * one being displayed, and matching it is the source of truth for hit testing. For a
   * feature that is not thinned it returns null, and the caller tests by full enumeration
   * as before.
   */
  getDisplayedSet(feature: Feature): VisibleHandleSet | null {
    const entry = this.entries.get(feature.id);
    if (!entry) return null;
    if (entry.handleCount !== countPotentialHandles(feature)) return null;
    return entry.set;
  }

  /**
   * Discards the cache (all entries when featureId is omitted)
   */
  clear(featureId?: string): void {
    if (featureId === undefined) {
      this.entries.clear();
      if (this.refreshTimer !== null) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
      return;
    }
    this.entries.delete(featureId);
  }

  /** Stores an entry (discarding the oldest one when the upper bound is exceeded) */
  private store(featureId: string, entry: CacheEntry): void {
    this.entries.delete(featureId);
    while (this.entries.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(featureId, entry);
  }

  /** Re-arms the timer that triggers a redraw (only one is held at a time) */
  private scheduleRefresh(onNeedsRefresh?: () => void): void {
    if (!onNeedsRefresh) return;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      onNeedsRefresh();
    }, THINNING_REFRESH_DEBOUNCE_MS + REFRESH_TIMER_MARGIN_MS);
  }
}
