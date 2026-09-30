// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Import of image files (creates an Image feature)
 */

import { drawProperties } from '../../../shared/properties.js';
import { processImageFile } from '../../../shared/utils/image.js';
import type { AutoNameGenerator } from '../../../shared/utils/name-generator.js';
import type { Store } from '../../../store/store.js';
import type { Feature, FileData, LoadOptions, LoadResult } from '../../../store/types.js';
import { DrawError } from '../../errors.js';
import type { PreparedLoad } from './types.js';

/**
 * Decodes an image file for a load that creates an Image feature; the writes are left to the
 * transaction of the caller
 *
 * @param beforeWrite - Runs first when the image is written, such as the deletion of a replace
 */
export async function prepareImage(
  file: File,
  options: LoadOptions,
  deps: {
    store: Store;
    autoNameGenerator: AutoNameGenerator;
    generateFeatureId: () => string;
    getCurrentLayerId: () => string;
  },
  beforeWrite?: () => void,
): Promise<PreparedLoad> {
  const coordinate = options.coordinate;
  if (!coordinate) {
    throw new DrawError('invalid-input', 'Image files require coordinate option');
  }

  const { store, autoNameGenerator, generateFeatureId, getCurrentLayerId } = deps;
  let processed: Awaited<ReturnType<typeof processImageFile>>;
  try {
    processed = await processImageFile(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DrawError('unsupported-format', `The image cannot be read: ${message}`, {
      cause: error,
    });
  }

  // The IDs, the layer and the automatic name are taken when the image is written, so that a
  // load that fails later takes nothing
  const write = (): LoadResult => {
    const fileId = generateFeatureId();
    const fileData: FileData = {
      id: fileId,
      mimeType: processed.mimeType,
      dataURL: processed.dataUrl,
    };
    const featureId = generateFeatureId();
    const layerId =
      options.layerId && store.getLayer(options.layerId) ? options.layerId : getCurrentLayerId();
    const autoName = autoNameGenerator.generateName('Image');
    const feature: Feature = {
      groupId: undefined,
      id: featureId,
      type: 'Image',
      geometry: { type: 'Point', coordinates: coordinate },
      layerId,
      properties: {
        ...drawProperties({
          imageFileId: fileId,
          imageWidth: processed.width,
          imageHeight: processed.height,
          createdZoom: options.zoom ?? 1,
        }),
        ...(autoName !== undefined && { name: autoName }),
      },
      locked: false,
      visible: true,
      style: {},
    };

    beforeWrite?.();
    store.createFile(fileData);
    store.createFeature(feature);
    store.setSelection('feature', [featureId]);

    return {
      format: 'image',
      featureIds: [featureId],
      replaced: false,
    };
  };
  return { write };
}
