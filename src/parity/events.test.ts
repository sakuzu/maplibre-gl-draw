// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of what the instance does: the events
 *
 * The scenes of the other axes read the events of every write, selection, hit, snap and drag.
 * These scenes add the events that no other axis gives (loading, the options, the datasets,
 * the images and the stacking order) and the fields of `document.changed` that only some
 * writes carry (the order inside a layer and a group, the selection, the editing, the mode,
 * the metadata and the files).
 */

import type { FeatureCollection } from 'geojson';
import { describe, vi } from 'vitest';
import type { DocumentChange, Draw, DrawDocument, Feature } from '../index.js';
import {
  createApplicationStore,
  createParityInstance,
  fillParityDocument,
  observeParity,
  type ParityInstance,
  parityQuiet,
  parityStoreView,
  parityTable,
  readParity,
  settleParity,
} from '../test-utils.js';

const table = parityTable('events');

/**
 * A scene: the document, then `setup` (not observed), then `act` (observed). With `store`, the
 * notifications of the Store of the instance (`draw.getStore().subscribe`) are read too.
 */
function scene(
  name: string,
  act: (draw: Draw, t: ParityInstance) => unknown,
  setup?: (draw: Draw, t: ParityInstance) => void,
  options: { drawing?: boolean; store?: boolean; isExternalEntry?: (id: string) => boolean } = {},
): void {
  table.scene(name, async () => {
    const { store, ...instance } = options;
    const t = createParityInstance({ initDefaultLayer: false, ...instance });
    fillParityDocument(t);
    if (setup) parityQuiet(() => setup(t.draw, t));
    const notified: DocumentChange[] = [];
    if (store) {
      settleParity();
      parityStoreView(t.draw.getStore()).subscribe((change) => notified.push(change));
    }
    const seen = await observeParity(t, () => act(t.draw, t));
    return store ? { ...seen, storeChanges: readParity(notified, 'storeChanges') } : seen;
  });
}

/** A PNG of one pixel */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A point of the native document */
function nativePoint(id: string, groupId: string | undefined, coordinates: number[]): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates },
    layerId: 'nl',
    groupId,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}

/** A native document of one layer with a group, a feature outside it and an image */
const NATIVE: DrawDocument = {
  version: '3.0.0',
  metadata: { title: 'Loaded' },
  layerOrder: ['nl'],
  layers: [
    {
      id: 'nl',
      name: 'Loaded layer',
      visible: true,
      locked: false,
      opacity: 1,
      items: ['ng', 'nf3', 'ni'],
      styleRule: undefined,
      metadata: undefined,
    },
  ],
  groups: [
    {
      id: 'ng',
      layerId: 'nl',
      name: 'NG',
      featureIds: ['nf1', 'nf2'],
      visible: true,
      locked: false,
    },
  ],
  features: [
    nativePoint('nf1', 'ng', [0.1, 0.1]),
    nativePoint('nf2', 'ng', [0.2, 0.2]),
    nativePoint('nf3', undefined, [0.3, 0.3]),
    {
      id: 'ni',
      type: 'Image',
      geometry: { type: 'Point', coordinates: [0.5, -0.5] },
      layerId: 'nl',
      groupId: undefined,
      properties: {
        'maplibre-gl-draw:imageFileId': 'nfile',
        'maplibre-gl-draw:imageWidth': 10,
        'maplibre-gl-draw:imageHeight': 10,
      },
      style: {},
      visible: true,
      locked: false,
    },
  ],
  files: { nfile: { id: 'nfile', mimeType: 'image/png', dataURL: PNG } },
};

/** A GeoJSON collection of a point, a line and a feature without a geometry (skipped) */
const COLLECTION = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'from GeoJSON' },
      geometry: { type: 'Point', coordinates: [0.4, -0.4] },
    },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [0.1, -0.1],
          [0.3, -0.2],
        ],
      },
    },
    { type: 'Feature', properties: {}, geometry: null },
  ],
} as unknown as FeatureCollection;

describe('loading', () => {
  scene('document.load a GeoJSON collection', (draw) => draw.document.load(COLLECTION));
  scene('document.load a GeoJSON collection into a new layer and group', (draw) =>
    draw.document.load(COLLECTION, { layer: { id: 'nl', name: 'New' }, group: { name: 'NG' } }),
  );
  scene('document.load a GeoJSON collection into a layer, flattened', (draw) =>
    draw.document.load(
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'MultiPoint',
          coordinates: [
            [0.1, 0.1],
            [0.2, 0.2],
          ],
        },
      },
      { layerId: 'lb', flattenMulti: true },
    ),
  );
  scene('document.load a geometry as text', (draw) =>
    draw.document.load(JSON.stringify({ type: 'Point', coordinates: [0.6, -0.6] })),
  );
  scene('document.load a native document, replacing', (draw) =>
    draw.document.load(NATIVE, { mode: 'replace' }),
  );
  scene('document.load a native document, merging', (draw) =>
    draw.document.load(NATIVE, { mode: 'merge' }),
  );
  scene('document.load text that is not JSON', (draw) => draw.document.load('not json'));
  scene(
    'document.load in read-only',
    (draw) => draw.document.load(COLLECTION),
    (draw) => draw.setReadOnly(true),
  );
  scene('document.loadMany of two', (draw) =>
    draw.document.loadMany([
      { source: COLLECTION },
      { source: { type: 'Point', coordinates: [0.7, -0.7] }, options: { layerId: 'lb' } },
    ]),
  );
  scene('document.load an image file', (draw) =>
    draw.document.load(
      new Blob([Buffer.from(PNG.split(',')[1], 'base64')], { type: 'image/png' }),
      {
        coordinate: [0.5, -0.5],
        zoom: 10,
      },
    ),
  );
});

describe('the fields of document.changed', () => {
  // The declaration of `DocumentChange` has `layerReorder` and `groupReorder`, but the published
  // version never sets them: an order inside a layer or a group arrives as `layers.updated` and
  // `groups.updated` (the rows record what the code does)
  //
  // The guide of saving says that the subscription to the Store delivers the same
  // `DocumentChange` as `document.changed`; the Store also notifies a change of the selection,
  // the mode or the editing alone, which `document.changed` leaves out (the rows read both)
  scene(
    'features.move inside a layer gives the order of the layer',
    (draw) => draw.features.move('pg', { layerId: 'la', index: 0 }),
    undefined,
    { store: true },
  );
  scene(
    'features.move inside a group gives the order of the group',
    (draw) => draw.features.move('gb', { groupId: 'g1', index: 0 }),
    undefined,
    { store: true },
  );
  scene(
    'selection.set gives the selection',
    (draw) => draw.selection.set('feature', ['pt']),
    undefined,
    { store: true },
  );
  scene('setMode gives the mode', (draw) => draw.setMode('drawLine'), undefined, { store: true });
  scene(
    'metadata.update gives the metadata',
    (draw) => draw.metadata.update({ title: 'M' }),
    undefined,
    { store: true },
  );
  scene(
    'a load with an image gives the files',
    (draw) => draw.document.load(NATIVE, { mode: 'replace' }),
    undefined,
    { store: true },
  );
  scene(
    'selection.delete gives the selection and the features',
    (draw) => draw.selection.delete(),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
    { store: true },
  );
  scene(
    'layers.reorder gives the order of the layers',
    (draw) => draw.layers.reorder(['lb', 'la', 'lc', 'ld']),
    undefined,
    { store: true },
  );
  table.scene('the editing a Store marks, ended by the select mode', async () => {
    const app = createApplicationStore();
    const t = createParityInstance({ initDefaultLayer: false, app });
    fillParityDocument(t);
    parityQuiet(() => t.draw.setMode('drawLine'));
    const notified: DocumentChange[] = [];
    settleParity();
    app.scene.subscribe((change) => notified.push(change));
    const seen = await observeParity(t, () => {
      app.scene.startEditing(['pt', 'ln']);
      return t.draw.setMode('select');
    });
    return { ...seen, storeChanges: readParity(notified, 'storeChanges') };
  });
});

describe('the options, the datasets, the images and the stacking order', () => {
  scene('options.update', (draw) =>
    draw.options.update({ snapping: { enabled: false }, clickTolerancePx: 6 }),
  );
  scene('datasets.add of rows', (draw) =>
    draw.datasets.add({
      id: 'ds',
      rows: [
        {
          type: 'Feature',
          properties: { n: 1 },
          geometry: { type: 'Point', coordinates: [0.5, -1.5] },
        },
      ],
    }),
  );
  scene(
    'datasets.remove',
    (draw) => draw.datasets.remove('ds'),
    (draw) => {
      draw.datasets.add({ id: 'ds', rows: [] });
    },
  );
  scene(
    'datasets.move above the layers',
    (draw) => draw.datasets.move('ds2', { order: 'aboveLayers' }),
    (draw) => {
      draw.datasets.addMany([
        { id: 'ds', rows: [] },
        { id: 'ds2', rows: [] },
      ]);
    },
  );
  scene(
    'datasets.move to an index',
    (draw) => draw.datasets.move('ds2', { index: 0 }),
    (draw) => {
      draw.datasets.addMany([
        { id: 'ds', rows: [] },
        { id: 'ds2', rows: [] },
      ]);
    },
  );
  scene(
    'a click on a row of an interactive dataset',
    (_draw, t) => t.map.click([0.5, -1.5]),
    (draw) => {
      draw.datasets.add({
        id: 'ds',
        interactive: true,
        rows: [
          {
            type: 'Feature',
            properties: { n: 1 },
            geometry: { type: 'Point', coordinates: [0.5, -1.5] },
          },
        ],
      });
    },
  );
  scene(
    'a click in the image mode',
    (_draw, t) => t.map.click([0.5, -0.5]),
    (draw) => draw.setMode('drawImage'),
  );
  scene(
    'an entry that is not a layer in the stacking order, drawn',
    (draw, t) => {
      draw.layers.reorder(['la', 'lb', 'external', 'lc', 'ld']);
      t.map.render();
    },
    (_draw, t) => t.map.render(),
    { drawing: true, isExternalEntry: (id) => id === 'external' },
  );
  table.scene('an image whose file cannot be decoded, drawn', async () => {
    const t = createParityInstance({ initDefaultLayer: false, drawing: true });
    parityQuiet(() => {
      t.map.render();
    });
    return observeParity(t, async () => {
      await t.draw.document.load(NATIVE, { mode: 'replace' });
      t.map.render();
      await vi.advanceTimersByTimeAsync(1000);
      t.map.render();
    });
  });
});

table.end();
