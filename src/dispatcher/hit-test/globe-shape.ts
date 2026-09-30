// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shape hit testing tests on the globe
 *
 * The strategies test in longitude and latitude and take an edge as the straight line between
 * its vertices in degrees. On the globe an edge is drawn along the straight line of the
 * Mercator plane carried onto the sphere (`view/globe-subdivision.ts`), which leaves the
 * straight line in degrees on a long edge that is not a parallel or a meridian. So on the globe
 * the lines and the rings are cut along the Mercator plane before they are tested, with the
 * line cell of the rendering: between two close points the two straight lines agree, and what
 * can be clicked is what is drawn.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  densifyOnMercatorPlane,
  globeSubdivisionGrid,
} from '../../shared/math/globe-subdivision.js';
import type { FeatureCoordinates } from '../../shared/types/model.js';
import { coordinatesOf, geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import { isGlobeProjection } from '../../shared/utils/map.js';
import type { Coordinate, Feature } from '../../store/types.js';

/** The most points the cut adds to one path (a guard against a runaway) */
const MAX_POINTS = 65_536;

/**
 * Reshapes a feature into the shape it is drawn with, for the precise test (the feature itself
 * when the shape is the same)
 */
export type DrawnShapeResolver = (feature: Feature) => Feature;

/**
 * The line cell of the globe for hit testing, in Mercator world units (0 on a flat map)
 *
 * The rendering cuts while maplibre draws the globe. A map set to the globe projection is cut
 * here at every zoom: past its switch to Mercator the cut only adds points on the straight
 * lines already drawn.
 */
export function globeHitTestGrid(map: MapLibreMap): number {
  return isGlobeProjection(map) ? globeSubdivisionGrid(map.getZoom(), 'line') : 0;
}

/**
 * The feature with its lines and rings cut along the Mercator plane into pieces of at most
 * `grid` (the feature itself when nothing is cut)
 *
 * LineString, Freehand, Polygon, MultiLineString and MultiPolygon are cut. The other types
 * keep their shape: a point has no edge, and a circle and an image are tested by their own
 * geometry.
 *
 * @param feature The feature to test
 * @param grid The longest piece, in Mercator world units (0 cuts nothing)
 */
export function shapeOnGlobe(feature: Feature, grid: number): Feature {
  if (!(grid > 0)) return feature;
  const cut = (path: Coordinate[]): Coordinate[] => densifyOnMercatorPlane(path, grid, MAX_POINTS);

  let coordinates: FeatureCoordinates;
  switch (feature.type) {
    case 'LineString':
    case 'Freehand':
      coordinates = cut(coordinatesOf(feature) as Coordinate[]);
      break;
    case 'Polygon':
    case 'MultiLineString':
      coordinates = (coordinatesOf(feature) as Coordinate[][]).map(cut);
      break;
    case 'MultiPolygon':
      coordinates = (coordinatesOf(feature) as Coordinate[][][]).map((rings) => rings.map(cut));
      break;
    default:
      return feature;
  }
  return { ...feature, geometry: geometryFromCoordinates(feature.type, coordinates) };
}

/**
 * A resolver that cuts on the globe of `map`, keeping the last cut of each feature
 *
 * Hover tests the same features on every move of the pointer, so a feature object that was
 * already cut with the same cell is not cut again. Features are replaced, not changed in
 * place, when their coordinates change, so the object is the key.
 */
export function createGlobeShapeResolver(map: MapLibreMap): DrawnShapeResolver {
  const cache = new WeakMap<Feature, { grid: number; shape: Feature }>();
  return (feature) => {
    const grid = globeHitTestGrid(map);
    if (!(grid > 0)) return feature;
    const hit = cache.get(feature);
    if (hit && hit.grid === grid) return hit.shape;
    const shape = shapeOnGlobe(feature, grid);
    cache.set(feature, { grid, shape });
    return shape;
  };
}
