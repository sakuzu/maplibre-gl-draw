// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the validation of imported image data
 */

import { describe, expect, it, vi } from 'vitest';
import { processImageDataUrl, UnsupportedImageTypeError } from '../../../shared/utils/image.js';
import { normalizeEmbeddedFile } from './embedded-file.js';

vi.mock('../../../shared/utils/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/utils/image.js')>()),
  processImageDataUrl: vi.fn(async () => ({
    dataUrl: 'data:image/webp;base64,UklGRg==',
    width: 4096,
    height: 1024,
    mimeType: 'image/webp',
  })),
}));

function pngDataUrl(width: number, height: number): string {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

describe('normalizeEmbeddedFile', () => {
  it('keeps an image within the size limit as it is', async () => {
    const dataURL = pngDataUrl(100, 50);
    expect(await normalizeEmbeddedFile(dataURL, 'image/png')).toEqual({
      mimeType: 'image/png',
      dataURL,
    });
  });

  it('scales down an image larger than the texture limit', async () => {
    expect(await normalizeEmbeddedFile(pngDataUrl(16384, 4096), 'image/png')).toEqual({
      mimeType: 'image/webp',
      dataURL: 'data:image/webp;base64,UklGRg==',
    });
  });

  it('reports unsupported-format when the scaled-down result comes back in a type that is not accepted', async () => {
    vi.mocked(processImageDataUrl).mockRejectedValueOnce(
      new UnsupportedImageTypeError('image/bmp'),
    );
    expect(await normalizeEmbeddedFile(pngDataUrl(16384, 4096), 'image/png')).toMatchObject({
      code: 'unsupported-format',
      detail: 'cannot be stored: The browser returned an image of an unsupported type: image/bmp',
    });
  });

  it('reports invalid-input instead of throwing when the pixels cannot be decoded', async () => {
    const failure = new Error('Failed to load image');
    vi.mocked(processImageDataUrl).mockRejectedValueOnce(failure);
    expect(await normalizeEmbeddedFile(pngDataUrl(16384, 4096), 'image/png')).toEqual({
      code: 'invalid-input',
      detail: 'cannot be decoded: Failed to load image',
      cause: failure,
    });
  });

  it('reports invalid-input for an external URL', async () => {
    expect(await normalizeEmbeddedFile('https://example.com/a.png', 'image/png')).toMatchObject({
      code: 'invalid-input',
    });
  });

  it('reports invalid-input for a declared MIME type that disagrees with the data', async () => {
    expect(await normalizeEmbeddedFile(pngDataUrl(10, 10), 'image/jpeg')).toMatchObject({
      code: 'invalid-input',
    });
    expect(await normalizeEmbeddedFile(pngDataUrl(10, 10), undefined)).toMatchObject({
      code: 'invalid-input',
    });
  });
});
