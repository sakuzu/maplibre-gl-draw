// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the validation of embedded image data URLs
 */

import { describe, expect, it } from 'vitest';
import { isEmbeddedImageDataUrl, readEmbeddedImage } from './embedded-image.js';

function dataUrl(mimeType: string, bytes: number[]): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const le16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const le24 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

function png(width: number, height: number): number[] {
  return [
    0x89,
    ...ascii('PNG\r\n\x1a\n'),
    ...be32(13),
    ...ascii('IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
  ];
}

function gif(width: number, height: number): number[] {
  return [...ascii('GIF89a'), ...le16(width), ...le16(height), 0, 0, 0];
}

function jpeg(width: number, height: number): number[] {
  return [
    0xff,
    0xd8,
    // APP0 (length 16)
    0xff,
    0xe0,
    0x00,
    0x10,
    ...ascii('JFIF\0'),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    // SOF0
    0xff,
    0xc0,
    0x00,
    0x11,
    8,
    (height >> 8) & 255,
    height & 255,
    (width >> 8) & 255,
    width & 255,
    3,
  ];
}

function webpVp8x(width: number, height: number): number[] {
  return [
    ...ascii('RIFF'),
    0,
    0,
    0,
    0,
    ...ascii('WEBPVP8X'),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...le24(width - 1),
    ...le24(height - 1),
  ];
}

describe('readEmbeddedImage', () => {
  it('reads the size of a PNG', () => {
    expect(readEmbeddedImage(dataUrl('image/png', png(300, 200)))).toEqual({
      mimeType: 'image/png',
      width: 300,
      height: 200,
    });
  });

  it('reads the size of a GIF', () => {
    expect(readEmbeddedImage(dataUrl('image/gif', gif(17, 9)))).toEqual({
      mimeType: 'image/gif',
      width: 17,
      height: 9,
    });
  });

  it('reads the size of a JPEG after skipping the segments before the frame header', () => {
    expect(readEmbeddedImage(dataUrl('image/jpeg', jpeg(640, 480)))).toEqual({
      mimeType: 'image/jpeg',
      width: 640,
      height: 480,
    });
  });

  it('reads the size of an extended WebP', () => {
    expect(readEmbeddedImage(dataUrl('image/webp', webpVp8x(5000, 70)))).toEqual({
      mimeType: 'image/webp',
      width: 5000,
      height: 70,
    });
  });

  it('rejects a URL that would make the viewer send a request', () => {
    expect(readEmbeddedImage('https://example.com/tracker.png')).toBeNull();
    expect(readEmbeddedImage('//example.com/tracker.png')).toBeNull();
    expect(readEmbeddedImage('blob:https://example.com/1234')).toBeNull();
  });

  it('rejects SVG and non-Base64 data URLs', () => {
    expect(readEmbeddedImage('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBeNull();
    expect(readEmbeddedImage('data:image/png,%89PNG')).toBeNull();
    expect(readEmbeddedImage('data:image/png;base64,not base64!')).toBeNull();
  });

  it('rejects bytes that do not match the declared type', () => {
    expect(readEmbeddedImage(dataUrl('image/jpeg', png(10, 10)))).toBeNull();
    expect(readEmbeddedImage(dataUrl('image/png', ascii('<html></html>')))).toBeNull();
  });

  it('rejects an image with a zero size', () => {
    expect(readEmbeddedImage(dataUrl('image/png', png(0, 10)))).toBeNull();
  });

  it('rejects anything that is not a string', () => {
    expect(readEmbeddedImage(undefined)).toBeNull();
    expect(readEmbeddedImage({ src: 'data:image/png;base64,' })).toBeNull();
  });
});

describe('isEmbeddedImageDataUrl', () => {
  it('accepts only the embedded raster forms', () => {
    expect(isEmbeddedImageDataUrl(dataUrl('image/webp', webpVp8x(1, 1)))).toBe(true);
    expect(isEmbeddedImageDataUrl('http://example.com/a.png')).toBe(false);
    expect(isEmbeddedImageDataUrl('data:text/html;base64,PGgxPg==')).toBe(false);
  });
});
