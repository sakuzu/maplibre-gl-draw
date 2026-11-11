// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// An image file as a GeoJSON feature of the type Image, to import at a position: the picture as
// a data URL under `maplibre-gl-draw:imageData`, as the GeoJSON the library writes out carries
// it, drawn at its size in pixels at the zoom given.

import type { Feature, Position } from 'geojson';

/** The types of image the library keeps in a document */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Whether a file is an image the library keeps (PNG, JPEG, WebP or GIF) */
export function isImageFile(file: Blob): boolean {
  return IMAGE_TYPES.includes(file.type);
}

/** An image file as a feature centered on `at`, at its size in pixels at `zoom` */
export async function imageFeature(file: Blob, at: Position, zoom: number): Promise<Feature> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  bitmap.close();
  const dataURL = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result as string));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsDataURL(file);
  });
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: at },
    properties: {
      ...(file instanceof File && { name: file.name }),
      'maplibre-gl-draw:featureType': 'Image',
      'maplibre-gl-draw:imageData': dataURL,
      'maplibre-gl-draw:imageMimeType': file.type,
      'maplibre-gl-draw:imageWidth': width,
      'maplibre-gl-draw:imageHeight': height,
      'maplibre-gl-draw:createdZoom': zoom,
    },
  };
}
