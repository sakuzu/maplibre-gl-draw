// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The targets of the geometry operations: which features each operation accepts, how a
 * feature is read as the input of the geometry module, and how the result is read back
 */

import type {
  AreaCoordinates,
  GeometryInput,
  MultiPolygonCoordinates,
} from '../../geometry/types.js';
import { generateCirclePolygon } from '../../shared/math/index.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { getCircleRadius } from '../../shared/utils/property.js';
import { getDisplayFeatures } from '../../store/local-visibility.js';
import { isFeatureLocked } from '../../store/lock.js';
import type { Store } from '../../store/store.js';
import type { Coordinate, Feature, FeatureCoordinates, FeatureType } from '../../store/types.js';

/**
 * Whether the feature can be a target of a boolean operation.
 *
 * The area types (Polygon / MultiPolygon / Circle) only. A Circle without a radius has no
 * area, so it is excluded from the targets.
 */
export function isAreaFeature(feature: Feature): boolean {
  if (feature.type === 'Circle') {
    const radiusMeters = getCircleRadius(feature);
    return radiusMeters !== undefined && radiusMeters > 0;
  }
  return feature.type === 'Polygon' || feature.type === 'MultiPolygon';
}

/**
 * Converts a feature into the area coordinates of the geometry module.
 *
 * A Circle is reduced to a ring with the default number of segments (64) of
 * generateCirclePolygon, the same as in the rendering (view/renderers/drawer.ts). An input
 * that has no area returns null.
 */
export function toAreaCoordinates(feature: Feature): AreaCoordinates | null {
  if (feature.type === 'Circle') {
    const radiusMeters = getCircleRadius(feature);
    if (radiusMeters === undefined || radiusMeters <= 0) return null;
    return [generateCirclePolygon(coordinatesOf(feature) as Coordinate, radiusMeters)];
  }
  if (feature.type === 'Polygon' || feature.type === 'MultiPolygon') {
    return coordinatesOf(feature) as AreaCoordinates;
  }
  return null;
}

/**
 * The feature types that can be the cutting side of a split.
 *
 * Only the types whose coordinates can be read as a polyline are accepted. The area types
 * cannot be a "cutting line" (cutting with a polygon is the job of punching out = subtract).
 */
const SPLIT_LINE_TYPES: ReadonlySet<string> = new Set([
  'LineString',
  'MultiLineString',
  'Freehand',
]);

/**
 * Whether the feature can be the cutting side of a split.
 */
export function isSplitLineFeature(feature: Feature): boolean {
  return SPLIT_LINE_TYPES.has(feature.type);
}

/**
 * Reduces a line feature to an array of polylines.
 *
 * A MultiLineString becomes one polyline per part. A type that cannot be the cutting side
 * returns an empty array.
 */
export function toSplitPaths(feature: Feature): Coordinate[][] {
  if (feature.type === 'MultiLineString') return coordinatesOf(feature) as Coordinate[][];
  if (isSplitLineFeature(feature)) return [coordinatesOf(feature) as Coordinate[]];
  return [];
}

/**
 * The feature types that are targets of the buffer.
 *
 * The types that can be reduced to the GeometryInput of the geometry module, plus Circle,
 * which is handled as a special case. The other types such as Freehand / Image / Text are
 * excluded from the targets because the meaning of their coordinates does not match a
 * geometry (an image is a rectangle, a text is an anchor point).
 */
const BUFFERABLE_TYPES: ReadonlySet<string> = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'Circle',
]);

/**
 * Whether the feature can be a target of the buffer.
 *
 * Only a Circle that has a radius is a target (a Circle without a radius has no starting
 * point to grow or shrink from).
 */
export function isBufferableFeature(feature: Feature): boolean {
  if (feature.type === 'Circle') {
    const radiusMeters = getCircleRadius(feature);
    return radiusMeters !== undefined && radiusMeters > 0;
  }
  return BUFFERABLE_TYPES.has(feature.type);
}

/**
 * Converts a feature into the GeometryInput of the geometry module.
 *
 * The shape of the coordinates matches the shape of the core Feature coordinates and is
 * GeoJSON compatible, so it can be passed by only re-typing it. A Circle is handled as a
 * special case (growing or shrinking the radius), so it is not converted here.
 */
export function toBufferGeometry(feature: Feature): GeometryInput | null {
  switch (feature.type) {
    case 'Point':
    case 'MultiPoint':
    case 'LineString':
    case 'MultiLineString':
    case 'Polygon':
    case 'MultiPolygon':
      return { type: feature.type, coordinates: coordinatesOf(feature) } as GeometryInput;
    default:
      return null;
  }
}

/**
 * Builds the type and coordinates of the feature to create from the MultiPolygon coordinates
 * returned by the geometry module.
 *
 * Polygon when there is one part, MultiPolygon when there are several. An empty array (no
 * area) returns null.
 */
export function toResultGeometry(
  parts: MultiPolygonCoordinates,
): { type: FeatureType; coordinates: FeatureCoordinates } | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return { type: 'Polygon', coordinates: parts[0] };
  return { type: 'MultiPolygon', coordinates: parts };
}

/** The IDs of the current feature selection (empty on a group or layer selection). */
export function currentSelectionIds(store: Store): string[] {
  const selection = store.getSelection();
  return selection.type === 'feature' ? selection.ids : [];
}

/**
 * Resolves the targets of an operation in z order (the head is the backmost, the tail is the
 * frontmost).
 *
 * The order follows getDisplayFeatures (= getOrderedFeatures with the locally hidden features
 * removed). That is "the order between the layers -> the order within a layer -> the
 * featureIds within a group", which is the draw order of core itself. Hidden features (both
 * the shared visible and the local hidden) do not appear in this list, so they are
 * automatically excluded from the targets here.
 * Locked features (the effective lock) are excluded explicitly.
 *
 * @param ids The target IDs. When undefined, the current selection
 * @param accept The acceptance test, on the type and so on
 */
export function resolveTargetFeatures(
  store: Store,
  ids: string[] | undefined,
  accept: (feature: Feature) => boolean,
): Feature[] {
  const wanted = ids ?? currentSelectionIds(store);
  if (wanted.length === 0) return [];

  const wantedIds = new Set(wanted);
  return getDisplayFeatures(store).filter(
    (feature) => wantedIds.has(feature.id) && accept(feature) && !isFeatureLocked(feature, store),
  );
}
