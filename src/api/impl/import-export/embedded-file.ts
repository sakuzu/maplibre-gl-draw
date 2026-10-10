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

import { readEmbeddedImage } from '../../../shared/utils/embedded-image.js';
import {
  exceedsMaxImageSize,
  processImageDataUrl,
  UnsupportedImageTypeError,
} from '../../../shared/utils/image.js';

/** An embedded image accepted for import */
export interface EmbeddedFileContent {
  mimeType: string;
  dataURL: string;
}

/**
 * Why an embedded image cannot be imported
 *
 * - `invalid-input`: the data URL is not an embedded PNG / JPEG / WebP / GIF of its declared
 *   type, or its pixels cannot be decoded
 * - `unsupported-format`: it has to be scaled down and the browser cannot encode the result in
 *   a type the library accepts
 */
export interface EmbeddedFileProblem {
  code: 'invalid-input' | 'unsupported-format';
  /** What went wrong, in English, to follow the name of the image in a message */
  detail: string;
  /** The error that was caught, when there was one */
  cause?: unknown;
}

/**
 * Validates and normalizes an embedded image
 *
 * Nothing is thrown: an error of the decoding or the encoding is returned as a problem.
 *
 * @param dataURL - the image data URL found in the data
 * @param mimeType - the MIME type declared next to it
 * @returns the content to store, or the reason it cannot be imported
 */
export async function normalizeEmbeddedFile(
  dataURL: unknown,
  mimeType: unknown,
): Promise<EmbeddedFileContent | EmbeddedFileProblem> {
  const info = readEmbeddedImage(dataURL);
  if (!info || typeof dataURL !== 'string' || mimeType !== info.mimeType) {
    return {
      code: 'invalid-input',
      detail: 'is not an embedded PNG / JPEG / WebP / GIF data URL of its declared type',
    };
  }

  if (exceedsMaxImageSize(info.width, info.height)) {
    let processed: Awaited<ReturnType<typeof processImageDataUrl>>;
    try {
      processed = await processImageDataUrl(dataURL);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof UnsupportedImageTypeError) {
        return { code: 'unsupported-format', detail: `cannot be stored: ${message}`, cause: error };
      }
      return { code: 'invalid-input', detail: `cannot be decoded: ${message}`, cause: error };
    }
    return { mimeType: processed.mimeType, dataURL: processed.dataUrl };
  }
  return { mimeType: info.mimeType, dataURL };
}

/** Whether the result of {@link normalizeEmbeddedFile} is a problem */
export function isEmbeddedFileProblem(
  result: EmbeddedFileContent | EmbeddedFileProblem,
): result is EmbeddedFileProblem {
  return 'code' in result;
}
