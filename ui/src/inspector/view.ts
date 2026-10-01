// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// What the inspector shows, read from the draw instance: nothing, one feature, several, a layer,
// a group, or several layers or groups. It is read again after each event the inspector follows,
// so what it shows is always what the draw instance holds.

import type {
  Feature,
  FeatureStyleResolved,
  FeatureType,
  Group,
  Layer,
} from '@sakuzu/maplibre-gl-draw';
import type { Messages } from '../messages.js';
import type { InspectorDraw } from './types.js';

/** The events after which the inspector reads the draw instance again */
export const INSPECTOR_EVENTS = [
  'selection.changed',
  'document.changed',
  'hidden.changed',
  'readOnly.changed',
] as const;

/** One feature, with what its inspector needs */
export interface FeatureView {
  kind: 'feature';
  feature: Feature;
  /** The look it is drawn with */
  applied: FeatureStyleResolved | undefined;
  /** Its layer */
  layer: Layer | undefined;
  /** Whether it can be edited now (not read-only, no lock on it, its group or its layer) */
  editable: boolean;
  /** Whether the document is read-only */
  readOnly: boolean;
  /** Whether this client hides it */
  hidden: boolean;
}

/** What the inspector shows */
export type InspectorView =
  | { kind: 'empty' }
  | FeatureView
  | {
      kind: 'features';
      features: Feature[];
      applied: (FeatureStyleResolved | undefined)[];
      editable: boolean;
      readOnly: boolean;
    }
  | { kind: 'layer'; layer: Layer; onlyLayer: boolean; readOnly: boolean }
  | { kind: 'group'; group: Group; layer: Layer | undefined; readOnly: boolean }
  | { kind: 'items'; type: 'layer' | 'group'; count: number; readOnly: boolean };

/** Reads what the inspector shows */
export function readView(draw: InspectorDraw): InspectorView {
  const { type, ids } = draw.selection.get();
  const readOnly = draw.isReadOnly();
  if (type === 'feature') {
    const features = draw.features.getMany(ids).filter((f): f is Feature => f !== undefined);
    if (features.length === 0) return { kind: 'empty' };
    const editable = features.every((f) => draw.features.isEditable(f.id));
    if (features.length === 1) {
      const [feature] = features;
      return {
        kind: 'feature',
        feature,
        applied: draw.features.getAppliedStyle(feature.id),
        layer: draw.layers.get(feature.layerId),
        editable,
        readOnly,
        hidden: draw.hidden.has(feature.id),
      };
    }
    const applied = features.map((f) => draw.features.getAppliedStyle(f.id));
    return { kind: 'features', features, applied, editable, readOnly };
  }
  if (type === 'layer') {
    const layers = ids.map((id) => draw.layers.get(id)).filter((l): l is Layer => !!l);
    if (layers.length === 0) return { kind: 'empty' };
    if (layers.length > 1) return { kind: 'items', type, count: layers.length, readOnly };
    return { kind: 'layer', layer: layers[0], onlyLayer: draw.layers.count() <= 1, readOnly };
  }
  if (type === 'group') {
    const groups = ids.map((id) => draw.groups.get(id)).filter((g): g is Group => !!g);
    if (groups.length === 0) return { kind: 'empty' };
    if (groups.length > 1) return { kind: 'items', type, count: groups.length, readOnly };
    const [group] = groups;
    return { kind: 'group', group, layer: draw.layers.get(group.layerId), readOnly };
  }
  return { kind: 'empty' };
}

/** The name of a type: the words of the built-in types, and a custom type as it is named */
export function typeLabel(type: FeatureType, m: Messages): string {
  switch (type) {
    case 'Point':
      return m.point;
    case 'LineString':
      return m.line;
    case 'Polygon':
      return m.polygon;
    case 'Circle':
      return m.circle;
    case 'Freehand':
      return m.freehand;
    case 'Image':
      return m.image;
    case 'MultiPoint':
      return m.multiPoint;
    case 'MultiLineString':
      return m.multiLine;
    case 'MultiPolygon':
      return m.multiPolygon;
    default:
      return type;
  }
}

/** The number of features of each type, in the order the types first appear */
export function kindCounts(
  features: readonly Pick<Feature, 'type'>[],
  m: Messages,
): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of features) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => ({ label: typeLabel(type, m), count }));
}
