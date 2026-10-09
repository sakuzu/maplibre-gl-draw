// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the conversion of images through a canvas
 *
 * A browser that cannot encode WebP from a canvas returns another type from `toDataURL`. The
 * MIME type reported with the image is the one of the data URL that came back, and a type the
 * library does not accept is an error. The canvas, the image and the file reader are stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processImageDataUrl, processImageFile, UnsupportedImageTypeError } from './image.js';

/** What the stubbed canvas returns from toDataURL */
let returnedDataUrl = '';
const toDataURL = vi.fn((_type?: string, _quality?: number) => returnedDataUrl);

class StubImage {
  naturalWidth = 200;
  naturalHeight = 100;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

class StubFileReader {
  result: string | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(_file: Blob): void {
    this.result = 'data:image/png;base64,AAAA';
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  toDataURL.mockClear();
  vi.stubGlobal('Image', StubImage);
  vi.stubGlobal('FileReader', StubFileReader);
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toDataURL,
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('processImageDataUrl', () => {
  it('reports WebP when the browser returns WebP', async () => {
    returnedDataUrl = 'data:image/webp;base64,UklGRg==';
    const processed = await processImageDataUrl('data:image/png;base64,AAAA');
    expect(toDataURL).toHaveBeenCalledWith('image/webp', expect.any(Number));
    expect(processed).toEqual({
      dataUrl: 'data:image/webp;base64,UklGRg==',
      width: 200,
      height: 100,
      mimeType: 'image/webp',
    });
  });

  it('reports PNG when WebP is requested and the browser returns PNG', async () => {
    returnedDataUrl = 'data:image/png;base64,iVBORw==';
    const processed = await processImageDataUrl('data:image/png;base64,AAAA');
    expect(toDataURL).toHaveBeenCalledWith('image/webp', expect.any(Number));
    expect(processed.mimeType).toBe('image/png');
    expect(processed.dataUrl).toBe('data:image/png;base64,iVBORw==');
  });

  it('fails when the browser returns a type that is not accepted', async () => {
    returnedDataUrl = 'data:image/bmp;base64,Qk0=';
    await expect(processImageDataUrl('data:image/png;base64,AAAA')).rejects.toBeInstanceOf(
      UnsupportedImageTypeError,
    );
  });

  it('fails when the browser returns an empty data URL', async () => {
    returnedDataUrl = 'data:,';
    await expect(processImageDataUrl('data:image/png;base64,AAAA')).rejects.toBeInstanceOf(
      UnsupportedImageTypeError,
    );
  });
});

describe('processImageFile', () => {
  it('reports PNG for a pasted file when WebP is requested and the browser returns PNG', async () => {
    returnedDataUrl = 'data:image/png;base64,iVBORw==';
    const file = new File([new Uint8Array([0])], 'pasted.png', { type: 'image/png' });
    const processed = await processImageFile(file);
    expect(toDataURL).toHaveBeenCalledWith('image/webp', expect.any(Number));
    expect(processed.mimeType).toBe('image/png');
    expect(processed.dataUrl).toBe('data:image/png;base64,iVBORw==');
  });
});
