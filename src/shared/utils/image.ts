// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image processing utilities
 *
 * Converts an image file into the WebP format, resizing it when necessary.
 */

export interface ProcessedImage {
  dataUrl: string;
  width: number;
  height: number;
  mimeType: string;
}

const WEBP_QUALITY = 0.95;

/**
 * Maximum size of an image
 * A value that accounts for the WebGL texture limit (modern GPUs support 4096 or more)
 */
export const MAX_IMAGE_SIZE = 4096;

/**
 * Tests whether the image needs to be resized and, when it does, computes the new size
 */
function calculateResizedDimensions(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number; needsResize: boolean } {
  if (width <= maxSize && height <= maxSize) {
    return { width, height, needsResize: false };
  }

  const aspectRatio = width / height;
  let newWidth: number;
  let newHeight: number;

  if (width > height) {
    newWidth = maxSize;
    newHeight = Math.round(maxSize / aspectRatio);
  } else {
    newHeight = maxSize;
    newWidth = Math.round(maxSize * aspectRatio);
  }

  return { width: newWidth, height: newHeight, needsResize: true };
}

/**
 * Converts a file into a DataURL in the WebP format
 * A large image is resized automatically
 */
export async function processImageFile(file: File): Promise<ProcessedImage> {
  return processImageDataUrl(await fileToDataUrl(file));
}

/**
 * Whether an image of this size has to be scaled down before it is used as a texture
 */
export function exceedsMaxImageSize(width: number, height: number): boolean {
  return width > MAX_IMAGE_SIZE || height > MAX_IMAGE_SIZE;
}

/**
 * Converts an image DataURL into a DataURL in the WebP format
 * A large image is resized automatically
 */
export async function processImageDataUrl(originalDataUrl: string): Promise<ProcessedImage> {
  // 1. Load it as an Image (to get the dimensions)
  const img = await loadImage(originalDataUrl);

  // 2. Decide whether it needs to be resized
  const { width, height } = calculateResizedDimensions(
    img.naturalWidth,
    img.naturalHeight,
    MAX_IMAGE_SIZE,
  );

  // 3. Draw it onto a Canvas and convert it into WebP
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get canvas 2d context');
  }

  // Settings for a high-quality resize
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.drawImage(img, 0, 0, width, height);

  // 4. Convert into WebP
  const webpDataUrl = canvas.toDataURL('image/webp', WEBP_QUALITY);

  return {
    dataUrl: webpDataUrl,
    width,
    height,
    mimeType: 'image/webp',
  };
}

/**
 * Converts a File into a DataURL
 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to read file as data URL'));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Loads an image from a DataURL
 */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

/**
 * Tests whether it is an image file
 */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}
