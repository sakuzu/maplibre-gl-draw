// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.document`: the whole document, to load and to write out
 */

import type { FeatureCollection } from 'geojson';
import type { Store } from '../../../store/store.js';
import type { Coordinate, LoadResult as StoredLoadResult } from '../../../store/types.js';
import {
  isGeoJSONFeatureCollection,
  isNativeFormat,
} from '../../import-export/format-detection.js';
import { exportGeoJSON } from '../../import-export/geojson-export.js';
import { loadGeoJSON } from '../../import-export/geojson-import.js';
import { loadImage } from '../../import-export/image-import.js';
import { exportNative, loadNative } from '../../import-export/native-format.js';
import type { DocumentResource } from '../document.js';
import { DrawError } from '../errors.js';
import type { DrawDocument, LoadOptions, LoadResult, LoadSource } from '../model.js';
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

/**
 * Creates `draw.document`
 *
 * @internal
 */
export function createDocument(
  deps: Pick<ResourceDeps, 'store' | 'autoNameGenerator' | 'generateId' | 'getActiveLayerId'>,
): DocumentResource {
  const { store } = deps;

  return {
    async load(source: LoadSource, options: LoadOptions = {}): Promise<LoadResult | null> {
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
        return withReplace(store, mode === 'replace', () =>
          loadImage(
            read.file,
            {
              coordinate: options.coordinate as Coordinate,
              zoom: options.zoom,
              layerId,
              flattenMulti: options.flattenMulti,
            },
            importDeps,
          ),
        );
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
      return withReplace(store, mode === 'replace', () =>
        loadGeoJSON(collection, importDeps, { flattenMulti: options.flattenMulti }),
      );
    },

    toJSON: (): DrawDocument => exportNative(store),

    toGeoJSON: (): FeatureCollection => exportGeoJSON(store),
  };
}

/**
 * Runs a load that adds features; with `replace`, the features and groups that were there
 * before are deleted once the load has succeeded, so a failed load loses nothing
 */
async function withReplace(
  store: Store,
  replace: boolean,
  load: () => Promise<StoredLoadResult>,
): Promise<LoadResult> {
  const previous = replace ? store.listFeatures().map((feature) => feature.id) : [];
  const previousGroups = replace ? store.listGroups().map((group) => group.id) : [];
  const result = await load();
  if (!replace) return result;
  store.transact(() => {
    for (const id of previous) if (store.getFeature(id)) store.deleteFeature(id);
    for (const id of previousGroups) if (store.getGroup(id)) store.deleteGroup(id);
  }, 'silent');
  return { ...result, replaced: true };
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
    return { kind: 'data', data: parseJSON(await source.text()) };
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
