// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Classification of the Store features into runs
 *
 * A run is a sequence of features that the BatchManager of immediate mode would draw in one
 * batch. Cutting the feature list where the kind changes keeps the z-order of retained mode
 * identical to immediate mode.
 */

import { coordinatesOf } from '../../shared/utils/coordinates.js';
import type { Coordinate, Feature, Layer } from '../../store/types.js';
import type { FeatureCompanionRegistry } from '../feature-companion.js';
import { type PointShape, toInstancedPointShape } from '../renderers/point/point-instance.js';
import type { RetainedStyleResolver } from '../renderers/retained.js';

/**
 * Kind of a run
 *
 * It is matched with the unit at which the BatchManager of immediate mode flushes a batch (the
 * batch kind and the point shape). A position where the kind changes becomes a run boundary.
 */
export type RunKind = 'polygon' | 'line' | `point-${PointShape}` | 'immediate';

/**
 * Classifies a feature into the kind of its run
 *
 * It copies the batch kinds, the flush rules and the fallback rules of immediate mode
 * (BatchManager.processFeature) as they are. If this drifts from immediate mode the z-order
 * breaks, so keep the conditions here in one-to-one correspondence with the immediate-mode side.
 *
 * @param customTypes Renderers of the custom feature types (a registered type is drawn at once)
 * @param layer The layer it belongs to (used to evaluate the style rules)
 */
export function classifyFeature(
  feature: Feature,
  styles: RetainedStyleResolver,
  customTypes: ReadonlyMap<string, unknown>,
  companions: FeatureCompanionRegistry,
  layer?: Layer,
): RunKind {
  // A custom type is drawn immediately (it cannot go on a core batch)
  if (customTypes.has(feature.type)) return 'immediate';

  // A feature that has a companion (feature companion) needs a hook right before it, so it cannot
  // go on a retained batch. It is split out into an immediate chunk and drawn one at a time (on
  // the assumption that features with a companion are few; if no provider at all is registered
  // this test is false in O(1)).
  if (companions.has(feature)) return 'immediate';

  switch (feature.type) {
    case 'Point':
    case 'MultiPoint': {
      const shape = toInstancedPointShape(styles.getPointStyle(feature, layer).shape);
      // A shape without instancing support is drawn immediately, one point at a time
      return shape ? `point-${shape}` : 'immediate';
    }
    case 'LineString':
    case 'Freehand':
    case 'MultiLineString': {
      const strokeStyle = styles.getLineStringStrokeStyle(feature, layer);
      // Dashed and dotted lines cannot be retained because their CPU-side splitting depends on
      // the zoom
      return strokeStyle.lineStyle === 'solid' ? 'line' : 'immediate';
    }
    case 'Polygon':
    case 'MultiPolygon':
    case 'Circle': {
      const { strokeStyle } = styles.getPolygonStyles(feature, layer);
      // Only a dashed outline cannot be retained (fill only and a solid outline can be)
      if (strokeStyle.opacity > 0 && strokeStyle.lineStyle !== 'solid') return 'immediate';
      return 'polygon';
    }
    default:
      // Kinds that retained mode does not handle, such as Image
      return 'immediate';
  }
}

/**
 * Origin of the relative coordinates of a chunk (the representative coordinate of the first
 * feature)
 */
export function featureOrigin(feature: Feature | undefined): [number, number] {
  if (!feature) return [0, 0];

  switch (feature.type) {
    case 'MultiPoint': {
      const coord = (coordinatesOf(feature) as Coordinate[])[0];
      return coord ? [coord[0], coord[1]] : [0, 0];
    }
    case 'LineString':
    case 'Freehand': {
      const coord = (coordinatesOf(feature) as Coordinate[])[0];
      return coord ? [coord[0], coord[1]] : [0, 0];
    }
    case 'MultiLineString': {
      const coord = (coordinatesOf(feature) as Coordinate[][])[0]?.[0];
      return coord ? [coord[0], coord[1]] : [0, 0];
    }
    case 'Polygon': {
      const coord = (coordinatesOf(feature) as Coordinate[][])[0]?.[0];
      return coord ? [coord[0], coord[1]] : [0, 0];
    }
    case 'MultiPolygon': {
      const coord = (coordinatesOf(feature) as Coordinate[][][])[0]?.[0]?.[0];
      return coord ? [coord[0], coord[1]] : [0, 0];
    }
    default: {
      // A single coordinate, such as Point / Circle
      const coord = coordinatesOf(feature) as Coordinate;
      return Array.isArray(coord) && typeof coord[0] === 'number' ? [coord[0], coord[1]] : [0, 0];
    }
  }
}
