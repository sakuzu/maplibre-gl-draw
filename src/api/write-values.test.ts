// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the values of an application on the document and its layers, the image the image
 * mode asks for, and the version of the format read
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapStub } from '../test-utils.js';
import type { Draw } from './draw.js';
import { createDraw } from './draw.js';
import { DrawError } from './errors.js';

// The image of a file is decoded by the browser; here it comes back as a small PNG
vi.mock('../shared/utils/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/image.js')>()),
  processImageFile: vi.fn(async () => ({
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    width: 10,
    height: 10,
    mimeType: 'image/png',
  })),
}));

let draw: Draw;

beforeEach(() => {
  draw = createDraw(createMapStub().map);
});

afterEach(() => {
  draw.destroy();
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'done';
  } catch (error) {
    if (error instanceof DrawError) return error.code;
    throw error;
  }
}

describe('the values of an application', () => {
  it('are kept on the document under keys of their prefix, apart from the title', async () => {
    await draw.write((tx) =>
      tx.document.update({ title: 'T', metadata: { 'app:basemap': 'positron', 'app:n': 1 } }),
    );
    expect(draw.document.title).toBe('T');
    expect(draw.document.metadata).toEqual({ 'app:basemap': 'positron', 'app:n': 1 });
    await draw.write((tx) =>
      tx.document.update({ metadata: { 'app:n': 2 }, unset: { metadata: ['app:basemap'] } }),
    );
    expect(draw.document.metadata).toEqual({ 'app:n': 2 });
    const written = draw.document.toJSON();
    expect(written.metadata).toEqual({ title: 'T', 'app:n': 2 });
    await draw.undo();
    expect(draw.document.metadata).toEqual({ 'app:basemap': 'positron', 'app:n': 1 });
  });

  it('refuses a key without a prefix, a value undefined and a value that is not JSON', async () => {
    for (const metadata of [{ basemap: 'x' }, { 'app:x': undefined }, { 'app:x': new Date() }]) {
      expect(
        await codeOf(draw.write((tx) => tx.document.update({ metadata: metadata as never }))),
      ).toBe('invalid-input');
    }
  });

  it('are merged on a layer key by key', async () => {
    const layerId = draw.layers.getActive()?.id as string;
    await draw.write((tx) => tx.layers.update(layerId, { metadata: { 'app:a': 1, 'app:b': 2 } }));
    await draw.write((tx) =>
      tx.layers.update(layerId, { metadata: { 'app:a': 3 }, unset: { metadata: ['app:b'] } }),
    );
    expect(draw.layers.get(layerId)?.metadata).toEqual({ 'app:a': 3 });
  });

  it('come back as they were when the document is opened again', async () => {
    await draw.write((tx) =>
      tx.document.update({ title: 'T', description: 'D', metadata: { 'app:v': [1, 2] } }),
    );
    const other = createDraw(createMapStub().map);
    await other.open(draw.document.toJSON());
    expect(other.document.title).toBe('T');
    expect(other.document.description).toBe('D');
    expect(other.document.metadata).toEqual({ 'app:v': [1, 2] });
    other.destroy();
  });
});

describe('the stacking order', () => {
  it('takes a dataset placed among the layers, before it is on the order', async () => {
    const layerId = draw.layers.getActive()?.id as string;
    draw.datasets.add({ id: 'cells', rows: [], order: 'layer-order' });
    await draw.write((tx) => tx.layers.place('cells', { below: layerId }));
    const order = draw.layers.getOrder();
    expect(order.indexOf('cells')).toBe(order.indexOf(layerId) + 1);
  });
});

describe('the format read', () => {
  it('upgrades a document of version 3, its features in the fields of version 3', async () => {
    const layerId = draw.layers.getActive()?.id as string;
    const v3 = {
      version: '3.0.0',
      metadata: { title: 'Old' },
      layers: [{ id: layerId, name: 'L', visible: true, locked: false, opacity: 1, items: ['p'] }],
      layerOrder: [layerId],
      features: [
        {
          id: 'p',
          type: 'Point',
          geometry: { type: 'Point', coordinates: [1, 2] },
          layerId,
          properties: { name: 'a' },
          style: { pointColor: '#ff0000' },
          visible: true,
          locked: false,
        },
      ],
    };
    await draw.open(v3 as never);
    expect(draw.document.title).toBe('Old');
    expect(draw.features.get('p')?.properties).toMatchObject({
      name: 'a',
      'maplibre-gl-draw:style': { pointColor: '#ff0000' },
    });
  });

  it('refuses a version that has no upgrade', async () => {
    const earlier = { ...draw.document.toJSON(), version: '1.0.0' };
    expect(await codeOf(draw.open(earlier))).toBe('invalid-input');
  });

  it('writes the title and the description in the metadata', async () => {
    await draw.write((tx) => tx.document.update({ title: 'T', description: 'D' }));
    expect(draw.document.toJSON().metadata).toEqual({ title: 'T', description: 'D' });
  });
});

describe('the image the image mode asks for', () => {
  it('is placed where the mode asked, as one commit', async () => {
    const asked: unknown[] = [];
    const image = new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' });
    draw.options.update({
      requestImage: async (at) => {
        asked.push(at);
        return image;
      },
    });
    const changes: unknown[] = [];
    draw.on('change', (change) => changes.push(change));
    draw.mode.set('draw_image');
    draw.mode.drawing.add([0, 0]);
    await vi.waitFor(() => expect(draw.features.count()).toBe(1));
    expect(asked).toHaveLength(1);
    expect(changes).toHaveLength(1);
    const [feature] = draw.features.list(undefined, { limit: 1 });
    expect(feature.properties['maplibre-gl-draw:featureType']).toBe('Image');
    await draw.undo();
    expect(draw.features.count()).toBe(0);
  });
});
