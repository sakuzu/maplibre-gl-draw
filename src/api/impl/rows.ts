// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The conversions between the rows of the datasets as the engine keeps them and as the 2.0
 * API gives them: GeoJSON features, `BBox` arrays and `Position` arrays
 */

import type { BBox } from '../../geometry/types.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import type { DatasetRow } from '../datasets.js';

/**
 * A row of a dataset as a GeoJSON feature: its ID, its geometry (`null` for a row without
 * one) and its properties, and its look under `style` when it has one
 *
 * @internal
 */
export function toDatasetRow(feature: StoredFeature): DatasetRow {
  const row: DatasetRow = {
    type: 'Feature',
    id: feature.id,
    geometry: hasGeometry(feature) ? feature.geometry : null,
    properties: feature.properties ?? {},
  };
  if (feature.style && Object.keys(feature.style).length > 0) row.style = feature.style;
  return row;
}

/** Whether a row has a geometry (a row without one is kept as a hidden point at NaN) */
function hasGeometry(feature: StoredFeature): boolean {
  const { geometry } = feature;
  if (feature.visible !== false || geometry.type !== 'Point') return true;
  return !Number.isNaN(geometry.coordinates[0]);
}

/**
 * The box of a `bbox` given to the API (`[west, south, east, north]`, or with the heights
 * `[west, south, low, east, north, high]`), as a box of its own
 *
 * @internal
 */
export function planeBBoxOf(bbox: BBox | readonly number[]): BBox {
  if (bbox.length === 6) {
    return [bbox[0], bbox[1], bbox[3], bbox[4]];
  }
  return [bbox[0], bbox[1], bbox[2], bbox[3]];
}

/**
 * A copy of a box of the library, to hand out (what is handed out is not the box it keeps)
 *
 * @internal
 */
export function copyBBox(bounds: BBox): BBox {
  return [bounds[0], bounds[1], bounds[2], bounds[3]];
}
