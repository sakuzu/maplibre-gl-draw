// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The terrain scene: the drawing lying on 3D terrain
 *
 * The Nordkette range above Innsbruck, seen from the south with the map's terrain on. An
 * area and an image on the slope, a trail climbing to the ridge, a straight dashed line
 * across the valley and markers on the stations and the summit: each follows the relief,
 * and the parts behind the ridge are hidden by it. The elevation comes from the same
 * Mapterhorn tiles as the terrain example, which also shade the relief.
 */

import type * as maplibregl from 'maplibre-gl';

import { DEM_TILES } from '../../examples/basemap.ts';
import { buildDocument, drawImage, type SceneLayer, type ShowcaseScene } from './scene';

const EXAGGERATION = 1.5;

export const terrainScene: ShowcaseScene = {
  basemap: 'https://tiles.openfreemap.org/styles/bright',
  camera: { center: [11.392, 47.2875], zoom: 12.9, pitch: 72, bearing: -12 },
  maxPitch: 85,
  mapOnly: true,
  async load({ draw, map }) {
    addTerrain(map);
    await draw.document.load(createDocument());
  },
};

/** The elevation, the terrain made from it, a hillshade and a sky */
function addTerrain(map: maplibregl.Map): void {
  map.addSource('showcase-dem', { type: 'raster-dem', url: DEM_TILES });
  // A source of its own for the hillshade, as maplibre recommends
  map.addSource('showcase-hillshade', { type: 'raster-dem', url: DEM_TILES });
  const firstSymbol = map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id;
  map.addLayer(
    {
      id: 'showcase-hillshade',
      type: 'hillshade',
      source: 'showcase-hillshade',
      paint: { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': '#473b24' },
    },
    firstSymbol,
  );
  map.setTerrain({ source: 'showcase-dem', exaggeration: EXAGGERATION });
  map.setSky({
    'sky-color': '#9cc8ee',
    'horizon-color': '#e4eef7',
    'sky-horizon-blend': 0.6,
    'fog-color': '#e4eef7',
    'fog-ground-blend': 0.8,
    'horizon-fog-blend': 0.6,
  });
}

/** The layers of the scene, from the back */
export const TERRAIN_LAYERS: SceneLayer[] = [
  {
    id: 'layer-areas',
    name: 'Areas',
    features: [
      {
        id: 'survey-map',
        type: 'Image',
        geometry: { type: 'Point', coordinates: [11.4265, 47.3005] },
        properties: {
          name: 'Survey map',
          'maplibre-gl-draw:createdZoom': 13,
          'maplibre-gl-draw:imageFileId': 'file-survey',
          'maplibre-gl-draw:imageWidth': 480,
          'maplibre-gl-draw:imageHeight': 375,
        },
        style: { imageOpacity: 0.9 },
      },
      {
        id: 'forest-plot',
        type: 'Polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [11.333, 47.2835],
              [11.3615, 47.2825],
              [11.3745, 47.2925],
              [11.371, 47.3035],
              [11.3455, 47.3075],
              [11.33, 47.2975],
              [11.333, 47.2835],
            ],
          ],
        },
        properties: { name: 'Forest plot' },
        style: {
          fillColor: '#FF006E',
          fillOpacity: 0.45,
          strokeColor: '#C9004F',
          strokeWidth: 3,
          strokeOpacity: 1,
        },
      },
    ],
  },
  {
    id: 'layer-routes',
    name: 'Routes',
    features: [
      {
        id: 'meridian',
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [11.358, 47.255],
            [11.358, 47.328],
          ],
        },
        properties: { name: 'Straight line north' },
        style: { strokeColor: '#1D4ED8', strokeWidth: 3.5, lineStyle: 'dashed' },
      },
      {
        id: 'trail',
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [11.3995, 47.2862],
            [11.3925, 47.2905],
            [11.3985, 47.2945],
            [11.3885, 47.2985],
            [11.3945, 47.3018],
            [11.3835, 47.3045],
            [11.3862, 47.3122],
            [11.3905, 47.3262],
          ],
        },
        properties: { name: 'Trail' },
        style: { strokeColor: '#FF7B00', strokeWidth: 5, strokeOpacity: 1 },
      },
    ],
  },
  {
    id: 'layer-places',
    name: 'Places',
    features: [
      point('hungerburg', [11.3995, 47.2862], 'square', '#1D4ED8', 9),
      point('seegrube', [11.3835, 47.3045], 'circle', '#FF7B00', 10),
      point('hafelekar', [11.3862, 47.3122], 'star', '#FFD000', 16),
    ],
  },
];

function createDocument() {
  return buildDocument('Terrain', TERRAIN_LAYERS, [
    { id: 'file-survey', mimeType: 'image/png', dataURL: surveyMap() },
  ]);
}

function point(
  id: string,
  coordinates: [number, number],
  pointShape: 'circle' | 'square' | 'star',
  pointColor: string,
  pointRadius: number,
) {
  return {
    id,
    type: 'Point' as const,
    geometry: { type: 'Point' as const, coordinates },
    properties: { name: id },
    style: { pointShape, pointColor, pointRadius },
  };
}

/** A made-up survey sheet: a colored field under a grid, so that the drape shows in its lines */
function surveyMap(): string {
  return drawImage(512, 400, (context) => {
    const field = context.createLinearGradient(0, 0, 512, 400);
    field.addColorStop(0, '#ffe066');
    field.addColorStop(0.5, '#f4a261');
    field.addColorStop(1, '#e63946');
    context.fillStyle = field;
    context.fillRect(0, 0, 512, 400);

    context.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    context.lineWidth = 3;
    for (let x = 32; x < 512; x += 64) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, 400);
      context.stroke();
    }
    for (let y = 40; y < 400; y += 64) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(512, y);
      context.stroke();
    }

    context.strokeStyle = '#3d1f00';
    context.lineWidth = 10;
    context.strokeRect(5, 5, 502, 390);
  });
}
