// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The conversions between the rows of the datasets as the engine keeps them and as the 2.0
 * API gives them: GeoJSON features, `BBox` arrays and `Position` arrays
 */

import type { BBox } from 'geojson';
import type { BoundingBox, Feature as StoredFeature } from '../../store/types.js';
import type { DatasetRow } from '../datasets.js';

/**
 * A row of a dataset as a GeoJSON feature: its ID, its geometry (`null` for a row without
 * one) and its properties, and its look under `style` when it has one
 *
 * @internal
 */
export function toDatasetRow(feature: StoredFeature): DatasetRow {
  const row: DatasetRow & { style?: StoredFeature['style'] } = {
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
 * The range of a `BBox` (`[west, south, east, north]`, or with the heights
 * `[west, south, low, east, north, high]`)
 *
 * @internal
 */
export function toBoundingBox(bbox: BBox): BoundingBox {
  if (bbox.length === 6) {
    return { minX: bbox[0], minY: bbox[1], maxX: bbox[3], maxY: bbox[4] };
  }
  return { minX: bbox[0], minY: bbox[1], maxX: bbox[2], maxY: bbox[3] };
}

/**
 * A range as a `BBox`, `[west, south, east, north]`
 *
 * @internal
 */
export function toBBox(bounds: BoundingBox): BBox {
  return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY];
}
