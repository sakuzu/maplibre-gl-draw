// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Property helpers
 *
 * Utilities for handling the properties of a feature (feature.properties) in a type-safe way.
 *
 * This library's own data such as createdZoom/rotation/scale has to round-trip through
 * GeoJSON with the maplibre-gl-draw: prefix, so it is held inside feature.properties under
 * keys without the prefix.
 */

import { INTERNAL_PROPERTIES } from '../config/constants.js';
import type { Feature, ImageProperties } from '../types/model.js';

/**
 * Gets the zoom at which the feature was created (`properties.createdZoom`)
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
  const value = feature.properties[INTERNAL_PROPERTIES.CREATED_ZOOM];
  return typeof value === 'number' ? value : undefined;
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
 *   coordinates: [
 *     [139.76, 35.68],
 *     [139.78, 35.69],
 *   ],
 *   properties,
 * });
 * ```
 */
export function setCreatedZoom(properties: Record<string, unknown>, zoom: number): void {
  properties[INTERNAL_PROPERTIES.CREATED_ZOOM] = zoom;
}

/**
 * Gets the rotation of the feature in degrees (`properties.rotation`, 0 when unset)
 */
export function getRotation(feature: Feature): number {
  const value = feature.properties[INTERNAL_PROPERTIES.ROTATION];
  return typeof value === 'number' ? value : 0;
}

/**
 * Sets the rotation in degrees, in a `properties` object (the properties of a
 * {@link FeatureInput} before `addFeature`, say)
 */
export function setRotation(properties: Record<string, unknown>, rotation: number): void {
  properties[INTERNAL_PROPERTIES.ROTATION] = rotation;
}

/**
 * Gets the scale of the feature (`properties.scale`, 1 when unset), which resizing an Image
 * changes
 */
export function getScale(feature: Feature): number {
  const value = feature.properties[INTERNAL_PROPERTIES.SCALE];
  return typeof value === 'number' ? value : 1;
}

/**
 * Sets the scale of the feature
 */
export function setScale(properties: Record<string, unknown>, scale: number): void {
  properties[INTERNAL_PROPERTIES.SCALE] = scale;
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
  const p = feature.properties;
  return {
    imageFileId: typeof p.imageFileId === 'string' ? p.imageFileId : '',
    imageWidth: typeof p.imageWidth === 'number' ? p.imageWidth : 0,
    imageHeight: typeof p.imageHeight === 'number' ? p.imageHeight : 0,
    createdZoom: typeof p.createdZoom === 'number' ? p.createdZoom : 0,
    rotation: typeof p.rotation === 'number' ? p.rotation : undefined,
    scale: typeof p.scale === 'number' ? p.scale : undefined,
  };
}

/**
 * Gets the radius (meters) of a Circle feature. undefined when it is unset or invalid.
 */
export function getCircleRadius(feature: Feature): number | undefined {
  const value = feature.properties.radiusMeters;
  return typeof value === 'number' ? value : undefined;
}

/**
 * Gets the angle (degrees) of the radius handle of a Circle feature. The default is 135
 * (toward the southwest).
 */
export function getRadiusHandleAngle(feature: Feature): number {
  const value = feature.properties.radiusHandleAngle;
  return typeof value === 'number' ? value : 135;
}
