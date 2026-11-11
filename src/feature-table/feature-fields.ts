// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The fields of a row a feature writes, and a feature with the fields of its row written
 */

import type { Value } from '@sakuzu/tabane';
import type { RowField } from '../api/tables.js';
import type { Feature, FeatureStyle, FeatureType } from '../shared/types/model.js';
import { setOwnProperty } from '../shared/utils/own-property.js';

/**
 * The fields of a row a feature writes over another feature of the row (its layer and group of
 * features are not among them: they are written with the key of the order)
 *
 * @internal
 */
export function featureFields(before: Feature, after: Feature): Map<RowField, unknown> {
  const out = new Map<RowField, unknown>();
  if (after.type !== before.type) out.set('type', after.type);
  if (after.geometry !== before.geometry) out.set('geometry', after.geometry);
  if (after.style !== before.style) out.set('style', after.style ?? {});
  if ((after.visible !== false) !== (before.visible !== false)) {
    out.set('hidden', after.visible === false);
  }
  if ((after.locked === true) !== (before.locked === true))
    out.set('locked', after.locked === true);
  const a = (before.properties ?? {}) as Record<string, unknown>;
  const b = (after.properties ?? {}) as Record<string, unknown>;
  if (a !== b) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[key] !== b[key]) out.set(`properties:${key}`, b[key]);
    }
  }
  return out;
}

/**
 * A feature with the values of fields of its row written over it
 *
 * @internal
 */
export function featureWithFields(
  feature: Feature,
  fields: ReadonlyMap<RowField, unknown>,
): Feature {
  if (fields.size === 0) return feature;
  const out = { ...feature } as { -readonly [K in keyof Feature]: Feature[K] };
  let properties: Record<string, Value> | null = null;
  for (const [field, value] of fields) {
    if (value === undefined && !field.startsWith('properties:')) continue;
    switch (field) {
      case 'type':
        out.type = value as FeatureType;
        break;
      case 'layerId':
        out.layerId = value as string;
        break;
      case 'groupId':
        out.groupId = (value as string | null) || undefined;
        break;
      case 'geometry':
        out.geometry = value as Feature['geometry'];
        break;
      case 'style':
        out.style = (value ?? {}) as FeatureStyle;
        break;
      case 'hidden':
        out.visible = value !== true;
        break;
      case 'locked':
        out.locked = value === true;
        break;
      case 'order':
      case 'member':
        break;
      default: {
        properties ??= { ...(feature.properties ?? {}) };
        const key = field.slice('properties:'.length);
        if (value === undefined) delete properties[key];
        // The fields of a row hold values only
        else setOwnProperty(properties, key, value as Value);
      }
    }
  }
  if (properties) out.properties = properties;
  return out as Feature;
}
