// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resize operation
 *
 * The operation that resizes features. It computes in Web Mercator (see mercator-plane.ts),
 * so a handle follows the pointer on the map at any latitude. The extension points of the
 * draw instance are passed in as an argument ({@link ResizeExtensions}).
 */

import type { CustomResizeResult } from '../extension/index.js';
import type { HandleType } from '../shared/config/constants.js';
import { fromPlane, toPlane } from '../shared/math/mercator-plane.js';
import type { BoundingBoxCoords } from '../shared/types/selection-box.js';
import { mapCoordinatesDeep } from '../shared/utils/coordinates.js';
import { getCircleRadius, getImageProperties } from '../shared/utils/property.js';
import type { Coordinate, Feature, FeatureCoordinates } from '../store/types.js';

/**
 * A custom resize computation of a feature type
 */
export type ResizeCalculator = (
  handle: HandleType,
  state: ResizeState,
  currentLngLat: { lng: number; lat: number },
  feature: Feature,
) => CustomResizeResult | null;

/**
 * The extension points the resize reads from the draw instance
 *
 * The draw instance's selection extension registry satisfies it.
 */
export interface ResizeExtensions {
  getResizeStrategy(type: string): 'scale' | 'coordinates' | undefined;
  getCustomResizeCalculator(type: string): ResizeCalculator | undefined;
}

/**
 * Decides whether a feature has a scale property
 *
 * For features that have a scale property (Text, Image, custom features and so on)
 */
function hasScaleProperty(feature: Feature, extensions?: ResizeExtensions): boolean {
  // Get resizeStrategy from the draw instance's registry
  const strategy = extensions?.getResizeStrategy(feature.type);
  if (strategy === 'scale') {
    return true;
  }
  if (strategy === 'coordinates') {
    return false;
  }

  // The built-in types of the core
  if (feature.type === 'Image') {
    return true;
  }

  // Generic check (decided by the presence of a scale property)
  return (
    feature.properties !== null &&
    typeof feature.properties === 'object' &&
    'scale' in feature.properties
  );
}

/**
 * Gets the value of the scale property of a feature
 */
function getFeatureScale(feature: Feature): number {
  if (feature.type === 'Image') {
    const props = getImageProperties(feature);
    return props.scale ?? 1;
  }
  const props = feature.properties as Record<string, unknown>;
  return typeof props.scale === 'number' ? props.scale : 1;
}

/**
 * The result of the resize
 */
export interface ResizeResult {
  coordinates: FeatureCoordinates;
  /** The new scale value of a feature that has a scale property */
  scale?: number;
  /** The new radius for a Circle (meters) */
  radiusMeters?: number;
  /** The width (pixels) - for a custom resize */
  width?: number;
  /** The height (pixels) - for a custom resize */
  height?: number;
}

/**
 * The state of a resize drag, captured when the drag starts.
 */
export interface ResizeState {
  /** The handle being dragged */
  handle: HandleType;
  /** The pointer position at the start, in degrees */
  startLngLat: { lng: number; lat: number };
  /** The selection box at the start, corners in degrees */
  startBbox: BoundingBoxCoords;
  /** The coordinates of each feature at the start, by feature id */
  initialCoordinates: Map<string, FeatureCoordinates>;
  /** The scale of a feature that has a scale property, at the start */
  initialScales: Map<string, number>;
  /** The radius of a Circle at the start (meters) */
  initialRadiusMeters: Map<string, number>;
  /** The width at the start (pixels) - for a custom resize */
  initialWidth: Map<string, number>;
  /** The height at the start (pixels) - for a custom resize */
  initialHeight: Map<string, number>;
  /**
   * The extent of the bounding box (Web Mercator world units, 1 = the width of the world)
   * below which it is not stretched along that axis. The caller converts a screen distance
   * at the current zoom. 0 when omitted (only a box of no extent is left alone)
   */
  minAxisExtent?: number;
}

/**
 * Gets the anchor (the fixed point) from the handle position
 */
function getAnchorFromHandle(
  handle: HandleType,
  bbox: BoundingBoxCoords,
): { anchor: Coordinate; scaleX: number; scaleY: number } {
  switch (handle) {
    case 'resize-nw':
      return { anchor: bbox.bottomRight, scaleX: -1, scaleY: 1 };
    case 'resize-n':
      return {
        anchor: [(bbox.bottomLeft[0] + bbox.bottomRight[0]) / 2, bbox.bottomLeft[1]],
        scaleX: 0,
        scaleY: 1,
      };
    case 'resize-ne':
      return { anchor: bbox.bottomLeft, scaleX: 1, scaleY: 1 };
    case 'resize-e':
      return {
        anchor: [
          (bbox.topLeft[0] + bbox.bottomLeft[0]) / 2,
          (bbox.topLeft[1] + bbox.bottomLeft[1]) / 2,
        ],
        scaleX: 1,
        scaleY: 0,
      };
    case 'resize-se':
      return { anchor: bbox.topLeft, scaleX: 1, scaleY: -1 };
    case 'resize-s':
      return {
        anchor: [(bbox.topLeft[0] + bbox.topRight[0]) / 2, bbox.topLeft[1]],
        scaleX: 0,
        scaleY: -1,
      };
    case 'resize-sw':
      return { anchor: bbox.topRight, scaleX: -1, scaleY: -1 };
    case 'resize-w':
      return {
        anchor: [
          (bbox.topRight[0] + bbox.bottomRight[0]) / 2,
          (bbox.topRight[1] + bbox.bottomRight[1]) / 2,
        ],
        scaleX: -1,
        scaleY: 0,
      };
    default:
      return { anchor: bbox.center, scaleX: 1, scaleY: 1 };
  }
}

/**
 * Scales a coordinate in the transform plane around an anchor given in the plane
 */
function scaleCoordinate(
  coord: Coordinate,
  anchor: [number, number],
  scaleX: number,
  scaleY: number,
): Coordinate {
  const [x, y] = toPlane(coord);
  return fromPlane(anchor[0] + (x - anchor[0]) * scaleX, anchor[1] + (y - anchor[1]) * scaleY);
}

/**
 * Scales an array of coordinates
 *
 * It uses a common traversal that does not depend on the nesting depth, so Multi
 * geometries (a MultiPolygon is nested 4 levels deep) can be transformed as they
 * are.
 */
function scaleCoordinates(
  coords: FeatureCoordinates,
  anchor: [number, number],
  scaleX: number,
  scaleY: number,
): FeatureCoordinates {
  return mapCoordinatesDeep(coords, (coord) => scaleCoordinate(coord, anchor, scaleX, scaleY));
}

/**
 * The distance between 2 points of the transform plane
 */
function planeDistance(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * Computes the resize
 *
 * @param extensions The draw instance's extension points (custom resize calculators)
 *
 * @internal
 */
export function computeResize(
  state: ResizeState,
  currentLngLat: { lng: number; lat: number },
  features: Feature[],
  extensions?: ResizeExtensions,
): Map<string, ResizeResult> {
  const { handle, startLngLat, startBbox } = state;
  const {
    anchor: anchorLngLat,
    scaleX: scaleDirectionX,
    scaleY: scaleDirectionY,
  } = getAnchorFromHandle(handle, startBbox);
  const anchor = toPlane(anchorLngLat);
  const start = toPlane([startLngLat.lng, startLngLat.lat]);
  const current = toPlane([currentLngLat.lng, currentLngLat.lat]);

  // Compute the scale from the distance to the anchor (this handles rotation)
  const startDistance = planeDistance(start, anchor);
  const currentDistance = planeDistance(current, anchor);

  // Compute the scale from the rate of change of the distance
  // Note: for a small feature (Text and so on) startDistance becomes a very small value, so
  // only a distance of exactly zero is left alone
  let uniformScale = 1;
  if (startDistance > 0) {
    uniformScale = currentDistance / startDistance;
  }

  // Limit the minimum scale
  uniformScale = Math.max(uniformScale, 0.1);

  // The scale along the axes (for non-rotated features)
  // Compute the amount of movement
  const dx = current[0] - start[0];
  const dy = current[1] - start[1];

  // The size of the bounding box (valid only when it is not rotated). A box thinner than the
  // caller's minimum extent (a screen distance) is not stretched along that axis, because the
  // division would turn a pixel of pointer movement into a huge scale
  const topLeft = toPlane(startBbox.topLeft);
  const bboxWidth = Math.abs(toPlane(startBbox.topRight)[0] - topLeft[0]);
  const bboxHeight = Math.abs(topLeft[1] - toPlane(startBbox.bottomLeft)[1]);
  const minExtent = Math.max(0, state.minAxisExtent ?? 0);

  let scaleX = 1;
  let scaleY = 1;

  if (scaleDirectionX !== 0 && bboxWidth > minExtent) {
    scaleX = 1 + (scaleDirectionX * dx) / bboxWidth;
  }
  if (scaleDirectionY !== 0 && bboxHeight > minExtent) {
    scaleY = 1 + (scaleDirectionY * dy) / bboxHeight;
  }

  // Limit the minimum scale
  scaleX = Math.max(scaleX, 0.1);
  scaleY = Math.max(scaleY, 0.1);

  // Compute the new coordinates of each feature
  const result = new Map<string, ResizeResult>();

  for (const feature of features) {
    const initialCoords = state.initialCoordinates.get(feature.id);
    if (!initialCoords) continue;

    // Use the custom resize calculator first if there is one
    const customCalculator = extensions?.getCustomResizeCalculator(feature.type);
    if (customCalculator) {
      const customResult = customCalculator(handle, state, currentLngLat, feature);
      if (customResult) {
        result.set(feature.id, {
          coordinates: customResult.coordinates,
          width: customResult.width,
          height: customResult.height,
        });
        continue;
      }
    }

    // Which features scale by property was decided when the resize started (initialScales)
    if (state.initialScales.has(feature.id)) {
      // For a feature that has a scale property:
      // with the anchor as the fixed point, scale the center coordinate too and change scale
      const initialScale = state.initialScales.get(feature.id) ?? 1;
      const newScale = initialScale * uniformScale;
      const newCoords = scaleCoordinates(initialCoords, anchor, uniformScale, uniformScale);
      result.set(feature.id, {
        coordinates: newCoords,
        scale: newScale,
      });
    } else if (feature.type === 'Circle') {
      // For a Circle: scale the center coordinate and scale the radius too
      const initialRadius = state.initialRadiusMeters.get(feature.id) ?? 0;
      const newRadius = initialRadius * uniformScale;
      const newCoords = scaleCoordinates(initialCoords, anchor, uniformScale, uniformScale);
      result.set(feature.id, {
        coordinates: newCoords,
        radiusMeters: newRadius,
      });
    } else {
      // For Point, LineString, Polygon and Freehand: change only the coordinates
      const newCoords = scaleCoordinates(initialCoords, anchor, scaleX, scaleY);
      result.set(feature.id, { coordinates: newCoords });
    }
  }

  return result;
}

/**
 * Starts the resize operation
 *
 * @param extensions The draw instance's extension points (resize strategies of custom types)
 * @param minAxisExtent The extent of the bounding box (Web Mercator world units) below which
 *   it is not stretched along that axis; the caller converts a screen distance at its zoom
 *
 * @internal
 */
export function startResize(
  handle: HandleType,
  startLngLat: { lng: number; lat: number },
  bbox: BoundingBoxCoords,
  features: Feature[],
  extensions?: ResizeExtensions,
  minAxisExtent = 0,
): ResizeState {
  const initialCoordinates = new Map<string, FeatureCoordinates>();
  const initialScales = new Map<string, number>();
  const initialRadiusMeters = new Map<string, number>();
  const initialWidth = new Map<string, number>();
  const initialHeight = new Map<string, number>();

  for (const feature of features) {
    initialCoordinates.set(feature.id, JSON.parse(JSON.stringify(feature.coordinates)));

    // For a feature that has a scale property, store the initial scale
    if (hasScaleProperty(feature, extensions)) {
      initialScales.set(feature.id, getFeatureScale(feature));
    }

    // For a Circle, store the initial radius
    if (feature.type === 'Circle') {
      const radiusMeters = getCircleRadius(feature);
      initialRadiusMeters.set(feature.id, radiusMeters ?? 0);
    }

    // For a feature that has width / height properties (Note and so on), store the initial size
    const props = feature.properties as Record<string, unknown>;
    if (typeof props.width === 'number') {
      initialWidth.set(feature.id, props.width);
    }
    if (typeof props.height === 'number') {
      initialHeight.set(feature.id, props.height);
    }
  }

  return {
    handle,
    startLngLat,
    startBbox: bbox,
    initialCoordinates,
    initialScales,
    initialRadiusMeters,
    initialWidth,
    initialHeight,
    minAxisExtent,
  };
}
