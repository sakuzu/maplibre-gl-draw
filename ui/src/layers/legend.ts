// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The rows of the legend: for each layer with a style rule, from the front, the rows core derives
// from the rule (`deriveLegend`), with the words of the interface for the labels that are not
// values of the data.
//
// A layer without a rule has no rows: the colors of its features come from the default look of
// each type and from the style of each feature, which a legend of the layer cannot sum up.

import {
  type Messages as CoreMessages,
  deriveLegend,
  type Feature,
  getStyleRuleChannel,
  type Layer,
  type LegendEntry,
} from '@sakuzu/maplibre-gl-draw';
import type { Messages } from '../messages.js';

/** The shape of the swatches of a layer, after the kind of what its features draw */
export type LegendShape = 'box' | 'dot' | 'line' | 'area';

/** The legend of one layer */
export interface LegendBlock {
  /** The ID of the layer */
  layerId: string;
  /** The name of the layer */
  name: string;
  /** The rows, in the order to show them */
  entries: LegendEntry[];
  /** The shape of the swatches */
  shape: LegendShape;
}

/** What the legend reads from the draw instance */
export interface LegendSource {
  readonly layers: {
    get(id: string): Layer | undefined;
    getOrder(): readonly string[];
  };
  readonly features: { list(filter?: { layerId?: string }): Feature[] };
}

/** Fills the placeholders `{name}` of a sentence */
function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);
}

/** The words of the labels of a legend, for `deriveLegend` */
export function legendMessages(m: Messages): Partial<CoreMessages> {
  return {
    legendAll: m.legendAll,
    legendOther: m.legendOther,
    legendBelow: (upper) => fill(m.legendBelow, { upper }),
    legendAtLeast: (lower) => fill(m.legendAtLeast, { lower }),
    legendRange: (lower, upper) => fill(m.legendRange, { lower, upper }),
  };
}

/**
 * The shape of the swatches for the features of a layer: a dot for points, a line for lines, an
 * area for areas, and a box when they are mixed or there are none
 */
export function legendShape(features: readonly Feature[]): LegendShape {
  let channel: string | undefined;
  for (const feature of features) {
    if (feature.type === 'Image') continue;
    const next = getStyleRuleChannel(feature.type);
    if (channel === undefined) channel = next;
    else if (channel !== next) return 'box';
  }
  if (channel === 'point') return 'dot';
  if (channel === 'stroke') return 'line';
  if (channel === 'fill') return 'area';
  return 'box';
}

/** The legend of every layer with a style rule, from the front */
export function legendBlocks(source: LegendSource, m: Messages): LegendBlock[] {
  const words = legendMessages(m);
  const blocks: LegendBlock[] = [];
  for (const id of [...source.layers.getOrder()].reverse()) {
    const layer = source.layers.get(id);
    if (!layer?.styleRule) continue;
    blocks.push({
      layerId: layer.id,
      name: layer.name,
      entries: deriveLegend(layer.styleRule, words),
      shape: legendShape(source.features.list({ layerId: layer.id })),
    });
  }
  return blocks;
}
