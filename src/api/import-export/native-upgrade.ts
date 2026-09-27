// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Upgrades native data written by an earlier major version to the current one
 *
 * Each step takes data of one major version to the next, and the steps run in a chain until
 * the data reaches the version this library writes. A step only renames and moves fields; it
 * checks nothing, and leaves a value it does not understand as it is, so that the validation
 * that follows reports it. Data of a major version without a step is returned as it is, and
 * the validation rejects its version.
 */

import { DRAW_PROPERTY_NAMES, drawPropertyKey } from '../../shared/properties.js';
import { geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import type { FeatureCoordinates } from '../../store/types.js';
import { NATIVE_VERSION } from './constants.js';
import { foldLegacyImageStyle } from './legacy-image-style.js';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the object has the key as an own property */
function hasOwnKey(value: Json, key: string): boolean {
  return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}

/** The major version of a semantic version, or null when it is not one */
function majorOf(version: unknown): number | null {
  if (typeof version !== 'string') return null;
  const match = /^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(version);
  return match ? Number(match[1]) : null;
}

/**
 * 2.x to 3.0.0: the document model of the 2.0 API
 *
 * - a feature holds a GeoJSON `geometry` instead of `coordinates`
 * - the values of the library in `properties` get the `maplibre-gl-draw:` prefix
 * - the `order` of a layer becomes `items`
 * - the size, the rotation and the opacity in the style of an Image move to the prefixed
 *   `imageWidth`, `imageHeight` and `rotation` in `properties` and to `imageOpacity`
 * - a group gets the `layerId` of the layer whose items list it (or of its first member, and
 *   `''` when it has neither)
 */
function upgradeFrom2(data: Json): Json {
  const layers = Array.isArray(data.layers)
    ? data.layers.map((layer: unknown) => {
        if (!isRecord(layer) || !('order' in layer) || 'items' in layer) return layer;
        const { order, ...rest } = layer;
        return { ...rest, items: order };
      })
    : data.layers;

  const features = Array.isArray(data.features)
    ? data.features.map((feature: unknown) =>
        isRecord(feature) ? upgradeFeature(feature) : feature,
      )
    : data.features;

  const layerOfItem = new Map<string, string>();
  if (Array.isArray(layers)) {
    for (const layer of layers) {
      if (!isRecord(layer) || typeof layer.id !== 'string' || !Array.isArray(layer.items)) continue;
      for (const item of layer.items) {
        if (typeof item === 'string' && !layerOfItem.has(item)) layerOfItem.set(item, layer.id);
      }
    }
  }
  const layerOfFeature = new Map<string, string>();
  if (Array.isArray(features)) {
    for (const feature of features) {
      if (isRecord(feature) && typeof feature.id === 'string') {
        if (typeof feature.layerId === 'string') layerOfFeature.set(feature.id, feature.layerId);
      }
    }
  }

  const groups = Array.isArray(data.groups)
    ? data.groups.map((group: unknown) => {
        if (!isRecord(group) || 'layerId' in group || typeof group.id !== 'string') return group;
        const members = Array.isArray(group.featureIds) ? group.featureIds : [];
        const layerId =
          layerOfItem.get(group.id) ??
          members
            .map((id) => (typeof id === 'string' ? layerOfFeature.get(id) : undefined))
            .find((id) => id !== undefined);
        // A group that no layer lists and that has no member belongs to no layer
        return { ...group, layerId: layerId ?? '' };
      })
    : data.groups;

  return { ...data, version: '3.0.0', layers, groups, features };
}

/** A feature of version 2 in the shape of version 3 */
function upgradeFeature(feature: Json): Json {
  let result = feature;
  if ('coordinates' in feature && !('geometry' in feature)) {
    const { coordinates, ...rest } = feature;
    const geometry =
      typeof feature.type === 'string' && Array.isArray(coordinates)
        ? geometryFromCoordinates(feature.type, coordinates as FeatureCoordinates)
        : // Left for the validation to report
          { type: undefined, coordinates };
    result = { ...rest, geometry };
  }
  if (isRecord(feature.properties)) {
    const properties: Json = { ...feature.properties };
    for (const name of DRAW_PROPERTY_NAMES) {
      const key = drawPropertyKey(name);
      if (hasOwnKey(properties, name) && !hasOwnKey(properties, key)) {
        properties[key] = properties[name];
        delete properties[name];
      }
    }
    result = { ...result, properties };
    if (feature.type === 'Image' && isRecord(feature.style)) {
      const style: Json = { ...feature.style };
      if (foldLegacyImageStyle(properties, style)) result = { ...result, style };
    }
  }
  return result;
}

/** The step that takes data of each major version to the next */
const UPGRADES: ReadonlyMap<number, (data: Json) => Json> = new Map([[2, upgradeFrom2]]);

/**
 * Upgrades native data of an earlier major version to the version this library writes
 *
 * @param data - the data as it was read
 * @returns the upgraded data, or the data as it is when it is of the current major version,
 *   of a version without an upgrade, or not an object
 */
export function upgradeNativeData(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const current = majorOf(NATIVE_VERSION);
  let result: Json = data;
  for (let major = majorOf(result.version); major !== null && major !== current; ) {
    const step = UPGRADES.get(major);
    if (!step) break;
    result = step(result);
    major = majorOf(result.version);
  }
  return result;
}
