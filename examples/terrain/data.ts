// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The drawing of the terrain example, in the native format of the library: an area and an
// image on the slope of the Nordkette above Innsbruck, a trail climbing to the ridge, a straight
// dashed line across the valley and markers on the stations and the summit. Each follows the
// relief, and the parts behind the ridge are hidden by it.
import type { DrawDocument, Feature, FileData } from '@sakuzu/maplibre-gl-draw';

type SceneFeature = Pick<Feature, 'id' | 'type' | 'geometry' | 'style' | 'properties'>;

export interface SceneLayer {
  id: string;
  name: string;
  features: SceneFeature[];
}

/** The id of the image file the survey map refers to */
export const SURVEY_FILE_ID = 'file-survey';

/** The layers of the drawing, listed from the back */
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
          'maplibre-gl-draw:imageFileId': SURVEY_FILE_ID,
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
      point('Hungerburg', [11.3995, 47.2862], 'square', '#1D4ED8', 9),
      point('Seegrube', [11.3835, 47.3045], 'circle', '#FF7B00', 10),
      point('Hafelekar', [11.3862, 47.3122], 'star', '#FFD000', 16),
    ],
  },
];

function point(
  name: string,
  coordinates: [number, number],
  pointShape: 'circle' | 'square' | 'star',
  pointColor: string,
  pointRadius: number,
): SceneFeature {
  return {
    id: name.toLowerCase(),
    type: 'Point',
    geometry: { type: 'Point', coordinates },
    properties: { name },
    style: { pointShape, pointColor, pointRadius },
  };
}

/** Builds a document in the native format from layers listed from the back */
export function buildDocument(
  title: string,
  layers: SceneLayer[],
  files: FileData[],
): DrawDocument {
  return {
    version: '3.0.0',
    metadata: { title },
    layerOrder: layers.map((layer) => layer.id),
    layers: layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      visible: true,
      locked: false,
      opacity: 1,
      items: layer.features.map((feature) => feature.id),
      styleRule: undefined,
      metadata: undefined,
    })),
    features: layers.flatMap((layer) =>
      layer.features.map((feature) => ({
        ...feature,
        layerId: layer.id,
        groupId: undefined,
        visible: true,
        locked: false,
      })),
    ),
    files: Object.fromEntries(files.map((file) => [file.id, file])),
  };
}
