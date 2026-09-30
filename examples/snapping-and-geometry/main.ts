// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// snapping-and-geometry: precise drawing and editing of areas.
// Drawing snaps to vertices and edges and traces along the boundary it snapped to; shared
// vertices can move together; selected features are merged, subtracted, buffered and split.

import { createDraw, type Feature, type Position } from '@sakuzu/maplibre-gl-draw';
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
const draw = createDraw(map, {
  // Snap within 12 px; holding Alt suspends it
  snapping: { tolerancePx: 12, disableKey: 'alt' },
});

/** A square of `size` degrees with its south-west corner at [lng, lat] */
function square(lng: number, lat: number, size: number): Position[][] {
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
draw.features.createMany([
  { type: 'Polygon', geometry: { type: 'Polygon', coordinates: square(139.758, 35.679, 0.004) } },
  { type: 'Polygon', geometry: { type: 'Polygon', coordinates: square(139.762, 35.679, 0.004) } },
  { type: 'Polygon', geometry: { type: 'Polygon', coordinates: square(139.765, 35.682, 0.003) } },
  {
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [139.757, 35.6805],
        [139.763, 35.6815],
      ],
    },
  },
]);

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
  () => draw.options.get().snapping?.enabled !== false,
  (on) => draw.options.update({ snapping: { enabled: on } }),
);
toggle(
  'tracing',
  () => draw.options.get().tracing?.enabled !== false,
  (on) => draw.options.update({ tracing: { enabled: on } }),
);
// Off by default: a vertex drag then moves the same vertex of the neighbors too
toggle(
  'shared-vertices',
  () => draw.options.get().topology?.sharedVertexDrag === true,
  (on) => draw.options.update({ topology: { sharedVertexDrag: on } }),
);

/** The IDs of the selected features, in the order they were selected */
function selectedIds(): string[] {
  const { type, ids } = draw.selection.get();
  return type === 'feature' ? [...ids] : [];
}

/** Shows what an operation did: the features it made, or that it changed nothing */
function report(operation: string, inputs: number, results: Feature[] | null): void {
  output.textContent =
    results === null || results.length === 0
      ? `${operation}: empty, ${inputs} in, nothing changed`
      : `${operation}: applied, ${inputs} in, ${results.length} out`;
}

// Each operation works on the selection (Shift + click selects more than one feature)
const operations: Record<string, () => void> = {
  union: () => {
    const ids = selectedIds();
    const result = draw.features.union(ids);
    report('union', ids.length, result && [result]);
  },
  // The first feature selected loses the area of the others
  subtract: () => {
    const [subject, ...others] = selectedIds();
    if (subject === undefined) return;
    const result = draw.features.difference(subject, others);
    report('subtract', others.length + 1, result && [result]);
  },
  buffer: () => {
    const ids = selectedIds();
    report('buffer', ids.length, draw.features.buffer(ids, { distanceMeters: 100 }));
  },
  // A polygon and a line crossing it are selected
  split: () => {
    const selected = draw.selection.features();
    const line = selected.find((feature) => feature.type === 'LineString');
    const area = selected.find((feature) => feature.type === 'Polygon');
    if (!line || !area) return;
    report('split', 2, draw.features.split(area.id, line.id));
  },
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-op]')) {
  button.addEventListener('click', () => operations[button.dataset.op ?? '']?.());
}

/** The area of a polygon feature in square meters (0 for the other types) */
function areaOf(feature: Feature): number {
  if (feature.type !== 'Polygon' && feature.type !== 'MultiPolygon') return 0;
  return polygonArea(feature.geometry as Parameters<typeof polygonArea>[0]);
}

draw.on('selection.changed', () => {
  const selected = draw.selection.features();
  if (selected.length === 0) return;
  const area = selected.reduce((sum, feature) => sum + areaOf(feature), 0);
  output.textContent = `${selected.length} selected, ${Math.round(area).toLocaleString()} m²`;
});

// For the browser console and the end-to-end tests
Object.assign(window, { map, draw });
