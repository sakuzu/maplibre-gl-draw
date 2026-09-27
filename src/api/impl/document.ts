// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.document`: the whole document, to load and to write out
 */

import type { FeatureCollection } from 'geojson';
import type { Store } from '../../store/store.js';
import type { Coordinate } from '../../store/types.js';
import type { DocumentResource } from '../document.js';
import { DrawError } from '../errors.js';
import type { DrawDocument, LoadOptions, LoadResult, LoadSource } from '../model.js';
import { isGeoJSONFeatureCollection, isNativeFormat } from './import-export/format-detection.js';
import { exportGeoJSON } from './import-export/geojson-export.js';
import { loadGeoJSON } from './import-export/geojson-import.js';
import { loadImage } from './import-export/image-import.js';
import { exportNative, loadNative } from './import-export/native-format.js';
import type { ResourceDeps } from './shared.js';
import { invalidInput, isRecord, notFound } from './shared.js';

const GEOMETRY_TYPES: ReadonlySet<string> = new Set([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'GeometryCollection',
]);

/** A source after the files and the strings are read */
type ReadSource = { kind: 'data'; data: unknown } | { kind: 'image'; file: File };

/** The source of the writes of a load of each format, as its notification carries it */
const LOAD_SOURCES: Readonly<Record<LoadResult['format'], string>> = {
  native: 'silent',
  geojson: 'load',
  image: 'local',
};

/**
 * Creates `draw.document`
 *
 * @param onLoaded - Called after each load that read something, with the result and the source
 *   its writes carried
 * @internal
 */
export function createDocument(
  deps: Pick<ResourceDeps, 'store' | 'autoNameGenerator' | 'generateId' | 'getActiveLayerId'>,
  onLoaded?: (result: LoadResult, source: string) => void,
): DocumentResource {
  const { store } = deps;

  const load = async (source: LoadSource, options: LoadOptions = {}) => {
    let result: LoadResult | null;
    try {
      result = await read(source, options);
    } catch (error) {
      // Whatever went wrong, the promise rejects with a DrawError
      throw asDrawError('invalid-input', error);
    }
    if (result) onLoaded?.(result, LOAD_SOURCES[result.format]);
    return result;
  };

  return {
    load,

    toJSON: (): DrawDocument => exportNative(store),

    toGeoJSON: (): FeatureCollection => exportGeoJSON(store),
  };

  async function read(source: LoadSource, options: LoadOptions = {}): Promise<LoadResult | null> {
    if (!isRecord(options as unknown)) throw invalidInput('The options must be an object');
    const mode = options.mode;
    if (mode !== undefined && mode !== 'replace' && mode !== 'merge') {
      throw invalidInput('mode must be replace or merge');
    }
    const layerId = options.layerId;
    if (layerId !== undefined && !store.getLayer(layerId)) throw notFound('layer', layerId);
    if (store.isReadOnly()) return null;

    const read = await readSource(source);
    const importDeps = {
      store,
      autoNameGenerator: deps.autoNameGenerator,
      generateFeatureId: deps.generateId,
      getCurrentLayerId: () => layerId ?? deps.getActiveLayerId(),
    };

    if (read.kind === 'image') {
      if (!options.coordinate) throw invalidInput('An image needs the coordinate option');
      const replace = mode === 'replace';
      const result = await loadImage(
        read.file,
        {
          coordinate: options.coordinate as Coordinate,
          zoom: options.zoom,
          layerId,
          flattenMulti: options.flattenMulti,
        },
        importDeps,
        // With replace, the features and groups go in the transaction that adds the image
        replace ? () => deleteFeaturesAndGroups(store) : undefined,
      );
      return replace ? { ...result, replaced: true } : result;
    }

    const { data } = read;
    if (isNativeFormat(data)) {
      if (mode === 'merge') {
        throw invalidInput('A document of the library can only replace the document');
      }
      try {
        return await loadNative(data, { store });
      } catch (error) {
        throw asDrawError('invalid-input', error);
      }
    }
    const collection = toFeatureCollection(data);
    if (collection === null) {
      throw new DrawError(
        'unsupported-format',
        'The source is neither a document of the library nor GeoJSON',
      );
    }
    // The layer given to the load wins over the one a feature names; with replace, the
    // features and groups are replaced in the transaction that writes the new ones
    return loadGeoJSON(collection, importDeps, {
      flattenMulti: options.flattenMulti,
      layerId,
      replace: mode === 'replace',
    });
  }
}

/** Deletes every feature and group of the document, keeping the layers */
function deleteFeaturesAndGroups(store: Store): void {
  for (const feature of store.listFeatures()) store.deleteFeature(feature.id);
  for (const group of store.listGroups()) store.deleteGroup(group.id);
}

/** Reads a file or a string into data, or keeps an image file as it is */
async function readSource(source: LoadSource): Promise<ReadSource> {
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const name = typeof File !== 'undefined' && source instanceof File ? source.name : '';
    if (source.type.startsWith('image/')) {
      const file =
        typeof File !== 'undefined' && source instanceof File
          ? source
          : new File([source], name || 'image', { type: source.type });
      return { kind: 'image', file };
    }
    let text: string;
    try {
      text = await source.text();
    } catch (error) {
      throw asDrawError('unsupported-format', error);
    }
    return { kind: 'data', data: parseJSON(text) };
  }
  if (typeof source === 'string') return { kind: 'data', data: parseJSON(source) };
  return { kind: 'data', data: source };
}

/** Parses JSON text; text that is not JSON cannot be read */
function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw asDrawError('unsupported-format', error);
  }
}

/** A FeatureCollection from GeoJSON data (a collection, a feature or a geometry), or null */
function toFeatureCollection(data: unknown): FeatureCollection | null {
  if (isGeoJSONFeatureCollection(data)) return data as FeatureCollection;
  if (!isRecord(data)) return null;
  if (data.type === 'Feature') {
    return { type: 'FeatureCollection', features: [data as unknown as GeoJSON.Feature] };
  }
  if (typeof data.type === 'string' && GEOMETRY_TYPES.has(data.type)) {
    return {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: data as unknown as GeoJSON.Geometry },
      ],
    };
  }
  return null;
}

/** Wraps an error of a reader into a DrawError with the code */
function asDrawError(code: 'invalid-input' | 'unsupported-format', error: unknown): DrawError {
  if (error instanceof DrawError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DrawError(code, message, { cause: error });
}
