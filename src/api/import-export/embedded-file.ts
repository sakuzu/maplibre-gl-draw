// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Validation of the image data carried by imported files
 *
 * Both the native format (`files[].dataURL`) and GeoJSON (`maplibre-gl-draw:imageData`) carry
 * the pixels of an Image feature as a data URL. Only an embedded PNG / JPEG / WebP / GIF is
 * accepted, its header must agree with the declared MIME type, and an image larger than the
 * texture limit is scaled down here, the same as when an image file is loaded.
 */

import { readEmbeddedImage } from '../../shared/utils/embedded-image.js';
import { exceedsMaxImageSize, processImageDataUrl } from '../../shared/utils/image.js';

/** An embedded image accepted for import */
export interface EmbeddedFileContent {
  mimeType: string;
  dataURL: string;
}

/**
 * Validates and normalizes an embedded image
 *
 * @param dataURL - the image data URL found in the data
 * @param mimeType - the MIME type declared next to it
 * @returns the content to store, or null when it is not an accepted embedded image
 */
export async function normalizeEmbeddedFile(
  dataURL: unknown,
  mimeType: unknown,
): Promise<EmbeddedFileContent | null> {
  const info = readEmbeddedImage(dataURL);
  if (!info || typeof dataURL !== 'string') return null;
  if (mimeType !== info.mimeType) return null;

  if (exceedsMaxImageSize(info.width, info.height)) {
    const processed = await processImageDataUrl(dataURL);
    return { mimeType: processed.mimeType, dataURL: processed.dataUrl };
  }
  return { mimeType: info.mimeType, dataURL };
}
