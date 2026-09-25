// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Import of image files (creates an Image feature)
 */

import { processImageFile } from '../../shared/utils/image.js';
import type { AutoNameGenerator } from '../../shared/utils/name-generator.js';
import type { Store } from '../../store/store.js';
import type { Feature, FileData, LoadOptions, LoadResult } from '../../store/types.js';

/**
 * Imports an image file and creates an Image feature
 */
export async function loadImage(
  file: File,
  options: LoadOptions,
  deps: {
    store: Store;
    autoNameGenerator: AutoNameGenerator;
    generateFeatureId: () => string;
    getCurrentLayerId: () => string;
  },
): Promise<LoadResult> {
  if (!options.coordinate) {
    throw new Error('Image files require coordinate option');
  }

  const { store, autoNameGenerator, generateFeatureId, getCurrentLayerId } = deps;
  const processed = await processImageFile(file);

  // Create the FileData
  const fileId = generateFeatureId();
  const fileData: FileData = {
    id: fileId,
    mimeType: processed.mimeType,
    dataURL: processed.dataUrl,
  };

  // Create the Image feature
  const featureId = generateFeatureId();
  const layerId = options.layerId || getCurrentLayerId();
  const autoName = autoNameGenerator.generateName('Image');
  const feature: Feature = {
    id: featureId,
    type: 'Image',
    coordinates: options.coordinate,
    layerId,
    properties: {
      imageFileId: fileId,
      imageWidth: processed.width,
      imageHeight: processed.height,
      createdZoom: options.zoom ?? 1,
      ...(autoName !== undefined && { name: autoName }),
    },
    locked: false,
    visible: true,
  };

  // Create the file and the feature in a transaction
  store.transact(() => {
    store.createFile(fileData);
    store.createFeature(feature);
    store.setSelection('feature', [featureId]);
  });

  return {
    format: 'image',
    featureIds: [featureId],
    replaced: false,
  };
}
