// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drawing of the overview scene, east of Tokyo Station (Kyobashi and Nihonbashi)
 *
 * What one layer of this library holds that a style layer of the map cannot: each feature
 * has a look of its own. The first layer mixes three areas (fill and outline in different
 * colors, a solid, a dashed and a dotted outline, 1, 3 and 6 px wide), three lines (1, 4 and
 * 10 px), points of the four shapes with an outline (in a group), a circle with a radius in
 * meters, a freehand stroke and an image. The second layer colors its parcels by a categorical
 * style rule, so the Legend tab of the standard UI lists it.
 *
 * Plain data, with nothing of the page: the test of the sample geometry imports it.
 */

import type { DrawDocument, Position, StyleRule } from '@sakuzu/maplibre-gl-draw';
import { buildDocument, type SceneFeature, type SceneLayer } from './scene';

/** The camera of the scene: the drawing fills the map between the panels of the standard UI */
export const OVERVIEW_CAMERA = { center: [139.7765, 35.6796] as [number, number], zoom: 15.2 };

/** The feature that is selected, to show its frame and handles in the inspector */
export const SELECTED_FEATURE = 'area-dashed';

/** The layer new drawings go into */
export const ACTIVE_LAYER = 'layer-drawing';

/** The ID of the embedded image */
const IMAGE_FILE = 'file-station';

/** The center of the drawing; the features are placed in meters east and north of it */
const ORIGIN: [number, number] = [139.7765, 35.6795];
const METERS_PER_DEGREE = 111_320;

/** A position `x` meters east and `y` meters north of the origin */
function at(x: number, y: number): [number, number] {
  const lng = ORIGIN[0] + x / (METERS_PER_DEGREE * Math.cos((ORIGIN[1] * Math.PI) / 180));
  const lat = ORIGIN[1] + y / METERS_PER_DEGREE;
  return [round(lng), round(lat)];
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** A closed ring through the given positions in meters */
function ring(points: [number, number][]): Position[] {
  const positions = points.map(([x, y]) => at(x, y));
  return [...positions, positions[0]];
}

/** The categorical rule of the second layer */
export const LAND_USE_RULE: StyleRule = {
  kind: 'categorical',
  property: 'use',
  map: {
    Residential: '#F4A261',
    Commercial: '#E63946',
    Park: '#2A9D8F',
    Civic: '#457B9D',
  },
  other: '#cccccc',
};

/** Three areas: the fill and the outline in different colors, three dash patterns and widths */
const AREAS: SceneFeature[] = [
  {
    id: 'area-solid',
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        ring([
          [-400, 220],
          [-190, 220],
          [-190, 430],
          [-400, 430],
        ]),
      ],
    },
    properties: { name: 'Solid outline, 1 px' },
    style: {
      fillColor: '#FFD166',
      fillOpacity: 0.55,
      strokeColor: '#9A6700',
      strokeWidth: 1,
      lineStyle: 'solid',
    },
  },
  {
    id: 'area-dashed',
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        ring([
          [-110, 210],
          [60, 225],
          [110, 330],
          [40, 440],
          [-100, 425],
          [-140, 320],
        ]),
      ],
    },
    properties: { name: 'Dashed outline, 3 px' },
    style: {
      fillColor: '#8ECAE6',
      fillOpacity: 0.5,
      strokeColor: '#1D4ED8',
      strokeWidth: 3,
      lineStyle: 'dashed',
    },
  },
  {
    id: 'area-dotted',
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        ring([
          [180, 210],
          [400, 245],
          [365, 440],
          [200, 420],
        ]),
      ],
    },
    properties: { name: 'Dotted outline, 6 px' },
    style: {
      fillColor: '#C77DFF',
      fillOpacity: 0.4,
      strokeColor: '#5A189A',
      strokeWidth: 6,
      lineStyle: 'dotted',
    },
  },
];

/** A gentle wave across the left half, around `y` meters north, as a line of a given width */
function wave(id: string, y: number, strokeColor: string, strokeWidth: number): SceneFeature {
  const coordinates: Position[] = [];
  for (let x = -400; x <= -20; x += 20) {
    coordinates.push(at(x, y + 20 * Math.sin((x + 400) / 60)));
  }
  return {
    id,
    type: 'LineString',
    geometry: { type: 'LineString', coordinates },
    properties: { name: `Line, ${strokeWidth} px` },
    style: { strokeColor, strokeWidth, strokeOpacity: 1 },
  };
}

/** Three lines, 1, 4 and 10 px wide */
const LINES: SceneFeature[] = [
  wave('line-1', 160, '#023E8A', 1),
  wave('line-4', 90, '#F72585', 4),
  wave('line-10', 5, '#FB8500', 10),
];

/** A freehand stroke: a loop drawn by hand, many close positions */
function freehand(): SceneFeature {
  const coordinates: Position[] = [];
  for (let t = 0; t <= 1; t += 0.01) {
    const angle = t * Math.PI * 4.2;
    const x = 70 + t * 290 + 40 * Math.cos(angle) + 5 * Math.sin(t * 47);
    const y = 90 + 50 * Math.sin(angle) + 4 * Math.cos(t * 39);
    coordinates.push(at(x, y));
  }
  return {
    id: 'freehand',
    type: 'Freehand',
    geometry: { type: 'LineString', coordinates },
    properties: { name: 'Freehand' },
    style: { strokeColor: '#D00000', strokeWidth: 3, strokeOpacity: 0.9 },
  };
}

/** Points of the four shapes, each with an outline */
const POINTS: SceneFeature[] = (
  [
    ['circle', -380, '#FF006E'],
    ['square', -280, '#3A86FF'],
    ['triangle', -180, '#FFBE0B'],
    ['star', -80, '#8338EC'],
  ] as const
).map(([pointShape, x, pointColor]) => ({
  id: `point-${pointShape}`,
  type: 'Point',
  geometry: { type: 'Point', coordinates: at(x, -110) },
  properties: { name: pointShape[0].toUpperCase() + pointShape.slice(1) },
  style: {
    pointShape,
    pointColor,
    pointRadius: pointShape === 'star' ? 15 : 11,
    pointStrokeColor: '#1F2937',
    pointStrokeWidth: 2,
  },
}));

/** A circle 90 m in radius, stored as its center and its radius */
const CIRCLE: SceneFeature = {
  id: 'circle',
  type: 'Circle',
  geometry: { type: 'Point', coordinates: at(55, -110) },
  properties: { name: 'Within 90 m', 'maplibre-gl-draw:radiusMeters': 90 },
  style: {
    fillColor: '#06D6A0',
    fillOpacity: 0.35,
    strokeColor: '#047857',
    strokeWidth: 2,
  },
};

/** An image, 150 x 100 px at the zoom it was placed at, turned a little */
const IMAGE: SceneFeature = {
  id: 'image',
  type: 'Image',
  geometry: { type: 'Point', coordinates: at(300, -110) },
  properties: {
    name: 'Station sketch',
    'maplibre-gl-draw:createdZoom': OVERVIEW_CAMERA.zoom,
    'maplibre-gl-draw:rotation': -6,
    'maplibre-gl-draw:imageFileId': IMAGE_FILE,
    'maplibre-gl-draw:imageWidth': 150,
    'maplibre-gl-draw:imageHeight': 100,
  },
  style: { imageOpacity: 1 },
};

/** Parcels in a row, colored by the rule of their layer from `use` */
const PARCELS: SceneFeature[] = (
  [
    ['Residential', -400, -260],
    ['Commercial', -235, -95],
    ['Park', -70, 70],
    ['Civic', 95, 235],
    ['Residential', 260, 400],
  ] as const
).map(([use, x0, x1], i) => ({
  id: `parcel-${i + 1}`,
  type: 'Polygon',
  geometry: {
    type: 'Polygon',
    coordinates: [
      ring([
        [x0, -420],
        [x1, -420],
        [x1, -240],
        [x0, -240],
      ]),
    ],
  },
  properties: { name: `Parcel ${i + 1}`, use },
  style: { fillOpacity: 0.7, strokeColor: '#ffffff', strokeWidth: 1.5 },
}));

/** The layers of the drawing, from the back */
export const OVERVIEW_LAYERS: SceneLayer[] = [
  { id: 'layer-land-use', name: 'Land use', features: PARCELS, styleRule: LAND_USE_RULE },
  {
    id: ACTIVE_LAYER,
    name: 'Drawing',
    features: [...AREAS, ...LINES, freehand(), CIRCLE, ...POINTS, IMAGE],
    groups: [
      { id: 'group-points', name: 'Point shapes', featureIds: POINTS.map((point) => point.id) },
    ],
  },
];

/**
 * The document of the scene, with the image given as a data URL
 *
 * @param image The picture of the image feature
 */
export function createOverviewDocument(image: string): DrawDocument {
  return buildDocument('Overview', OVERVIEW_LAYERS, [
    { id: IMAGE_FILE, mimeType: 'image/png', dataURL: image },
  ]);
}
