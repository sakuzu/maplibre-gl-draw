// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the viewport ranges across the antimeridian
 *
 * maplibre reports a view across the antimeridian with unwrapped longitudes (an east edge above
 * 180). The features are stored in [-180, 180], so the view is split into two ranges before the
 * spatial index is queried, and the features on both sides of the line are found.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { LngLatBounds } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { RBushSpatialIndex } from '../store/spatial/spatial-index.js';
import type { Feature } from '../store/types.js';
import {
  getExpandedViewportBounds,
  getExpandedViewportRanges,
  splitLongitudeCopies,
  splitLongitudeRange,
  ViewportFilter,
} from './viewport.js';

function point(id: string, lng: number, lat: number): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

/** A map whose view is the given unwrapped range */
function mapViewing(west: number, south: number, east: number, north: number): MapLibreMap {
  return {
    getBounds: () => new LngLatBounds([west, south], [east, north]),
  } as unknown as MapLibreMap;
}

describe('splitLongitudeRange', () => {
  it('keeps a range inside [-180, 180] as it is', () => {
    expect(splitLongitudeRange(139, 140)).toEqual([[139, 140]]);
  });

  it('splits a range across the east of the antimeridian into the view of each copy', () => {
    expect(splitLongitudeRange(170, 190)).toEqual([
      [170, 190],
      [-190, -170],
    ]);
  });

  it('splits a range across the west of the antimeridian into the view of each copy', () => {
    expect(splitLongitudeRange(-190, -170)).toEqual([
      [170, 190],
      [-190, -170],
    ]);
  });

  it('gives each copy its shift', () => {
    expect(splitLongitudeCopies(170, 190)).toEqual([
      { lngShift: 0, minX: 170, maxX: 190 },
      { lngShift: 360, minX: -190, maxX: -170 },
    ]);
    expect(splitLongitudeCopies(-190, -170)).toEqual([
      { lngShift: -360, minX: 170, maxX: 190 },
      { lngShift: 0, minX: -190, maxX: -170 },
    ]);
  });

  it('does not add a copy that the view only touches at the edge', () => {
    expect(splitLongitudeCopies(100, 180)).toEqual([{ lngShift: 0, minX: 100, maxX: 180 }]);
  });

  it('brings a range on another copy of the world back into [-180, 180]', () => {
    expect(splitLongitudeRange(500, 510)).toEqual([[140, 150]]);
  });

  it('covers every longitude for a range of 360 degrees or more', () => {
    expect(splitLongitudeRange(-200, 200)).toEqual([[-180, 180]]);
  });
});

describe('the viewport across the antimeridian', () => {
  it('finds the features at 179.9 and -179.9 in a view centered on the antimeridian', () => {
    const index = new RBushSpatialIndex();
    index.insert(point('east', 179.9, 0));
    index.insert(point('west', -179.9, 0));
    index.insert(point('far', 0, 0));

    const map = mapViewing(179.8, -0.1, 180.2, 0.1);
    const filter = new ViewportFilter({ map, spatialIndex: index });

    expect([...filter.getVisibleIds()].sort()).toEqual(['east', 'west']);
  });

  it('gives two ranges, and a bbox that covers every longitude', () => {
    const map = mapViewing(179.8, -0.1, 180.2, 0.1);

    const ranges = getExpandedViewportRanges(map, 2);
    expect(ranges).toHaveLength(2);
    expect(ranges[0].minX).toBeCloseTo(179.6);
    expect(ranges[0].maxX).toBeCloseTo(180.4);
    expect(ranges[1].minX).toBeCloseTo(-180.4);
    expect(ranges[1].maxX).toBeCloseTo(-179.6);

    const bounds = getExpandedViewportBounds(map, 2);
    expect(bounds.minX).toBeLessThan(-180);
    expect(bounds.maxX).toBeGreaterThan(180);
    expect(bounds.minY).toBeCloseTo(-0.2);
    expect(bounds.maxY).toBeCloseTo(0.2);
  });

  it('keeps a single range away from the antimeridian', () => {
    const map = mapViewing(139.6, 35.6, 139.8, 35.8);
    const bounds = getExpandedViewportBounds(map, 2);
    expect(bounds.minX).toBeCloseTo(139.5);
    expect(bounds.maxX).toBeCloseTo(139.9);
  });
});

describe('the viewport of a whole globe', () => {
  it('keeps the margin of latitude when the view spans every longitude', () => {
    // maplibre's bounds of a globe in full view stop a degree or two short of its edge
    const map = mapViewing(-180, -90, 180, 48);
    const bounds = getExpandedViewportBounds(map, 2);
    expect(bounds.minX).toBe(-180);
    expect(bounds.maxX).toBe(180);
    expect(bounds.maxY).toBe(90);
  });

  it('keeps the margin of latitude when only the expanded view is 360 degrees wide', () => {
    const map = mapViewing(-150, -30, 150, 40);
    const [range] = getExpandedViewportRanges(map, 2);
    expect(range.minX).toBeCloseTo(-150);
    expect(range.maxX).toBeCloseTo(150);
    expect(range.minY).toBeCloseTo(-65);
    expect(range.maxY).toBeCloseTo(75);
  });

  it('finds a point between the reported bounds and the edge of the sphere', () => {
    const index = new RBushSpatialIndex();
    index.insert(point('near-edge', 151.5, 48.1));
    const map = mapViewing(-180, -90, 180, 48);
    const filter = new ViewportFilter({ map, spatialIndex: index });
    expect([...filter.getVisibleIds()]).toEqual(['near-edge']);
  });
});
