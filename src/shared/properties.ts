// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values the library keeps in the `properties` of a feature
 *
 * Every value the library owns is stored under a key that starts with
 * {@link DRAW_PROPERTY_PREFIX}; every other key is an attribute of the user. The code reads and
 * writes these values only through the accessors of this module, never through string
 * literals, so that the keys are spelled in one place.
 */

/** The prefix of the keys of `properties` that hold the values of the library. */
export const DRAW_PROPERTY_PREFIX = 'maplibre-gl-draw:' as const;

/**
 * The values of the library, by name (the key without the prefix), with their types
 *
 * @internal
 */
export interface DrawPropertyValues {
  /** The reference zoom: the zoom the feature was drawn or created at */
  createdZoom: number;
  /** The rotation, in degrees */
  rotation: number;
  /** The scale factor */
  scale: number;
  /** The radius of a circle, in meters */
  radiusMeters: number;
  /** The direction of the radius handle of a circle, in degrees */
  radiusHandleAngle: number;
  /** The ID of the file of an image feature */
  imageFileId: string;
  /** The width of the image of an image feature, in pixels */
  imageWidth: number;
  /** The height of the image of an image feature, in pixels */
  imageHeight: number;
}

/**
 * The name of a value of the library (the key of `properties` without the prefix)
 *
 * @internal
 */
export type DrawPropertyName = keyof DrawPropertyValues;

/**
 * The key of `properties` that holds each value of the library
 *
 * @internal
 */
export const DRAW_PROPERTY_KEYS = {
  createdZoom: 'createdZoom',
  rotation: 'rotation',
  scale: 'scale',
  radiusMeters: 'radiusMeters',
  radiusHandleAngle: 'radiusHandleAngle',
  imageFileId: 'imageFileId',
  imageWidth: 'imageWidth',
  imageHeight: 'imageHeight',
} as const satisfies Record<DrawPropertyName, string>;

/**
 * The names of the values of the library, in a stable order
 *
 * @internal
 */
export const DRAW_PROPERTY_NAMES: readonly DrawPropertyName[] = Object.keys(
  DRAW_PROPERTY_KEYS,
) as DrawPropertyName[];

/** The type each value must have to be read */
const VALUE_TYPES: Readonly<Record<DrawPropertyName, 'number' | 'string'>> = {
  createdZoom: 'number',
  rotation: 'number',
  scale: 'number',
  radiusMeters: 'number',
  radiusHandleAngle: 'number',
  imageFileId: 'string',
  imageWidth: 'number',
  imageHeight: 'number',
};

/**
 * Whether a key of `properties` holds a value of the library, so that an attribute panel can
 * leave it out.
 *
 * @param key - A key of `properties`
 * @returns True when the key starts with {@link DRAW_PROPERTY_PREFIX}
 */
export function isDrawProperty(key: string): boolean {
  return key.startsWith(DRAW_PROPERTY_PREFIX);
}

/**
 * The key of `properties` that holds a value of the library
 *
 * @internal
 */
export function drawPropertyKey(name: DrawPropertyName): string {
  return DRAW_PROPERTY_KEYS[name];
}

/**
 * Reads a value of the library from `properties`
 *
 * @param properties - The `properties` of a feature
 * @param name - The name of the value
 * @returns The value, or undefined when it is absent or not of its type
 * @internal
 */
export function readDrawProperty<K extends DrawPropertyName>(
  properties: Readonly<Record<string, unknown>> | null | undefined,
  name: K,
): DrawPropertyValues[K] | undefined {
  const value = properties?.[DRAW_PROPERTY_KEYS[name]];
  return typeof value === VALUE_TYPES[name] ? (value as DrawPropertyValues[K]) : undefined;
}

/**
 * Reads a value of the library from the `properties` of a feature
 *
 * @param feature - The feature
 * @param name - The name of the value
 * @returns The value, or undefined when it is absent or not of its type
 * @internal
 */
export function getDrawProperty<K extends DrawPropertyName>(
  feature: { readonly properties: Readonly<Record<string, unknown>> },
  name: K,
): DrawPropertyValues[K] | undefined {
  return readDrawProperty(feature.properties, name);
}

/**
 * Whether `properties` has a key for a value of the library (whatever its value)
 *
 * @internal
 */
export function hasDrawProperty(
  properties: Readonly<Record<string, unknown>> | null | undefined,
  name: DrawPropertyName,
): boolean {
  return properties != null && DRAW_PROPERTY_KEYS[name] in properties;
}

/**
 * Writes a value of the library into a `properties` object; `undefined` removes the key
 *
 * @param properties - The `properties` object to write into (changed in place)
 * @param name - The name of the value
 * @param value - The value
 * @internal
 */
export function setDrawProperty<K extends DrawPropertyName>(
  properties: Record<string, unknown>,
  name: K,
  value: DrawPropertyValues[K] | undefined,
): void {
  const key = DRAW_PROPERTY_KEYS[name];
  if (value === undefined) {
    delete properties[key];
  } else {
    properties[key] = value;
  }
}

/**
 * The entries of `properties` for some values of the library, to spread into a new
 * `properties` object (a value given as `undefined` is left out)
 *
 * @example
 * ```ts
 * const properties = { ...feature.properties, ...drawProperties({ scale: 2 }) };
 * ```
 * @internal
 */
export function drawProperties(
  values: Partial<DrawPropertyValues>,
): Record<string, number | string> {
  const result: Record<string, number | string> = {};
  for (const name of Object.keys(values) as DrawPropertyName[]) {
    const value = values[name];
    if (value !== undefined) result[DRAW_PROPERTY_KEYS[name]] = value;
  }
  return result;
}
