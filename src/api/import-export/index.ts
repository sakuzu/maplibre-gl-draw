// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Orchestrator of the Import/Export API
 *
 * createImportExportAPI is a thin orchestrator that detects the format and then delegates
 * to each import/export function. The implementation is spread across format-detection /
 * geojson-import / geojson-export / native-format / image-import / file-name.
 */

import { isImageFile } from '../../shared/utils/image.js';
import type {
  ExportFormat,
  ExportOptions,
  ExportResult,
  LoadOptions,
  LoadResult,
} from '../../store/types.js';
import type { Context } from '../context.js';
import { buildExportFileName } from './file-name.js';
import { isGeoJSONFeatureCollection, isNativeFormat } from './format-detection.js';
import { exportGeoJSON } from './geojson-export.js';
import { loadGeoJSON } from './geojson-import.js';
import { loadImage } from './image-import.js';
import { exportNative, loadNative } from './native-format.js';

/**
 * Import/Export API interface
 */
export interface ImportExportAPI {
  load(source: File | unknown, options?: LoadOptions): Promise<LoadResult>;
  export(format: ExportFormat, options?: ExportOptions): ExportResult;
  getSuggestedFileName(): string;
}

/**
 * Creates the Import/Export API
 *
 * @internal
 */
export function createImportExportAPI(context: Context): ImportExportAPI {
  const { store, generateFeatureId, getCurrentLayerId, autoNameGenerator } = context;
  const importDeps = {
    store,
    autoNameGenerator,
    generateFeatureId,
    getCurrentLayerId,
  };

  const api: ImportExportAPI = {
    /**
     * Loads data or a file.
     *
     * Detects the kind of source automatically and handles it accordingly:
     *   - File: detects the file kind automatically (image / .json / .geojson)
     *   - object: detects the data format automatically (native format /
     *     GeoJSON FeatureCollection)
     */
    async load(source: File | unknown, options?: LoadOptions): Promise<LoadResult> {
      if (source instanceof File) {
        if (isImageFile(source)) {
          return loadImage(source, options || {}, importDeps);
        }

        const fileName = source.name.toLowerCase();
        const mimeType = source.type;
        const isJsonFile =
          fileName.endsWith('.json') ||
          fileName.endsWith('.geojson') ||
          mimeType === 'application/json' ||
          mimeType === 'application/geo+json';

        if (isJsonFile) {
          const text = await source.text();
          let data: unknown;
          try {
            data = JSON.parse(text);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid JSON file "${source.name}": ${detail}`);
          }
          return api.load(data, options);
        }

        throw new Error(`Unsupported file type: ${source.type || source.name}`);
      }

      if (isNativeFormat(source)) {
        return loadNative(source, { store });
      }
      if (isGeoJSONFeatureCollection(source)) {
        return loadGeoJSON(source, importDeps, { flattenMulti: options?.flattenMulti });
      }
      throw new Error(
        'Unsupported data format. Expected native format or GeoJSON FeatureCollection.',
      );
    },

    /**
     * Exports the data
     */
    export(format: ExportFormat, options?: ExportOptions): ExportResult {
      const metadata = store.getMetadata();

      if (format === 'native') {
        const data = exportNative(store, options);
        const fileName =
          options?.fileName || buildExportFileName(metadata, '.maplibre-gl-draw.json');
        return {
          format: 'native',
          data: JSON.stringify(data, null, 2),
          mimeType: 'application/json',
          fileName,
        };
      }

      if (format === 'geojson') {
        const data = exportGeoJSON(store, options);
        const fileName = options?.fileName || buildExportFileName(metadata, '.geojson');
        return {
          format: 'geojson',
          data: JSON.stringify(data, null, 2),
          mimeType: 'application/geo+json',
          fileName,
        };
      }

      throw new Error(`Unsupported export format: ${format}`);
    },

    /**
     * Generates a suggested export file name
     */
    getSuggestedFileName(): string {
      return buildExportFileName(store.getMetadata(), '.maplibre-gl-draw.json');
    },
  };

  return api;
}
