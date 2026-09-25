// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// large-data: showing data too large to edit.
// A dataset draws features that are not in the drawing: 50,000 static cells
// colored by a style rule, and points fetched for the view as it moves, thinned where they
// collide. Clicking one reports it; neither is editable or saved with the drawing.

import {
  createMapLibreGLDraw,
  type DatasetFeatureInput,
  type DatasetFeatureProvider,
} from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

const CENTER: [number, number] = [139.767, 35.681];
const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: CENTER,
  zoom: 13,
});
const draw = createMapLibreGLDraw(map);

/** 250 x 200 square cells around the center, with a value from 0 to 100 that varies smoothly */
function createCells(): DatasetFeatureInput[] {
  const cols = 250;
  const rows = 200;
  const size = 0.0006;
  const cells: DatasetFeatureInput[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = CENTER[0] + (col - cols / 2) * size;
      const y = CENTER[1] + (row - rows / 2) * size * 0.8;
      const value = Math.round(
        50 + 30 * Math.sin(col / 17) * Math.cos(row / 13) + 20 * Math.sin((col + row) / 40),
      );
      cells.push({
        id: `cell-${row}-${col}`,
        type: 'Polygon',
        coordinates: [
          [
            [x, y],
            [x + size, y],
            [x + size, y + size * 0.8],
            [x, y + size * 0.8],
            [x, y],
          ],
        ],
        properties: { value },
        style: { fillOpacity: 0.6, strokeWidth: 0 },
      });
    }
  }
  return cells;
}

const grid = draw.addDataset({
  id: 'grid',
  features: createCells(),
  styleRule: {
    kind: 'graduated',
    property: 'value',
    breaks: [20, 40, 60, 80],
    colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'],
    other: '#cccccc',
  },
  order: 'below-store',
  interactive: true,
});

// Points for the requested range (rounded to tiles), about 16 per tile width, at a stable
// pseudo-random place in each step. A real provider would fetch them from a server
const pointsFor: DatasetFeatureProvider = async (bbox, zoom) => {
  if (zoom < 12) return [];
  const step = 360 / 2 ** (Math.floor(zoom) + 4);
  const points: DatasetFeatureInput[] = [];
  for (let i = Math.floor(bbox.minX / step); i * step < bbox.maxX; i++) {
    for (let j = Math.floor(bbox.minY / step); j * step < bbox.maxY; j++) {
      const hash = Math.abs(Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1;
      points.push({
        id: `point-${i}-${j}`,
        type: 'Point',
        coordinates: [(i + hash) * step, (j + ((hash * 7) % 1)) * step],
        properties: { kind: ['shop', 'school', 'station'][Math.floor(hash * 3)] },
      });
    }
  }
  return points;
};

const points = draw.addDataset({
  id: 'points',
  provider: pointsFor,
  styleRule: {
    kind: 'categorical',
    property: 'kind',
    map: { shop: '#e15759', school: '#59a14f', station: '#4e79a7' },
    other: '#cccccc',
  },
  baseStyle: { point: { pointRadius: 5 } },
  // Points that overlap on screen are not drawn; from zoom 17 every point is
  collisionThinning: { enabled: true, fullDisplayZoom: 17 },
  order: 'above-store',
  interactive: true,
});

const output = document.getElementById('output') as HTMLPreElement;
draw.on('draw.dataset.click', ({ datasetId, feature }) => {
  output.textContent = feature
    ? `${datasetId}: ${feature.id} ${JSON.stringify(feature.properties)}`
    : '';
});

// The cells go behind or in front of what is drawn
const orderButton = document.getElementById('grid-order') as HTMLButtonElement;
orderButton.addEventListener('click', () => {
  const inFront = !orderButton.classList.contains('active');
  draw.moveDataset(grid.id, { order: inFront ? 'above-store' : 'below-store' });
  orderButton.classList.toggle('active', inFront);
});

const thinningButton = document.getElementById('thinning') as HTMLButtonElement;
thinningButton.classList.add('active');
thinningButton.addEventListener('click', () => {
  const enabled = !thinningButton.classList.contains('active');
  points.setCollisionThinning({ enabled, fullDisplayZoom: 17 });
  thinningButton.classList.toggle('active', enabled);
});

document.getElementById('draw-polygon')?.addEventListener('click', () => {
  draw.setMode('draw_polygon');
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
