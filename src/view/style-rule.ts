// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Style rules of a layer
 *
 * A set of pure functions that evaluate the declarative style rule a layer holds
 * (`Layer.styleRule`) and derive a color from the attributes of a feature. So that the
 * same functions can be used both from rendering (FeatureDrawer) and from
 * datasets, they depend on neither the Store, nor WebGL, nor the DOM.
 *
 * The priority of evaluation is "the feature's own color > the layer's rule > the default
 * color". Whether a feature has its own color is decided by the presence of the color
 * property of the relevant channel, to match the existing style resolution (FeatureDrawer
 * merges `style.fillColor` and the like into the defaults property by property).
 * Therefore the rule does apply to a feature that only holds things other than colors,
 * such as `{ strokeWidth: 3 }`.
 *
 * When the attribute is missing or its type does not match, it falls back to the rule's
 * `other` rather than to the default color. This is so that the caller can tell
 * "the rule is not taking effect" apart from "there is no value".
 */

import { MESSAGES_EN, type Messages, resolveMessages } from '../messages.js';
import { interpolateHexColor } from '../shared/utils/color.js';
import type { Feature, FeatureStyle, FeatureType, StyleRule } from '../store/types.js';

/**
 * One row of a legend derived by {@link deriveLegend}: a label and a color.
 *
 * It holds only a label and a color. The library does not draw the legend UI.
 */
export interface LegendEntry {
  /** The displayed label */
  label: string;
  /** The color (in #RRGGBB form) */
  color: string;
}

/**
 * Which color property of a feature style the rule color goes to, by geometry type.
 *
 * It expresses which style property the rule's color becomes, per geometry type.
 *
 * - point: `pointColor` (Point / MultiPoint)
 * - stroke: `strokeColor` (LineString / MultiLineString / Freehand)
 * - fill: `fillColor` (Polygon / MultiPolygon / Circle)
 */
export type StyleRuleChannel = 'point' | 'stroke' | 'fill';

/** The name of the FeatureStyle color property corresponding to each channel */
const CHANNEL_COLOR_PROPERTY: Record<StyleRuleChannel, 'pointColor' | 'strokeColor' | 'fillColor'> =
  {
    point: 'pointColor',
    stroke: 'strokeColor',
    fill: 'fillColor',
  };

/**
 * Returns the channel that carries the rule color for a feature type.
 *
 * Types other than the known ones (Image and custom types) return 'fill'.
 *
 * @param type The feature type
 * @returns `'point'`, `'stroke'` or `'fill'`
 */
export function getStyleRuleChannel(type: FeatureType): StyleRuleChannel {
  switch (type) {
    case 'Point':
    case 'MultiPoint':
      return 'point';
    case 'LineString':
    case 'MultiLineString':
    case 'Freehand':
      return 'stroke';
    default:
      return 'fill';
  }
}

/**
 * Computes the key string of categorical
 *
 * Strings, numbers and booleans are turned into strings with `String()` and matched
 * against the keys of the map. Anything else (objects, arrays, null, undefined) is not
 * matched.
 */
function toCategoricalKey(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Computes the number used by graduated / continuous
 *
 * No type conversion is done. Non-numbers (numeric strings included), NaN and Infinity
 * give null.
 */
function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Computes the class of graduated
 *
 * `breaks` are the boundary values in ascending order (n of them) and `colors` has n + 1
 * entries. If the value v is below `breaks[i]` it is `colors[i]`, and if it is below no
 * boundary at all it is `colors[n]`.
 */
function graduatedIndex(breaks: number[], value: number): number {
  for (let i = 0; i < breaks.length; i++) {
    if (value < breaks[i]) return i;
  }
  return breaks.length;
}

/**
 * Evaluates a style rule against the attributes of a feature and returns a color.
 *
 * When the attribute is missing or its type does not match, the rule's `other` is
 * returned. `single` does not look at attributes, so it is always the same color.
 * `categorical` matches strings, numbers and booleans by `String(value)`; `graduated` and
 * `continuous` take finite numbers only (a numeric string gives `other`). `continuous`
 * clamps values outside `min`..`max` and returns the first ramp color when `max <= min`. It
 * is a pure function.
 *
 * @param rule The style rule
 * @param properties The attributes of the feature
 * @returns The color in `#RRGGBB` form
 *
 * @example
 * ```ts
 * import { evaluateStyleRule, type StyleRule } from '@sakuzu/maplibre-gl-draw';
 *
 * const rule: StyleRule = {
 *   kind: 'graduated',
 *   property: 'population',
 *   breaks: [1000, 10000],
 *   colors: ['#fee8c8', '#fdbb84', '#e34a33'],
 *   other: '#cccccc',
 * };
 * evaluateStyleRule(rule, { population: 5000 }); // '#fdbb84'
 * evaluateStyleRule(rule, { population: '5000' }); // '#cccccc' (not a number)
 * evaluateStyleRule(rule, {}); // '#cccccc'
 * ```
 */
export function evaluateStyleRule(
  rule: StyleRule,
  properties: Record<string, unknown> | undefined,
): string {
  if (rule.kind === 'single') {
    return rule.color;
  }
  return evaluateStyleRuleValue(rule, properties?.[rule.property]);
}

/**
 * Evaluates a style rule against the value of the attribute it reads
 *
 * The same result as `evaluateStyleRule(rule, { [rule.property]: value })`, for a caller that
 * holds the attribute as a column rather than as the properties of a feature.
 *
 * @internal
 */
export function evaluateStyleRuleValue(rule: StyleRule, value: unknown): string {
  if (rule.kind === 'single') {
    return rule.color;
  }

  if (rule.kind === 'categorical') {
    const key = toCategoricalKey(value);
    if (key === null) return rule.other;
    const color = rule.map[key];
    return color ?? rule.other;
  }

  const numeric = toFiniteNumber(value);
  if (numeric === null) return rule.other;

  if (rule.kind === 'graduated') {
    const color = rule.colors[graduatedIndex(rule.breaks, numeric)];
    // An invalid rule whose colors count falls short of breaks + 1 falls back to other
    return color ?? rule.other;
  }

  // continuous: linearly interpolates the 2 colors of the ramp over min..max
  // (out-of-range values are clamped)
  const [from, to] = rule.ramp;
  if (!(rule.max > rule.min)) return from;
  const t = Math.min(1, Math.max(0, (numeric - rule.min) / (rule.max - rule.min)));
  return interpolateHexColor(from, to, t);
}

/**
 * Returns the rule color of a feature, or null when there is no rule.
 *
 * Returns null when there is no rule. The precedence of the feature's own style is a
 * per-channel decision, so it is not decided here (`applyRuleColor` does it).
 *
 * @param feature The target feature
 * @param rule The style rule of the layer (undefined when it is not set)
 * @returns The rule color (in #RRGGBB form). null when there is no rule
 */
export function resolveRuleColor(feature: Feature, rule: StyleRule | undefined): string | null {
  if (!rule) return null;
  return evaluateStyleRule(rule, feature.properties);
}

/**
 * Returns the style of a feature with the rule color put on the color property of a
 * channel.
 *
 * A feature that has its own color property for the relevant channel beats the rule, so
 * in that case the original style is returned as is. Properties other than colors (stroke
 * width, opacity and so on) are used together with the rule color.
 *
 * @param style The feature's own style
 * @param ruleColor The rule color (null means there is no rule)
 * @param channel The channel that carries the rule color
 * @returns The effective style: the input itself when `ruleColor` is null or the feature
 *   has its own color for the channel, otherwise a new object
 */
export function applyRuleColor(
  style: FeatureStyle | undefined,
  ruleColor: string | null,
  channel: StyleRuleChannel,
): FeatureStyle | undefined {
  if (ruleColor === null) return style;

  const property = CHANNEL_COLOR_PROPERTY[channel];
  if (style?.[property]) return style;

  return { ...style, [property]: ruleColor };
}

/**
 * Returns the effective style of a feature under the style rule of its layer.
 *
 * A combination of `resolveRuleColor` and `applyRuleColor`. The rendering path that uses a
 * cache caches only the resolution of the rule color, so it calls the two separately.
 *
 * @param feature The target feature
 * @param rule The style rule of the layer
 * @param channel The channel that carries the rule color
 * @returns The effective style
 */
export function resolveFeatureStyle(
  feature: Feature,
  rule: StyleRule | undefined,
  channel: StyleRuleChannel,
): FeatureStyle | undefined {
  const style = feature.style as FeatureStyle | undefined;
  return applyRuleColor(style, resolveRuleColor(feature, rule), channel);
}

/**
 * Builds the class label of graduated
 *
 * Numbers are turned into strings with `String()` as they are (formatting such as digit
 * grouping and units is the caller's responsibility).
 */
function graduatedLabel(breaks: number[], index: number, messages: Messages): string {
  if (breaks.length === 0) return messages.legendAll;
  if (index === 0) return messages.legendBelow(String(breaks[0]));
  if (index >= breaks.length) return messages.legendAtLeast(String(breaks[breaks.length - 1]));
  return messages.legendRange(String(breaks[index - 1]), String(breaks[index]));
}

/**
 * Derives the rows of a legend from a style rule; the library does not draw the legend.
 *
 * Every label that is not a value of the data comes from the messages table (English by
 * default; see `Messages`). The rules for turning labels into strings are as follows.
 *
 * - single: 1 entry. The label is `legendAll` ("All")
 * - categorical: the keys of `map` become the labels as they are, lined up in declaration
 *   order. `legendOther` ("Other", the color of `other`) is appended at the end
 * - graduated: the boundary notation of each class (`legendBelow` "Below 10",
 *   `legendRange` "10 to below 20", `legendAtLeast` "20 or more"). `legendOther` is
 *   appended at the end
 * - continuous: only the 2 end points `min` and `max` (no intermediate colors).
 *   `legendOther` is appended at the end
 *
 * Numbers are turned into strings with `String()`. Locale formatting is up to the caller.
 *
 * @param rule The style rule
 * @param messages The entries of the messages table to use (default: `MESSAGES_EN`;
 *   missing entries fall back to it)
 * @returns The legend rows, in the order to show them
 *
 * @example
 * ```ts
 * import { deriveLegend, type StyleRule } from '@sakuzu/maplibre-gl-draw';
 *
 * const rule: StyleRule = {
 *   kind: 'graduated',
 *   property: 'population',
 *   breaks: [1000, 10000],
 *   colors: ['#fee8c8', '#fdbb84', '#e34a33'],
 *   other: '#cccccc',
 * };
 * deriveLegend(rule);
 * // [
 * //   { label: 'Below 1000', color: '#fee8c8' },
 * //   { label: '1000 to below 10000', color: '#fdbb84' },
 * //   { label: '10000 or more', color: '#e34a33' },
 * //   { label: 'Other', color: '#cccccc' },
 * // ]
 *
 * // In the language of the host application
 * deriveLegend(rule, { legendOther: 'Autres', legendBelow: (upper) => `Moins de ${upper}` });
 * ```
 */
export function deriveLegend(rule: StyleRule, messages?: Partial<Messages>): LegendEntry[] {
  const table = messages ? resolveMessages(messages) : MESSAGES_EN;

  if (rule.kind === 'single') {
    return [{ label: table.legendAll, color: rule.color }];
  }

  if (rule.kind === 'categorical') {
    const entries: LegendEntry[] = Object.keys(rule.map).map((key) => ({
      label: key,
      color: rule.map[key],
    }));
    entries.push({ label: table.legendOther, color: rule.other });
    return entries;
  }

  if (rule.kind === 'graduated') {
    const count = Math.min(rule.colors.length, rule.breaks.length + 1);
    const entries: LegendEntry[] = [];
    for (let i = 0; i < count; i++) {
      entries.push({ label: graduatedLabel(rule.breaks, i, table), color: rule.colors[i] });
    }
    entries.push({ label: table.legendOther, color: rule.other });
    return entries;
  }

  return [
    { label: String(rule.min), color: rule.ramp[0] },
    { label: String(rule.max), color: rule.ramp[1] },
    { label: table.legendOther, color: rule.other },
  ];
}
