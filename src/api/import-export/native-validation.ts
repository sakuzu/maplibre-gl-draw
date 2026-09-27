// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Validation of native-format data before it replaces the store
 *
 * Loading the native format clears the existing data first, and store.transact does not roll
 * back. Every property the import relies on is therefore checked here, before anything is
 * deleted: a problem throws while the existing data is still intact. The checks follow the
 * native format described in docs/reference/data-format.md.
 */

import type { Data, Feature, FileData, Group, Layer } from '../../store/types.js';
import { NATIVE_VERSION } from './constants.js';
import { normalizeEmbeddedFile } from './embedded-file.js';
import { describeGeometryProblem } from './geometry-validation.js';
import { sanitizeFeatureStyle } from './style-validation.js';

function fail(message: string): never {
  throw new Error(`Invalid native data: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function validateLayer(layer: unknown, index: number): Layer {
  if (!isRecord(layer)) fail(`layers[${index}] is not an object`);
  const where = `layer "${String(layer.id)}"`;
  if (!isNonEmptyString(layer.id)) fail(`layers[${index}] has no valid string id`);
  if (typeof layer.name !== 'string') fail(`${where} has no string name`);
  if (typeof layer.visible !== 'boolean') fail(`${where} has no boolean visible`);
  if (typeof layer.locked !== 'boolean') fail(`${where} has no boolean locked`);
  if (typeof layer.opacity !== 'number' || !Number.isFinite(layer.opacity)) {
    fail(`${where} has no finite opacity`);
  }
  if (!Array.isArray(layer.items) || !layer.items.every((id) => typeof id === 'string')) {
    fail(`${where} has no items array of strings`);
  }
  if (layer.metadata !== undefined && !isRecord(layer.metadata)) {
    fail(`${where} has a metadata that is not an object`);
  }
  if (layer.styleRule !== undefined && !isRecord(layer.styleRule)) {
    fail(`${where} has a styleRule that is not an object`);
  }
  return layer as unknown as Layer;
}

function validateGroup(group: unknown, index: number): Group {
  if (!isRecord(group)) fail(`groups[${index}] is not an object`);
  const where = `group "${String(group.id)}"`;
  if (!isNonEmptyString(group.id)) fail(`groups[${index}] has no valid string id`);
  if (typeof group.name !== 'string') fail(`${where} has no string name`);
  if (typeof group.visible !== 'boolean') fail(`${where} has no boolean visible`);
  if (typeof group.locked !== 'boolean') fail(`${where} has no boolean locked`);
  if (typeof group.layerId !== 'string') fail(`${where} has no string layerId`);
  if (!Array.isArray(group.featureIds) || !group.featureIds.every((id) => typeof id === 'string')) {
    fail(`${where} has no featureIds array of strings`);
  }
  return group as unknown as Group;
}

/** Parses a semantic version (major.minor.patch, with an optional pre-release or build) */
function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Checks the version of the data against the version this library writes
 *
 * Another major version is rejected, because it can change the meaning of any field. A newer
 * minor version only adds fields, so it is read with a warning: the fields it adds are kept
 * as they are but not interpreted.
 */
function validateVersion(version: unknown): void {
  if (typeof version !== 'string') fail('version is not a string');
  const parsed = parseVersion(version);
  if (!parsed) fail(`version "${version}" is not a semantic version`);
  const [major, minor] = parsed;
  const [supportedMajor, supportedMinor] = parseVersion(NATIVE_VERSION) as [number, number, number];
  if (major !== supportedMajor) {
    fail(`version ${version} is not supported (this library reads ${supportedMajor}.x)`);
  }
  if (minor > supportedMinor) {
    console.warn(
      `Native data version ${version} is newer than ${NATIVE_VERSION}; ` +
        'the fields it adds are kept but not interpreted',
    );
  }
}

/**
 * Validates a feature and returns it with its style reduced to the usable keys
 */
function validateFeature(
  feature: unknown,
  index: number,
  layerIds: ReadonlySet<string>,
  groupIds: ReadonlySet<string>,
): Feature {
  if (!isRecord(feature)) fail(`features[${index}] is not an object`);
  if (!isNonEmptyString(feature.id)) fail('feature without a valid string id');
  const where = `feature "${feature.id}"`;
  if (!isNonEmptyString(feature.type)) fail(`${where} has no string type`);

  const geometryProblem = describeGeometryProblem(feature.type, feature.geometry);
  if (geometryProblem) fail(`${where} has ${geometryProblem}`);

  if (typeof feature.layerId !== 'string' || !layerIds.has(feature.layerId)) {
    fail(`${where} refers to a layer that does not exist`);
  }
  if (
    feature.groupId !== undefined &&
    (typeof feature.groupId !== 'string' || !groupIds.has(feature.groupId))
  ) {
    fail(`${where} refers to a group that does not exist`);
  }
  if (!isRecord(feature.properties)) fail(`${where} has no properties object`);
  if (feature.style !== undefined && !isRecord(feature.style)) {
    fail(`${where} has a style that is not an object`);
  }
  if (typeof feature.visible !== 'boolean') fail(`${where} has no boolean visible`);
  if (typeof feature.locked !== 'boolean') fail(`${where} has no boolean locked`);

  // A style key of the wrong type or form is dropped rather than rejecting the file: the
  // store accepts any value through its API, so the library's own export can carry one. A
  // feature without a usable style gets the empty style
  const style = feature.style === undefined ? undefined : sanitizeFeatureStyle(feature.style);
  return { ...feature, style: style ?? {} } as unknown as Feature;
}

async function validateFiles(files: unknown): Promise<FileData[]> {
  if (files === undefined) return [];
  if (!isRecord(files)) fail('files is not an object');
  const result: FileData[] = [];
  for (const [key, file] of Object.entries(files)) {
    if (!isRecord(file) || !isNonEmptyString(file.id) || file.id !== key) {
      fail(`file "${key}" is not an object whose id matches its key`);
    }
    const content = await normalizeEmbeddedFile(file.dataURL, file.mimeType);
    if (!content) {
      fail(
        `file "${key}" is not an embedded PNG / JPEG / WebP / GIF data URL of its declared type`,
      );
    }
    result.push({ ...(file as unknown as FileData), ...content });
  }
  return result;
}

/**
 * Validates the stacking order: distinct non-empty strings that list every layer of the data
 *
 * Entries that are not layers belong to the application and are kept as they are.
 */
function validateLayerOrder(value: unknown, layers: readonly Layer[]): string[] {
  if (!Array.isArray(value)) fail('layerOrder is not an array');
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!isNonEmptyString(entry)) fail(`layerOrder[${index}] is not a non-empty string`);
    if (seen.has(entry)) fail(`layerOrder lists "${entry}" twice`);
    seen.add(entry);
  }
  for (const layer of layers) {
    if (!seen.has(layer.id)) fail(`layerOrder does not list layer "${layer.id}"`);
  }
  return value as string[];
}

/** Native data that passed validation, with the files normalized */
export interface ValidatedNativeData {
  layers: Layer[];
  /** The stacking order, from the back */
  layerOrder: string[];
  groups: Group[];
  /** The features in data order, each style reduced to its usable keys */
  features: Feature[];
  files: FileData[];
}

/**
 * Validates native data before the destructive part of the import
 *
 * @param data - the data to load
 * @param retainedLayerIds - IDs of the layers that remain in the store after it is cleared
 * @throws when anything the import relies on is missing or malformed, or when the data has
 *   another major version
 */
export async function validateNativeData(
  data: Data,
  retainedLayerIds: ReadonlySet<string>,
): Promise<ValidatedNativeData> {
  validateVersion(data.version);
  if (!Array.isArray(data.features)) fail('features is not an array');
  if (data.layers !== undefined && !Array.isArray(data.layers)) fail('layers is not an array');
  if (data.groups !== undefined && !Array.isArray(data.groups)) fail('groups is not an array');
  if (data.metadata !== undefined && !isRecord(data.metadata)) fail('metadata is not an object');

  const layers = (data.layers ?? []).map(validateLayer);
  const layerIds = new Set(retainedLayerIds);
  const seenLayerIds = new Set<string>();
  for (const layer of layers) {
    if (seenLayerIds.has(layer.id)) fail(`duplicate layer id "${layer.id}"`);
    seenLayerIds.add(layer.id);
    layerIds.add(layer.id);
  }
  const layerOrder = validateLayerOrder(data.layerOrder, layers);

  // Feature and group IDs share the entries of layer.items, so they must not collide either
  const itemIds = new Set<string>();
  const groups = (data.groups ?? []).map(validateGroup);
  const groupIds = new Set<string>();
  for (const group of groups) {
    if (itemIds.has(group.id)) fail(`duplicate group id "${group.id}"`);
    itemIds.add(group.id);
    groupIds.add(group.id);
  }

  const features = data.features.map((entry, index) => {
    const feature = validateFeature(entry, index, layerIds, groupIds);
    if (itemIds.has(feature.id)) fail(`duplicate feature id "${feature.id}"`);
    itemIds.add(feature.id);
    return feature;
  });

  const files = await validateFiles(data.files);
  return { layers, layerOrder, groups, features, files };
}
