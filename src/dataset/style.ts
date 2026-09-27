// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Style resolution of a dataset
 *
 * The styles use the evaluator of chapter 5 (the pure functions of view/style-rule) as they are.
 * The precedence is "the individual color of a feature > the rule of the dataset > the base
 * style of the dataset > the default color", and the evaluation results go into a
 * StyleRuleCache per dataset (the cache the Store rendering of the draw instance uses is not
 * polluted).
 */

import type { Feature, FeatureStyle, StyleRule } from '../shared/types/model.js';
import { StyleRuleCache } from '../view/cache/style-rule.js';
import { applyRuleColor, getStyleRuleChannel, type StyleRuleChannel } from '../view/style-rule.js';
import type { DatasetBaseStyle } from './types.js';

/**
 * The rule and the base style of a dataset, and the features carrying them
 *
 * The features carrying the rule colors are reused per id (so that they are not copied every
 * frame). Whoever changes what they depend on (the rule, the base style, the contents) calls
 * `clear()`.
 *
 * @internal
 */
export class DisplayFeatureStyler {
  private styleRule: StyleRule | undefined;
  /** Base style per dataset (per channel) */
  private baseStyle: DatasetBaseStyle | undefined;
  private readonly styleCache = new StyleRuleCache();
  /** Reuse of the features carrying the rule colors (to avoid copying them every frame) */
  private readonly preparedCache = new Map<string, Feature>();

  constructor(styleRule: StyleRule | undefined, baseStyle: DatasetBaseStyle | undefined) {
    this.styleRule = styleRule;
    this.baseStyle = baseStyle;
  }

  /** The base style (undefined when not set) */
  get base(): DatasetBaseStyle | undefined {
    return this.baseStyle;
  }

  /** The style rule (undefined when not set) */
  get rule(): StyleRule | undefined {
    return this.styleRule;
  }

  /** Whether a rule or a base style is set (without either, a feature is returned as it is) */
  get isStyled(): boolean {
    return Boolean(this.styleRule) || Boolean(this.baseStyle);
  }

  /** Replaces the rule and discards the caches */
  setRule(rule: StyleRule | undefined): void {
    this.styleRule = rule;
    this.clear();
  }

  /**
   * Replaces the base style and discards the caches
   *
   * The cache of the rule colors does not depend on the base style, but it is discarded together
   * with it, to keep the handling in step with setRule.
   */
  setBase(style: DatasetBaseStyle | undefined): void {
    this.baseStyle = style;
    this.clear();
  }

  /** Discards the evaluation results and the reused features */
  clear(): void {
    this.styleCache.clear();
    this.preparedCache.clear();
  }

  /**
   * Returns the feature carrying the rule color and the base style
   *
   * When the individual style has a color for that channel, the rule has no effect
   * (applyRuleColor returns the same reference). The base style goes underneath the rule color
   * and the individual style, so it is spread first and overwritten afterwards. Only when neither
   * the rule nor the base style had any effect is the original feature returned as it is.
   */
  prepare(feature: Feature): Feature {
    const cached = this.preparedCache.get(feature.id);
    if (cached) return cached;

    const channel = getStyleRuleChannel(feature.type);
    const ruleColor = this.styleCache.resolve(feature, this.styleRule);
    const style = this.effectiveStyle(feature.style, ruleColor, channel);
    const prepared = style === feature.style ? feature : { ...feature, style };
    this.preparedCache.set(feature.id, prepared);
    return prepared;
  }

  /**
   * The style that `prepare` gives a feature: the individual style over the rule color over the
   * base style of the channel
   *
   * @param style The individual style (undefined for none)
   * @param ruleColor The rule color (null without a rule)
   */
  effectiveStyle(
    style: FeatureStyle | undefined,
    ruleColor: string | null,
    channel: StyleRuleChannel,
  ): FeatureStyle | undefined {
    const styled = applyRuleColor(style, ruleColor, channel);
    const base = this.baseStyle?.[channel];
    return base ? { ...base, ...styled } : styled;
  }

  /** Like `prepare`, but returns the feature as it is when nothing is set */
  prepareIfStyled(feature: Feature): Feature {
    return this.isStyled ? this.prepare(feature) : feature;
  }

  /**
   * Returns the array of features carrying the rule colors and the base style
   *
   * The original array is returned as it is when neither the rule nor the base style is set.
   */
  prepareAll(features: Feature[]): Feature[] {
    if (!this.isStyled) return features;

    const result: Feature[] = new Array(features.length);
    for (let i = 0; i < features.length; i++) {
      result[i] = this.prepare(features[i]);
    }
    return result;
  }
}
