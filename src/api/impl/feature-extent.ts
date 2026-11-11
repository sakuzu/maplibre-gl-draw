// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The extent of the features that match a filter (`features.bbox`)
 *
 * The extent of a feature is the one the instance draws and finds it by: the extent of its
 * positions, the extent of the circle of a Circle, the extent of the image of an Image on the
 * screen at the zoom it was placed at (`getBoundingBox`). A Store of objects reads it from its
 * features. A Store that holds its features as rows reads it from the boxes of the rows the
 * tables keep, without making the features: the box of a row is the extent of its positions; a
 * Circle is read from its center and its radius; an Image, whose extent is read from its
 * attributes, from its feature.
 */

import { ROW_FLAG_DELETED } from '@sakuzu/kasane/render';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { rowPoint, rowType, rowValue } from '../../feature-table/row-read.js';
import { coordinatesBBox } from '../../geometry/bbox.js';
import { circleBoundingBox } from '../../geometry/circle.js';
import { positionsOf } from '../../geometry/geojson.js';
import type { BBox } from '../../geometry/types.js';
import { drawPropertyKey } from '../../shared/properties.js';
import { getBoundingBox } from '../../shared/utils/feature-bbox.js';
import { forEachMatchingRow, type RowFilter } from '../../store/feature-stream.js';
import type { Store } from '../../store/store.js';
import type { Feature } from '../../store/types.js';

/** The key of the radius of a Circle in the attributes of a row */
const RADIUS_KEY = drawPropertyKey('radiusMeters');

/** An extent being widened, from nothing */
class Extent {
  minX = Number.POSITIVE_INFINITY;
  minY = Number.POSITIVE_INFINITY;
  maxX = Number.NEGATIVE_INFINITY;
  maxY = Number.NEGATIVE_INFINITY;

  add(minX: number, minY: number, maxX: number, maxY: number): void {
    if (minX < this.minX) this.minX = minX;
    if (minY < this.minY) this.minY = minY;
    if (maxX > this.maxX) this.maxX = maxX;
    if (maxY > this.maxY) this.maxY = maxY;
  }

  addBox(box: BBox | null): void {
    if (box) this.add(box[0], box[1], box[2], box[3]);
  }

  /** The extent, or null when nothing widened it */
  get box(): BBox | null {
    return this.minX <= this.maxX ? [this.minX, this.minY, this.maxX, this.maxY] : null;
  }
}

/**
 * The extent of a feature (null for one without a finite position)
 *
 * @internal
 */
export function featureExtent(feature: Feature): BBox | null {
  if (feature.type === 'Circle' || feature.type === 'Image') {
    if (coordinatesBBox(positionsOf(feature.geometry)) === null) return null;
    // A box of its own (getBoundingBox gives a new one every time)
    return getBoundingBox(feature);
  }
  return coordinatesBBox(positionsOf(feature.geometry));
}

/**
 * The extent of features (null when none has a finite position)
 *
 * @internal
 */
export function featuresExtent(features: Iterable<Feature>): BBox | null {
  const extent = new Extent();
  for (const feature of features) extent.addBox(featureExtent(feature));
  return extent.box;
}

/**
 * The extent of the rows of a Store that holds its features as rows that match a filter (null
 * when none has a finite position), read from the boxes of the rows without making features
 *
 * @internal
 */
export function rowsExtent(store: Store, filter: RowFilter): BBox | null {
  const tables = store.tables;
  const internals = featureTablesInternals(tables);
  const extent = new Extent();
  if (!tables || !internals) return null;
  forEachMatchingRow(store, filter, (handle) => {
    const place = internals.placeOf(handle);
    if (!place) return true;
    const { group, row } = place;
    if ((group.data.flags[row] & ROW_FLAG_DELETED) !== 0) return true;
    const type = rowType(group.data, row);
    if (type === 'Image') {
      const feature = store.getFeature(tables.getRowId(handle) as string);
      if (feature) extent.addBox(featureExtent(feature));
      return true;
    }
    if (type === 'Circle') {
      const center = rowPoint(group, row);
      if (!center) return true;
      const radius = rowValue(group, row, RADIUS_KEY);
      const circle =
        typeof radius === 'number' && radius > 0 ? circleBoundingBox(center, radius) : null;
      extent.addBox(circle ?? [center[0], center[1], center[0], center[1]]);
      return true;
    }
    const b = group.data.rowBounds;
    const at = row * 4;
    if (!Number.isNaN(b[at])) extent.add(b[at], b[at + 1], b[at + 2], b[at + 3]);
    return true;
  });
  return extent.box;
}
