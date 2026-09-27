// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the resources of the draw instance share: their dependencies, the checks of the
 * arguments and the lookups of the document
 */

import type { FeatureStyleConfig } from '../../../shared/config/feature-style.js';
import type { AutoNameGenerator } from '../../../shared/utils/name-generator.js';
import { isFeatureLocked, isGroupLocked } from '../../../store/lock.js';
import type { Store } from '../../../store/store.js';
import type { BoundingBox, Feature, Group, Layer, SelectionType } from '../../../store/types.js';
import { DrawError } from '../errors.js';

/**
 * The dependencies of the resources. A bare Store and plain functions are enough, so that a
 * test builds a resource without a map.
 *
 * @internal
 */
export interface ResourceDeps {
  /** The Store of the instance */
  store: Store;
  /** Generates the ID of a new feature, layer or group */
  generateId: () => string;
  /** The names of new layers and groups */
  autoNameGenerator: AutoNameGenerator;
  /** The ID of the active layer, or an empty string when there is no layer */
  getActiveLayerId: () => string;
  /** Changes the active layer */
  setActiveLayerId: (id: string) => void;
  /** The defaults of the look of the features */
  featureStyle: FeatureStyleConfig;
  /**
   * The spatial index of the features, for a filter by extent; the extent of each feature is
   * measured when it is left out
   */
  spatialIndex?: { findInBounds(bounds: BoundingBox): string[] };
}

// ============================================================================
// Errors
// ============================================================================

/** The error for an ID that names nothing of its kind */
export function notFound(kind: string, id: unknown): DrawError {
  return new DrawError('not-found', `There is no ${kind} with the ID ${JSON.stringify(id)}`, {
    id,
  });
}

/** The error for an input of the wrong shape or value */
export function invalidInput(message: string, details?: unknown): DrawError {
  return new DrawError('invalid-input', message, details);
}

// ============================================================================
// Checks of the arguments
// ============================================================================

/** Whether the value is a plain object (not null, not an array) */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws unless the value is a plain object */
export function requireRecord(value: unknown, what: string): void {
  if (!isRecord(value)) throw invalidInput(`${what} must be an object`);
}

/** Throws unless the value is an array of strings, and returns it without repeated IDs */
export function requireIds(value: unknown, what = 'The IDs'): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw invalidInput(`${what} must be an array of strings`);
  }
  return [...new Set(value as string[])];
}

/** Throws unless the value is a non-empty string */
export function requireId(value: unknown, what = 'The ID'): string {
  if (typeof value !== 'string' || value === '') {
    throw invalidInput(`${what} must be a non-empty string`);
  }
  return value;
}

/** Throws unless the key of the object is absent or a boolean */
export function optionalBoolean(value: Record<string, unknown>, key: string): void {
  if (key in value && value[key] !== undefined && typeof value[key] !== 'boolean') {
    throw invalidInput(`${key} must be a boolean`);
  }
}

/** Throws unless the key of the object is absent or a string */
export function optionalString(value: Record<string, unknown>, key: string): void {
  if (key in value && value[key] !== undefined && typeof value[key] !== 'string') {
    throw invalidInput(`${key} must be a string`);
  }
}

/** Throws unless the keys of the object are all among the allowed ones */
export function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], what: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalidInput(`${what} cannot have the key ${key}`);
  }
}

/** Throws unless the index is absent or an integer from 0 */
export function optionalIndex(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidInput('index must be an integer from 0');
  }
  return value;
}

/**
 * The keys of a filter that must match; a key given as `undefined` does not filter
 *
 * @returns The entries to compare
 */
export function filterEntries(
  filter: unknown,
  allowed: readonly string[],
): Array<[string, unknown]> {
  if (filter === undefined) return [];
  requireRecord(filter, 'The filter');
  onlyKeys(filter as Record<string, unknown>, allowed, 'The filter');
  return Object.entries(filter as Record<string, unknown>).filter(
    ([, value]) => value !== undefined,
  );
}

/** Whether an item matches every entry of a filter */
export function matches(item: object, entries: Array<[string, unknown]>): boolean {
  const record = item as Record<string, unknown>;
  return entries.every(([key, value]) => record[key] === value);
}

/** Whether a patch changes nothing but `locked` and `visible`, which a lock still allows */
export function onlyLockOrVisibility(patch: object): boolean {
  return Object.keys(patch).every((key) => key === 'locked' || key === 'visible');
}

// ============================================================================
// Lookups of the document
// ============================================================================

/** Whether the ID names a feature, a group or a layer */
export function isTaken(store: Store, id: string): boolean {
  return (
    store.getFeature(id) !== undefined ||
    store.getGroup(id) !== undefined ||
    store.getLayer(id) !== undefined
  );
}

/** The layer that lists a group, or else the layer the group records */
export function layerOfGroup(store: Store, group: Group): Layer | undefined {
  return store.getLayer(group.layerId);
}

/** Whether the feature is locked: itself, its group or its layer */
export function featureLocked(store: Store, feature: Feature): boolean {
  return isFeatureLocked(feature, store);
}

/** Whether the group is locked: itself or its layer */
export function groupLocked(store: Store, group: Group): boolean {
  return isGroupLocked(group, () => layerOfGroup(store, group));
}

/**
 * Whether an item can be seen: it exists, its own visible flag and the ones of its group and
 * layer are on, and this client hides none of them
 */
export function isShown(store: Store, type: SelectionType, id: string): boolean {
  const layerShown = (layerId: string): boolean =>
    store.getLayer(layerId)?.visible === true && !store.isHidden(layerId);
  const groupShown = (group: Group): boolean =>
    group.visible && !store.isHidden(group.id) && layerShown(group.layerId);
  if (type === 'layer') return layerShown(id);
  if (type === 'group') {
    const group = store.getGroup(id);
    return group !== undefined && groupShown(group);
  }
  const feature = store.getFeature(id);
  if (!feature?.visible || store.isHidden(id)) return false;
  if (feature.groupId) {
    const group = store.getGroup(feature.groupId);
    if (group && !groupShown(group)) return false;
  }
  return layerShown(feature.layerId);
}

/** Looks an item of a type up, or undefined */
export function getItem(
  store: Store,
  type: SelectionType,
  id: string,
): Feature | Group | Layer | undefined {
  if (type === 'feature') return store.getFeature(id);
  if (type === 'group') return store.getGroup(id);
  return store.getLayer(id);
}
