// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the `generateId` option: every ID the library makes comes from it
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createId } from '../../shared/utils/id.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';

vi.mock('../../shared/utils/id', () => ({ createId: vi.fn(() => 'built-in') }));

// The image of a file is decoded by the browser; here it comes back as a small PNG
vi.mock('../../shared/utils/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/utils/image.js')>()),
  processImageFile: vi.fn(async () => ({
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    width: 10,
    height: 10,
    mimeType: 'image/png',
  })),
}));

/** A 10 by 10 PNG header, enough for the embedded image check (it is not scaled down) */
function smallPng(): string {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(10, 16);
  bytes.writeUInt32BE(10, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

let draw: Draw;
let minted: string[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(createId).mockClear();
  minted = [];
  draw = createDraw(createMapStub().map, {
    generateId: () => {
      const id = `app-${minted.length + 1}`;
      minted.push(id);
      return id;
    },
  });
});

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

/** Every ID of the document but the one of the layer the instance starts with */
function documentIds(): string[] {
  const store = draw.getStore();
  return [
    ...store.listLayers().map((layer) => layer.id),
    ...store.listGroups().map((group) => group.id),
    ...store.listFeatures().map((feature) => feature.id),
    ...store.listFiles().map((file) => file.id),
  ].filter((id) => id !== 'default-layer');
}

describe('generateId', () => {
  it('makes every ID the library creates', async () => {
    // Draw a point, and a line through the pending ID of the drawing mode
    draw.setMode('draw_point');
    draw.drawing.addVertex([0.5, 0.5]);
    draw.setMode('draw_line');
    draw.drawing.addVertex([-1, 0.5]);
    draw.drawing.addVertex([2, 0.5]);
    expect(draw.drawing.finish()).toBe(true);
    const [point] = draw.features.list({ type: 'Point' });
    const [line] = draw.features.list({ type: 'LineString' });

    // Split an area along the line: the results are new features
    const area = draw.features.create({
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      },
    });
    const pieces = draw.features.split(area?.id ?? '', line.id);
    expect(pieces).toHaveLength(2);

    // Group a selection, and create a layer
    draw.selection.set('feature', [point.id, line.id]);
    const group = draw.selection.group();
    const layer = draw.layers.create({ name: 'more' });

    // Paste an image, and load GeoJSON with an embedded image
    const image = new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' });
    await draw.document.load(image, { coordinate: [0, 0] });
    await draw.document.load({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            'maplibre-gl-draw:featureType': 'Image',
            'maplibre-gl-draw:imageData': smallPng(),
            'maplibre-gl-draw:imageMimeType': 'image/png',
          },
          geometry: { type: 'Point', coordinates: [1, 1] },
        },
      ],
    });

    const ids = documentIds();
    expect(group && minted.includes(group.id)).toBe(true);
    expect(layer && minted.includes(layer.id)).toBe(true);
    // Two Images and their two files
    expect(draw.getStore().listFiles()).toHaveLength(2);
    expect(draw.features.list({ type: 'Image' })).toHaveLength(2);
    for (const id of ids) expect(minted).toContain(id);
    expect(new Set(minted).size).toBe(minted.length);
    expect(createId).not.toHaveBeenCalled();
  });

  it('can only be given when the instance is created, as a function', () => {
    expect(() => draw.options.update({ generateId: () => 'x' } as never)).toThrow(DrawError);
    expect(() => createDraw(createMapStub().map, { generateId: 'x' as never })).toThrow(DrawError);
  });
});

describe('without generateId', () => {
  it('makes the IDs with the built-in generator', () => {
    const other = createDraw(createMapStub().map);
    other.setMode('draw_point');
    other.drawing.addVertex([0, 0]);
    expect(other.features.list()[0].id).toBe('built-in');
    other.destroy();
  });
});
