// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The fields of the style of features, and the patches their changes make.
//
// Each type reads its own keys of the style (the table of FeatureStyle in core): a point its
// marker, a line its stroke, an area its fill and its stroke, an image its opacity. A custom type
// has no field here. The values shown are those the feature is drawn with
// (draw.features.getAppliedStyle: the default, the layer rule and the style of the feature on top
// of each other); a change writes the key into the style of the features.
//
// The opacities are fractions from 0 to 1 in core and percentages from 0 to 100 on screen.

import type {
  Feature,
  FeatureStyle,
  FeatureStyleResolved,
  FeatureType,
  LineStyle,
  PointShape,
} from '@sakuzu/maplibre-gl-draw';
import type { Messages } from '../messages.js';
import type { InspectorDraw, InspectorField } from './types.js';

/** A key of the style that the inspector edits */
export type StyleKey = keyof FeatureStyleResolved;

/** The kind of style a type reads */
export type StyleKind = 'point' | 'line' | 'area' | 'image';

/** The values of the line style, as core's LineStyle has them */
export const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const satisfies readonly LineStyle[];

/** The shapes of a point marker, as core's PointShape has them */
export const POINT_SHAPES = [
  'circle',
  'square',
  'triangle',
  'star',
] as const satisfies readonly PointShape[];

const STROKE: readonly StyleKey[] = ['strokeColor', 'strokeWidth', 'strokeOpacity', 'lineStyle'];

/** The keys of each kind, in the order of the fields */
export const STYLE_KEYS: Readonly<Record<StyleKind, readonly StyleKey[]>> = Object.freeze({
  point: [
    'pointColor',
    'pointRadius',
    'pointShape',
    'pointOpacity',
    'pointStrokeColor',
    'pointStrokeWidth',
  ],
  line: STROKE,
  area: ['fillColor', 'fillOpacity', ...STROKE],
  image: ['imageOpacity'],
});

/** The kind of style of a type, or null for a custom type */
export function styleKind(type: FeatureType): StyleKind | null {
  switch (type) {
    case 'Point':
    case 'MultiPoint':
      return 'point';
    case 'LineString':
    case 'MultiLineString':
    case 'Freehand':
      return 'line';
    case 'Polygon':
    case 'MultiPolygon':
    case 'Circle':
      return 'area';
    case 'Image':
      return 'image';
    default:
      return null;
  }
}

/** The keys a type reads, in order; none for a custom type */
export function styleKeys(type: FeatureType): readonly StyleKey[] {
  const kind = styleKind(type);
  return kind ? STYLE_KEYS[kind] : [];
}

/** The keys that are opacities: 0 to 1 in core, percentages on screen */
const PERCENT: ReadonlySet<StyleKey> = new Set([
  'fillOpacity',
  'strokeOpacity',
  'pointOpacity',
  'imageOpacity',
]);

/** Whether a key is an opacity, shown as a percentage */
export function isPercentKey(key: string): boolean {
  return PERCENT.has(key as StyleKey);
}

/** The control of each key, without its name and its value */
type FieldShape = Omit<InspectorField, 'key' | 'label' | 'value' | 'mixed'>;

const COLOR: FieldShape = { kind: 'color' };
const PERCENT_SLIDER: FieldShape = { kind: 'slider', min: 0, max: 100, step: 1, unit: '%' };

function shapes(m: Messages): Record<StyleKey, FieldShape> {
  return {
    fillColor: COLOR,
    fillOpacity: PERCENT_SLIDER,
    strokeColor: COLOR,
    strokeWidth: { kind: 'slider', min: 0.5, max: 20, step: 0.5, unit: 'px' },
    strokeOpacity: PERCENT_SLIDER,
    lineStyle: {
      kind: 'segmented',
      options: [
        { value: 'solid', label: m.lineSolid },
        { value: 'dashed', label: m.lineDashed },
        { value: 'dotted', label: m.lineDotted },
      ] satisfies { value: (typeof LINE_STYLES)[number]; label: string }[],
    },
    pointColor: COLOR,
    pointRadius: { kind: 'slider', min: 1, max: 40, step: 1, unit: 'px' },
    pointShape: {
      kind: 'segmented',
      options: [
        { value: 'circle', label: m.shapeCircle },
        { value: 'square', label: m.shapeSquare },
        { value: 'triangle', label: m.shapeTriangle },
        { value: 'star', label: m.shapeStar },
      ] satisfies { value: (typeof POINT_SHAPES)[number]; label: string }[],
    },
    pointOpacity: PERCENT_SLIDER,
    pointStrokeColor: COLOR,
    pointStrokeWidth: { kind: 'slider', min: 0, max: 10, step: 1, unit: 'px' },
    imageOpacity: PERCENT_SLIDER,
  };
}

/** The name of each key */
function labels(m: Messages): Record<StyleKey, string> {
  return {
    fillColor: m.styleFillColor,
    fillOpacity: m.styleFillOpacity,
    strokeColor: m.styleStrokeColor,
    strokeWidth: m.styleStrokeWidth,
    strokeOpacity: m.styleStrokeOpacity,
    lineStyle: m.styleLineStyle,
    pointColor: m.stylePointColor,
    pointRadius: m.stylePointRadius,
    pointShape: m.stylePointShape,
    pointOpacity: m.stylePointOpacity,
    pointStrokeColor: m.stylePointStrokeColor,
    pointStrokeWidth: m.stylePointStrokeWidth,
    imageOpacity: m.styleImageOpacity,
  };
}

/** A value of the style as the field shows it: an opacity as a whole percentage */
export function displayValue(key: StyleKey, value: unknown): unknown {
  if (isPercentKey(key) && typeof value === 'number') return Math.round(value * 100);
  if (typeof value === 'string' && key.endsWith('Color')) return value.toLowerCase();
  return value;
}

/**
 * The keys the features share, in the order of the first one's: the keys of every type of the
 * selection. Empty when one of them is of a custom type, or when there is no feature
 */
export function sharedStyleKeys(features: readonly Pick<Feature, 'type'>[]): StyleKey[] {
  if (features.length === 0) return [];
  const [first, ...rest] = features;
  return styleKeys(first.type).filter((key) => rest.every((f) => styleKeys(f.type).includes(key)));
}

/**
 * The fields of the style of features: the keys they share, each with the value they are drawn
 * with, or `mixed` when their values differ.
 *
 * @param features - The features selected
 * @param applied - The look of a feature as core resolves it (`draw.features.getAppliedStyle`);
 *   a feature it gives nothing for shows the keys of its own style
 * @param messages - The words
 * @param disabled - Whether the fields cannot be changed (read-only, a lock)
 */
export function styleFields(
  features: readonly Feature[],
  applied: (id: string) => FeatureStyleResolved | undefined,
  messages: Messages,
  disabled = false,
): InspectorField[] {
  const keys = sharedStyleKeys(features);
  if (keys.length === 0) return [];
  const looks = features.map((f) => applied(f.id) ?? (f.style as Partial<FeatureStyleResolved>));
  const shape = shapes(messages);
  const label = labels(messages);
  return keys.map((key) => {
    const values = looks.map((look) => displayValue(key, look[key]));
    const mixed = values.some((v) => v !== values[0]);
    const field: InspectorField = { key, label: label[key], ...shape[key] };
    if (mixed) field.mixed = true;
    else field.value = values[0];
    if (disabled) field.disabled = true;
    return field;
  });
}

/**
 * The style that a change of a field writes: an opacity from a percentage to a fraction (clamped
 * to 0..1), a number as it is, a color or a choice as a string. An empty value (a number
 * input emptied) removes the key, so the feature takes the layer rule or the default again.
 */
export function stylePatch(key: string, value: unknown): FeatureStyle {
  const k = key as StyleKey;
  if (value === null || value === undefined || value === '') return { [k]: undefined };
  if (isPercentKey(k)) {
    const n = Number(value);
    return { [k]: Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : undefined };
  }
  if (typeof value === 'number') return { [k]: value } as FeatureStyle;
  return { [k]: String(value) } as FeatureStyle;
}

/**
 * The keys of the inspector's fields that the features set in their own style, over the layer
 * rule and the defaults. Keys the features share no field for (keys of an extension) are left
 * out, so a reset does not touch them
 */
export function ownStyleKeys(features: readonly Pick<Feature, 'type' | 'style'>[]): StyleKey[] {
  const fields = new Set(sharedStyleKeys(features));
  const out = new Set<StyleKey>();
  for (const f of features) {
    for (const [key, value] of Object.entries(f.style ?? {})) {
      if (value !== undefined && fields.has(key as StyleKey)) out.add(key as StyleKey);
    }
  }
  return [...out];
}

/** The style that removes keys, so the features take the layer rule or the defaults again */
export function resetPatch(keys: readonly string[]): FeatureStyle {
  const out: Record<string, undefined> = {};
  for (const key of keys) out[key] = undefined;
  return out as FeatureStyle;
}

/**
 * Writes a style into features, in one transaction
 *
 * @returns The features after the change, or null when core refused it (read-only, a lock)
 */
export function applyStyle(
  draw: Pick<InspectorDraw, 'transact' | 'features'>,
  ids: readonly string[],
  style: FeatureStyle,
): Feature[] | null {
  return draw.transact(() => draw.features.updateMany(ids.map((id) => ({ id, patch: { style } }))));
}
