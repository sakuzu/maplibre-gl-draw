// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Box selection logic
 *
 * Responsible for handling box selection in select mode
 */

import { isLocallyHidden } from '../../store/local-visibility.js';
import type { BoxSelection, Coordinate, Feature } from '../../store/types.js';
import type { ModeContext } from '../handler.js';

/**
 * Detect the features inside the box
 *
 * First the candidates are obtained quickly through the SpatialIndex (rbush),
 * and then a precise inside-the-box test is performed.
 */
export function queryFeaturesInBox(boxSelection: BoxSelection, context: ModeContext): string[] {
  const { store, spatialIndex, boxSelectionRegistry } = context;
  const rects = boxRects(boxSelection.startPoint, boxSelection.endPoint);

  // First obtain the candidates quickly with rbush (from each part of a box that crosses the
  // antimeridian)
  const candidateIds = new Set<string>();
  for (const rect of rects) {
    for (const id of spatialIndex.findInBounds(rect)) candidateIds.add(id);
  }

  // Perform the precise inside-the-box test on the candidates.
  // As with the click hit test (HitTestService.hitTestAll), hidden or locked features / their
  // layer / their group are excluded from the selection targets (this prevents the
  // inconsistency where box selection alone could select while ignoring locks and hiding).
  const hitIds: string[] = [];
  for (const id of candidateIds) {
    const feature = store.getFeature(id);
    if (!feature) continue;
    if (!feature.visible || feature.locked) continue;
    // What this client has hidden locally is excluded from the box selection targets too
    // (this prevents the inconsistency of being hit by the box while invisible).
    if (isLocallyHidden(feature, store)) continue;

    const layer = store.getLayer(feature.layerId);
    if (layer && (!layer.visible || layer.locked)) continue;

    if (feature.groupId) {
      const group = store.getGroup(feature.groupId);
      if (group && (!group.visible || group.locked)) continue;
    }

    if (rects.some((rect) => isFeatureInBox(feature, rect, boxSelectionRegistry))) {
      hitIds.push(feature.id);
    }
  }

  return hitIds;
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
  boxSelectionRegistry: ModeContext['boxSelectionRegistry'],
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

  const coords = feature.coordinates;

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
