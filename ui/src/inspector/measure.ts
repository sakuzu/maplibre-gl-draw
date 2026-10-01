// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The measurements of a feature, written in metric or imperial units.
//
// Lengths and areas come from core's geometry entry (meters and square meters on the sphere); a
// circle, whose geometry is its center, is measured from its radius. A Multi geometry gives the
// totals of its parts.
//
// Units: a length is in meters below 1 000 m and in kilometers from there; an area in square
// meters below 1 ha (10 000 m²), in hectares below 1 km², and in square kilometers from there.
// In imperial units a length is in feet below 1 mile (5 280 ft), an area in square feet below
// 1 acre (43 560 ft²), in acres below 1 square mile (640 ac), and in square miles from there.
// The small unit is written with at most one decimal, the large ones with two.

import type { Feature } from '@sakuzu/maplibre-gl-draw';
import { area, length, perimeter } from '@sakuzu/maplibre-gl-draw/geometry';
import type { Units } from './types.js';

/** What a row of the measurements is */
export type MeasureKey =
  | 'longitude'
  | 'latitude'
  | 'length'
  | 'area'
  | 'perimeter'
  | 'radius'
  | 'points';

/** A row of the measurements: what it is and the value, written out */
export interface MeasureRow {
  key: MeasureKey;
  value: string;
}

const FOOT = 0.3048;
const FEET_PER_MILE = 5280;
const SQUARE_FOOT = FOOT * FOOT;
const SQUARE_FEET_PER_ACRE = 43_560;
const ACRES_PER_SQUARE_MILE = 640;

/** The property of core that holds the radius of a circle, in meters */
const RADIUS_KEY = 'maplibre-gl-draw:radiusMeters';

function number(value: number, locale: string, digits: { min: number; max: number }): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits.min,
    maximumFractionDigits: digits.max,
  }).format(value);
}

const SMALL = { min: 0, max: 1 };
const LARGE = { min: 2, max: 2 };

/** A length in meters, written in the units */
export function formatLength(meters: number, units: Units, locale = 'en'): string {
  if (units === 'imperial') {
    const feet = meters / FOOT;
    if (feet < FEET_PER_MILE) return `${number(feet, locale, SMALL)} ft`;
    return `${number(feet / FEET_PER_MILE, locale, LARGE)} mi`;
  }
  if (meters < 1000) return `${number(meters, locale, SMALL)} m`;
  return `${number(meters / 1000, locale, LARGE)} km`;
}

/** An area in square meters, written in the units */
export function formatArea(squareMeters: number, units: Units, locale = 'en'): string {
  if (units === 'imperial') {
    const squareFeet = squareMeters / SQUARE_FOOT;
    if (squareFeet < SQUARE_FEET_PER_ACRE) return `${number(squareFeet, locale, SMALL)} ft²`;
    const acres = squareFeet / SQUARE_FEET_PER_ACRE;
    if (acres < ACRES_PER_SQUARE_MILE) return `${number(acres, locale, LARGE)} ac`;
    return `${number(acres / ACRES_PER_SQUARE_MILE, locale, LARGE)} mi²`;
  }
  if (squareMeters < 10_000) return `${number(squareMeters, locale, SMALL)} m²`;
  if (squareMeters < 1_000_000) return `${number(squareMeters / 10_000, locale, LARGE)} ha`;
  return `${number(squareMeters / 1_000_000, locale, LARGE)} km²`;
}

/** A longitude or a latitude in degrees, with six decimals */
export function formatDegrees(degrees: number, locale = 'en'): string {
  return `${number(degrees, locale, { min: 6, max: 6 })}°`;
}

/** The radius of a circle in meters, or undefined */
function radiusOf(feature: Feature): number | undefined {
  const r = feature.properties?.[RADIUS_KEY];
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : undefined;
}

/** Runs a measurement of core, which throws on a geometry it does not take */
function tryMeasure(run: () => number): number | undefined {
  try {
    const value = run();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The measurements of a feature: the coordinates of a point, the length of a line, the area and
 * the perimeter of an area (and the radius of a circle), the number of points of a MultiPoint.
 * An image and a custom type have none.
 *
 * @param feature - The feature
 * @param units - Metric or imperial
 * @param locale - The language tag the numbers are written in
 */
export function measure(feature: Feature, units: Units, locale = 'en'): MeasureRow[] {
  const { geometry } = feature;
  const len = (meters: number | undefined): MeasureRow[] =>
    meters === undefined ? [] : [{ key: 'length', value: formatLength(meters, units, locale) }];
  switch (feature.type) {
    case 'Point': {
      if (geometry.type !== 'Point') return [];
      const [lng, lat] = geometry.coordinates;
      return [
        { key: 'longitude', value: formatDegrees(lng, locale) },
        { key: 'latitude', value: formatDegrees(lat, locale) },
      ];
    }
    case 'MultiPoint': {
      if (geometry.type !== 'MultiPoint') return [];
      const count = new Intl.NumberFormat(locale).format(geometry.coordinates.length);
      return [{ key: 'points', value: count }];
    }
    case 'LineString':
    case 'MultiLineString':
    case 'Freehand':
      return len(tryMeasure(() => length(geometry as Parameters<typeof length>[0])));
    case 'Polygon':
    case 'MultiPolygon': {
      const a = tryMeasure(() => area(geometry as Parameters<typeof area>[0]));
      const p = tryMeasure(() => perimeter(geometry as Parameters<typeof perimeter>[0]));
      const rows: MeasureRow[] = [];
      if (a !== undefined) rows.push({ key: 'area', value: formatArea(a, units, locale) });
      if (p !== undefined) rows.push({ key: 'perimeter', value: formatLength(p, units, locale) });
      return rows;
    }
    case 'Circle': {
      const r = radiusOf(feature);
      if (r === undefined) return [];
      return [
        { key: 'area', value: formatArea(Math.PI * r * r, units, locale) },
        { key: 'perimeter', value: formatLength(2 * Math.PI * r, units, locale) },
        { key: 'radius', value: formatLength(r, units, locale) },
      ];
    }
    default:
      return [];
  }
}
