// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The chunks of the rows drawn by kind (where the program that draws the rows in one draw cannot
 * be made): a chunk is a run of rows of one kind, built into a retained batch of the renderer of
 * its kind (the polygons, the solid lines, the points of one shape) from the features of its rows
 * that are drawn, with the decisions the features are drawn by. Its rows hidden are left out, so
 * the chunk is built again when the state of one of its rows changes.
 */

import { generateCirclePolygon } from '../../shared/math/index.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { getCircleRadius, getCreatedZoom } from '../../shared/utils/property.js';
import type { Coordinate, Feature, Layer } from '../../store/types.js';
import { toLineBatchItem, toPointInstanceData } from '../renderers/batch-manager.js';
import type { LineBatchItem, RetainedLineBatch } from '../renderers/line/line-types.js';
import {
  type PointShape,
  type RetainedPointBatch,
  toInstancedPointShape,
} from '../renderers/point/point-instance.js';
import type {
  RetainedPolygonBatch,
  SDFPolygonBatchData,
} from '../renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import type { TableRunKind } from './table-partition.js';

/** The created zoom of a feature whose width is fixed on screen (the shader ignores it) */
const FIXED_WIDTH_CREATED_ZOOM = 0;

/**
 * The retained batch of a chunk drawn by kind
 *
 * @internal
 */
export type KindBatch =
  | { readonly kind: 'point'; readonly batch: RetainedPointBatch | null }
  | { readonly kind: 'line'; readonly batch: RetainedLineBatch | null }
  | { readonly kind: 'polygon'; readonly batch: RetainedPolygonBatch | null };

/**
 * Builds the retained batch of a run of one kind from the features of its rows drawn
 *
 * @returns The batch (null when the renderer cannot build it yet: it is built in a later frame)
 * @internal
 */
export function buildKindBatch(
  kind: TableRunKind,
  features: Feature[],
  layer: Layer | undefined,
  origin: [number, number],
  renderers: RetainedRendererSet,
): KindBatch | null {
  const styles = renderers.styles;
  if (kind === 'line') {
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
        for (const part of coordinatesOf(feature) as Coordinate[][]) push(part);
      } else {
        push(coordinatesOf(feature) as Coordinate[]);
      }
    }
    if (items.length === 0) return { kind: 'line', batch: null };
    const batch = renderers.line.buildRetainedBatch(items, { lineStyle: 'solid' }, { origin });
    return batch ? { kind: 'line', batch } : null;
  }
  if (kind === 'polygon') {
    const polygons: SDFPolygonBatchData[] = [];
    for (const feature of features) {
      const { fillColor, strokeStyle } = styles.getPolygonStyles(feature, layer);
      const hasStroke = strokeStyle.opacity > 0 && strokeStyle.width > 0;
      const createdZoom = getCreatedZoom(feature);
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
        const parts = coordinatesOf(feature) as Coordinate[][][];
        for (let i = 0; i < parts.length; i++) push(parts[i], i);
      } else if (feature.type === 'Circle') {
        const radiusMeters = getCircleRadius(feature);
        if (!radiusMeters || radiusMeters <= 0) continue;
        push([generateCirclePolygon(coordinatesOf(feature) as Coordinate, radiusMeters)], 0);
      } else {
        push(coordinatesOf(feature) as Coordinate[][], 0);
      }
    }
    if (polygons.length === 0) return { kind: 'polygon', batch: null };
    const batch = renderers.polygon.buildRetained(polygons, { origin });
    return batch ? { kind: 'polygon', batch } : null;
  }
  const shape: PointShape | null = kind.startsWith('point-')
    ? toInstancedPointShape(kind.slice('point-'.length))
    : null;
  if (!shape) return null;
  const points: ReturnType<typeof toPointInstanceData>[] = [];
  for (const feature of features) {
    const style = styles.getPointStyle(feature, layer);
    if (feature.type === 'MultiPoint') {
      for (const coord of coordinatesOf(feature) as Coordinate[]) {
        points.push(toPointInstanceData(coord, style));
      }
    } else {
      points.push(toPointInstanceData(coordinatesOf(feature) as Coordinate, style));
    }
  }
  if (points.length === 0) return { kind: 'point', batch: null };
  const batch = renderers.point.buildRetained(points, shape, { origin });
  return batch ? { kind: 'point', batch } : null;
}

/**
 * Releases the retained batch of a chunk drawn by kind
 *
 * @internal
 */
export function disposeKindBatch(batch: KindBatch, renderers: RetainedRendererSet): void {
  if (!batch.batch) return;
  if (batch.kind === 'point') renderers.point.disposeRetained(batch.batch);
  else if (batch.kind === 'line') renderers.line.disposeRetainedBatch(batch.batch);
  else renderers.polygon.disposeRetained(batch.batch);
}

/**
 * Draws the retained batch of a chunk drawn by kind
 *
 * @internal
 */
export function drawKindBatch(
  batch: KindBatch,
  renderers: RetainedRendererSet,
  zoom: number,
  projectionData: Parameters<RetainedRendererSet['point']['drawRetained']>[2],
  factors: Parameters<RetainedRendererSet['point']['drawRetained']>[3],
): void {
  if (!batch.batch) return;
  if (batch.kind === 'point') {
    renderers.point.drawRetained(batch.batch, zoom, projectionData, factors);
  } else if (batch.kind === 'line') {
    renderers.line.drawRetainedBatch(batch.batch, zoom, projectionData, factors);
  } else {
    renderers.polygon.drawRetained(
      batch.batch,
      zoom,
      projectionData,
      renderers.viewport(),
      factors,
    );
  }
}
