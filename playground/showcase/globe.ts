// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The globe scene: the drawing on the globe projection
 *
 * The map in maplibre's globe projection, zoomed out until the earth is a sphere. Long
 * routes between continents (great circles), a large box between two meridians and two
 * parallels, a geodesic circle, places and an image all lie on the sphere and bend with it;
 * the route that runs past the edge of the sphere goes behind it. An edge between two vertices
 * follows the path it takes on the Mercator map, so the box is given by its four corners and
 * its edges run along the meridians and the parallels.
 */

import type * as maplibregl from 'maplibre-gl';

import { buildDocument, drawImage, greatCircle, type ShowcaseScene } from './scene';

const PLACES = {
  tokyo: [139.69, 35.69],
  london: [-0.13, 51.51],
  perth: [115.86, -31.95],
  singapore: [103.82, 1.35],
  dubai: [55.27, 25.2],
  newYork: [-74.01, 40.71],
} satisfies Record<string, [number, number]>;

export const globeScene: ShowcaseScene = {
  basemap: 'https://tiles.openfreemap.org/styles/liberty',
  camera: { center: [100, 26], zoom: 1.85 },
  mapOnly: true,
  async load({ draw, map }) {
    setUpGlobe(map);
    await draw.load(createDocument());
  },
};

function setUpGlobe(map: maplibregl.Map): void {
  map.setProjection({ type: 'globe' });
  map.setSky({ 'atmosphere-blend': 1 });
  map.getContainer().classList.add('showcase-space');
}

function createDocument() {
  return buildDocument(
    'Globe',
    [
      {
        id: 'layer-areas',
        name: 'Areas',
        features: [
          {
            id: 'monsoon-box',
            type: 'Polygon',
            geometry: { type: 'Polygon', coordinates: [lngLatBox(50, 5, 100, 38)] },
            properties: { name: 'Box from 50°E to 100°E, 5°N to 38°N' },
            style: {
              fillColor: '#FF7B00',
              fillOpacity: 0.55,
              strokeColor: '#FF7B00',
              strokeWidth: 3,
              strokeOpacity: 1,
            },
          },
          {
            id: 'tokyo-range',
            type: 'Circle',
            geometry: { type: 'Point', coordinates: PLACES.tokyo },
            properties: { name: '2,500 km from Tokyo', 'maplibre-gl-draw:radiusMeters': 2_500_000 },
            style: {
              fillColor: '#3A86FF',
              fillOpacity: 0.35,
              strokeColor: '#3A86FF',
              strokeWidth: 2.5,
              strokeOpacity: 1,
            },
          },
          {
            id: 'storm',
            type: 'Image',
            geometry: { type: 'Point', coordinates: [131, 16] },
            properties: {
              name: 'Storm',
              'maplibre-gl-draw:createdZoom': 3,
              'maplibre-gl-draw:imageFileId': 'file-storm',
              'maplibre-gl-draw:imageWidth': 150,
              'maplibre-gl-draw:imageHeight': 150,
            },
            style: { imageOpacity: 0.95 },
          },
        ],
      },
      {
        id: 'layer-routes',
        name: 'Routes',
        features: [
          route('tokyo-london', PLACES.tokyo, PLACES.london, '#FF006E', 'solid'),
          route('singapore-new-york', PLACES.singapore, PLACES.dubai, '#8338EC', 'solid', [
            PLACES.london,
            PLACES.newYork,
          ]),
          route('tokyo-perth', PLACES.tokyo, PLACES.perth, '#FF006E', 'dashed'),
          route('dubai-perth', PLACES.dubai, PLACES.perth, '#8338EC', 'dotted'),
        ],
      },
      {
        id: 'layer-places',
        name: 'Places',
        features: Object.entries(PLACES).map(([name, coordinates]) => ({
          id: `place-${name}`,
          type: 'Point' as const,
          geometry: { type: 'Point' as const, coordinates },
          properties: { name },
          style:
            name === 'tokyo'
              ? { pointShape: 'star' as const, pointColor: '#FFD000', pointRadius: 13 }
              : { pointColor: '#FF006E', pointRadius: 7 },
        })),
      },
    ],
    [{ id: 'file-storm', mimeType: 'image/png', dataURL: storm() }],
  );
}

/** The ring of a box between two meridians and two parallels: its four corners */
function lngLatBox(west: number, south: number, east: number, north: number): [number, number][] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/** A route along great circles through the given places */
function route(
  id: string,
  from: [number, number],
  to: [number, number],
  strokeColor: string,
  lineStyle: 'solid' | 'dashed' | 'dotted',
  then: [number, number][] = [],
) {
  const stops = [from, to, ...then];
  const coordinates: [number, number][] = [];
  for (let i = 1; i < stops.length; i++) {
    const leg = greatCircle(stops[i - 1], stops[i]);
    coordinates.push(...(i === 1 ? leg : leg.slice(1)));
  }
  return {
    id,
    type: 'LineString' as const,
    geometry: { type: 'LineString' as const, coordinates },
    properties: { name: id },
    style: { strokeColor, strokeWidth: 4, strokeOpacity: 1, lineStyle },
  };
}

/** A made-up picture of a storm seen from above: a white spiral around an eye */
function storm(): string {
  return drawImage(256, 256, (context) => {
    const glow = context.createRadialGradient(128, 128, 8, 128, 128, 128);
    glow.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    glow.addColorStop(0.55, 'rgba(235, 242, 255, 0.7)');
    glow.addColorStop(1, 'rgba(235, 242, 255, 0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, 256, 256);

    context.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    context.lineCap = 'round';
    for (let arm = 0; arm < 3; arm++) {
      context.lineWidth = 14;
      context.beginPath();
      for (let t = 0; t <= 1; t += 0.02) {
        const angle = arm * ((2 * Math.PI) / 3) + t * 3.4;
        const radius = 14 + t * 108;
        const x = 128 + radius * Math.cos(angle);
        const y = 128 + radius * Math.sin(angle);
        if (t === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }

    context.fillStyle = '#1d3557';
    context.beginPath();
    context.arc(128, 128, 9, 0, 2 * Math.PI);
    context.fill();
  });
}
