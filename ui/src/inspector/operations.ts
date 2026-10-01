// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The operations on the features selected, and which of them apply.
//
// They are core's (draw.features.union and the rest), which check the features again and throw
// on any they do not take; the interface only offers an operation for features it would take:
//
// - union and intersection: two areas or more (Polygon, MultiPolygon, or a Circle with a radius)
// - difference: two areas or more, the first selected minus the others
// - split: one area and one line (LineString, MultiLineString or Freehand) to cut it along
// - buffer: one feature or more, each a point, a line or an area (not a freehand line, an image
//   or a custom type, which core does not buffer)
//
// The features an operation makes become the selection.

import type { Feature } from '@sakuzu/maplibre-gl-draw';
import type { InspectorDraw, Units } from './types.js';

/** An operation on the features selected */
export type OperationId = 'union' | 'intersection' | 'difference' | 'split' | 'buffer';

/** The operations, in the order they are offered */
export const OPERATION_IDS: readonly OperationId[] = Object.freeze([
  'union',
  'intersection',
  'difference',
  'split',
  'buffer',
]);

const RADIUS_KEY = 'maplibre-gl-draw:radiusMeters';

function hasRadius(feature: Pick<Feature, 'properties'>): boolean {
  const r = feature.properties?.[RADIUS_KEY];
  return typeof r === 'number' && r > 0;
}

/** Whether a feature is an area that union, intersection, difference and split take */
export function isArea(feature: Pick<Feature, 'type' | 'properties'>): boolean {
  if (feature.type === 'Circle') return hasRadius(feature);
  return feature.type === 'Polygon' || feature.type === 'MultiPolygon';
}

/** Whether a feature is a line that a split cuts along */
export function isCuttingLine(feature: Pick<Feature, 'type'>): boolean {
  return (
    feature.type === 'LineString' ||
    feature.type === 'MultiLineString' ||
    feature.type === 'Freehand'
  );
}

const BUFFERABLE = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString']);

/** Whether a feature is one that buffer takes */
export function isBufferable(feature: Pick<Feature, 'type' | 'properties'>): boolean {
  return isArea(feature) || BUFFERABLE.has(feature.type);
}

/** The area and the line of a split, or null when the features are not one of each */
export function splitPair<T extends Pick<Feature, 'type' | 'properties'>>(
  features: readonly T[],
): { area: T; line: T } | null {
  if (features.length !== 2) return null;
  const [a, b] = features;
  if (isArea(a) && isCuttingLine(b)) return { area: a, line: b };
  if (isArea(b) && isCuttingLine(a)) return { area: b, line: a };
  return null;
}

/** The operations that apply to features, in order */
export function applicableOperations(
  features: readonly Pick<Feature, 'type' | 'properties'>[],
): OperationId[] {
  const out: OperationId[] = [];
  const areas = features.length >= 2 && features.every(isArea);
  if (areas) out.push('union', 'intersection', 'difference');
  if (splitPair(features)) out.push('split');
  if (features.length >= 1 && features.every(isBufferable)) out.push('buffer');
  return out;
}

/** The units of the distance of a buffer */
export type DistanceUnit = 'm' | 'km' | 'ft' | 'mi';

/** The units of the distance offered for a system of units, the first being the default */
export function distanceUnits(units: Units): DistanceUnit[] {
  return units === 'imperial' ? ['ft', 'mi'] : ['m', 'km'];
}

const METERS: Record<DistanceUnit, number> = { m: 1, km: 1000, ft: 0.3048, mi: 1609.344 };

/** A distance in meters */
export function toMeters(value: number, unit: DistanceUnit): number {
  return value * METERS[unit];
}

/** Selects the features an operation made, when it made any */
function selectResults(draw: InspectorDraw, features: readonly Feature[] | null): string[] | null {
  if (!features) return null;
  const ids = features.map((f) => f.id);
  if (ids.length > 0) draw.selection.set('feature', ids);
  return ids;
}

/**
 * Runs union, intersection, difference or split on features, and selects what it made
 *
 * @param features - The features, in the order of the selection (difference subtracts the
 *   others from the first)
 * @returns The IDs of the features made (empty when the line did not cut the area), or null when
 *   core refused the operation (read-only, a lock) or its result is empty
 * @throws `DrawError` of core when the features do not suit the operation
 */
export function runOperation(
  draw: InspectorDraw,
  op: Exclude<OperationId, 'buffer'>,
  features: readonly Feature[],
): string[] | null {
  const ids = features.map((f) => f.id);
  return draw.transact(() => {
    switch (op) {
      case 'union': {
        const made = draw.features.union(ids);
        return selectResults(draw, made ? [made] : null);
      }
      case 'intersection': {
        const made = draw.features.intersection(ids);
        return selectResults(draw, made ? [made] : null);
      }
      case 'difference': {
        const [first, ...rest] = ids;
        const made = draw.features.difference(first, rest);
        return selectResults(draw, made ? [made] : null);
      }
      case 'split': {
        const pair = splitPair(features);
        if (!pair) return null;
        return selectResults(draw, draw.features.split(pair.area.id, pair.line.id));
      }
    }
  });
}

/**
 * Makes the buffers of features and selects them
 *
 * @param distanceMeters - The distance of the outline from the features, in meters
 * @param segments - The segments of a full circle; core's default when left out
 * @returns The IDs of the features made, or null when core refused the operation
 * @throws `DrawError` of core when a feature cannot be buffered or the distance is not finite
 */
export function runBuffer(
  draw: InspectorDraw,
  features: readonly Feature[],
  distanceMeters: number,
  segments?: number,
): string[] | null {
  const ids = features.map((f) => f.id);
  const options = segments === undefined ? { distanceMeters } : { distanceMeters, segments };
  return draw.transact(() => selectResults(draw, draw.features.buffer(ids, options)));
}
