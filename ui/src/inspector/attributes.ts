// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The name, the description and the attributes of a feature, and the patches their changes make.
//
// Core has no name for a feature. The interface keeps it, and the description, in two
// attributes of `properties`: `name` (the title of the inspector) and `description` (a field of
// its own). The Attributes tab lists every other key of `properties`, except the keys of the
// library (isDrawProperty).
//
// A value is shown as a string (an object or an array as JSON). A value the user types is kept
// as the string typed: "12" stays the string "12" and is not turned into a number, so that what
// is typed is what is stored, whatever it looks like. An application that wants typed values
// converts them itself (feature.updated tells it of each change).

import { type Feature, type FeaturePatch, isDrawProperty } from '@sakuzu/maplibre-gl-draw';

/** The attribute that holds the name of a feature */
export const NAME_KEY = 'name';
/** The attribute that holds the description of a feature */
export const DESCRIPTION_KEY = 'description';

/** An attribute as the list shows it */
export interface AttributeRow {
  key: string;
  value: string;
}

/** Whether a key of `properties` is kept out of the list of attributes */
export function isReservedKey(key: string): boolean {
  return key === NAME_KEY || key === DESCRIPTION_KEY || isDrawProperty(key);
}

/** A value of `properties` as a string */
export function showValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** The name of a feature, or an empty string */
export function featureName(feature: Pick<Feature, 'properties'>): string {
  const name = feature.properties?.[NAME_KEY];
  return typeof name === 'string' ? name : '';
}

/** The description of a feature, or an empty string */
export function featureDescription(feature: Pick<Feature, 'properties'>): string {
  const text = feature.properties?.[DESCRIPTION_KEY];
  return typeof text === 'string' ? text : '';
}

/** The attributes of a feature, in the order of `properties` */
export function attributeRows(feature: Pick<Feature, 'properties'>): AttributeRow[] {
  return Object.entries(feature.properties ?? {})
    .filter(([key]) => !isReservedKey(key))
    .map(([key, value]) => ({ key, value: showValue(value) }));
}

/** The patch that sets a text attribute, or removes it when the text is empty after trimming */
function textPatch(key: string, text: string): FeaturePatch {
  const value = text.trim();
  return { properties: { [key]: value === '' ? undefined : value } };
}

/** The patch that names a feature; an empty name removes the attribute */
export function namePatch(name: string): FeaturePatch {
  return textPatch(NAME_KEY, name);
}

/** The patch that describes a feature; an empty description removes the attribute */
export function descriptionPatch(text: string): FeaturePatch {
  const value = text.trim() === '' ? undefined : text;
  return { properties: { [DESCRIPTION_KEY]: value } };
}

/** Whether a name can be given to an attribute of the feature, other than the one at `except` */
function freeKey(feature: Pick<Feature, 'properties'>, key: string, except?: string): boolean {
  if (key === '' || isReservedKey(key)) return false;
  return key === except || !Object.hasOwn(feature.properties ?? {}, key);
}

/**
 * The patch of a change of the attribute at `index` of {@link attributeRows}: a new value, a
 * new name (the old key removed and the new one set), or both. When only the name changes, the
 * value keeps its type.
 *
 * @returns The patch, or null when nothing changes, there is no attribute at `index`, or the
 *   new name is empty, is the name of another attribute, or is kept (`name`, `description`, a
 *   key of the library)
 */
export function attributePatch(
  feature: Pick<Feature, 'properties'>,
  index: number,
  next: AttributeRow,
): FeaturePatch | null {
  const row = attributeRows(feature)[index];
  if (!row) return null;
  const key = next.key.trim();
  if (key === row.key && next.value === row.value) return null;
  if (!freeKey(feature, key, row.key)) return null;
  const raw = feature.properties[row.key];
  const value = next.value === row.value ? raw : next.value;
  if (key === row.key) return { properties: { [key]: value } };
  return { properties: { [row.key]: undefined, [key]: value } };
}

/**
 * The patch that adds an attribute
 *
 * @returns The patch, or null when the name is empty, is taken, or is kept
 */
export function attributeAdd(
  feature: Pick<Feature, 'properties'>,
  item: AttributeRow,
): FeaturePatch | null {
  const key = item.key.trim();
  if (!freeKey(feature, key)) return null;
  return { properties: { [key]: item.value } };
}

/**
 * The patch that removes the attribute at `index` of {@link attributeRows}
 *
 * @returns The patch, or null when there is no attribute at `index`
 */
export function attributeRemove(
  feature: Pick<Feature, 'properties'>,
  index: number,
): FeaturePatch | null {
  const row = attributeRows(feature)[index];
  return row ? { properties: { [row.key]: undefined } } : null;
}
