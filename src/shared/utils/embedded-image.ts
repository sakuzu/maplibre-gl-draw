// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedded image data URLs
 *
 * Image features reference their pixels through a data URL held in FileData. Such a URL is
 * handed to `new Image().src`, so anything other than an embedded raster image (an http(s)
 * URL, a blob URL, SVG and so on) would make every viewer of the data send a request to an
 * outside host or run a decoder the library does not expect. The only accepted form is
 * `data:image/(png|jpeg|webp|gif);base64,…`, and the pixel size is read from the header of the
 * decoded bytes so that an oversized image can be scaled down before it reaches the GPU.
 */

/** The MIME types accepted for embedded images */
export const EMBEDDED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type EmbeddedImageMimeType = (typeof EMBEDDED_IMAGE_MIME_TYPES)[number];

const EMBEDDED_IMAGE_PREFIX = /^data:(image\/(?:png|jpeg|webp|gif));base64,/;
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;

/** The facts read from an embedded image */
export interface EmbeddedImageInfo {
  /** The MIME type found in the bytes (it matches the one in the data URL) */
  mimeType: EmbeddedImageMimeType;
  width: number;
  height: number;
}

/**
 * Whether the value has the form of an embedded raster image data URL
 *
 * Only the prefix and the Base64 alphabet are checked; the bytes are not decoded. Used at the
 * rendering boundary, where the value has already been validated on import.
 */
export function isEmbeddedImageDataUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = EMBEDDED_IMAGE_PREFIX.exec(value);
  if (!match) return false;
  return BASE64_BODY.test(value.slice(match[0].length));
}

/**
 * Reads the MIME type and the pixel size of an embedded image data URL
 *
 * @returns null when the value is not an accepted data URL, when the bytes are not an image
 *   of the declared type, or when the size cannot be read
 */
export function readEmbeddedImage(value: unknown): EmbeddedImageInfo | null {
  if (!isEmbeddedImageDataUrl(value)) return null;
  const match = EMBEDDED_IMAGE_PREFIX.exec(value);
  if (!match) return null;
  const declared = match[1] as EmbeddedImageMimeType;

  let bytes: string;
  try {
    bytes = atob(value.slice(match[0].length));
  } catch {
    return null;
  }

  const info = readImageHeader(bytes);
  if (!info || info.mimeType !== declared) return null;
  if (!(info.width > 0 && info.height > 0)) return null;
  return info;
}

// ============================================================================
// Header parsing (bytes are a binary string, one char per byte)
// ============================================================================

function u8(b: string, i: number): number {
  return b.charCodeAt(i) & 0xff;
}

function u16be(b: string, i: number): number {
  return (u8(b, i) << 8) | u8(b, i + 1);
}

function u16le(b: string, i: number): number {
  return u8(b, i) | (u8(b, i + 1) << 8);
}

function u24le(b: string, i: number): number {
  return u8(b, i) | (u8(b, i + 1) << 8) | (u8(b, i + 2) << 16);
}

function u32be(b: string, i: number): number {
  return ((u8(b, i) << 24) >>> 0) + (u8(b, i + 1) << 16) + (u8(b, i + 2) << 8) + u8(b, i + 3);
}

function readImageHeader(b: string): EmbeddedImageInfo | null {
  if (b.startsWith('\x89PNG\r\n\x1a\n')) return readPng(b);
  if (b.startsWith('GIF87a') || b.startsWith('GIF89a')) return readGif(b);
  if (b.startsWith('RIFF') && b.slice(8, 12) === 'WEBP') return readWebp(b);
  if (u8(b, 0) === 0xff && u8(b, 1) === 0xd8) return readJpeg(b);
  return null;
}

function readPng(b: string): EmbeddedImageInfo | null {
  // The first chunk is IHDR: width and height are big-endian uint32 at 16 and 20
  if (b.length < 24 || b.slice(12, 16) !== 'IHDR') return null;
  return { mimeType: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
}

function readGif(b: string): EmbeddedImageInfo | null {
  if (b.length < 10) return null;
  return { mimeType: 'image/gif', width: u16le(b, 6), height: u16le(b, 8) };
}

function readWebp(b: string): EmbeddedImageInfo | null {
  const chunk = b.slice(12, 16);
  if (chunk === 'VP8 ') {
    if (b.length < 30) return null;
    return {
      mimeType: 'image/webp',
      width: u16le(b, 26) & 0x3fff,
      height: u16le(b, 28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    if (b.length < 25) return null;
    const b0 = u8(b, 21);
    const b1 = u8(b, 22);
    const b2 = u8(b, 23);
    const b3 = u8(b, 24);
    return {
      mimeType: 'image/webp',
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === 'VP8X') {
    if (b.length < 30) return null;
    return { mimeType: 'image/webp', width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  }
  return null;
}

function readJpeg(b: string): EmbeddedImageInfo | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (u8(b, i) !== 0xff) return null;
    const marker = u8(b, i + 1);
    if (marker === 0xff) {
      // Fill byte
      i += 1;
      continue;
    }
    // Markers without a length field
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { mimeType: 'image/jpeg', width: u16be(b, i + 7), height: u16be(b, i + 5) };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    i += 2 + u16be(b, i + 2);
  }
  return null;
}
