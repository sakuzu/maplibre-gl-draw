// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The rows of the legend: for each layer and each dataset with a style rule, in the order of the
// stack from the front, the rows core derives from the rule (`deriveLegend`), with the words of
// the interface for the labels that are not values of the data. The datasets are placed as in the
// layer panel: those of `above-store` in front of every layer, those of `layer-order` in their
// place among the layers, those of `below-store` behind every layer.
//
// A layer without a rule has no rows: the colors of its features come from the default look of
// each type and from the style of each feature, which a legend of the layer cannot sum up. A
// dataset without a rule has none either: its rows take the default look of the dataset.

import {
  type Messages as CoreMessages,
  type Dataset,
  deriveLegend,
  type Feature,
  type FeatureType,
  getStyleRuleChannel,
  type Layer,
  type LegendEntry,
} from '@sakuzu/maplibre-gl-draw';
import type { Messages } from '../messages.js';

/** The shape of the swatches of a layer, after the kind of what its features draw */
export type LegendShape = 'box' | 'dot' | 'line' | 'area';

/** The legend of one layer or one dataset */
export interface LegendBlock {
  /** Whether it is the legend of a layer or of a dataset */
  kind: 'layer' | 'dataset';
  /** The ID of the layer or of the dataset */
  id: string;
  /** The name of the layer, or the ID of the dataset (core gives a dataset no name) */
  name: string;
  /** The rows, in the order to show them */
  entries: LegendEntry[];
  /** The shape of the swatches */
  shape: LegendShape;
}

/** What the legend reads of a dataset */
export type LegendDataset = Pick<
  Dataset,
  'id' | 'order' | 'getStyleRule' | 'getRowType' | 'getThinningStats'
>;

/** What the legend reads from the draw instance */
export interface LegendSource {
  readonly layers: {
    get(id: string): Layer | undefined;
    getOrder(): readonly string[];
  };
  readonly features: { list(filter?: { layerId?: string }): Feature[] };
  /** The datasets; the legend has only the layers when left out */
  readonly datasets?: {
    get(id: string): LegendDataset | undefined;
    list(): readonly LegendDataset[];
  };
}

/** The most rows of a dataset whose types the shape of its swatches is read from */
const SAMPLED_ROWS = 1000;

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
  return shapeOfTypes(features.map((feature) => feature.type));
}

/** The shape of the swatches for features of these types, as `legendShape` gives it */
function shapeOfTypes(types: Iterable<FeatureType>): LegendShape {
  let channel: string | undefined;
  for (const type of types) {
    if (type === 'Image') continue;
    const next = getStyleRuleChannel(type);
    if (channel === undefined) channel = next;
    else if (channel !== next) return 'box';
  }
  if (channel === 'point') return 'dot';
  if (channel === 'stroke') return 'line';
  if (channel === 'fill') return 'area';
  return 'box';
}

/**
 * The shape of the swatches for the rows of a dataset, read from the types of its first rows (at
 * most a thousand), so that a large dataset costs no more than a small one: a box when it has no
 * rows yet
 */
export function datasetShape(dataset: LegendDataset): LegendShape {
  const count = Math.min(dataset.getThinningStats().total, SAMPLED_ROWS);
  function* types(): Generator<FeatureType> {
    for (let i = 0; i < count; i++) {
      const type = dataset.getRowType(i);
      if (type !== null) yield type;
    }
  }
  return shapeOfTypes(types());
}

/**
 * The legend of every layer and every dataset with a style rule, in the order of the stack from
 * the front. A dataset of `layer-order` that the stacking order does not list is not drawn, and
 * is left out
 */
export function legendBlocks(source: LegendSource, m: Messages): LegendBlock[] {
  const words = legendMessages(m);
  const blocks: LegendBlock[] = [];
  const all = source.datasets?.list() ?? [];
  const ofDataset = (dataset: LegendDataset): void => {
    const rule = dataset.getStyleRule();
    if (!rule) return;
    blocks.push({
      kind: 'dataset',
      id: dataset.id,
      name: dataset.id,
      entries: deriveLegend(rule, words),
      shape: datasetShape(dataset),
    });
  };
  // From the back, as core lists them
  const division = (order: LegendDataset['order']): void => {
    for (const dataset of all.filter((d) => d.order === order).reverse()) ofDataset(dataset);
  };
  const seen = new Set<string>();
  division('above-store');
  for (const id of [...source.layers.getOrder()].reverse()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const layer = source.layers.get(id);
    if (!layer) {
      const dataset = source.datasets?.get(id);
      if (dataset?.order === 'layer-order') ofDataset(dataset);
      continue;
    }
    if (!layer.styleRule) continue;
    blocks.push({
      kind: 'layer',
      id: layer.id,
      name: layer.name,
      entries: deriveLegend(layer.styleRule, words),
      shape: legendShape(source.features.list({ layerId: layer.id })),
    });
  }
  division('below-store');
  return blocks;
}
