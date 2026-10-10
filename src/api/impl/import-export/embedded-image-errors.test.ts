// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the failures of an embedded image that has to be scaled down: every path of the
 * import reports them with the same codes, as a DrawError
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processImageDataUrl, UnsupportedImageTypeError } from '../../../shared/utils/image.js';
import type { AutoNameGenerator } from '../../../shared/utils/name-generator.js';
import { MemoryStore } from '../../../store/memory.js';
import type { Data } from '../../../store/types.js';
import { createResourceDeps } from '../../../test-utils.js';
import { DrawError } from '../../errors.js';
import { createDocument } from '../document.js';
import { prepareGeoJSON } from './geojson-import.js';
import { prepareNative } from './native-format.js';

vi.mock('../../../shared/utils/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/utils/image.js')>()),
  processImageDataUrl: vi.fn(),
}));

/** A PNG header of the size given, larger than the texture limit when it is over 4096 */
function pngDataUrl(width: number, height: number): string {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

const LARGE = pngDataUrl(8192, 8192);

const geojson: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        'maplibre-gl-draw:featureType': 'Image',
        'maplibre-gl-draw:imageData': LARGE,
        'maplibre-gl-draw:imageMimeType': 'image/png',
      },
      geometry: { type: 'Point', coordinates: [0, 0] },
    },
  ],
};

const native = {
  version: '2.0.0',
  layers: [
    {
      id: 'l',
      name: 'l',
      visible: true,
      locked: false,
      opacity: 1,
      items: ['img'],
      styleRule: undefined,
      metadata: undefined,
    },
  ],
  layerOrder: ['l'],
  groups: [],
  features: [
    {
      id: 'img',
      type: 'Image',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: 'l',
      properties: { 'maplibre-gl-draw:imageFileId': 'f' },
      style: {},
      visible: true,
      locked: false,
    },
  ],
  files: { f: { id: 'f', mimeType: 'image/png', dataURL: LARGE } },
} as unknown as Data;

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({
    id: 'default-layer',
    name: 'Layer 1',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
});

const importDeps = () => ({
  store,
  autoNameGenerator: { generateName: () => undefined } as unknown as AutoNameGenerator,
  generateFeatureId: () => 'new',
  getCurrentLayerId: () => 'default-layer',
});

describe('an embedded image that cannot be decoded', () => {
  beforeEach(() => {
    vi.mocked(processImageDataUrl).mockRejectedValue(new Error('Failed to load image'));
  });

  it('is a DrawError invalid-input on the GeoJSON path, not the raw error', async () => {
    const failure = prepareGeoJSON(geojson, importDeps());
    await expect(failure).rejects.toBeInstanceOf(DrawError);
    await expect(failure).rejects.toMatchObject({
      code: 'invalid-input',
      message: expect.stringContaining('cannot be decoded: Failed to load image'),
    });
  });

  it('is a DrawError invalid-input on the native path', async () => {
    const failure = prepareNative(native, { store });
    await expect(failure).rejects.toBeInstanceOf(DrawError);
    await expect(failure).rejects.toMatchObject({ code: 'invalid-input' });
  });
});

describe('an embedded image the browser cannot encode', () => {
  beforeEach(() => {
    vi.mocked(processImageDataUrl).mockRejectedValue(new UnsupportedImageTypeError('image/bmp'));
  });

  it('is unsupported-format on every path of document.load, as for an image file', async () => {
    const doc = createDocument(createResourceDeps(store));
    for (const source of [geojson, native]) {
      const failure = doc.load(source);
      await expect(failure).rejects.toBeInstanceOf(DrawError);
      await expect(failure).rejects.toMatchObject({
        code: 'unsupported-format',
        message: expect.stringContaining('unsupported type: image/bmp'),
      });
    }
    expect(store.listFeatures()).toEqual([]);
  });
});
