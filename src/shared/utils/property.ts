// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Property helpers
 *
 * Utilities for handling the properties of a feature (feature.properties) in a type-safe way.
 * The values of the library are read and written through the accessors of
 * shared/properties.ts, which own their keys.
 */

import { getDrawProperty, setDrawProperty } from '../properties.js';
import type { Feature, ImageProperties } from '../types/model.js';

/**
 * Gets the zoom at which the feature was created (`maplibre-gl-draw:createdZoom` in
 * `properties`)
 *
 * The drawing modes record it. Line widths follow the map from that zoom, and an Image is
 * drawn at its size in pixels at that zoom (see {@link FeatureStyle.strokeWidth}).
 *
 * @returns The zoom, or undefined when the feature has none (it then keeps the same width on
 *   the screen)
 *
 * @example
 * ```ts
 * const feature = draw.getFeature(id);
 * const zoom = feature ? getCreatedZoom(feature) : undefined;
 * ```
 */
export function getCreatedZoom(feature: Feature): number | undefined {
  return getDrawProperty(feature, 'createdZoom');
}

/**
 * Sets the zoom at which a feature was created, in a `properties` object
 *
 * Use it on the properties of a {@link FeatureInput} before `addFeature`, so that the new
 * feature scales with the map from the current zoom like a drawn one.
 *
 * @example
 * ```ts
 * const properties: Record<string, unknown> = {};
 * setCreatedZoom(properties, map.getZoom());
 * draw.addFeature({
 *   type: 'LineString',
 *   geometry: {
 *     type: 'LineString',
 *     coordinates: [
 *       [139.76, 35.68],
 *       [139.78, 35.69],
 *     ],
 *   },
 *   properties,
 * });
 * ```
 */
export function setCreatedZoom(properties: Record<string, unknown>, zoom: number): void {
  setDrawProperty(properties, 'createdZoom', zoom);
}

/**
 * Gets the rotation of the feature in degrees (`maplibre-gl-draw:rotation` in `properties`, 0
 * when unset)
 */
export function getRotation(feature: Feature): number {
  return getDrawProperty(feature, 'rotation') ?? 0;
}

/**
 * Sets the rotation in degrees, in a `properties` object (the properties of a
 * {@link FeatureInput} before `addFeature`, say)
 */
export function setRotation(properties: Record<string, unknown>, rotation: number): void {
  setDrawProperty(properties, 'rotation', rotation);
}

/**
 * Gets the scale of the feature (`maplibre-gl-draw:scale` in `properties`, 1 when unset),
 * which resizing an Image changes
 */
export function getScale(feature: Feature): number {
  return getDrawProperty(feature, 'scale') ?? 1;
}

/**
 * Sets the scale of the feature
 */
export function setScale(properties: Record<string, unknown>, scale: number): void {
  setDrawProperty(properties, 'scale', scale);
}

/**
 * Gets the name of the feature
 */
export function getFeatureName(feature: Feature): string | undefined {
  const value = feature.properties.name;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Sets the name of the feature
 */
export function setFeatureName(properties: Record<string, unknown>, name: string): void {
  properties.name = name;
}

/**
 * Gets the description of the feature
 */
export function getFeatureDescription(feature: Feature): string | undefined {
  const value = feature.properties.description;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Sets the description of the feature
 */
export function setFeatureDescription(
  properties: Record<string, unknown>,
  description: string,
): void {
  properties.description = description;
}

/**
 * Gets the properties of an Image feature in a type-safe way.
 *
 * It validates and extracts each field from feature.properties (Record<string, unknown>).
 * Use it instead of a dangerous cast such as `as unknown as ImageProperties`.
 */
export function getImageProperties(feature: Feature): ImageProperties {
  return {
    imageFileId: getDrawProperty(feature, 'imageFileId') ?? '',
    imageWidth: getDrawProperty(feature, 'imageWidth') ?? 0,
    imageHeight: getDrawProperty(feature, 'imageHeight') ?? 0,
    createdZoom: getDrawProperty(feature, 'createdZoom') ?? 0,
    rotation: getDrawProperty(feature, 'rotation'),
    scale: getDrawProperty(feature, 'scale'),
  };
}

/**
 * Gets the radius (meters) of a Circle feature. undefined when it is unset or invalid.
 */
export function getCircleRadius(feature: Feature): number | undefined {
  return getDrawProperty(feature, 'radiusMeters');
}

/**
 * Gets the angle (degrees) of the radius handle of a Circle feature. The default is 135
 * (toward the southwest).
 */
export function getRadiusHandleAngle(feature: Feature): number {
  return getDrawProperty(feature, 'radiusHandleAngle') ?? 135;
}
