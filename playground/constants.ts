// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playground constants
 *
 * The default styles, the palettes, the basemaps and the sample data of the playground.
 */

// The playground saves its basemap choice in the document's metadata. The library's Metadata
// holds only a title and a description; an application adds its own keys like this.
declare module '@sakuzu/maplibre-gl-draw' {
  interface Metadata {
    /** The style URL of the basemap shown under the drawing */
    basemap?: string;
  }
}

// Default styles
export const DEFAULT_STYLES = {
  strokeColor: '#FF0077',
  strokeOpacity: 1.0,
  strokeWidth: 2,
  lineStyle: 'solid' as const,
  fillColor: '#FF0077',
  fillOpacity: 0.25,
  imageOpacity: 1.0,
};

// Color palette (18 colors)
export const DRAWING_PALETTE = [
  '#FF0000',
  '#FF6000',
  '#FFA500',
  '#FFD700',
  '#FFFF00',
  '#AAFF00',
  '#00FF00',
  '#00FFAA',
  '#00FFFF',
  '#00AAFF',
  '#0055FF',
  '#0000FF',
  '#7700FF',
  '#AA00FF',
  '#FF00FF',
  '#FF0077',
  '#FFFFFF',
  '#000000',
];

// Line style options
export const LINE_STYLE_OPTIONS = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
] as const;

// Snapping tolerance (the snapping.tolerancePx option of createDraw)
export const SNAP_TOLERANCE_PX = 10;

// Kinds of style rule
export const STYLE_RULE_KIND_OPTIONS = [
  { value: 'none', label: 'No rule' },
  { value: 'single', label: 'Single color' },
  { value: 'categorical', label: 'Categorical' },
  { value: 'graduated', label: 'Graduated' },
  { value: 'continuous', label: 'Continuous' },
] as const;

// Style rule color schemes (the sequential schemes used by single color, graduated and
// continuous)
export const STYLE_RULE_PALETTES = [
  {
    value: 'blue',
    label: 'Blues',
    colors: ['#eff3ff', '#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c'],
  },
  {
    value: 'green',
    label: 'Greens',
    colors: ['#edf8e9', '#c7e9c0', '#a1d99b', '#74c476', '#31a354', '#006d2c'],
  },
  {
    value: 'warm',
    label: 'Warm',
    colors: ['#fef0d9', '#fdd49e', '#fdbb84', '#fc8d59', '#e34a33', '#b30000'],
  },
  {
    value: 'purple',
    label: 'Purples',
    colors: ['#f2f0f7', '#dadaeb', '#bcbddc', '#9e9ac8', '#756bb1', '#54278f'],
  },
] as const;

// Categorical color scheme (distinguished by hue)
export const CATEGORICAL_PALETTE = [
  '#4E79A7',
  '#F28E2B',
  '#E15759',
  '#76B7B2',
  '#59A14F',
  '#EDC948',
  '#B07AA1',
  '#FF9DA7',
];

// Color for features that have no attribute or whose type does not match
export const STYLE_RULE_OTHER_COLOR = '#cccccc';

// Grid for the large-volume display demo (100 x 100 = 10,000 features)
export const DEMO_GRID = {
  cols: 100,
  rows: 100,
  cellLng: 0.0006,
  cellLat: 0.00045,
} as const;

// Dataset ID of the large-volume display demo
export const DEMO_DATASET_ID = 'demo-grid';

// Display name of the large-volume display demo as an underlay
export const DEMO_DATASET_NAME = 'Demo grid';

// Path and view position of the sample data (served from public/, so it is also in the build)
export const SAMPLE_DATA_URL = './sample-gis.geojson';
export const SAMPLE_DATA_VIEW = {
  center: [139.7515, 35.6875] as [number, number],
  zoom: 13.2,
};

// Basemap options (value is the style URL)
export const BASEMAP_OPTIONS = [
  {
    value: 'https://tiles.openfreemap.org/styles/bright',
    label: 'OpenFreeMap Bright',
  },
  {
    value: 'https://gsi-cyberjapan.github.io/gsivectortile-mapbox-gl-js/blank.json',
    label: 'GSI Blank Map',
  },
  {
    value: 'https://gsi-cyberjapan.github.io/gsivectortile-mapbox-gl-js/pale.json',
    label: 'GSI Pale Map',
  },
  {
    value: 'https://gsi-cyberjapan.github.io/gsivectortile-mapbox-gl-js/std.json',
    label: 'GSI Standard Map',
  },
] as const;

// Default basemap
export const DEFAULT_BASEMAP = 'https://tiles.openfreemap.org/styles/bright';
