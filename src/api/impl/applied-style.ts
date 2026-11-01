// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The look a feature is drawn with, put together in one place for `draw.features.getAppliedStyle`
 * and for the renderers of the custom types (`RenderContext.appliedStyle`)
 *
 * Three layers go on top of each other, in this order:
 *
 * - The default: the look the custom type of the feature declares
 *   (`FeatureTypeDefinition.defaultStyle`) over the defaults of the `style` option for its
 *   geometry, which fill the keys the type leaves out; the defaults of the option alone for a type
 *   that declares none and for a built-in type
 * - The color of the layer rule, in the channel of the type only: the point, the stroke or the
 *   fill. A built-in type has the channel of its type (`getStyleRuleChannel`); a custom type the
 *   one it declares (`FeatureTypeDefinition.styleRuleChannel`), or else the one of the geometry of
 *   the feature, as a built-in type of that geometry has it
 * - The style of the feature
 *
 * @internal
 */

import { mergedKeys } from '../../store/feature-edits.js';
import type { Layer, Feature as StoredFeature } from '../../store/types.js';
import {
  getGeometryRuleChannel,
  getStyleRuleChannel,
  resolveFeatureStyle,
  type StyleRuleChannel,
} from '../../view/style-rule.js';
import type { FeatureStyle, FeatureStyleResolved } from '../model.js';
import type { RuntimeOptions } from '../options.js';
import { toAppliedDefaults } from './options.js';

/**
 * What the look of a feature is put together from
 *
 * @internal
 */
export interface AppliedStyleSource {
  /** A layer of the document, whose rule colors its features */
  getLayer(id: string): Layer | undefined;
  /** The `style` option as it was given: the defaults of each geometry */
  getStyleOptions(): RuntimeOptions['style'];
}

/**
 * The looks of the features of an instance
 *
 * @internal
 */
export interface AppliedStyles {
  /**
   * The look a feature is drawn with. While the feature, the rule of its layer, the `style` option
   * and the declaration of its type stay the same objects, it is the same object, put together
   * once, and frozen
   */
  of(feature: StoredFeature): FeatureStyleResolved;
  /**
   * Registers a custom type, with the look it declares (a copy of it) and the channel the rule
   * colors, when it declares them
   *
   * @returns The function that cancels the registration (it leaves a later registration of the
   *   same type as it is)
   */
  registerType(type: string, declared: DeclaredLook): () => void;
}

/**
 * What a custom type declares of the look of its features
 *
 * @internal
 */
export interface DeclaredLook {
  /** The look of a feature without a style of its own (`FeatureTypeDefinition.defaultStyle`) */
  readonly style?: FeatureStyle;
  /** The channel the rule colors (`FeatureTypeDefinition.styleRuleChannel`) */
  readonly channel?: StyleRuleChannel;
}

/** A look put together, with what it was put together from */
interface Entry {
  readonly rule: Layer['styleRule'];
  readonly options: RuntimeOptions['style'];
  readonly declared: DeclaredLook | undefined;
  readonly style: FeatureStyleResolved;
}

/** A copy without the keys whose value is undefined */
function withoutUndefined(value: object): Record<string, unknown> {
  return mergedKeys({}, value as Record<string, unknown>);
}

/**
 * Puts the look of a feature together: the default (the declaration of its type over the
 * defaults of the option), the color of the layer rule and the style of the feature
 */
function compose(
  feature: StoredFeature,
  rule: Layer['styleRule'],
  options: RuntimeOptions['style'],
  declared: DeclaredLook | undefined,
): FeatureStyleResolved {
  const defaults = toAppliedDefaults(options, feature.type);
  const own = resolveFeatureStyle(feature, rule, channelOf(feature, declared)) ?? {};
  return {
    ...defaults,
    ...(declared?.style && withoutUndefined(declared.style)),
    ...withoutUndefined(own),
  } as FeatureStyleResolved;
}

/**
 * The channel the layer rule colors of a feature: the one of its type for a built-in type, and
 * for a custom type the one it declares, or else the one of the geometry of the feature
 */
function channelOf(feature: StoredFeature, declared: DeclaredLook | undefined): StyleRuleChannel {
  if (!declared) return getStyleRuleChannel(feature.type);
  return declared.channel ?? getGeometryRuleChannel(feature.geometry.type);
}

/**
 * Creates the looks of the features of an instance, with no type declaring a look yet
 *
 * @internal
 */
export function createAppliedStyles(source: AppliedStyleSource): AppliedStyles {
  const declaredByType = new Map<string, DeclaredLook>();
  // A feature is a new object once it changes, so the look of each one is kept with it
  const looks = new WeakMap<StoredFeature, Entry>();
  return {
    of(feature) {
      const rule = source.getLayer(feature.layerId)?.styleRule;
      const options = source.getStyleOptions();
      const declared = declaredByType.get(feature.type);
      const kept = looks.get(feature);
      if (kept && kept.rule === rule && kept.options === options && kept.declared === declared) {
        return kept.style;
      }
      // Frozen: every reader of the feature shares it
      const style = Object.freeze(compose(feature, rule, options, declared));
      looks.set(feature, { rule, options, declared, style });
      return style;
    },
    registerType(type, declared) {
      const own: DeclaredLook = {
        ...(declared.style && { style: { ...declared.style } }),
        ...(declared.channel && { channel: declared.channel }),
      };
      declaredByType.set(type, own);
      return () => {
        if (declaredByType.get(type) === own) declaredByType.delete(type);
      };
    },
  };
}
