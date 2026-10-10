// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Parsing without a document: GeoJSON and the native format read into new features, groups,
 * files and layers, with new IDs, and written nowhere
 *
 * The steps are those of a load (the conversion of GeoJSON, the validation of native data and
 * the decoding of embedded images), so the two cannot read a source differently. What a parse
 * adds is the renaming: every feature, group, layer and file gets a new ID, and the references
 * between them are rewritten to the new IDs.
 */

import { readDrawProperty, setDrawProperty } from '../../../shared/properties.js';
import { createId } from '../../../shared/utils/id.js';
import type { Feature, FileData, Group } from '../../../store/types.js';
import { DrawError } from '../../errors.js';
import type { GroupInput, LayerInput, ParsedDocument } from '../../model.js';
import { invalidInput, isRecord, onlyKeys, optionalBoolean, requireId } from '../shared.js';
import { isNativeFormat, toFeatureCollection } from './format-detection.js';
import { convertGeoJSONFeatures, decodeEmbeddedImages } from './geojson-import.js';
import { upgradeNativeData } from './native-upgrade.js';
import { validateNativeData } from './native-validation.js';
import { setOwnProperty } from './own-property.js';

type Skipped = ParsedDocument['skipped'];
type IdMap = ParsedDocument['idMap'];

/** An empty map of the IDs of the input to the new ones */
function createIdMap(): IdMap {
  return { features: {}, groups: {}, files: {}, layers: {} };
}

/**
 * Records the new ID of an ID of the input; the first one stays. The ID is an own key, so that
 * an ID such as `__proto__` stays an ordinary key
 */
function recordId(map: Record<string, string>, from: string, to: string): void {
  if (Object.getOwnPropertyDescriptor(map, from) === undefined) setOwnProperty(map, from, to);
}

/** The options of a parse, checked, with the generator resolved */
interface ResolvedParseOptions {
  generateId: () => string;
  layerId: string | undefined;
  flattenMulti: boolean;
}

/** Checks the options of a parse */
function resolveOptions(options: unknown): ResolvedParseOptions {
  if (options === undefined)
    return { generateId: createId, layerId: undefined, flattenMulti: false };
  if (!isRecord(options)) throw invalidInput('The options must be an object');
  onlyKeys(options, ['generateId', 'layerId', 'flattenMulti'], 'The options');
  const { generateId, layerId } = options;
  if (generateId !== undefined && typeof generateId !== 'function') {
    throw invalidInput('generateId must be a function');
  }
  optionalBoolean(options, 'flattenMulti');
  return {
    generateId: generateId === undefined ? createId : () => (generateId as () => string)(),
    layerId: layerId === undefined ? undefined : requireId(layerId, 'layerId'),
    flattenMulti: options.flattenMulti === true,
  };
}

/** Runs a parse so that every failure is a DrawError */
async function asParse(read: () => Promise<ParsedDocument>): Promise<ParsedDocument> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof DrawError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new DrawError('invalid-input', message, { cause: error });
  }
}

/** The skipped entries in input order (a conversion and an image may skip in turn) */
function byIndex(skipped: Skipped): Skipped {
  return [...skipped].sort((a, b) => a.index - b.index);
}

/**
 * Parses GeoJSON (a FeatureCollection, a Feature or a geometry) without writing it
 *
 * @internal
 */
export function parseGeoJSONInput(input: unknown, options?: unknown): Promise<ParsedDocument> {
  return asParse(async () => {
    const { generateId, layerId, flattenMulti } = resolveOptions(options);
    const collection = toFeatureCollection(input);
    if (collection === null) {
      throw new DrawError('unsupported-format', 'The input is not GeoJSON');
    }

    // The conversion of a load, with new IDs for every feature and file
    const target = layerId ?? '';
    const { results, skipped: converted } = convertGeoJSONFeatures(
      collection.features,
      target,
      generateId,
      { flattenMulti, keepIds: false },
    );
    const skipped: Skipped = converted.map(({ index, reason, detail }) => ({
      index,
      reason,
      detail,
    }));

    // An embedded image that cannot be imported leaves its feature out
    const problems = await decodeEmbeddedImages(results);
    const failed = new Set(problems.map(({ result }) => result));
    for (const { result, problem } of problems) {
      skipped.push({
        index: result.index,
        reason: problem.code,
        detail: `the image data ${problem.detail}`,
      });
    }
    const kept = results.filter((result) => !failed.has(result));

    // The features that name the same group of the input form one new group
    const groups = new Map<string, GroupInput & { featureIds: string[] }>();
    const features: Feature[] = [];
    const files: FileData[] = [];
    const idMap = createIdMap();
    for (const { feature, fileData, sourceId, sourceFileId } of kept) {
      // The layer a feature names in the input is not one of the target document
      feature.layerId = target;
      if (feature.groupId !== undefined) {
        let group = groups.get(feature.groupId);
        if (!group) {
          const id = generateId();
          group = { id, featureIds: [] };
          groups.set(feature.groupId, group);
          recordId(idMap.groups, feature.groupId, id);
        }
        group.featureIds.push(feature.id);
        feature.groupId = group.id;
      }
      if (sourceId !== undefined) recordId(idMap.features, sourceId, feature.id);
      features.push(feature);
      if (fileData) {
        files.push(fileData);
        if (sourceFileId !== undefined) recordId(idMap.files, sourceFileId, fileData.id);
      }
    }

    return {
      features,
      groups: [...groups.values()],
      files,
      layers: [],
      skipped: byIndex(skipped),
      idMap,
    };
  });
}

/**
 * Parses a document of the library without writing it
 *
 * @internal
 */
export function parseNativeInput(input: unknown, options?: unknown): Promise<ParsedDocument> {
  return asParse(async () => {
    const { generateId, layerId } = resolveOptions(options);
    if (!isNativeFormat(input)) {
      throw new DrawError('unsupported-format', 'The input is not a document of the library');
    }

    // The validation of a load: a malformed document throws, and an image that cannot be
    // imported is returned as a problem of its file
    const upgraded = upgradeNativeData(input) as typeof input;
    const validated = await validateNativeData(upgraded, new Set());
    const skipped: Skipped = [];

    // The layers, from the back, with new IDs; none when every feature goes into one layer
    const layerIds = new Map<string, string>();
    const layers: LayerInput[] = [];
    if (layerId === undefined) {
      const byId = new Map(validated.layers.map((layer) => [layer.id, layer]));
      for (const entry of validated.layerOrder) {
        const layer = byId.get(entry);
        if (!layer) continue;
        const id = generateId();
        layerIds.set(layer.id, id);
        layers.push({
          id,
          name: layer.name,
          visible: layer.visible,
          locked: layer.locked,
          opacity: layer.opacity,
          ...(layer.styleRule !== undefined && { styleRule: layer.styleRule }),
          ...(layer.metadata !== undefined && { metadata: layer.metadata }),
        });
      }
    }

    const groupIds = new Map<string, string>();
    for (const group of validated.groups) groupIds.set(group.id, generateId());

    // The features, with new IDs, their references rewritten; a feature whose image file
    // cannot be imported is left out
    const files = new Map(validated.files.map((file) => [file.id, file]));
    const fileIds = new Map<string, string>();
    const featureIds = new Map<string, string>();
    const features: Feature[] = [];
    const parsedFiles: FileData[] = [];
    validated.features.forEach((feature, index) => {
      const fileId = readDrawProperty(feature.properties, 'imageFileId');
      const problem = fileId === undefined ? undefined : validated.fileProblems.get(fileId);
      if (problem) {
        skipped.push({
          index,
          reason: problem.code,
          detail: `the image of file "${fileId}" ${problem.detail}`,
        });
        return;
      }
      const id = generateId();
      featureIds.set(feature.id, id);
      const properties = { ...feature.properties };
      const file = fileId === undefined ? undefined : files.get(fileId);
      if (fileId !== undefined && file) {
        let newFileId = fileIds.get(fileId);
        if (newFileId === undefined) {
          newFileId = generateId();
          fileIds.set(fileId, newFileId);
          parsedFiles.push({ ...file, id: newFileId });
        }
        setDrawProperty(properties, 'imageFileId', newFileId);
      }
      features.push({
        ...feature,
        id,
        layerId: layerId ?? layerIds.get(feature.layerId) ?? '',
        groupId: feature.groupId === undefined ? undefined : groupIds.get(feature.groupId),
        properties,
      });
    });

    const groups = parseGroups(validated.groups, validated.features, groupIds, featureIds);

    // Every ID of the input with the new one of what was read
    const idMap = createIdMap();
    const keptGroups = new Set(groups.map((group) => group.id));
    for (const [from, to] of featureIds) recordId(idMap.features, from, to);
    for (const [from, to] of groupIds) if (keptGroups.has(to)) recordId(idMap.groups, from, to);
    for (const [from, to] of fileIds) recordId(idMap.files, from, to);
    for (const [from, to] of layerIds) recordId(idMap.layers, from, to);

    return { features, groups, files: parsedFiles, layers, skipped, idMap };
  });
}

/**
 * The groups of a document of the library with their new IDs and the new IDs of their members,
 * in the order of the group, then those that name the group without being listed. A group
 * whose members were all left out is left out too.
 */
function parseGroups(
  groups: readonly Group[],
  features: readonly Feature[],
  groupIds: ReadonlyMap<string, string>,
  featureIds: ReadonlyMap<string, string>,
): GroupInput[] {
  // The group each kept feature names, by the ID of the input
  const groupOf = new Map<string, string>();
  for (const feature of features) {
    if (feature.groupId !== undefined && featureIds.has(feature.id)) {
      groupOf.set(feature.id, feature.groupId);
    }
  }
  const membersOf = new Map<string, Set<string>>(groups.map((group) => [group.id, new Set()]));
  for (const group of groups) {
    const members = membersOf.get(group.id);
    for (const id of group.featureIds) if (groupOf.get(id) === group.id) members?.add(id);
  }
  for (const [id, groupId] of groupOf) membersOf.get(groupId)?.add(id);
  const result: GroupInput[] = [];
  for (const group of groups) {
    const members = membersOf.get(group.id) ?? new Set<string>();
    if (members.size === 0) continue;
    result.push({
      id: groupIds.get(group.id) as string,
      name: group.name,
      visible: group.visible,
      locked: group.locked,
      featureIds: [...members].map((id) => featureIds.get(id) as string),
    });
  }
  return result;
}
