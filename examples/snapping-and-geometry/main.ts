// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// snapping-and-geometry: precise drawing and editing of areas.
// Drawing snaps to vertices and edges and traces along the boundary it snapped to; shared
// vertices can move together; selected features are merged, subtracted, buffered and split.

import { type Coordinate, createMapLibreGLDraw, type Feature } from '@sakuzu/maplibre-gl-draw';
import { area as polygonArea } from '@sakuzu/maplibre-gl-draw/geometry';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../maplibre-setup.ts';
import { basemapStyle } from '../basemap.ts';
import '../example.css';

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle(),
  center: [139.764, 35.682],
  zoom: 15,
});
const draw = createMapLibreGLDraw(map, {
  // Snap within 12 px; holding Alt suspends it
  snap: { tolerancePx: 12, disableKey: 'alt' },
});

/** A square of `size` degrees with its south-west corner at [lng, lat] */
function square(lng: number, lat: number, size: number): Coordinate[][] {
  return [
    [
      [lng, lat],
      [lng + size, lat],
      [lng + size, lat + size],
      [lng, lat + size],
      [lng, lat],
    ],
  ];
}

// Two squares that share an edge, a third that overlaps them, and a line across the first
draw.addFeature({ type: 'Polygon', coordinates: square(139.758, 35.679, 0.004) });
draw.addFeature({ type: 'Polygon', coordinates: square(139.762, 35.679, 0.004) });
draw.addFeature({ type: 'Polygon', coordinates: square(139.765, 35.682, 0.003) });
draw.addFeature({
  type: 'LineString',
  coordinates: [
    [139.757, 35.6805],
    [139.763, 35.6815],
  ],
});

const output = document.getElementById('output') as HTMLPreElement;

document.getElementById('draw-polygon')?.addEventListener('click', () => {
  draw.setMode('draw_polygon');
});
document.getElementById('draw-line')?.addEventListener('click', () => draw.setMode('draw_line'));

/** A button that switches a setting on and off and shows its state */
function toggle(id: string, get: () => boolean, set: (on: boolean) => void): void {
  const button = document.getElementById(id) as HTMLButtonElement;
  button.classList.toggle('active', get());
  button.addEventListener('click', () => {
    set(!get());
    button.classList.toggle('active', get());
  });
}
toggle(
  'snapping',
  () => draw.snapping.isEnabled(),
  (on) => draw.snapping.setEnabled(on),
);
toggle(
  'tracing',
  () => draw.tracing.isEnabled(),
  (on) => draw.tracing.setEnabled(on),
);
// Off by default: a vertex drag then moves the same vertex of the neighbors too
toggle(
  'shared-vertices',
  () => draw.topology.isSharedVertexDrag(),
  (on) => draw.topology.setSharedVertexDrag(on),
);

// Each operation works on the selection (Shift + click selects more than one feature)
const operations: Record<string, () => void> = {
  union: () => draw.geometry.union(),
  subtract: () => draw.geometry.subtract(),
  buffer: () => draw.geometry.buffer({ distanceMeters: 100 }),
  // A polygon and a line crossing it are selected
  split: () => draw.geometry.split(),
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-op]')) {
  button.addEventListener('click', () => operations[button.dataset.op ?? '']?.());
}

draw.on('draw.geometry.applied', ({ operation, status, inputIds, resultIds }) => {
  output.textContent = `${operation}: ${status}, ${inputIds.length} in, ${resultIds.length} out`;
});

/** The area of a polygon feature in square meters (0 for the other types) */
function areaOf(feature: Feature): number {
  if (feature.type !== 'Polygon' && feature.type !== 'MultiPolygon') return 0;
  return polygonArea({ type: feature.type, coordinates: feature.coordinates } as Parameters<
    typeof polygonArea
  >[0]);
}

draw.on('draw.selection.change', () => {
  const selected = draw.getSelectedFeatures();
  if (selected.length === 0) return;
  const area = selected.reduce((sum, feature) => sum + areaOf(feature), 0);
  output.textContent = `${selected.length} selected, ${Math.round(area).toLocaleString()} m²`;
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
