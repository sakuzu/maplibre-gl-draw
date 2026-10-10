// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the conversion of images through a canvas
 *
 * A browser that cannot encode WebP from a canvas returns another type from `toDataURL`. The
 * image is then encoded as JPEG when none of its pixels is transparent, and otherwise keeps the
 * type that came back. The MIME type reported with the image is the one of the data URL that came
 * back, and a type the library does not accept is an error. The canvas, the image and the file
 * reader are stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processImageDataUrl, processImageFile, UnsupportedImageTypeError } from './image.js';

/** What the stubbed canvas returns from toDataURL when WebP is requested */
let returnedDataUrl = '';
/** What the stubbed canvas returns from toDataURL when JPEG is requested */
let returnedJpegDataUrl = '';
const toDataURL = vi.fn((type?: string, _quality?: number) =>
  type === 'image/jpeg' ? returnedJpegDataUrl : returnedDataUrl,
);

/** The RGBA bytes the stubbed context returns from getImageData */
let pixels: Uint8ClampedArray = new Uint8ClampedArray();

/** RGBA bytes of `count` pixels, all opaque */
function opaquePixels(count: number): Uint8ClampedArray {
  return new Uint8ClampedArray(count * 4).fill(255);
}

/** RGBA bytes of `count` pixels, all opaque but the last one, whose alpha is 254 */
function pixelsWithOneTransparent(count: number): Uint8ClampedArray {
  const data = opaquePixels(count);
  data[count * 4 - 1] = 254;
  return data;
}

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
  returnedJpegDataUrl = 'data:image/jpeg;base64,/9j/4A==';
  pixels = opaquePixels(4);
  vi.stubGlobal('Image', StubImage);
  vi.stubGlobal('FileReader', StubFileReader);
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {}, getImageData: () => ({ data: pixels }) }),
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
    pixels = pixelsWithOneTransparent(4);
    const processed = await processImageDataUrl('data:image/png;base64,AAAA');
    expect(toDataURL).toHaveBeenCalledWith('image/webp', expect.any(Number));
    expect(processed.mimeType).toBe('image/png');
    expect(processed.dataUrl).toBe('data:image/png;base64,iVBORw==');
  });

  it('keeps WebP without encoding again when the browser returns WebP', async () => {
    returnedDataUrl = 'data:image/webp;base64,UklGRg==';
    const processed = await processImageDataUrl('data:image/png;base64,AAAA');
    expect(toDataURL).toHaveBeenCalledTimes(1);
    expect(toDataURL).toHaveBeenCalledWith('image/webp', 0.95);
    expect(processed.mimeType).toBe('image/webp');
    expect(processed.dataUrl).toBe('data:image/webp;base64,UklGRg==');
  });

  it('encodes an opaque image as JPEG when the browser returns PNG for WebP', async () => {
    returnedDataUrl = 'data:image/png;base64,iVBORw==';
    pixels = opaquePixels(4);
    const processed = await processImageDataUrl('data:image/png;base64,AAAA');
    expect(toDataURL).toHaveBeenNthCalledWith(1, 'image/webp', 0.95);
    expect(toDataURL).toHaveBeenNthCalledWith(2, 'image/jpeg', 0.92);
    expect(processed).toEqual({
      dataUrl: 'data:image/jpeg;base64,/9j/4A==',
      width: 200,
      height: 100,
      mimeType: 'image/jpeg',
    });
  });

  it('keeps PNG for an image with a transparent pixel when the browser returns PNG for WebP', async () => {
    returnedDataUrl = 'data:image/png;base64,iVBORw==';
    pixels = pixelsWithOneTransparent(4);
    const processed = await processImageDataUrl('data:image/png;base64,AAAA');
    expect(toDataURL).toHaveBeenCalledTimes(1);
    expect(toDataURL).not.toHaveBeenCalledWith('image/jpeg', expect.anything());
    expect(processed.mimeType).toBe('image/png');
    expect(processed.dataUrl).toBe('data:image/png;base64,iVBORw==');
  });

  it('reports the type the browser returns when JPEG is requested', async () => {
    returnedDataUrl = 'data:image/png;base64,iVBORw==';
    returnedJpegDataUrl = 'data:image/png;base64,iVBORw0K';
    pixels = opaquePixels(4);
    const processed = await processImageDataUrl('data:image/png;base64,AAAA');
    expect(toDataURL).toHaveBeenNthCalledWith(2, 'image/jpeg', 0.92);
    expect(processed.mimeType).toBe('image/png');
    expect(processed.dataUrl).toBe('data:image/png;base64,iVBORw0K');
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
    pixels = pixelsWithOneTransparent(4);
    const file = new File([new Uint8Array([0])], 'pasted.png', { type: 'image/png' });
    const processed = await processImageFile(file);
    expect(toDataURL).toHaveBeenCalledWith('image/webp', expect.any(Number));
    expect(processed.mimeType).toBe('image/png');
    expect(processed.dataUrl).toBe('data:image/png;base64,iVBORw==');
  });
});
