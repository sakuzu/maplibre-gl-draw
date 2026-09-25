// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Style Rule Builder
 *
 * A helper that assembles the StyleRule passed to a layer (and to a
 * dataset) from the attribute values of the real data. Colors are taken from the default
 * palettes so that the UI only has to choose the kind, the property name and the color
 * scheme.
 */

import type { StyleRule } from '@sakuzu/maplibre-gl-draw';

import { CATEGORICAL_PALETTE, STYLE_RULE_OTHER_COLOR, STYLE_RULE_PALETTES } from '../constants';

/** Kind of style rule (`none` means no rule) */
export type StyleRuleKind = 'none' | 'single' | 'categorical' | 'graduated' | 'continuous';

/** The input the UI holds */
export interface StyleRuleDraft {
  kind: StyleRuleKind;
  property: string;
  palette: string;
}

/** Result of the assembly */
export type StyleRuleBuildResult = { rule: StyleRule } | { error: string };

/** Maximum number of categories handled by the categorical kind */
const MAX_CATEGORIES = 8;

/** Number of breaks for the graduated kind */
const GRADUATED_BREAK_COUNT = 4;

/**
 * Gets the colors of a palette (an unknown name falls back to the first palette).
 */
function getPaletteColors(palette: string): readonly string[] {
  const found = STYLE_RULE_PALETTES.find((item) => item.value === palette);
  return (found ?? STYLE_RULE_PALETTES[0]).colors;
}

/**
 * Takes n colors from a palette at even intervals.
 */
function samplePalette(colors: readonly string[], n: number): string[] {
  if (n <= 1) return [colors[colors.length - 1]];
  return Array.from({ length: n }, (_, i) => {
    const index = Math.round((i * (colors.length - 1)) / (n - 1));
    return colors[index];
  });
}

/**
 * Extracts only the numbers, in ascending order.
 */
function toSortedNumbers(values: readonly unknown[]): number[] {
  const numbers: number[] = [];
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      numbers.push(value);
    }
  }
  return numbers.sort((a, b) => a - b);
}

/**
 * Rounds to a number of digits that is fit for display.
 */
function roundForLabel(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 100) return Math.round(value);
  if (abs >= 1) return Number(value.toFixed(1));
  return Number(value.toFixed(3));
}

/**
 * Builds quantile breaks from an ascending sequence of numbers (duplicates are folded).
 */
function computeBreaks(sorted: number[], count: number): number[] {
  const breaks: number[] = [];
  for (let i = 1; i <= count; i++) {
    const position = (sorted.length - 1) * (i / (count + 1));
    const value = roundForLabel(sorted[Math.round(position)]);
    if (breaks.length === 0 || value > breaks[breaks.length - 1]) {
      breaks.push(value);
    }
  }
  return breaks;
}

/**
 * Assembles a StyleRule from attribute values.
 *
 * @param draft The input from the UI
 * @param values The attribute values taken from the target features (may contain undefined)
 */
export function buildStyleRule(
  draft: StyleRuleDraft,
  values: readonly unknown[],
): StyleRuleBuildResult {
  const colors = getPaletteColors(draft.palette);

  if (draft.kind === 'single') {
    return { rule: { kind: 'single', color: colors[colors.length - 2] ?? colors[0] } };
  }

  const property = draft.property.trim();
  if (!property) {
    return { error: 'Enter a property name' };
  }

  if (draft.kind === 'categorical') {
    const categories: string[] = [];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      const key = String(value);
      if (!categories.includes(key)) {
        categories.push(key);
      }
      if (categories.length >= MAX_CATEGORIES) break;
    }
    if (categories.length === 0) {
      return { error: `No feature has the attribute "${property}"` };
    }
    const map: Record<string, string> = {};
    categories.forEach((key, index) => {
      map[key] = CATEGORICAL_PALETTE[index % CATEGORICAL_PALETTE.length];
    });
    return { rule: { kind: 'categorical', property, map, other: STYLE_RULE_OTHER_COLOR } };
  }

  const sorted = toSortedNumbers(values);
  if (sorted.length < 2) {
    return { error: `The attribute "${property}" needs at least two numbers` };
  }

  if (draft.kind === 'graduated') {
    const breaks = computeBreaks(sorted, GRADUATED_BREAK_COUNT);
    if (breaks.length === 0) {
      return { error: `All values of the attribute "${property}" are the same` };
    }
    return {
      rule: {
        kind: 'graduated',
        property,
        breaks,
        colors: samplePalette(colors, breaks.length + 1),
        other: STYLE_RULE_OTHER_COLOR,
      },
    };
  }

  const min = roundForLabel(sorted[0]);
  const max = roundForLabel(sorted[sorted.length - 1]);
  if (min === max) {
    return { error: `All values of the attribute "${property}" are the same` };
  }
  return {
    rule: {
      kind: 'continuous',
      property,
      min,
      max,
      ramp: [colors[0], colors[colors.length - 1]],
      other: STYLE_RULE_OTHER_COLOR,
    },
  };
}

/**
 * Converts an existing StyleRule back into the UI input.
 */
export function toStyleRuleDraft(rule: StyleRule | undefined, palette: string): StyleRuleDraft {
  if (!rule) {
    return { kind: 'none', property: '', palette };
  }
  if (rule.kind === 'single') {
    return { kind: 'single', property: '', palette };
  }
  return { kind: rule.kind, property: rule.property, palette };
}
