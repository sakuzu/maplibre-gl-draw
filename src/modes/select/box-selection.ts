// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Box selection logic
 *
 * Responsible for handling box selection in select mode
 */

import type { IdSet } from '../../api/model.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import type { DocumentAccess, DocumentBoxes, DocumentTables } from '../../store/document-access.js';
import type { BoxSelection, Coordinate, Feature } from '../../store/types.js';
import type { EngineModeContext } from '../handler.js';

/**
 * Detect the features inside the box
 *
 * First the candidates are obtained quickly through the spatial index of the Store (the boxes
 * of its rows), and then a precise inside-the-box test is performed. The features taken are
 * listed in stacking order, from the back.
 */
export function queryFeaturesInBox(
  boxSelection: BoxSelection,
  context: EngineModeContext,
): string[] {
  return [...selectFeaturesInBox(boxSelection, context).iterate()];
}

/**
 * The features inside the box, as a set of their rows, in stacking order from the back: what
 * the box selects, read without an array of their IDs
 *
 * The candidates come from the spatial index of the Store (the boxes of its rows). As with the
 * click hit test (HitTestService.hitTestAll), hidden or locked features, those of a hidden or
 * locked layer or group, and what this client hides are not taken: the layer reads that from the
 * rows, without the features being made. A row whose box lies wholly inside the box is taken
 * without its feature being made, when its type is tested by a built-in test (whose answer is
 * then yes: it meets the box, or its center is in it); a row on the edge of the box, and a row of
 * a type whose test is an extension's (its `boxSelect`), is tested on its feature.
 */
export function selectFeaturesInBox(boxSelection: BoxSelection, context: EngineModeContext): IdSet {
  const { spatialIndex, boxSelectionRegistry } = context;
  const store = context.store as DocumentAccess &
    Pick<DocumentBoxes, 'listSelectableRows'> &
    Pick<DocumentTables, 'getTables'>;
  const rects = boxRects(boxSelection.startPoint, boxSelection.endPoint);

  // The candidates of the spatial index, from each part of a box that crosses the antimeridian
  // (the layer takes each once)
  const candidateIds = (function* () {
    for (const rect of rects) yield* spatialIndex.findInBounds(rect);
  })();
  const rows = store.listSelectableRows(candidateIds, rects, (type) =>
    isBuiltInTest(boxSelectionRegistry.get(type)),
  );

  const tables = store.getTables();
  const taken = new Int32Array(rows.refs.length);
  let count = 0;
  for (let i = 0; i < rows.refs.length; i++) {
    const ref = rows.refs[i];
    if (rows.inside[i] === 1) {
      taken[count++] = ref;
      continue;
    }
    const id = tables.getRowId(ref);
    const feature = id === undefined ? undefined : store.getFeature(id);
    if (!feature) continue;
    if (rects.some((rect) => isFeatureInBox(feature, rect, boxSelectionRegistry))) {
      taken[count++] = ref;
    }
  }
  return store.featureSetOfRows(taken.subarray(0, count));
}

/**
 * Whether the box test of a type is a built-in one: the tests of the built-in types are made by
 * classes, and what an extension registers for a type (its `boxSelect`, or the test of its
 * geometry wrapped for it) is a plain object
 */
function isBuiltInTest(strategy: object | undefined): boolean {
  return strategy !== undefined && Object.getPrototypeOf(strategy) !== Object.prototype;
}

type Rect = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * The rectangles, in longitudes within [-180, 180], that a box drawn on the screen covers
 *
 * The corners come from the map unprojected as they are, so a box drawn across the
 * antimeridian has a longitude beyond ±180 at one side. It is brought back into [-180, 180]
 * and split at the line into two rectangles, and the box as drawn is kept as well; a box as
 * wide as the world covers every longitude.
 */
export function boxRects(start: Coordinate, end: Coordinate): Rect[] {
  const minY = Math.min(start[1], end[1]);
  const maxY = Math.max(start[1], end[1]);
  let minX = Math.min(start[0], end[0]);
  let maxX = Math.max(start[0], end[0]);

  if (maxX - minX >= 360) return [{ minX: -180, minY, maxX: 180, maxY }];

  // Features whose coordinates were stored beyond ±180 are still found by the box as drawn
  const drawn: Rect = { minX, minY, maxX, maxY };

  // Shift whole turns so that the west side is within [-180, 180)
  const turns = Math.floor((minX + 180) / 360);
  minX -= turns * 360;
  maxX -= turns * 360;
  const parts: Rect[] =
    maxX <= 180
      ? [{ minX, minY, maxX, maxY }]
      : [
          { minX, minY, maxX: 180, maxY },
          { minX: -180, minY, maxX: maxX - 360, maxY },
        ];
  return turns === 0 && parts.length === 1 ? parts : [...parts, drawn];
}

/**
 * Decide whether a feature is inside the box
 *
 * Uses BoxSelectionStrategyRegistry to perform the appropriate test per feature type.
 * - Point: whether the center coordinate is inside the box
 * - LineString: intersection test between the geometry and the box
 * - Polygon: intersection test between the geometry and the box
 * - Text/Image: intersection test between the OBB (the bounding box that accounts for rotation)
 *   and the box
 */
export function isFeatureInBox(
  feature: Feature,
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  boxSelectionRegistry: EngineModeContext['boxSelectionRegistry'],
): boolean {
  // Get the Strategy from the registry
  const strategy = boxSelectionRegistry.get(feature.type);
  if (strategy) {
    return strategy.intersects(feature, rect);
  }

  // Fallback for custom types (a coordinate-based test)
  return fallbackBoxSelection(feature, rect);
}

/**
 * The fallback box selection test
 *
 * Performs a simple coordinate-based test for feature types that are not registered.
 */
export function fallbackBoxSelection(
  feature: Feature,
  rect: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  const isPointInBox = (coord: Coordinate): boolean => {
    return (
      coord[0] >= rect.minX &&
      coord[0] <= rect.maxX &&
      coord[1] >= rect.minY &&
      coord[1] <= rect.maxY
    );
  };

  const coords = coordinatesOf(feature);

  // When the coordinates are a single point
  if (
    Array.isArray(coords) &&
    coords.length === 2 &&
    typeof coords[0] === 'number' &&
    typeof coords[1] === 'number'
  ) {
    return isPointInBox(coords as Coordinate);
  }

  // When the coordinates are an array
  if (Array.isArray(coords) && coords.length > 0) {
    const firstElement = coords[0];

    // LineString form: Coordinate[]
    if (
      Array.isArray(firstElement) &&
      firstElement.length === 2 &&
      typeof firstElement[0] === 'number'
    ) {
      return (coords as Coordinate[]).some((coord) => isPointInBox(coord));
    }

    // Polygon form: Coordinate[][]
    if (Array.isArray(firstElement) && Array.isArray(firstElement[0])) {
      const rings = coords as Coordinate[][];
      if (rings.length === 0) return false;
      return rings[0].some((coord) => isPointInBox(coord));
    }
  }

  return false;
}
