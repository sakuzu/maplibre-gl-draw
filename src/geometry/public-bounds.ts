// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bounds: the public bounding box of a geometry
 */

import type { Geometry } from 'geojson';
import { coordinatesBBox } from './bbox.js';
import { invalidInput } from './errors.js';
import { geometryOf, positionsOf } from './geojson.js';
import type { BBox } from './types.js';

/**
 * Returns the bounding box `[minLng, minLat, maxLng, maxLat]` in degrees of a geometry.
 *
 * @param geometry The geometry, or a feature whose geometry it is; coordinates in degrees.
 *   Every position counts, the holes and the members of a collection included; a position
 *   that is not finite is skipped. Crossing the ±180 degree meridian is not handled
 * @returns The box in degrees
 * @throws {@link GeometryError} (`invalid-input`) when the input is not a geometry or a feature
 *   with one, and when it has no finite position
 *
 * @example
 * ```ts
 * import { bbox } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * bbox({ type: 'LineString', coordinates: [[139.7, 35.6], [139.8, 35.7]] });
 * // [139.7, 35.6, 139.8, 35.7]
 * ```
 */
export function bbox(geometry: Geometry | { readonly geometry: Geometry }): BBox {
  const box = coordinatesBBox(positionsOf(geometryOf(geometry, 'bbox')));
  if (box === null) {
    throw invalidInput('bbox', 'the geometry has no finite position');
  }
  return box;
}
