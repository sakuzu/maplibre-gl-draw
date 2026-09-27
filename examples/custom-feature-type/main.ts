// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// custom-feature-type: a feature type the library does not have.
// A "Route" is a line drawn dashed in a fixed color. One definition says how it is drawn
// (with the library's shared line renderer), hit, box-selected, framed and reshaped.

import {
  createDraw,
  type Feature,
  type FeatureRenderer,
  type FeatureTypeDefinition,
  type Position,
  type ScreenPoint,
} from '@sakuzu/maplibre-gl-draw';
import type { LineString } from 'geojson';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

// Drawn in the feature's place in the layer order. The shared renderers are ready for the
// frame (shader and projection), so the renderer creates no GL object of its own
const routeRenderer: FeatureRenderer = {
  onAdd() {},
  draw(feature, ctx) {
    ctx.line.draw(verticesOf(feature), {
      width: 3,
      color: '#e64d1a',
      opacity: ctx.opacity,
      lineStyle: 'dashed',
    });
  },
  onRemove() {},
};

function verticesOf(feature: Feature): Position[] {
  return (feature.geometry as LineString).coordinates;
}

/** Distance from a point to a segment, in pixels */
function segmentDistance(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t =
    len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

const routeType: FeatureTypeDefinition = {
  type: 'Route',
  geometry: 'LineString',
  renderer: routeRenderer,
  // A click within the click tolerance of the line hits it
  hitTest(feature, ctx) {
    const points = verticesOf(feature).map((v) => ctx.screen.project(v));
    let best = Number.POSITIVE_INFINITY;
    for (let i = 1; i < points.length; i++) {
      best = Math.min(best, segmentDistance(ctx.point, points[i - 1], points[i]));
    }
    return best <= ctx.tolerancePx
      ? { kind: 'feature', id: feature.id, featureId: feature.id, distancePx: best }
      : null;
  },
  // A selection box takes a route when one of its vertices is inside
  boxSelect(feature, box, ctx) {
    return verticesOf(feature).some((v) => {
      const [x, y] = ctx.screen.project(v);
      return x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1];
    });
  },
  // The frame of the selection
  bounds(feature, ctx) {
    const points = verticesOf(feature).map((v) => ctx.project(v));
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return {
      min: [Math.min(...xs), Math.min(...ys)],
      max: [Math.max(...xs), Math.max(...ys)],
    };
  },
  // A handle on each vertex, which moves that vertex
  handles(feature) {
    return verticesOf(feature).map((position, index) => ({
      id: String(index),
      position,
      kind: 'vertex',
      cursor: 'move',
    }));
  },
  onHandleDrag(feature, handle, event) {
    const coordinates = [...verticesOf(feature)];
    coordinates[Number(handle.id)] = event.lngLat;
    return { geometry: { type: 'LineString', coordinates } };
  },
};

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.72, 35.685],
  zoom: 13,
});
const draw = createDraw(map);
const unregister = draw.extensions.featureTypes.add(routeType);

draw.features.create({
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
  const route = draw.features.create({
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
  if (route !== null) draw.selection.set('feature', [route.id]);
});

// Without its definition the type is neither drawn nor hit; the features stay in the data
document.getElementById('unregister')?.addEventListener('click', (event) => {
  unregister();
  (event.target as HTMLButtonElement).disabled = true;
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
