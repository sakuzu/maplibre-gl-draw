// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ViewportFilter
 *
 * Filters down to only the features inside the viewport.
 * It uses an expanded viewport and the SpatialIndex as a performance optimization.
 */

import type { LngLatBounds, Map as MapLibreMap } from 'maplibre-gl';
import { LngLatBounds as LngLatBoundsClass } from 'maplibre-gl';

import type { SpatialIndex } from '../store/spatial/spatial-index.js';
import type { BoundingBox, Feature } from '../store/types.js';

/**
 * The factor by which the render loop widens the viewport for rendering and culling: 2.
 *
 * To prevent flicker while panning and zooming, rendering and culling use the range
 * obtained by widening the real viewport by this factor.
 */
export const DEFAULT_VIEWPORT_EXPANSION_FACTOR = 2.0;

/**
 * Dependencies of ViewportFilter
 */
export interface ViewportFilterDeps {
  map: MapLibreMap;
  spatialIndex: SpatialIndex;
}

/**
 * Expands LngLatBounds by the given factor
 *
 * To prevent flicker while panning and zooming, the viewport is expanded so that
 * off-screen features are included in the render set in advance.
 *
 * Only the latitude is clamped (to -90..90). The longitude keeps the unwrapped values
 * that maplibre returns: a view across the antimeridian has an east edge above 180 (or a
 * west edge below -180), and clamping it would cut the other side of the line off.
 * `splitLongitudeRange` turns the result into ranges of [-180, 180].
 *
 * @param bounds The original bounding box
 * @param factor The expansion factor (2.0 = expand to twice the size)
 * @returns The expanded bounding box
 *
 * @internal
 */
export function expandBounds(bounds: LngLatBounds, factor: number): LngLatBounds {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();

  const width = ne.lng - sw.lng;
  const height = ne.lat - sw.lat;

  const widthPadding = (width * (factor - 1)) / 2;
  const heightPadding = (height * (factor - 1)) / 2;

  const clampLat = (lat: number) => Math.max(-90, Math.min(90, lat));

  return new LngLatBoundsClass(
    [sw.lng - widthPadding, clampLat(sw.lat - heightPadding)],
    [ne.lng + widthPadding, clampLat(ne.lat + heightPadding)],
  );
}

// The longitude helpers are pure math, defined in shared/ (dispatcher/ and snapping/ use
// them too); re-exported here for the existing imports
export { nearestLongitude, wrapLongitude } from '../shared/math/longitude.js';

/**
 * One copy of the world that a view covers
 *
 * `lngShift` is how far the stored longitudes are moved to be drawn there (0 for the stored
 * copy, 360 for the copy east of the antimeridian, -360 for the copy west of it), and
 * `minX` / `maxX` is the view seen from that copy, in stored longitudes.
 */
export interface LongitudeCopy {
  readonly lngShift: number;
  readonly minX: number;
  readonly maxX: number;
}

/**
 * Splits an unwrapped longitude range into the copies of the world it covers
 *
 * The features are stored with longitudes in [-180, 180], while the view of the map is a
 * continuous range that can run past the antimeridian (170 to 190, for example). Such a view
 * covers two copies: the stored copy, and the copy moved by 360 degrees, which shows the
 * stored longitudes -190 to -170 (that is, -180 to -170). Each copy is the whole view moved
 * back by its shift, so a longitude falls in the view of at most one copy (the view is less
 * than 360 degrees wide) and nothing is drawn twice; a longitude stored beyond ±180 is still
 * found on the copy that shows it. A range 360 degrees wide or more is the regime of world
 * copies, which are not replicated: it gives the stored copy, whole.
 *
 * @param west The west edge (unwrapped)
 * @param east The east edge (unwrapped, at least west)
 * @returns One or two copies, from the westmost shift
 */
export function splitLongitudeCopies(west: number, east: number): LongitudeCopy[] {
  if (!(east - west < 360)) return [{ lngShift: 0, minX: -180, maxX: 180 }];
  const copies: LongitudeCopy[] = [];
  const first = Math.ceil((west - 180) / 360);
  const last = Math.floor((east + 180) / 360);
  for (let turn = first; turn <= last; turn++) {
    // (+ 0 turns the -0 of Math.ceil into 0)
    const shift = turn * 360 + 0;
    const minX = west - shift;
    const maxX = east - shift;
    // A copy whose view only touches the stored range at its edge adds nothing
    if (Math.min(maxX, 180) > Math.max(minX, -180) || (copies.length === 0 && turn === last)) {
      copies.push({ lngShift: shift, minX, maxX });
    }
  }
  return copies;
}

/**
 * Splits an unwrapped longitude range into the ranges of stored longitudes it shows
 *
 * The ranges of `splitLongitudeCopies`, without the shift: the narrowing down by the
 * spatial index queries each of them.
 *
 * @param west The west edge (unwrapped)
 * @param east The east edge (unwrapped, at least west)
 * @returns One or two ranges `[west, east]` (west <= east)
 */
export function splitLongitudeRange(west: number, east: number): Array<[number, number]> {
  return splitLongitudeCopies(west, east).map((copy) => [copy.minX, copy.maxX]);
}

/**
 * The part of the view on one copy of the world (see `splitLongitudeCopies`)
 */
export interface ViewportCopy {
  /** How far the stored longitudes are moved to be drawn on this copy */
  readonly lngShift: number;
  /** The part of the view on this copy, in stored longitudes */
  readonly bounds: BoundingBox;
}

/**
 * Computes the copies of the world the current viewport covers, expanded
 *
 * Away from the antimeridian this is the stored copy alone. A view across it gives two:
 * the rendering draws the features of each copy with that copy's shift. When the expanded
 * view is 360 degrees wide or more, the longitudes of the view itself are used; when those are
 * still too wide, it is the regime of world copies and the stored copy is drawn alone.
 *
 * The latitudes keep the expansion in every case. On the globe the whole sphere is often in
 * view, so the longitudes span 360 degrees, and the bounds maplibre reports fall short of the
 * edge of the sphere by a degree or two: without the margin the points between the bounds and
 * the edge were culled and vanished, while a line reaching there was kept by the rest of its
 * box.
 *
 * @param map The MapLibre Map
 * @param expansionFactor The expansion factor
 */
export function getViewportCopies(map: MapLibreMap, expansionFactor: number): ViewportCopy[] {
  const view = map.getBounds();
  const expanded = expandBounds(view, expansionFactor);
  const tooWide = !(expanded.getEast() - expanded.getWest() < 360);
  const west = tooWide ? view.getWest() : expanded.getWest();
  const east = tooWide ? view.getEast() : expanded.getEast();
  const minY = expanded.getSouth();
  const maxY = expanded.getNorth();
  return splitLongitudeCopies(west, east).map((copy) => ({
    lngShift: copy.lngShift,
    bounds: { minX: copy.minX, minY, maxX: copy.maxX, maxY },
  }));
}

/**
 * Computes the ranges of the current viewport, expanded (one, or two across the antimeridian)
 *
 * The narrowing down by the spatial index queries every range, so the features on both sides
 * of the antimeridian are found.
 *
 * @param map The MapLibre Map
 * @param expansionFactor The expansion factor
 */
export function getExpandedViewportRanges(
  map: MapLibreMap,
  expansionFactor: number,
): BoundingBox[] {
  return getViewportCopies(map, expansionFactor).map((copy) => copy.bounds);
}

/**
 * Returns the current viewport of a map widened by a factor, as one range in degrees.
 *
 * This gathers the way the render loop obtains the viewport into one place, so that
 * the narrowing down of features (ViewportFilter) and the culling of
 * datasets look at the same range.
 *
 * A single bbox cannot hold the two ranges of a view across the antimeridian, so it
 * covers every longitude in that case (the thinning keeps everything in the latitude
 * band; nothing on either side of the line is dropped). `getExpandedViewportRanges`
 * gives the exact ranges.
 *
 * @param map The MapLibre Map
 * @param expansionFactor The factor applied to the width and height of the viewport (1 = the
 *   viewport itself)
 * @returns The range in degrees (`minX` / `maxX` longitudes, `minY` / `maxY` latitudes)
 */
export function getExpandedViewportBounds(map: MapLibreMap, expansionFactor: number): BoundingBox {
  return hullOf(getExpandedViewportRanges(map, expansionFactor));
}

/** The bbox of one or two ranges (two ranges together cover every stored longitude) */
function hullOf(ranges: BoundingBox[]): BoundingBox {
  if (ranges.length === 1) return ranges[0];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const range of ranges) {
    minX = Math.min(minX, range.minX);
    maxX = Math.max(maxX, range.maxX);
  }
  return { minX, minY: ranges[0].minY, maxX, maxY: ranges[0].maxY };
}

/**
 * ViewportFilter
 *
 * The class that filters features down to those inside the viewport.
 *
 * @internal
 */
export class ViewportFilter {
  private map: MapLibreMap;
  private spatialIndex: SpatialIndex;
  private expansionFactor: number;

  /**
   * @param deps The dependencies
   * @param expansionFactor The viewport expansion factor (default: 2.0)
   */
  constructor(deps: ViewportFilterDeps, expansionFactor = DEFAULT_VIEWPORT_EXPANSION_FACTOR) {
    this.map = deps.map;
    this.spatialIndex = deps.spatialIndex;
    this.expansionFactor = expansionFactor;
  }

  /**
   * Gets the Set of feature IDs that exist inside the current viewport
   *
   * @returns The Set of feature IDs inside the viewport
   */
  getVisibleIds(): Set<string> {
    // Across the antimeridian the view is two ranges, and each is queried
    const ids = new Set<string>();
    for (const range of getExpandedViewportRanges(this.map, this.expansionFactor)) {
      for (const id of this.spatialIndex.findInBounds(range)) ids.add(id);
    }
    return ids;
  }

  /**
   * Gets the copies of the world the current expanded viewport covers
   *
   * One copy (the stored one) away from the antimeridian, two across it
   * (see getViewportCopies).
   */
  getCopies(): ViewportCopy[] {
    return getViewportCopies(this.map, this.expansionFactor);
  }

  /**
   * Gets the Set of feature IDs inside a range of stored longitudes (one copy of the view)
   */
  getVisibleIdsIn(bounds: BoundingBox): Set<string> {
    return new Set(this.spatialIndex.findInBounds(bounds));
  }

  /**
   * Gets the bbox of the current expanded viewport
   *
   * Across the antimeridian it covers every longitude (see getExpandedViewportBounds).
   */
  getBounds(): BoundingBox {
    return getExpandedViewportBounds(this.map, this.expansionFactor);
  }

  /**
   * Filters an array of features down to those inside the viewport
   *
   * The filtering preserves the draw order.
   *
   * @param features The array of features to filter
   * @returns The array of features inside the viewport
   */
  filter(features: Feature[]): Feature[] {
    const visibleIds = this.getVisibleIds();
    return features.filter((f) => visibleIds.has(f.id));
  }
}

/**
 * Creates a ViewportFilter
 *
 * @internal
 */
export function createViewportFilter(
  deps: ViewportFilterDeps,
  expansionFactor?: number,
): ViewportFilter {
  return new ViewportFilter(deps, expansionFactor);
}
