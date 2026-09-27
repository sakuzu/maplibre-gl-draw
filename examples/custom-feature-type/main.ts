// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// custom-feature-type: a feature type the library does not have.
// A "Route" is a line drawn dashed in a fixed color. One handler registers how it is drawn
// (with the library's shared line renderer), hit, box-selected, framed and resized.

import {
  type BoundingBox,
  type BoxSelectionStrategy,
  type Coordinate,
  type CustomFeatureHandler,
  type CustomFeatureRenderer,
  createMapLibreGLDraw,
  type Feature,
  type HitTestStrategy,
} from '@sakuzu/maplibre-gl-draw';
import type { LineString } from 'geojson';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

// Drawn in the feature's place in the layer order. The shared renderers are ready for the
// frame (shader and projection), so the renderer creates no GL object of its own
const routeRenderer: CustomFeatureRenderer = {
  name: 'route',
  onAdd() {},
  draw(feature, projectionData, zoom, context) {
    context.sdfLineRenderer.draw(
      feature.coordinates as Coordinate[],
      { width: 3, color: [0.9, 0.3, 0.1, 1], opacity: context.opacity, lineStyle: 'dashed' },
      { widthUnit: 'pixels', closed: false },
      zoom,
      projectionData,
    );
  },
  onRemove() {},
};

/** Distance to a segment, in degrees of longitude at the latitude of p */
function segmentDistance(p: Coordinate, a: Coordinate, b: Coordinate): number {
  const k = 1 / Math.cos((p[1] * Math.PI) / 180);
  const ax = a[0] - p[0];
  const ay = (a[1] - p[1]) * k;
  const dx = b[0] - a[0];
  const dy = (b[1] - a[1]) * k;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function routeDistance(feature: Feature, p: Coordinate): number {
  const c = (feature.geometry as LineString).coordinates as Coordinate[];
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < c.length; i++) {
    best = Math.min(best, segmentDistance(p, c[i - 1], c[i]));
  }
  return best;
}

// A click within the click tolerance of the line hits it
const routeHitTest: HitTestStrategy = {
  geometryType: 'Route',
  distance: routeDistance,
  test: (feature, coordinate, toleranceLngLat) =>
    routeDistance(feature, coordinate) <= toleranceLngLat,
};

// A selection box takes a route when one of its vertices is inside
const routeBoxSelection: BoxSelectionStrategy = {
  featureType: 'Route',
  intersects: (feature, rect) =>
    ((feature.geometry as LineString).coordinates as Coordinate[]).some(
      ([x, y]) => x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY,
    ),
};

/** The extent of the vertices */
function extentOf(feature: Feature): BoundingBox {
  const c = (feature.geometry as LineString).coordinates as Coordinate[];
  const xs = c.map((p) => p[0]);
  const ys = c.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

const routeHandler: CustomFeatureHandler = {
  type: 'Route',
  renderer: routeRenderer,
  hitTest: routeHitTest,
  boxSelection: routeBoxSelection,
  // The frame of the selection, with its resize handles
  getSelectionBoundingBox(feature) {
    const { minX, minY, maxX, maxY } = extentOf(feature);
    return {
      topLeft: [minX, maxY],
      topRight: [maxX, maxY],
      bottomRight: [maxX, minY],
      bottomLeft: [minX, minY],
      center: [(minX + maxX) / 2, (minY + maxY) / 2],
    };
  },
  // A resize handle scales the vertices, as for a built-in line
  resizeStrategy: 'coordinates',
};

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.72, 35.685],
  zoom: 13,
});
const draw = createMapLibreGLDraw(map);
const unregister = draw.registerFeatureHandler(routeHandler);

draw.addFeature({
  type: 'Route',
  geometry: {
    type: 'LineString',
    coordinates: [
      [139.7, 35.68],
      [139.72, 35.69],
      [139.74, 35.68],
    ],
  },
});

// Another route across the center of the view, selected so its frame shows
document.getElementById('add-route')?.addEventListener('click', () => {
  const { lng, lat } = map.getCenter();
  const bounds = map.getBounds();
  const w = (bounds.getEast() - bounds.getWest()) / 6;
  const h = (bounds.getNorth() - bounds.getSouth()) / 6;
  const id = draw.addFeature({
    type: 'Route',
    geometry: {
      type: 'LineString',
      coordinates: [
        [lng - w, lat - h],
        [lng, lat + h],
        [lng + w, lat - h],
      ],
    },
  });
  // null when the write was refused because the drawing is read-only
  if (id !== null) draw.select(id);
});

// Without its handler the type is neither drawn nor hit; the features stay in the data
document.getElementById('unregister')?.addEventListener('click', (event) => {
  unregister();
  (event.target as HTMLButtonElement).disabled = true;
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
