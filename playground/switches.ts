// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The switches of the playground that are not tools: each is a letter with Shift, listed in the
// console when the page opens. The modes are tools of the toolbar instead, and the globe is the
// globe button of the map's controls.

import type { DatasetRow, Draw } from '@sakuzu/maplibre-gl-draw';
import type { FeatureCollection } from 'geojson';
import type * as maplibregl from 'maplibre-gl';
import { DEM_TILES } from '../examples/basemap.ts';

/** A switch: its letter (pressed with Shift), what it does, and the doing */
export interface Switch {
  key: string;
  label: string;
  run: () => void | Promise<void>;
}

/** Where Shift+S saves the drawing */
const STORAGE_KEY = 'maplibre-gl-draw-playground';
const DATASET_ID = 'cells';
const BIG_LAYER = 'two-hundred-thousand';

/**
 * The switches over a draw instance and its map
 *
 * @param onBig Called before the 200,000 points are loaded (true) and after they are removed
 */
export function createSwitches(
  draw: Draw,
  map: maplibregl.Map,
  onBig: (big: boolean) => void,
): Switch[] {
  return [
    { key: 'T', label: 'Terrain on and off', run: () => toggleTerrain(map) },
    { key: 'D', label: 'A dataset of 10,000 cells on and off', run: () => toggleCells(draw, map) },
    {
      key: 'R',
      label: 'Read-only on and off',
      run: () => {
        draw.setReadOnly(!draw.isReadOnly());
        console.info(`Read-only: ${draw.isReadOnly()}`);
      },
    },
    {
      key: 'K',
      label: 'Interaction lock on and off',
      run: () => {
        draw.setInteractionLocked(!draw.isInteractionLocked());
        console.info(`Interaction lock: ${draw.isInteractionLocked()}`);
      },
    },
    {
      key: 'S',
      label: 'Save the drawing in this browser (localStorage)',
      run: () => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(draw.document.toJSON()));
          console.info(`Saved ${draw.features.count()} features`);
        } catch (error) {
          // The storage of a page holds a few megabytes: not the 200,000 points
          console.info(`Not saved: ${error}`);
        }
      },
    },
    {
      key: 'O',
      label: 'Open the drawing saved in this browser',
      run: async () => {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === null) {
          console.info('Nothing is saved yet (Shift+S saves)');
          return;
        }
        const result = await draw.document.load(JSON.parse(saved));
        console.info(result ? `Opened ${result.featureIds.length} features` : 'Read-only');
      },
    },
    {
      key: 'B',
      label: 'Load 200,000 points as features, or remove them',
      run: () => toggleBig(draw, map, onBig),
    },
  ];
}

/** Runs the switches on their keys, and lists them in the console */
export function listenToSwitches(switches: readonly Switch[]): void {
  document.addEventListener('keydown', (e) => {
    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const target = e.target as HTMLElement | null;
    if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) {
      return;
    }
    const found = switches.find((s) => s.key === e.key.toUpperCase());
    if (!found) return;
    e.preventDefault();
    void found.run();
  });
  console.info(
    [
      'The switches of the playground:',
      ...switches.map((s) => `  Shift+${s.key}  ${s.label}`),
    ].join('\n'),
  );
}

/** The terrain of the map, from the elevation tiles of the examples, tilted to be seen */
function toggleTerrain(map: maplibregl.Map): void {
  if (!map.getSource('dem')) {
    map.addSource('dem', { type: 'raster-dem', url: DEM_TILES, tileSize: 256 });
  }
  const on = map.getTerrain() === null;
  map.setTerrain(on ? { source: 'dem', exaggeration: 1.5 } : null);
  map.easeTo({ pitch: on ? 60 : 0 });
  console.info(`Terrain: ${on}`);
}

/** A dataset of 100 x 100 cells around the center of the view, colored by a value */
function toggleCells(draw: Draw, map: maplibregl.Map): void {
  if (draw.datasets.get(DATASET_ID)) {
    draw.datasets.remove(DATASET_ID);
    console.info('Dataset: removed');
    return;
  }
  const { lng, lat } = map.getCenter();
  const size = 0.0006;
  const rows: DatasetRow[] = [];
  for (let i = 0; i < 100; i++) {
    for (let j = 0; j < 100; j++) {
      const west = lng + (i - 50) * size;
      const south = lat + (j - 50) * size * 0.8;
      const ring = [
        [west, south],
        [west + size * 0.9, south],
        [west + size * 0.9, south + size * 0.72],
        [west, south + size * 0.72],
        [west, south],
      ];
      rows.push({
        type: 'Feature',
        id: `cell-${i}-${j}`,
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { value: Math.round(50 + 50 * Math.sin(i / 9) * Math.cos(j / 7)) },
      });
    }
  }
  const dataset = draw.datasets.add({
    id: DATASET_ID,
    rows,
    baseStyle: { fill: { fillOpacity: 0.5, strokeWidth: 0 } },
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
  dataset.on('clicked', ({ row }) => console.info(`Cell ${row.id}:`, row.properties));
  console.info('Dataset: 10,000 cells, below the drawing; a click logs a cell');
}

/** 200,000 points in a layer of their own, every one an editable feature */
async function toggleBig(
  draw: Draw,
  map: maplibregl.Map,
  onBig: (big: boolean) => void,
): Promise<void> {
  if (draw.layers.get(BIG_LAYER)) {
    if (!draw.layers.delete(BIG_LAYER)) return;
    onBig(false);
    console.info('200,000 points: removed');
    return;
  }
  const { lng, lat } = map.getCenter();
  const points: FeatureCollection = { type: 'FeatureCollection', features: [] };
  for (let i = 0; i < 500; i++) {
    for (let j = 0; j < 400; j++) {
      points.features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [lng + (i - 250) * 0.0004, lat + (j - 200) * 0.0003],
        },
        properties: { row: j, column: i },
      });
    }
  }
  onBig(true);
  const started = performance.now();
  const result = await draw.document.load(points, {
    layer: { id: BIG_LAYER, name: '200,000 points' },
  });
  const ms = Math.round(performance.now() - started);
  if (!result) onBig(false);
  console.info(result ? `200,000 points: loaded in ${ms} ms` : 'Read-only');
}
