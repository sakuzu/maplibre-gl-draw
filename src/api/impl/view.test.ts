// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.view.preview`: another document read into a Store of rows of its own and shown in place
 * of the document, read-only, until `null` is given. What is drawn is checked by the end-to-end
 * test of `draw.document.setShown`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature, Layer } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { DrawDocument } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';
import { exportNative } from './import-export/native-format.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

function live(): Draw {
  const { store } = createTableStore();
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  draws.push(draw);
  store.createLayer(layer('now', true, 1));
  return draw;
}

const point = (id: string, layerId: string, x: number): Feature => ({
  id,
  type: 'Point',
  geometry: { type: 'Point', coordinates: [x, 0] },
  layerId,
  groupId: undefined,
  properties: { n: x },
  style: {},
  visible: true,
  locked: false,
});

const layer = (id: string, visible: boolean, opacity: number): Layer => ({
  id,
  name: id.toUpperCase(),
  visible,
  locked: false,
  opacity,
  styleRule: undefined,
  metadata: undefined,
  items: [],
});

/** A past version, written out as a document of the library: two layers and three features */
function pastDocument(title: string): DrawDocument {
  const { store } = createTableStore();
  store.createLayer(layer('a', true, 1));
  store.createLayer(layer('b', false, 0.5));
  store.transact(() => {
    store.setMetadata({ title });
    for (const f of [point('f1', 'a', 1), point('f2', 'a', 2), point('f3', 'b', 3)]) {
      store.createFeature(f);
    }
    store.setLayerOrder(['b', 'a']);
  });
  return exportNative(store);
}

const past = pastDocument('past');

describe('draw.view.preview', () => {
  it('shows the source read-only in place of the document, and the document again for null', async () => {
    const draw = live();
    await draw.view.preview(past);
    const shown = draw.document.getShown();
    expect(shown).not.toBeNull();
    expect(draw.isReadOnly()).toBe(true);
    expect(shown?.getLayerOrder()).toEqual(['b', 'a']);
    expect(shown?.getLayer('b')?.opacity).toBe(0.5);
    expect(shown?.getFeature('f2')?.properties).toEqual({ n: 2 });
    expect(shown?.getMetadata().title).toBe('past');
    // The document does not change
    expect(draw.layers.list().map((l) => l.id)).toEqual(['now']);
    expect(draw.document.title).toBe('');
    await draw.view.preview(null);
    expect(draw.document.getShown()).toBeNull();
    expect(draw.isReadOnly()).toBe(false);
  });

  it('keeps the entries of the stacking order that are not layers, and what the source adds', async () => {
    const draw = live();
    const withEntries = {
      ...past,
      layerOrder: ['b', 'app:tiles', 'a'],
      records: [{ id: 'app:tiles' }],
    };
    await draw.view.preview(withEntries);
    expect(draw.document.getShown()?.getLayerOrder()).toEqual(['b', 'app:tiles', 'a']);
    await draw.view.preview(null);
  });

  it('reads GeoJSON and a JSON string as draw.open does', async () => {
    const draw = live();
    await draw.view.preview(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } },
        ],
      }),
    );
    const shown = draw.document.getShown();
    expect(shown?.getLayerOrder()).toHaveLength(1);
    expect(shown?.getLayer(shown.getLayerOrder()[0] ?? '')).toBeDefined();
    await draw.view.preview(null);
  });

  it('shows the last source asked for when two are read at once', async () => {
    const draw = live();
    const first = draw.view.preview(past);
    const second = draw.view.preview(pastDocument('second'));
    await Promise.all([first, second]);
    expect(draw.document.getShown()?.getMetadata().title).toBe('second');
  });

  it('refuses what cannot be read, and a signal that stopped it, showing nothing', async () => {
    const draw = live();
    await expect(draw.view.preview('not json')).rejects.toMatchObject({
      code: 'unsupported-format',
    });
    const stopped = new AbortController();
    stopped.abort();
    await expect(draw.view.preview(past, { signal: stopped.signal })).rejects.toBeInstanceOf(
      DrawError,
    );
    expect(draw.document.getShown()).toBeNull();
    expect(draw.isReadOnly()).toBe(false);
  });
});
