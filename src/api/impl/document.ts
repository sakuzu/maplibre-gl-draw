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
import type { GroupShell } from './groups.js';
import { insertGroup, prepareGroupShell } from './groups.js';
import { isNativeFormat, toFeatureCollection } from './import-export/format-detection.js';
import { exportGeoJSON } from './import-export/geojson-export.js';
import { prepareGeoJSON } from './import-export/geojson-import.js';
import { prepareImage } from './import-export/image-import.js';
import { exportNative, prepareNative } from './import-export/native-format.js';
import type { PreparedLoad } from './import-export/types.js';
import type { PreparedLayer } from './layers.js';
import { insertLayer, prepareLayer } from './layers.js';
import type { ResourceDeps } from './shared.js';
import { invalidInput, isRecord, isTaken, notFound } from './shared.js';

/** A source after the files and the strings are read */
type ReadSource = { kind: 'data'; data: unknown } | { kind: 'image'; file: File };

/** The source of the writes of a load, of every format, as its notification carries it */
const LOAD_SOURCE = 'load';

/** The keys of the group of the options of a load */
const GROUP_KEYS = ['id', 'name', 'visible', 'locked'] as const;

/** A load read and checked, with the layer and the group it creates when it is written */
interface PreparedItem {
  load: PreparedLoad;
  layer: PreparedLayer | undefined;
  group: GroupShell | undefined;
}

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

  /**
   * Reads a source, or null when the document is read-only; every failure is a DrawError
   *
   * @param pending - The IDs the layers and groups of the same write take, added to
   * @param createdLayers - The IDs of the layers the earlier items of the same write create,
   *   added to: a later item may name one with `layerId`
   */
  const prepare = async (
    source: LoadSource,
    options: LoadOptions | undefined,
    pending: Set<string>,
    createdLayers: Set<string>,
  ) => {
    try {
      return await read(source, options, pending, createdLayers);
    } catch (error) {
      // Whatever went wrong, the promise rejects with a DrawError
      throw asDrawError('invalid-input', error);
    }
  };

  /**
   * Writes the loads that were read in one transaction and announces each one, or returns
   * null when the document became read-only while they were read
   */
  const writeAll = (prepared: readonly PreparedItem[]): LoadResult[] | null => {
    if (store.isReadOnly()) return null;
    // An ID given to a new layer or group may have been taken while the sources were read;
    // nothing may throw once the writing has started
    for (const { layer, group } of prepared) {
      for (const id of [layer?.layer.id, group?.id]) {
        if (id !== undefined && isTaken(store, id)) {
          throw new DrawError('already-exists', `The ID ${JSON.stringify(id)} is already taken`, {
            id,
          });
        }
      }
    }
    const results = store.transact(() => prepared.map(writeItem), LOAD_SOURCE);
    for (const result of results) onLoaded?.(result, LOAD_SOURCE);
    return results;
  };

  /** Writes one load: its new layer first, then its features, then the group of them */
  const writeItem = ({ load, layer, group }: PreparedItem): LoadResult => {
    if (layer) insertLayer(store, layer);
    const result: LoadResult = load.write();
    if (layer) result.layerId = layer.layer.id;
    const first = store.getFeature(result.featureIds[0] ?? '');
    if (group && first) {
      // The features of a grouped load are all in one layer
      const featureIds = result.featureIds.filter(
        (id) => store.getFeature(id)?.layerId === first.layerId,
      );
      insertGroup(store, { ...group, layerId: first.layerId, featureIds });
      result.groupId = group.id;
    }
    return result;
  };

  return {
    async load(source, options) {
      const prepared = await prepare(source, options, new Set(), new Set());
      return prepared ? (writeAll([prepared])?.[0] ?? null) : null;
    },

    async loadMany(items) {
      if (!Array.isArray(items)) throw invalidInput('The items must be an array');
      for (const item of items as unknown[]) {
        if (!isRecord(item) || !('source' in item)) {
          throw invalidInput('Each item must be an object with a source');
        }
      }
      // Everything is read before anything is written, so a failure writes nothing
      const prepared: PreparedItem[] = [];
      const pending = new Set<string>();
      const createdLayers = new Set<string>();
      for (const { source, options } of items) {
        const item = await prepare(source, options, pending, createdLayers);
        if (!item) return null;
        prepared.push(item);
      }
      return writeAll(prepared);
    },

    toJSON: (): DrawDocument => exportNative(store),

    toGeoJSON: (): FeatureCollection => exportGeoJSON(store),
  };

  async function read(
    source: LoadSource,
    given: LoadOptions | undefined,
    pending: Set<string>,
    createdLayers: Set<string>,
  ): Promise<PreparedItem | null> {
    const options = given ?? {};
    if (!isRecord(options as unknown)) throw invalidInput('The options must be an object');
    const mode = options.mode;
    if (mode !== undefined && mode !== 'replace' && mode !== 'merge') {
      throw invalidInput('mode must be replace or merge');
    }
    if (options.layer !== undefined && options.layerId !== undefined) {
      throw invalidInput('layer and layerId cannot be given together');
    }
    // A layer an earlier item of the same write creates is known: it is written before this one
    if (
      options.layerId !== undefined &&
      !store.getLayer(options.layerId) &&
      !createdLayers.has(options.layerId)
    ) {
      throw notFound('layer', options.layerId);
    }
    // The new layer and group take their IDs now, so that the items of one write differ
    const layer =
      options.layer !== undefined ? prepareLayer(deps, options.layer, pending) : undefined;
    if (layer) {
      pending.add(layer.layer.id);
      createdLayers.add(layer.layer.id);
    }
    const group =
      options.group !== undefined
        ? prepareGroupShell(deps, options.group, GROUP_KEYS, pending)
        : undefined;
    if (group) pending.add(group.id);
    if (store.isReadOnly()) return null;
    const load = await readLoad(source, options, layer?.layer.id ?? options.layerId, {
      grouped: group !== undefined,
      creates: layer !== undefined || group !== undefined,
      reservedIds: pending,
    });
    return { load, layer, group };
  }

  /**
   * Reads a source into a load of its format
   *
   * @param layerId - The layer every feature goes into: the one given, or the one the load
   *   creates
   */
  async function readLoad(
    source: LoadSource,
    options: LoadOptions,
    layerId: string | undefined,
    extra: { grouped: boolean; creates: boolean; reservedIds: ReadonlySet<string> },
  ): Promise<PreparedLoad> {
    const mode = options.mode;

    const read = await readSource(source);
    const importDeps = {
      store,
      autoNameGenerator: deps.autoNameGenerator,
      generateFeatureId: deps.generateId,
      // The layer of the options, unless another load of the same transaction removed it
      getCurrentLayerId: () =>
        layerId !== undefined && store.getLayer(layerId) ? layerId : deps.getActiveLayerId(),
    };

    if (read.kind === 'image') {
      if (!options.coordinate) throw invalidInput('An image needs the coordinate option');
      const replace = mode === 'replace';
      const prepared = await prepareImage(
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
      if (!replace) return prepared;
      return { write: () => ({ ...prepared.write(), replaced: true }) };
    }

    const { data } = read;
    if (isNativeFormat(data)) {
      if (mode === 'merge') {
        throw invalidInput('A document of the library can only replace the document');
      }
      if (extra.creates) {
        throw invalidInput('A document of the library brings its own layers and groups');
      }
      try {
        return await prepareNative(data, { store });
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
    return prepareGeoJSON(collection, importDeps, {
      flattenMulti: options.flattenMulti,
      layerId,
      replace: mode === 'replace',
      oneGroup: extra.grouped,
      reservedIds: extra.reservedIds,
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

/** Wraps an error of a reader into a DrawError with the code */
function asDrawError(code: 'invalid-input' | 'unsupported-format', error: unknown): DrawError {
  if (error instanceof DrawError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DrawError(code, message, { cause: error });
}
