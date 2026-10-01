// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The switches of the playground that are not tools: actions of the standard UI, in the card at
// the bottom left of the map, each with a letter and Shift as its key (listed with ?). The modes
// are tools of the toolbar instead, and the globe is the globe button of the map's controls.

import type { DatasetRow, Draw } from '@sakuzu/maplibre-gl-draw';
import type { ActionSpec, DrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import type { FeatureCollection } from 'geojson';
import type * as maplibregl from 'maplibre-gl';
import { DEM_TILES } from '../examples/basemap.ts';

/** Where Save keeps the drawing */
const STORAGE_KEY = 'maplibre-gl-draw-playground';
const DATASET_ID = 'cells';
const BIG_LAYER = 'two-hundred-thousand';

/** The switches over a draw instance and its map, in English or in Japanese */
export function createSwitches(draw: Draw, map: maplibregl.Map, ja: boolean): ActionSpec[] {
  return [
    {
      id: 'terrain',
      label: ja ? '地形' : 'Terrain',
      kind: 'toggle',
      shortcut: 'shift+t',
      run: () => toggleTerrain(map),
      checked: () => map.getTerrain() !== null,
    },
    {
      id: 'cells',
      label: ja ? '1 万のセル' : '10,000 cells',
      kind: 'toggle',
      shortcut: 'shift+d',
      run: () => toggleCells(draw, map),
      checked: () => draw.datasets.get(DATASET_ID) !== undefined,
    },
    {
      id: 'read-only',
      label: ja ? '読み取り専用' : 'Read-only',
      kind: 'toggle',
      shortcut: 'shift+r',
      run: () => {
        draw.setReadOnly(!draw.isReadOnly());
        console.info(`Read-only: ${draw.isReadOnly()}`);
      },
      checked: () => draw.isReadOnly(),
    },
    {
      id: 'interaction-lock',
      label: ja ? '操作の錠' : 'Interaction lock',
      kind: 'toggle',
      shortcut: 'shift+k',
      run: () => {
        draw.setInteractionLocked(!draw.isInteractionLocked());
        console.info(`Interaction lock: ${draw.isInteractionLocked()}`);
      },
      checked: () => draw.isInteractionLocked(),
    },
    {
      id: 'big',
      label: ja ? '20 万の点' : '200,000 points',
      kind: 'toggle',
      shortcut: 'shift+b',
      run: () => void toggleBig(draw, map),
      checked: () => draw.layers.get(BIG_LAYER) !== undefined,
    },
    {
      id: 'save',
      label: ja ? '保存' : 'Save',
      kind: 'action',
      shortcut: 'shift+s',
      hint: ja ? 'このブラウザーに保存します' : 'In this browser (localStorage)',
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
      id: 'open',
      label: ja ? '開く' : 'Open',
      kind: 'action',
      shortcut: 'shift+o',
      run: async () => {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === null) {
          console.info('Nothing is saved yet (Save, Shift+S)');
          return;
        }
        const result = await draw.document.load(JSON.parse(saved));
        console.info(result ? `Opened ${result.featureIds.length} features` : 'Read-only');
      },
    },
  ];
}

/**
 * Puts the switches in the card of actions of the standard UI. They show what they read from the
 * draw instance and the map, which the card reads again after each press and on the events that
 * change it, also when code or another control changes it
 */
export function addSwitches(ui: DrawUI, draw: Draw, map: maplibregl.Map, ja: boolean): void {
  for (const action of createSwitches(draw, map, ja)) ui.actions.add(action);
  const refresh = () => ui.actions.refresh();
  for (const event of [
    'readOnly.changed',
    'interactionLock.changed',
    'layer.created',
    'layer.deleted',
    'dataset.added',
    'dataset.removed',
  ] as const) {
    draw.on(event, refresh);
  }
  map.on('terrain', refresh);
}

/** The terrain of the map, from the elevation tiles of the examples, tilted to be seen */
function toggleTerrain(map: maplibregl.Map): void {
  if (!map.getSource('dem')) {
    map.addSource('dem', { type: 'raster-dem', url: DEM_TILES });
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

/**
 * 200,000 points in a layer of their own, every one an editable feature. The layer panel of the
 * standard UI lists none of them, only their number under the layer, as for any layer of more
 * than 1,000 features
 */
async function toggleBig(draw: Draw, map: maplibregl.Map): Promise<void> {
  if (draw.layers.get(BIG_LAYER)) {
    if (!draw.layers.delete(BIG_LAYER)) return;
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
  const started = performance.now();
  const result = await draw.document.load(points, {
    layer: { id: BIG_LAYER, name: '200,000 points' },
  });
  const ms = Math.round(performance.now() - started);
  console.info(result ? `200,000 points: loaded in ${ms} ms` : 'Read-only');
}
