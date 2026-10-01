// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The sample data of globe: six cities, the routes between them along great circles, a box
// between two meridians and two parallels, a circle of 2,500 km around Tokyo (its airport by
// the bay), where a picture of a storm goes, and an area across the antimeridian. The features
// are listed by layer, from the back; the page puts them in the layers it makes.

import type { FeatureInput, Position } from '@sakuzu/maplibre-gl-draw';

/** The cities, as [longitude, latitude] */
export const CITIES = {
  Tokyo: [139.7798, 35.5494],
  London: [-0.13, 51.51],
  Perth: [115.86, -31.95],
  Singapore: [103.82, 1.35],
  Dubai: [55.27, 25.2],
  'New York': [-74.01, 40.71],
} satisfies Record<string, [number, number]>;

/**
 * The points of the great circle from `from` to `to`, one every 2 degrees of arc at most, by
 * spherical interpolation: a long line given as many short edges follows the shortest way over
 * the globe
 */
function greatCircle(from: [number, number], to: [number, number]): Position[] {
  const rad = Math.PI / 180;
  const toVector = ([lng, lat]: [number, number]) => [
    Math.cos(lat * rad) * Math.cos(lng * rad),
    Math.cos(lat * rad) * Math.sin(lng * rad),
    Math.sin(lat * rad),
  ];
  const [a, b] = [toVector(from), toVector(to)];
  const angle = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const steps = Math.max(1, Math.ceil(angle / rad / 2));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const [ka, kb] = [Math.sin((1 - t) * angle), Math.sin(t * angle)].map(
      (k) => k / Math.sin(angle),
    );
    const [x, y, z] = a.map((v, k) => ka * v + kb * b[k]);
    const round = (value: number) => Math.round(value * 1e5) / 1e5;
    return [round(Math.atan2(y, x) / rad), round(Math.atan2(z, Math.hypot(x, y)) / rad)];
  });
}

/** A route along great circles through the given cities, one after the other */
function route(
  name: string,
  stops: Array<keyof typeof CITIES>,
  strokeColor: string,
  lineStyle: 'solid' | 'dashed' | 'dotted',
): FeatureInput {
  const coordinates: Position[] = [];
  for (let i = 1; i < stops.length; i++) {
    const leg = greatCircle(CITIES[stops[i - 1]], CITIES[stops[i]]);
    coordinates.push(...(i === 1 ? leg : leg.slice(1)));
  }
  return {
    type: 'LineString',
    geometry: { type: 'LineString', coordinates },
    properties: { name },
    style: { strokeColor, strokeWidth: 4, lineStyle },
  };
}

/** The areas: the box, the circle around Tokyo and the area across the antimeridian */
export const AREAS: FeatureInput[] = [
  {
    // A box between two meridians and two parallels, given by its four corners: an edge
    // follows the path it takes on the flat map, so its edges run along them
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [50, 5],
          [100, 5],
          [100, 38],
          [50, 38],
          [50, 5],
        ],
      ],
    },
    properties: { name: 'Box from 50°E to 100°E, 5°N to 38°N' },
    style: { fillColor: '#ff7b00', fillOpacity: 0.55, strokeColor: '#ff7b00', strokeWidth: 3 },
  },
  {
    type: 'Circle',
    geometry: { type: 'Point', coordinates: CITIES.Tokyo },
    properties: { name: '2,500 km from Tokyo', 'maplibre-gl-draw:radiusMeters': 2_500_000 },
    style: { fillColor: '#3a86ff', fillOpacity: 0.35, strokeColor: '#3a86ff', strokeWidth: 2.5 },
  },
  {
    // Its longitudes run on past 180 instead of jumping to -180, as a shape drawn across the
    // line is kept; the GeoJSON written out wraps them
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [174, -21],
          [186, -21],
          [186, -12],
          [174, -12],
          [174, -21],
        ],
      ],
    },
    properties: { name: 'Across the antimeridian' },
    style: { fillColor: '#edae49', fillOpacity: 0.5, strokeColor: '#a86a00', strokeWidth: 2 },
  },
];

/** Where the picture of the storm is centered, and the zoom at which it has its size in pixels */
export const STORM = { center: [131, 16] as [number, number], zoom: 3, size: 150 };

/**
 * The routes along great circles, and the line from London to Tokyo with two vertices only,
 * whose one edge follows the straight line of the flat map
 */
export const ROUTES: FeatureInput[] = [
  route('Tokyo to London', ['Tokyo', 'London'], '#ff006e', 'solid'),
  route('Singapore to New York', ['Singapore', 'Dubai', 'London', 'New York'], '#8338ec', 'solid'),
  route('Tokyo to Perth', ['Tokyo', 'Perth'], '#ff006e', 'dashed'),
  route('Dubai to Perth', ['Dubai', 'Perth'], '#8338ec', 'dotted'),
  {
    type: 'LineString',
    geometry: { type: 'LineString', coordinates: [CITIES.London, CITIES.Tokyo] },
    properties: { name: 'Two vertices' },
    style: { strokeColor: '#30638e', strokeWidth: 2, lineStyle: 'dashed' },
  },
];

/** The cities, Tokyo as a star */
export const PLACES: FeatureInput[] = Object.entries(CITIES).map(([name, coordinates]) => ({
  type: 'Point',
  geometry: { type: 'Point', coordinates },
  properties: { name },
  style:
    name === 'Tokyo'
      ? { pointShape: 'star', pointColor: '#ffd000', pointRadius: 13 }
      : { pointColor: '#ff006e', pointRadius: 7 },
}));
