// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Combine: the public boolean operations on polygons and the split by a line
 */

import type { Feature, LineString, MultiPolygon, Polygon } from 'geojson';
import { differenceAll, intersectionAll, unionAll } from './boolean.js';
import { withOperation } from './errors.js';
import { areaOf, areasOf, lineOf, toAreaGeometry } from './geojson.js';
import { splitArea } from './split.js';

/**
 * Returns the union of polygons.
 *
 * @param polygons The Polygons and MultiPolygons, or features whose geometry is one;
 *   coordinates in degrees. Rings with fewer than 3 positions or a position that is not finite
 *   are left out
 * @returns A Polygon, or a MultiPolygon when the union falls apart, with self-intersections
 *   resolved and the rings oriented as RFC 7946 recommends. null when nothing has an area
 * @throws {@link GeometryError} (`invalid-input`) when an element is not a Polygon or a
 *   MultiPolygon, and (`engine-failure`) when the boolean operation fails
 *
 * @example
 * ```ts
 * import { union } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * union([
 *   { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
 *   { type: 'Polygon', coordinates: [[[0.5, 0], [1.5, 0], [1.5, 1], [0.5, 1], [0.5, 0]]] },
 * ]);
 * // { type: 'Polygon', coordinates: [[[0, 0], [1.5, 0], [1.5, 1], [0, 1], [0, 0]]] }
 * ```
 */
export function union(
  polygons: readonly (Polygon | MultiPolygon | Feature)[],
): Polygon | MultiPolygon | null {
  const inputs = areasOf(polygons, 'union');
  return withOperation('union', () => toAreaGeometry(unionAll(inputs)));
}

/**
 * Returns the part that polygons have in common.
 *
 * @param polygons The Polygons and MultiPolygons, or features whose geometry is one;
 *   coordinates in degrees
 * @returns A Polygon or a MultiPolygon in the form {@link union} returns. null when the
 *   polygons share no area (touching boundaries included), when one has no area, and for an
 *   empty array
 * @throws {@link GeometryError} (`invalid-input`) when an element is not a Polygon or a
 *   MultiPolygon, and (`engine-failure`) when the boolean operation fails
 */
export function intersection(
  polygons: readonly (Polygon | MultiPolygon | Feature)[],
): Polygon | MultiPolygon | null {
  const inputs = areasOf(polygons, 'intersection');
  return withOperation('intersection', () => toAreaGeometry(intersectionAll(inputs)));
}

/**
 * Returns a polygon with other polygons removed from it.
 *
 * @param subject The Polygon or MultiPolygon to remove from, or a feature whose geometry is
 *   one; coordinates in degrees
 * @param others The Polygons and MultiPolygons to remove, or features whose geometry is one;
 *   coordinates in degrees
 * @returns A Polygon or a MultiPolygon in the form {@link union} returns; a removed area inside
 *   the subject becomes a hole. null when nothing remains
 * @throws {@link GeometryError} (`invalid-input`) when an argument is not a Polygon or a
 *   MultiPolygon, and (`engine-failure`) when the boolean operation fails
 */
export function difference(
  subject: Polygon | MultiPolygon | Feature,
  others: readonly (Polygon | MultiPolygon | Feature)[],
): Polygon | MultiPolygon | null {
  const left = areaOf(subject, 'difference');
  const right = areasOf(others, 'difference');
  return withOperation('difference', () => toAreaGeometry(differenceAll(left, right)));
}

/**
 * Cuts a polygon with a line and returns the pieces.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees
 * @param line The cutting LineString, or a feature whose geometry is one; coordinates in
 *   degrees. A stretch that runs along the boundary does not cut, and positions closer than
 *   1e-9 degrees count as one
 * @returns One Polygon per piece, holes kept. When the line does not cut across, the polygon
 *   itself (one Polygon per part of a MultiPolygon). An empty array when it has no area
 * @throws {@link GeometryError} (`invalid-input`) when an argument is not of the expected
 *   type, and (`engine-failure`) when the boolean operation fails
 */
export function split(
  polygon: Polygon | MultiPolygon | Feature,
  line: LineString | Feature,
): Polygon[] {
  const area = areaOf(polygon, 'split');
  const path = lineOf(line, 'split');
  return withOperation('split', () =>
    splitArea(area, path).flatMap((piece) =>
      piece.map((coordinates): Polygon => ({ type: 'Polygon', coordinates })),
    ),
  );
}
