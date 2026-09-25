// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Conversions from features to the data of a retained batch
 *
 * The same math as the collect functions of display: the style is resolved once at build time
 * and the result is baked into the vertex or instance data of the batch.
 */

import { generateCirclePolygon } from '../../shared/math/index.js';
import { getCircleRadius, getCreatedZoom } from '../../shared/utils/property.js';
import type { Coordinate, Feature, Layer } from '../../store/types.js';
import { toLineBatchItem, toPointInstanceData } from '../renderers/batch-manager.js';
import type { LineBatchItem } from '../renderers/line/line-types.js';
import type { PointInstanceDataFull } from '../renderers/point/point-instance.js';
import type { SDFPolygonBatchData } from '../renderers/polygon/sdf-polygon.js';
import type { RetainedStyleResolver } from '../renderers/retained.js';

/**
 * createdZoom of a fixed-width feature
 *
 * When the line width is expressed as a negative value the shader ignores createdZoom, so the
 * value itself has no meaning. It is a constant only to decide what goes into the array.
 */
const FIXED_WIDTH_CREATED_ZOOM = 0;

/**
 * Collects the items of a line batch
 *
 * A feature without createdZoom has to be drawn with a constant width on screen. u_zoom is per
 * batch, so a fixed width is expressed with a negative width (a convention of the shader). This
 * way fixed widths and variable widths can be mixed in the same batch and the z-order is kept.
 */
export function collectLineItems(
  features: Feature[],
  styles: RetainedStyleResolver,
  layer: Layer | undefined,
): LineBatchItem[] {
  const items: LineBatchItem[] = [];

  for (const feature of features) {
    const strokeStyle = styles.getLineStringStrokeStyle(feature, layer);
    const createdZoom = getCreatedZoom(feature);

    const push = (coords: Coordinate[] | undefined): void => {
      if (!coords || coords.length < 2) return;
      const item = toLineBatchItem(
        coords as Array<[number, number]>,
        feature.id,
        strokeStyle,
        createdZoom ?? FIXED_WIDTH_CREATED_ZOOM,
      );
      if (createdZoom === undefined) item.strokeWidth = -strokeStyle.width;
      items.push(item);
    };

    if (feature.type === 'MultiLineString') {
      for (const part of feature.coordinates as Coordinate[][]) push(part);
    } else {
      push(feature.coordinates as Coordinate[]);
    }
  }

  return items;
}

/**
 * Collects the data of a polygon batch
 *
 * A fill-only polygon is also pushed as an SDFPolygon without an outline (strokeOpacity = 0).
 * Immediate mode draws it with PolygonBatchRenderer, but the appearance of the fill is the same.
 */
export function collectPolygons(
  features: Feature[],
  styles: RetainedStyleResolver,
  layer: Layer | undefined,
): SDFPolygonBatchData[] {
  const polygons: SDFPolygonBatchData[] = [];

  for (const feature of features) {
    const { fillColor, strokeStyle } = styles.getPolygonStyles(feature, layer);
    const hasStroke = strokeStyle.opacity > 0 && strokeStyle.width > 0;
    const createdZoom = getCreatedZoom(feature);
    // The outline of a feature without createdZoom has a fixed width (the negative convention)
    const strokeWidth = hasStroke
      ? createdZoom === undefined
        ? -strokeStyle.width
        : strokeStyle.width
      : 0;

    const push = (rings: Coordinate[][] | undefined, partIndex: number): void => {
      const outerRing = rings?.[0];
      if (!rings || !outerRing || outerRing.length < 3) return;
      if (!hasStroke && fillColor[3] <= 0) return;

      polygons.push({
        coordinates: rings,
        style: {
          fillColor,
          fillOpacity: 1,
          strokeColor: strokeStyle.color,
          strokeWidth,
          strokeOpacity: hasStroke ? 1 : 0,
        },
        createdZoom: createdZoom ?? FIXED_WIDTH_CREATED_ZOOM,
        featureId: feature.id,
        partIndex,
      });
    };

    if (feature.type === 'MultiPolygon') {
      const parts = feature.coordinates as Coordinate[][][];
      for (let i = 0; i < parts.length; i++) push(parts[i], i);
    } else if (feature.type === 'Circle') {
      const radiusMeters = getCircleRadius(feature);
      if (!radiusMeters || radiusMeters <= 0) continue;
      push([generateCirclePolygon(feature.coordinates as Coordinate, radiusMeters)], 0);
    } else {
      push(feature.coordinates as Coordinate[][], 0);
    }
  }

  return polygons;
}

/**
 * Collects the data of the point instances
 */
export function collectPoints(
  features: Feature[],
  styles: RetainedStyleResolver,
  layer: Layer | undefined,
): PointInstanceDataFull[] {
  const points: PointInstanceDataFull[] = [];

  for (const feature of features) {
    const style = styles.getPointStyle(feature, layer);

    if (feature.type === 'MultiPoint') {
      for (const coord of feature.coordinates as Coordinate[]) {
        points.push(toPointInstanceData(coord, style));
      }
    } else {
      points.push(toPointInstanceData(feature.coordinates as Coordinate, style));
    }
  }

  return points;
}
