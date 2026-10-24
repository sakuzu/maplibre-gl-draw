// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Conversion from GeoJSON to the internal Feature format + load of a
 * GeoJSON FeatureCollection
 */

import { rewriteReferences, type Value } from '@sakuzu/tabane';
import { readGeoJSONFeature } from '../../../feature-table/geojson-read.js';
import { setDrawProperty } from '../../../shared/properties.js';
import type { AutoNameGenerator } from '../../../shared/utils/name-generator.js';
import { setOwnProperty } from '../../../shared/utils/own-property.js';
import { deleteFeaturesAndGroups } from '../../../store/feature-stream.js';
import type { Store } from '../../../store/store.js';
import type { FileData, LoadResult, SkippedFeature } from '../../../store/types.js';
import { DrawError, type DrawErrorCode } from '../../errors.js';
import type { EmbeddedFileProblem } from './embedded-file.js';
import { isEmbeddedFileProblem, normalizeEmbeddedFile } from './embedded-file.js';
import type { ConvertedFeatureResult, GeoJSONImportOptions, PreparedLoad } from './types.js';

/** The result of a GeoJSON import */
export interface GeoJSONLoadResult extends LoadResult {
  format: 'geojson';
  /** The features of the source that were not imported, in source order */
  skipped: SkippedFeature[];
}

/** How a GeoJSON Feature is converted */
export interface GeoJSONConvertOptions {
  /** Whether Multi* geometries are expanded into features with a single geometry */
  flattenMulti?: boolean;
  /**
   * Whether a feature keeps the ID the input gives it (a load resolves the collisions when it
   * writes); when false, every feature gets a new ID
   */
  keepIds: boolean;
}

/**
 * Converts a GeoJSON Feature into the internal Feature format
 *
 * The feature is read by the rules every reader of GeoJSON shares (`readGeoJSONFeature`), and a
 * feature that cannot be imported is returned as a reason instead of throwing. Here it gets its
 * IDs, its layer and its group, and the file of its embedded image. Nothing is written.
 *
 * @param generateId - Makes the IDs of new features and of the files of embedded images
 */
export function convertGeoJSONToFeature(
  geoFeature: unknown,
  layerId: string,
  generateId: () => string,
  options: GeoJSONConvertOptions,
): { results: ConvertedFeatureResult[] } | { reason: string } {
  // A Feature holds `x` and `y`: a longer position is cut to them
  const read = readGeoJSONFeature(geoFeature, options.flattenMulti === true, 'xy');
  if (typeof read === 'string') return { reason: read };
  const { properties, image } = read;

  // When there is image data on a single Image point, create the FileData and set a new
  // imageFileId
  let fileData: FileData | undefined;
  if (image) {
    const newFileId = generateId();
    fileData = { id: newFileId, mimeType: image.mimeType, dataURL: image.dataURL };
    setDrawProperty(properties, 'imageFileId', newFileId);
  }

  // The ID of the input is taken only by a feature read whole (the parts of a flattened Multi
  // and of a GeometryCollection get their own). Whether it collides with existing data is
  // resolved by the caller, which knows the store.
  const takeId = (): string =>
    options.keepIds && read.whole && read.inputId !== undefined ? read.inputId : generateId();
  const results: ConvertedFeatureResult[] = read.parts.map(({ type, geometry }) => ({
    feature: {
      id: takeId(),
      layerId: read.layerId ?? layerId,
      groupId: read.groupId,
      // The features that multiply out of one feature of the input each copy its properties
      properties: read.whole ? properties : { ...properties },
      style: read.style,
      locked: read.locked,
      visible: read.visible,
      type,
      geometry,
    },
  }));
  const [first] = results;
  if (fileData) first.fileData = fileData;
  if (read.inputId !== undefined) first.sourceId = read.inputId;
  if (image?.fileId !== undefined && first.fileData) first.sourceFileId = image.fileId;
  return { results };
}

/** A feature of the input that a conversion left out, with the code and the reason */
export interface ConversionSkip {
  /** The index of the feature in the input */
  index: number;
  /** Why it was left out */
  reason: DrawErrorCode;
  /** Why it was left out, in English, for logs */
  detail: string;
}

/** A converted feature with the index of the feature of the input it came from */
export interface IndexedConversion extends ConvertedFeatureResult {
  index: number;
}

/**
 * Converts the features of a GeoJSON FeatureCollection: the step that a load and a parse share
 *
 * A feature that cannot be converted is skipped with `invalid-input` and its reason. The
 * embedded images are not decoded yet (see {@link decodeEmbeddedImages}).
 */
export function convertGeoJSONFeatures(
  features: readonly unknown[],
  layerId: string,
  generateId: () => string,
  options: GeoJSONConvertOptions,
): { results: IndexedConversion[]; skipped: ConversionSkip[] } {
  const results: IndexedConversion[] = [];
  const skipped: ConversionSkip[] = [];
  features.forEach((geoFeature: unknown, index) => {
    const converted = convertGeoJSONToFeature(geoFeature, layerId, generateId, options);
    if ('reason' in converted) {
      skipped.push({ index, reason: 'invalid-input', detail: converted.reason });
    } else {
      for (const result of converted.results) results.push({ ...result, index });
    }
  });
  return { results, skipped };
}

/**
 * Validates and normalizes the embedded images of converted features, in place: the step that
 * a load and a parse share
 *
 * Embedded images are accepted only as PNG / JPEG / WebP / GIF data URLs, and an oversized one
 * is scaled down. Nothing is thrown; the features whose image cannot be imported are returned
 * with the problem, in input order.
 */
export async function decodeEmbeddedImages(
  results: readonly IndexedConversion[],
): Promise<Array<{ result: IndexedConversion; problem: EmbeddedFileProblem }>> {
  const problems: Array<{ result: IndexedConversion; problem: EmbeddedFileProblem }> = [];
  for (const result of results) {
    if (!result.fileData) continue;
    const content = await normalizeEmbeddedFile(result.fileData.dataURL, result.fileData.mimeType);
    if (isEmbeddedFileProblem(content)) {
      problems.push({ result, problem: content });
    } else {
      result.fileData = { ...result.fileData, ...content };
    }
  }
  return problems;
}

/** How many times a colliding feature id is regenerated before the import gives up */
const MAX_ID_ATTEMPTS = 1000;

/**
 * Reads a GeoJSON FeatureCollection for a load that adds to the existing data (or replaces
 * the features and groups): the features are converted and checked and the embedded images
 * decoded here, and the writes are left to the transaction of the caller. The IDs and the
 * references to layers and groups are resolved when the features are written, against the
 * document as it is then (another load of the same transaction may have changed it).
 */
export async function prepareGeoJSON(
  data: GeoJSON.FeatureCollection<GeoJSON.Geometry>,
  deps: {
    store: Store;
    autoNameGenerator: AutoNameGenerator;
    generateFeatureId: () => string;
    getCurrentLayerId: () => string;
  },
  options?: GeoJSONImportOptions,
): Promise<PreparedLoad> {
  const { store, autoNameGenerator, generateFeatureId, getCurrentLayerId } = deps;
  const layerId = getCurrentLayerId();

  // 1. Validate and convert everything, and decode the embedded images, before writing.
  //    store.transact does not roll back, so nothing may throw once the writing has started. A
  //    feature that cannot be imported is skipped with its reason instead of rejecting the
  //    whole load. The features keep the IDs of the file; the collisions are resolved when
  //    they are written.
  const converted = convertGeoJSONFeatures(data.features, layerId, generateFeatureId, {
    flattenMulti: options?.flattenMulti,
    keepIds: true,
  });
  const { results } = converted;
  const skipped: SkippedFeature[] = converted.skipped.map(({ index, detail }) => ({
    index,
    reason: detail,
  }));

  // Unlike a malformed geometry, a bad image rejects the whole load: the image fields are
  // written only by this library's export, so a bad one means the file was altered, and the
  // load is refused rather than trusted in part. An image the browser cannot encode is refused
  // as unsupported-format, the same as when an image file is loaded.
  const [failure] = await decodeEmbeddedImages(results);
  if (failure) {
    const { result, problem } = failure;
    throw new DrawError(
      problem.code,
      `Invalid GeoJSON: the image data of feature "${result.feature.id}" ${problem.detail}`,
      problem.cause === undefined ? undefined : { cause: problem.cause },
    );
  }

  const replace = options?.replace === true;
  // 2. The writes, in the transaction of the caller, the deletion of a replace included: the
  //    whole import is one notification, one step for a subscriber that records changes
  const write = (): LoadResult => {
    const currentLayerId = getCurrentLayerId();
    if (replace) deleteFeaturesAndGroups(store);
    // Feature and group IDs share the entries of layer.order, so an id taken by either (or by
    // an earlier feature of this import) is replaced with a new one. This is what makes a
    // GeoJSON exported from a store loadable into the same store again.
    // With replace, the features and groups of the document are gone by the time the new ones
    // are written, so only the IDs of this import can collide
    const takenIds = new Set<string>();
    // An id the Store does not take (an id of another form than its own) is replaced the same way
    const isTaken = (id: string): boolean =>
      takenIds.has(id) ||
      options?.reservedIds?.has(id) === true ||
      store.acceptsId?.(id) === false ||
      (!replace && (store.getFeature(id) !== undefined || store.getGroup(id) !== undefined));
    const resolveId = (id: string): string => {
      let resolved = id;
      for (let attempt = 0; isTaken(resolved); attempt++) {
        if (attempt >= MAX_ID_ATTEMPTS) {
          throw new DrawError(
            'invalid-input',
            'Failed to generate a unique feature id for the GeoJSON import',
          );
        }
        resolved = generateFeatureId();
      }
      takenIds.add(resolved);
      return resolved;
    };

    const forcedLayerId = options?.layerId;
    const oneGroup = options?.oneGroup === true;
    // The new ID of each ID of the file that was taken (the first feature of an ID names it)
    const renamed: Record<string, string> = {};
    const seenIds = new Set<string>();
    for (const { feature } of results) {
      const before = feature.id;
      feature.id = resolveId(before);
      if (!seenIds.has(before)) {
        seenIds.add(before);
        if (feature.id !== before) setOwnProperty(renamed, before, feature.id);
      }
      // References are resolved against this store: a layer given to the load wins over the one
      // the feature names, a layer the store does not have falls back to the current layer, and a
      // group it does not have (or a group of another layer, or any group when the groups are
      // replaced) is dropped: a feature pointing at a missing group would belong to no layer
      // order and never be drawn.
      if (forcedLayerId !== undefined && store.getLayer(forcedLayerId)) {
        feature.layerId = forcedLayerId;
      } else if (forcedLayerId !== undefined || oneGroup || !store.getLayer(feature.layerId)) {
        feature.layerId = currentLayerId;
      }
      // The features of a load that makes a group of them leave the group they name
      if (oneGroup) delete feature.groupId;
      if (feature.groupId !== undefined) {
        const group = replace ? undefined : store.getGroup(feature.groupId);
        if (!group || group.layerId !== feature.layerId) delete feature.groupId;
      }
    }

    // A reference to a feature that took a new ID names the new one
    if (Object.keys(renamed).length > 0) {
      for (const { feature } of results) {
        feature.properties = rewriteReferences(feature.properties, renamed) as Record<
          string,
          Value
        >;
      }
    }

    const featureIds: string[] = [];
    for (const result of results) {
      // When there is image data, add the file first
      if (result.fileData) {
        store.createFile(result.fileData);
      }
      // When name is not set, generate an automatic name
      if (result.feature.properties.name === undefined) {
        const autoName = autoNameGenerator.generateName(result.feature.type);
        if (autoName !== undefined) {
          result.feature.properties.name = autoName;
        }
      }
      store.createFeature(result.feature);
      featureIds.push(result.feature.id);
    }

    const loaded: GeoJSONLoadResult = {
      format: 'geojson',
      featureIds,
      replaced: replace,
      skipped,
    };
    return loaded;
  };
  return { write };
}
