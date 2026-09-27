// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rotation operation
 *
 * The operation that rotates features. It rotates in Web Mercator (see mercator-plane.ts),
 * which is conformal, so the shape on the map is kept however large the feature is and however
 * often it is rotated. The extension points of the draw instance are passed in as an argument
 * ({@link RotateExtensions}).
 */

import { fromPlane, toPlane } from '../shared/math/mercator-plane.js';
import { getDrawProperty, hasDrawProperty } from '../shared/properties.js';
import type { BoundingBoxCoords } from '../shared/types/selection-box.js';
import { mapCoordinatesDeep } from '../shared/utils/coordinates.js';
import { getImageProperties } from '../shared/utils/property.js';
import type { Coordinate, Feature, FeatureCoordinates } from '../store/types.js';

/**
 * The extension points the rotation reads from the draw instance
 *
 * The draw instance's selection extension registry satisfies it.
 */
export interface RotateExtensions {
  getResizeStrategy(type: string): 'scale' | 'coordinates' | undefined;
}

/**
 * Decides whether a feature has a rotation property
 *
 * It covers Image, the custom feature types registered with resizeStrategy: 'scale' in the
 * draw instance's registry (they rotate through the rotation property even when it is not
 * set yet), and features that have a rotation property in properties.
 */
function hasRotationProperty(feature: Feature, extensions?: RotateExtensions): boolean {
  // Image is covered explicitly
  if (feature.type === 'Image') {
    return true;
  }
  // A custom type that scales (rather than rewriting its coordinates) rotates by property
  if (extensions?.getResizeStrategy(feature.type) === 'scale') {
    return true;
  }
  // Also covers features that have a rotation property in properties
  return (
    feature.properties !== null &&
    typeof feature.properties === 'object' &&
    hasDrawProperty(feature.properties, 'rotation')
  );
}

/**
 * Gets the value of the rotation property of a feature
 */
function getFeatureRotation(feature: Feature): number {
  if (feature.type === 'Image') {
    const props = getImageProperties(feature);
    return props.rotation ?? 0;
  }
  return getDrawProperty(feature, 'rotation') ?? 0;
}

/**
 * The result of the rotation
 */
export interface RotateResult {
  coordinates: FeatureCoordinates;
  /** The new rotation value of a feature that has a rotation property (degrees) */
  rotation?: number;
}

/**
 * The state of the rotation operation
 *
 * @internal
 */
export interface RotateState {
  /** The mouse coordinate at the start */
  startLngLat: { lng: number; lat: number };
  /** The angle at the start (radians) */
  startAngle: number;
  /** The center of the rotation */
  center: Coordinate;
  /** The feature coordinates at the start */
  initialCoordinates: Map<string, FeatureCoordinates>;
  /** The rotation of Text / Image at the start */
  initialRotations: Map<string, number>;
}

/**
 * Computes the angle of a point around the center (radians, counterclockwise from east, in
 * the transform plane)
 */
function computeAngle(center: Coordinate, point: { lng: number; lat: number }): number {
  const [cx, cy] = toPlane(center);
  const [px, py] = toPlane([point.lng, point.lat]);
  return Math.atan2(py - cy, px - cx);
}

/**
 * Rotates a coordinate around the center in the transform plane
 */
function rotateCoordinate(coord: Coordinate, center: Coordinate, angle: number): Coordinate {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const [cx, cy] = toPlane(center);
  const [x, y] = toPlane(coord);
  const dx = x - cx;
  const dy = y - cy;
  return fromPlane(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
}

/**
 * Rotates an array of coordinates
 *
 * It uses a common traversal that does not depend on the nesting depth, so Multi
 * geometries (a MultiPolygon is nested 4 levels deep) can be rotated as they are.
 */
function rotateCoordinates(
  coords: FeatureCoordinates,
  center: Coordinate,
  angle: number,
): FeatureCoordinates {
  return mapCoordinatesDeep(coords, (coord) => rotateCoordinate(coord, center, angle));
}

/**
 * Computes the rotation
 *
 * @internal
 */
export function computeRotation(
  state: RotateState,
  currentLngLat: { lng: number; lat: number },
  features: Feature[],
): Map<string, RotateResult> {
  const { startAngle, center } = state;

  // Compute the current angle
  const currentAngle = computeAngle(center, currentLngLat);

  // Compute the amount of rotation
  const deltaAngle = currentAngle - startAngle;

  // Compute the new coordinates of each feature
  const result = new Map<string, RotateResult>();

  // Decide whether there are only features with a rotation property (the case of a
  // single selection where the coordinates are not changed). Which features rotate by
  // property was decided when the rotation started (initialRotations)
  const byProperty = (f: Feature) => state.initialRotations.has(f.id);
  const rotationFeatures = features.filter(byProperty);
  const otherFeatures = features.filter((f) => !byProperty(f));
  const isSingleRotationFeature = rotationFeatures.length === 1 && otherFeatures.length === 0;

  for (const feature of features) {
    const initialCoords = state.initialCoordinates.get(feature.id);
    if (!initialCoords) continue;

    if (byProperty(feature)) {
      // For a feature that has a rotation property (Image, custom types and so on)
      // rotation is stored in degrees (because the rendering side expects degrees)
      const initialRotation = state.initialRotations.get(feature.id) ?? 0;
      const deltaAngleDeg = (deltaAngle * 180) / Math.PI;
      const newRotation = initialRotation + deltaAngleDeg;

      if (isSingleRotationFeature) {
        // For a single selection: leave the coordinates unchanged and change only rotation
        result.set(feature.id, {
          coordinates: initialCoords,
          rotation: newRotation,
        });
      } else {
        // For a multiple selection: rotate the coordinates too, around the center
        const newCoords = rotateCoordinates(initialCoords, center, deltaAngle);
        result.set(feature.id, {
          coordinates: newCoords,
          rotation: newRotation,
        });
      }
    } else {
      // Point, LineString, Polygon and so on: change only the coordinates
      const newCoords = rotateCoordinates(initialCoords, center, deltaAngle);
      result.set(feature.id, { coordinates: newCoords });
    }
  }

  return result;
}

/**
 * Starts the rotation operation
 *
 * @param extensions The draw instance's extension points (a custom type registered with
 *   resizeStrategy: 'scale' rotates through its rotation property)
 *
 * @internal
 */
export function startRotation(
  startLngLat: { lng: number; lat: number },
  bbox: BoundingBoxCoords,
  features: Feature[],
  extensions?: RotateExtensions,
): RotateState {
  const center = bbox.center;
  const startAngle = computeAngle(center, startLngLat);
  const initialCoordinates = new Map<string, FeatureCoordinates>();
  const initialRotations = new Map<string, number>();

  for (const feature of features) {
    initialCoordinates.set(feature.id, JSON.parse(JSON.stringify(feature.coordinates)));

    // For a feature that has a rotation property, store the initial rotation angle
    if (hasRotationProperty(feature, extensions)) {
      initialRotations.set(feature.id, getFeatureRotation(feature));
    }
  }

  return {
    startLngLat,
    startAngle,
    center,
    initialCoordinates,
    initialRotations,
  };
}

/**
 * Gets the rotation angle (for debugging)
 *
 * @internal
 */
export function getRotationDelta(
  state: RotateState,
  currentLngLat: { lng: number; lat: number },
): number {
  const currentAngle = computeAngle(state.center, currentLngLat);
  return currentAngle - state.startAngle;
}
