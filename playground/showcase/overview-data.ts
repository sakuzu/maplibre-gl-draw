// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drawing of the overview scene, east of Tokyo Station (Yaesu, Nihonbashi and Kyobashi)
 *
 * Five layers, from the back:
 *
 * - Land use: nine parcels colored by a categorical style rule from `use`
 * - Draft (50%): a footprint in a layer drawn at half opacity
 * - Zones: an area with a hole (selected, so its vertex handles show), a MultiPolygon, a group
 *   of three overlapping circles with a radius in meters, a group of five squares from a full
 *   to a faint fill, and a group of three areas with a solid, a dashed and a dotted outline 1, 3
 *   and 6 px wide
 * - Routes: five lines from 1.5 to 12 px wide, and a group of a dashed and a dotted trail
 * - Notes: an image, a freehand stroke around it, and a group of points of the four shapes
 *
 * Under them, a dataset of fine hexagonal cells colored by a graduated rule. The Legend tab of
 * the standard UI lists the rules of the first layer and of the dataset.
 *
 * Plain data, with nothing of the page: the test of the sample geometry imports it, and calls
 * `createDensityGrid` to check the cells too.
 */

import type {
  DatasetBaseStyle,
  DatasetRow,
  DrawDocument,
  DrawProperties,
  Position,
  StyleRule,
} from '@sakuzu/maplibre-gl-draw';
import { buildDocument, type SceneFeature, type SceneLayer } from './scene';

/** The camera of the scene: the drawing fills the map between the panels of the standard UI */
export const OVERVIEW_CAMERA = { center: [139.7775, 35.6826] as [number, number], zoom: 14.35 };

/** The feature that is selected, to show its frame and its vertex handles */
export const SELECTED_FEATURE = 'courtyard';

/** The layer new drawings go into */
export const ACTIVE_LAYER = 'layer-notes';

/** The ID of the embedded image */
const IMAGE_FILE = 'file-station';

/** The zoom the features were drawn at, which their sizes in pixels are given for */
const DRAWN_AT_ZOOM = 15;

/** The attributes of a feature: its name, the zoom it was drawn at, and any others */
function drawn(name: string, others: DrawProperties = {}): DrawProperties {
  return { name, 'maplibre-gl-draw:createdZoom': DRAWN_AT_ZOOM, ...others };
}

/** Positions given as a flat list of longitudes and latitudes in turn */
function pairs(values: number[]): Position[] {
  const positions: Position[] = [];
  for (let i = 0; i + 1 < values.length; i += 2) positions.push([values[i], values[i + 1]]);
  return positions;
}

/** The closed ring of a box, from its north-west corner clockwise */
function box(west: number, south: number, east: number, north: number): Position[] {
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
    [west, north],
  ];
}

// Land use

/** The categorical rule of the land use layer */
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

/** Parcels in three rows, colored by the rule of their layer from `use` */
const PARCELS: SceneFeature[] = (
  [
    ['Commercial', 139.782768, 35.678928, 139.784055, 35.679681],
    ['Commercial', 139.784141, 35.678928, 139.785214, 35.679681],
    ['Residential', 139.7853, 35.678928, 139.786845, 35.679681],
    ['Residential', 139.782768, 35.677924, 139.783626, 35.678866],
    ['Park', 139.783712, 35.677924, 139.7856, 35.678866],
    ['Civic', 139.785686, 35.678426, 139.786845, 35.678866],
    ['Residential', 139.785686, 35.677924, 139.786845, 35.678364],
    ['Civic', 139.782768, 35.677171, 139.78427, 35.677862],
    ['Residential', 139.784356, 35.677171, 139.786845, 35.677862],
  ] as const
).map(([use, west, south, east, north], i) => ({
  id: `parcel-${i + 1}`,
  type: 'Polygon',
  geometry: { type: 'Polygon', coordinates: [box(west, south, east, north)] },
  properties: drawn(`Parcel ${i + 1}`, { use }),
  style: { fillOpacity: 0.75, strokeColor: '#ffffff', strokeWidth: 1.5 },
}));

// Draft

/** A footprint in a dashed outline, in a layer drawn at half opacity */
const DRAFT_FOOTPRINT: SceneFeature = {
  id: 'draft-footprint',
  type: 'Polygon',
  geometry: {
    type: 'Polygon',
    coordinates: [
      pairs([
        139.773048, 35.683063, 139.775408, 35.683237, 139.775537, 35.681668, 139.773219, 35.681494,
        139.773048, 35.683063,
      ]),
    ],
  },
  properties: drawn('Draft footprint'),
  style: {
    fillColor: '#FF9E00',
    fillOpacity: 1,
    strokeColor: '#1D4ED8',
    strokeWidth: 3,
    lineStyle: 'dashed',
  },
};

// Zones

/** Five squares of one color, from a full to a faint fill */
const FILL_OPACITY: SceneFeature[] = (
  [
    [100, 139.776007, 139.776797],
    [75, 139.776968, 139.777758],
    [50, 139.77793, 139.77872],
    [25, 139.778891, 139.779681],
    [10, 139.779852, 139.780642],
  ] as const
).map(([percent, west, east]) => ({
  id: `fill-${percent}`,
  type: 'Polygon',
  geometry: { type: 'Polygon', coordinates: [box(west, 35.683036, east, 35.683678)] },
  properties: drawn(`Fill ${percent}%`),
  style: {
    fillColor: '#1D3557',
    fillOpacity: percent / 100,
    strokeColor: '#1D3557',
    strokeWidth: 1.5,
    strokeOpacity: 1,
  },
}));

/** Three areas whose fill and outline are of different hues, which one style layer of the map
 * cannot do: a solid, a dashed and a dotted outline */
const OUTLINES: SceneFeature[] = [
  {
    id: 'outline-solid',
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [box(139.776009, 35.6876, 139.779114, 35.6885)],
    },
    properties: drawn('Solid outline, 1 px'),
    style: {
      fillColor: '#FFD166',
      fillOpacity: 0.55,
      strokeColor: '#2A9D8F',
      strokeWidth: 1,
      lineStyle: 'solid',
    },
  },
  {
    id: 'outline-dashed',
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        pairs([
          139.779714, 35.68805, 139.7804, 35.6885, 139.782132, 35.6885, 139.782818, 35.68805,
          139.782132, 35.6876, 139.7804, 35.6876, 139.779714, 35.68805,
        ]),
      ],
    },
    properties: drawn('Dashed outline, 3 px'),
    style: {
      fillColor: '#8ECAE6',
      fillOpacity: 0.5,
      strokeColor: '#D00000',
      strokeWidth: 3,
      lineStyle: 'dashed',
    },
  },
  {
    id: 'outline-dotted',
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        pairs([
          139.783418, 35.6876, 139.786, 35.68765, 139.786523, 35.6885, 139.7838, 35.68845,
          139.783418, 35.6876,
        ]),
      ],
    },
    properties: drawn('Dotted outline, 6 px'),
    style: {
      fillColor: '#C77DFF',
      fillOpacity: 0.4,
      strokeColor: '#1B7F3B',
      strokeWidth: 6,
      lineStyle: 'dotted',
    },
  },
];

/** Three overlapping circles, each stored as its center and a radius in meters */
const COVERAGE: SceneFeature[] = (
  [
    ['A', 139.770966, 35.685503, '#FF4D6D'],
    ['B', 139.772897, 35.685503, '#3A86FF'],
    ['C', 139.771932, 35.684143, '#FFBE0B'],
  ] as const
).map(([letter, lng, lat, color], i) => ({
  id: `circle-${i + 1}`,
  type: 'Circle',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: drawn(`Coverage ${letter}`, {
    'maplibre-gl-draw:radiusMeters': 170.7,
    'maplibre-gl-draw:radiusHandleAngle': 45,
  }),
  style: {
    fillColor: color,
    fillOpacity: 0.32,
    strokeColor: color,
    strokeWidth: 2.5,
    strokeOpacity: 0.95,
  },
}));

/** One feature of three areas */
const ISLANDS: SceneFeature = {
  id: 'islands',
  type: 'MultiPolygon',
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [
        pairs([
          139.783103, 35.680698, 139.782492, 35.680386, 139.781668, 35.680261, 139.781068,
          35.680608, 139.78093, 35.68107, 139.781541, 35.681382, 139.782366, 35.681507, 139.782966,
          35.681161, 139.783103, 35.680698,
        ]),
      ],
      [
        pairs([
          139.784744, 35.680955, 139.784071, 35.680881, 139.783489, 35.68107, 139.783379, 35.681495,
          139.783933, 35.681739, 139.784592, 35.681722, 139.784993, 35.681369, 139.784744,
          35.680955,
        ]),
      ],
      [
        pairs([
          139.786132, 35.680271, 139.785876, 35.679982, 139.785198, 35.67995, 139.784614, 35.680066,
          139.784339, 35.680351, 139.784768, 35.680588, 139.785364, 35.68069, 139.786009, 35.680576,
          139.786132, 35.680271,
        ]),
      ],
    ],
  },
  properties: drawn('Islands'),
  style: {
    fillColor: '#06D6A0',
    fillOpacity: 0.55,
    strokeColor: '#04836B',
    strokeWidth: 2,
    strokeOpacity: 0.9,
  },
};

/** An area with a hole */
const COURTYARD: SceneFeature = {
  id: 'courtyard',
  type: 'Polygon',
  geometry: {
    type: 'Polygon',
    coordinates: [
      pairs([
        139.779829, 35.680128, 139.778858, 35.679297, 139.777449, 35.678792, 139.776049, 35.679322,
        139.775216, 35.680214, 139.775704, 35.681201, 139.776751, 35.68199, 139.778335, 35.681876,
        139.779431, 35.681159, 139.779829, 35.680128,
      ]),
      pairs([
        139.778242, 35.680654, 139.777488, 35.681001, 139.77672, 35.680645, 139.77678, 35.680068,
        139.777534, 35.679721, 139.778302, 35.680077, 139.778242, 35.680654,
      ]),
    ],
  },
  properties: drawn('Courtyard block'),
  style: {
    fillColor: '#8338EC',
    fillOpacity: 0.45,
    strokeColor: '#5A189A',
    strokeWidth: 2.5,
    strokeOpacity: 1,
  },
};

// Routes

/** A line of a given width and dash pattern */
function line(
  id: string,
  name: string,
  strokeColor: string,
  strokeWidth: number,
  lineStyle: 'solid' | 'dashed' | 'dotted',
  coordinates: Position[],
): SceneFeature {
  return {
    id,
    type: 'LineString',
    geometry: { type: 'LineString', coordinates },
    properties: drawn(name),
    style: { strokeColor, strokeWidth, strokeOpacity: 1, lineStyle },
  };
}

/** Five solid lines from 1.5 to 12 px wide */
const ROUTES: SceneFeature[] = [
  line(
    'route-1',
    'Route 1.5 px',
    '#00B4D8',
    1.5,
    'solid',
    pairs([
      139.776009, 35.686711, 139.776309, 35.686669, 139.77661, 35.686631, 139.77691, 35.686597,
      139.77721, 35.68657, 139.777511, 35.68655, 139.777811, 35.686537, 139.778112, 35.686532,
      139.778412, 35.686534, 139.778712, 35.686545, 139.779013, 35.686563, 139.779313, 35.686589,
      139.779614, 35.68662, 139.779914, 35.686658, 139.780214, 35.686699, 139.780515, 35.686744,
      139.780815, 35.68679, 139.781116, 35.686837, 139.781416, 35.686884, 139.781716, 35.686928,
      139.782017, 35.686969, 139.782317, 35.687005, 139.782618, 35.687036, 139.782918, 35.68706,
      139.783218, 35.687078, 139.783519, 35.687087, 139.783819, 35.687089, 139.78412, 35.687083,
      139.78442, 35.687069, 139.784721, 35.687047, 139.785021, 35.687019, 139.785321, 35.686985,
      139.785622, 35.686946, 139.785922, 35.686903, 139.786223, 35.686857, 139.786523, 35.68681,
    ]),
  ),
  line(
    'route-2',
    'Route 3 px',
    '#4361EE',
    3,
    'solid',
    pairs([
      139.776009, 35.686328, 139.776309, 35.686286, 139.77661, 35.686247, 139.77691, 35.686214,
      139.77721, 35.686187, 139.777511, 35.686166, 139.777811, 35.686153, 139.778112, 35.686148,
      139.778412, 35.686151, 139.778712, 35.686162, 139.779013, 35.68618, 139.779313, 35.686205,
      139.779614, 35.686237, 139.779914, 35.686274, 139.780214, 35.686316, 139.780515, 35.68636,
      139.780815, 35.686407, 139.781116, 35.686454, 139.781416, 35.6865, 139.781716, 35.686544,
      139.782017, 35.686585, 139.782317, 35.686622, 139.782618, 35.686653, 139.782918, 35.686677,
      139.783218, 35.686694, 139.783519, 35.686704, 139.783819, 35.686705, 139.78412, 35.686699,
      139.78442, 35.686685, 139.784721, 35.686664, 139.785021, 35.686636, 139.785321, 35.686602,
      139.785622, 35.686562, 139.785922, 35.686519, 139.786223, 35.686474, 139.786523, 35.686427,
    ]),
  ),
  line(
    'route-3',
    'Route 5 px',
    '#7209B7',
    5,
    'solid',
    pairs([
      139.776009, 35.685945, 139.776309, 35.685902, 139.77661, 35.685864, 139.77691, 35.68583,
      139.77721, 35.685803, 139.777511, 35.685783, 139.777811, 35.68577, 139.778112, 35.685765,
      139.778412, 35.685768, 139.778712, 35.685778, 139.779013, 35.685797, 139.779313, 35.685822,
      139.779614, 35.685854, 139.779914, 35.685891, 139.780214, 35.685932, 139.780515, 35.685977,
      139.780815, 35.686023, 139.781116, 35.68607, 139.781416, 35.686117, 139.781716, 35.686161,
      139.782017, 35.686202, 139.782317, 35.686238, 139.782618, 35.686269, 139.782918, 35.686293,
      139.783218, 35.686311, 139.783519, 35.68632, 139.783819, 35.686322, 139.78412, 35.686316,
      139.78442, 35.686302, 139.784721, 35.68628, 139.785021, 35.686252, 139.785321, 35.686218,
      139.785622, 35.686179, 139.785922, 35.686136, 139.786223, 35.68609, 139.786523, 35.686044,
    ]),
  ),
  line(
    'route-4',
    'Route 8 px',
    '#F72585',
    8,
    'solid',
    pairs([
      139.776009, 35.685561, 139.776309, 35.685519, 139.77661, 35.68548, 139.77691, 35.685447,
      139.77721, 35.68542, 139.777511, 35.685399, 139.777811, 35.685386, 139.778112, 35.685381,
      139.778412, 35.685384, 139.778712, 35.685395, 139.779013, 35.685413, 139.779313, 35.685438,
      139.779614, 35.68547, 139.779914, 35.685507, 139.780214, 35.685549, 139.780515, 35.685593,
      139.780815, 35.68564, 139.781116, 35.685687, 139.781416, 35.685733, 139.781716, 35.685778,
      139.782017, 35.685818, 139.782317, 35.685855, 139.782618, 35.685886, 139.782918, 35.68591,
      139.783218, 35.685927, 139.783519, 35.685937, 139.783819, 35.685939, 139.78412, 35.685932,
      139.78442, 35.685918, 139.784721, 35.685897, 139.785021, 35.685869, 139.785321, 35.685835,
      139.785622, 35.685796, 139.785922, 35.685753, 139.786223, 35.685707, 139.786523, 35.68566,
    ]),
  ),
  line(
    'route-5',
    'Route 12 px',
    '#FF9E00',
    12,
    'solid',
    pairs([
      139.776009, 35.685178, 139.776309, 35.685135, 139.77661, 35.685097, 139.77691, 35.685064,
      139.77721, 35.685036, 139.777511, 35.685016, 139.777811, 35.685003, 139.778112, 35.684998,
      139.778412, 35.685001, 139.778712, 35.685011, 139.779013, 35.68503, 139.779313, 35.685055,
      139.779614, 35.685087, 139.779914, 35.685124, 139.780214, 35.685165, 139.780515, 35.68521,
      139.780815, 35.685256, 139.781116, 35.685304, 139.781416, 35.68535, 139.781716, 35.685394,
      139.782017, 35.685435, 139.782317, 35.685471, 139.782618, 35.685502, 139.782918, 35.685527,
      139.783218, 35.685544, 139.783519, 35.685553, 139.783819, 35.685555, 139.78412, 35.685549,
      139.78442, 35.685535, 139.784721, 35.685514, 139.785021, 35.685485, 139.785321, 35.685451,
      139.785622, 35.685412, 139.785922, 35.685369, 139.786223, 35.685324, 139.786523, 35.685277,
    ]),
  ),
];

/** A dashed and a dotted trail */
const TRAILS: SceneFeature[] = [
  line(
    'trail-dashed',
    'Dashed trail',
    '#FB5607',
    3.5,
    'dashed',
    pairs([
      139.776009, 35.684474, 139.776309, 35.684476, 139.77661, 35.684483, 139.77691, 35.684495,
      139.77721, 35.684512, 139.777511, 35.684532, 139.777811, 35.684555, 139.778112, 35.684581,
      139.778412, 35.684609, 139.778712, 35.684638, 139.779013, 35.684668, 139.779313, 35.684697,
      139.779614, 35.684724, 139.779914, 35.68475, 139.780214, 35.684772, 139.780515, 35.684791,
      139.780815, 35.684806, 139.781116, 35.684816, 139.781416, 35.684822, 139.781716, 35.684822,
      139.782017, 35.684818, 139.782317, 35.684809, 139.782618, 35.684795, 139.782918, 35.684777,
      139.783218, 35.684755, 139.783519, 35.684731, 139.783819, 35.684704, 139.78412, 35.684675,
      139.78442, 35.684646, 139.784721, 35.684616, 139.785021, 35.684588, 139.785321, 35.684561,
      139.785622, 35.684537, 139.785922, 35.684516, 139.786223, 35.684499, 139.786523, 35.684486,
    ]),
  ),
  line(
    'trail-dotted',
    'Dotted trail',
    '#0077B6',
    3.5,
    'dotted',
    pairs([
      139.776009, 35.684073, 139.776309, 35.684076, 139.77661, 35.684083, 139.77691, 35.684095,
      139.77721, 35.684111, 139.777511, 35.684131, 139.777811, 35.684155, 139.778112, 35.684181,
      139.778412, 35.684209, 139.778712, 35.684238, 139.779013, 35.684267, 139.779313, 35.684296,
      139.779614, 35.684324, 139.779914, 35.684349, 139.780214, 35.684371, 139.780515, 35.68439,
      139.780815, 35.684405, 139.781116, 35.684416, 139.781416, 35.684421, 139.781716, 35.684422,
      139.782017, 35.684417, 139.782317, 35.684408, 139.782618, 35.684394, 139.782918, 35.684376,
      139.783218, 35.684355, 139.783519, 35.68433, 139.783819, 35.684303, 139.78412, 35.684274,
      139.78442, 35.684245, 139.784721, 35.684216, 139.785021, 35.684187, 139.785321, 35.684161,
      139.785622, 35.684136, 139.785922, 35.684115, 139.786223, 35.684098, 139.786523, 35.684085,
    ]),
  ),
];

// Notes

/** An image, 120 x 80 px at the zoom it was placed at, turned a little */
const PHOTO: SceneFeature = {
  id: 'photo',
  type: 'Image',
  geometry: { type: 'Point', coordinates: [139.778369, 35.677764] },
  properties: drawn('Station photo', {
    'maplibre-gl-draw:rotation': -6,
    'maplibre-gl-draw:imageFileId': IMAGE_FILE,
    'maplibre-gl-draw:imageWidth': 120,
    'maplibre-gl-draw:imageHeight': 80,
  }),
  style: { imageOpacity: 1 },
};

/** A freehand loop around the image: many close positions */
const SCRIBBLE: SceneFeature = {
  id: 'scribble',
  type: 'Freehand',
  geometry: {
    type: 'LineString',
    coordinates: pairs([
      139.776504, 35.677867, 139.776508, 35.677974, 139.776546, 35.678081, 139.776622, 35.678186,
      139.776736, 35.678284, 139.776887, 35.678371, 139.777068, 35.678445, 139.777273, 35.678503,
      139.777493, 35.678546, 139.77772, 35.678573, 139.777949, 35.678589, 139.778176, 35.678593,
      139.778399, 35.67859, 139.77862, 35.678581, 139.778841, 35.678566, 139.779062, 35.678545,
      139.779284, 35.678516, 139.779505, 35.678477, 139.779721, 35.678426, 139.779924, 35.67836,
      139.780107, 35.678281, 139.780261, 35.678187, 139.780378, 35.678083, 139.780454, 35.67797,
      139.780488, 35.677853, 139.78048, 35.677736, 139.780435, 35.677622, 139.78036, 35.677513,
      139.780262, 35.67741, 139.780146, 35.677313, 139.780018, 35.677222, 139.779877, 35.677134,
      139.779725, 35.67705, 139.779558, 35.676969, 139.779373, 35.676893, 139.779168, 35.676825,
      139.778942, 35.676766, 139.778697, 35.676722, 139.778436, 35.676696, 139.778168, 35.676689,
      139.7779, 35.676704, 139.777642, 35.67674, 139.7774, 35.676794, 139.777182, 35.676865,
      139.776988, 35.676948, 139.776821, 35.67704, 139.776676, 35.677137, 139.776552, 35.677238,
      139.776444, 35.677343, 139.77635, 35.67745, 139.77627, 35.677561, 139.776207, 35.677676,
      139.776166, 35.677796, 139.776153, 35.677921, 139.776174, 35.678047, 139.776235, 35.678173,
      139.776339, 35.678293, 139.776486, 35.678405,
    ]),
  },
  properties: drawn('Freehand note'),
  style: { strokeColor: '#FF006E', strokeWidth: 3, strokeOpacity: 0.9, lineStyle: 'solid' },
};

/** Points of the four shapes, each with an outline */
const MARKERS: SceneFeature[] = (
  [
    ['circle', 139.780944, 35.682505, '#FF006E', 12],
    ['square', 139.782017, 35.682505, '#3A86FF', 11],
    ['triangle', 139.783133, 35.68254, '#FFBE0B', 15],
    ['star', 139.784291, 35.682522, '#8338EC', 17],
  ] as const
).map(([pointShape, lng, lat, pointColor, pointRadius]) => ({
  id: `marker-${pointShape}`,
  type: 'Point',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: drawn(pointShape[0].toUpperCase() + pointShape.slice(1)),
  style: {
    pointShape,
    pointColor,
    pointRadius,
    pointStrokeColor: '#1F2937',
    pointStrokeWidth: 2,
  },
}));

const ids = (features: SceneFeature[]): string[] => features.map((feature) => feature.id);

/** The layers of the drawing, from the back; the features of each from the back */
export const OVERVIEW_LAYERS: SceneLayer[] = [
  { id: 'layer-landuse', name: 'Land use', features: PARCELS, styleRule: LAND_USE_RULE },
  { id: 'layer-draft', name: 'Draft (50%)', opacity: 0.5, features: [DRAFT_FOOTPRINT] },
  {
    id: 'layer-zones',
    name: 'Zones',
    features: [...FILL_OPACITY, ...OUTLINES, ...COVERAGE, ISLANDS, COURTYARD],
    groups: [
      { id: 'group-opacity', name: 'Fill opacity', featureIds: ids(FILL_OPACITY) },
      { id: 'group-outlines', name: 'Outlines', featureIds: ids(OUTLINES) },
      { id: 'group-coverage', name: 'Coverage', featureIds: ids(COVERAGE) },
    ],
  },
  {
    id: 'layer-routes',
    name: 'Routes',
    features: [...ROUTES, ...TRAILS],
    groups: [{ id: 'group-trails', name: 'Trails', featureIds: ids(TRAILS) }],
  },
  {
    id: ACTIVE_LAYER,
    name: 'Notes',
    features: [PHOTO, SCRIBBLE, ...MARKERS],
    groups: [{ id: 'group-markers', name: 'Markers', featureIds: ids(MARKERS) }],
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

// The dataset under the layers

/** The ID of the dataset of hexagonal cells, which the standard UI shows as its name */
export const DENSITY_DATASET = 'Density';

/** The graduated rule of the dataset */
export const DENSITY_RULE: StyleRule = {
  kind: 'graduated',
  property: 'density',
  breaks: [20, 40, 60, 80],
  colors: ['#ffffcc', '#a1dab4', '#41b6c4', '#2c7fb8', '#253494'],
  other: '#cccccc',
};

/** The look of the cells: a fill without an outline */
export const DENSITY_BASE_STYLE: DatasetBaseStyle = {
  fill: { fillOpacity: 0.8, strokeWidth: 0, strokeOpacity: 0 },
};

/** The patch of cells */
const GRID = {
  /** Center of the patch */
  center: [139.77075, 35.68062] as Position,
  /** Radius of the patch in degrees of longitude */
  radius: 0.00247,
  /** Circumradius of a hexagon in degrees of longitude */
  cell: 0.0001,
};

/**
 * Hexagonal cells over a round patch, with a smooth made-up density from 0 to 100
 */
export function createDensityGrid(): DatasetRow[] {
  const [lng0, lat0] = GRID.center;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const r = GRID.cell;
  const dx = Math.sqrt(3) * r;
  const dy = 1.5 * r;
  const rows: DatasetRow[] = [];
  const n = Math.ceil(GRID.radius / dy) + 1;

  for (let row = -n; row <= n; row++) {
    const offset = row % 2 === 0 ? 0 : dx / 2;
    for (let col = -n; col <= n; col++) {
      const x = col * dx + offset;
      const y = row * dy;
      const d = Math.hypot(x, y) / GRID.radius;
      const angle = Math.atan2(y, x);
      // A wavy edge, so the patch does not read as a perfect disc
      const edge = 1 + 0.08 * Math.sin(angle * 3) + 0.05 * Math.cos(angle * 5);
      if (d > edge) continue;

      const u = x / GRID.radius;
      const v = y / GRID.radius;
      const density =
        48 +
        34 * Math.exp(-((u - 0.25) ** 2 + (v + 0.2) ** 2) * 3) +
        20 * Math.sin(u * 4.2) * Math.cos(v * 3.6) -
        30 * d * d;
      const ring: Position[] = [];
      for (let i = 0; i <= 6; i++) {
        const a = (Math.PI / 3) * (i % 6) + Math.PI / 6;
        ring.push([lng0 + x + r * 0.94 * Math.cos(a), lat0 + (y + r * 0.94 * Math.sin(a)) * k]);
      }
      rows.push({
        type: 'Feature',
        id: `cell-${row}-${col}`,
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { density: Math.round(Math.min(100, Math.max(0, density))) },
      });
    }
  }
  return rows;
}
