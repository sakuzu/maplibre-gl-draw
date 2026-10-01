// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The nodes of the layer tree, built from the draw instance each time it changes.
//
// The tree reads like a stack: the front comes first. Core lists everything from the back (the
// stacking order of the layers, the items of a layer, the features of a group), so every list is
// reversed here, and a move in the tree is converted back (move.ts).
//
// A node is a layer, a group or a feature, which are selected, or a dataset, which is a row of the
// stack and is not. Its `data` is the entity of core as it was read, so the handlers of the panel
// know what was pressed without reading it again.
//
// The datasets are rows at the root in their place in the stack: those of `above-store` in front
// of every layer, those of `layer-order` where `layers.getOrder()` places them among the layers,
// and those of `below-store` behind every layer, each division from the front. A `layer-order`
// dataset that the stacking order does not list is not drawn, and is left out.

import Circle from '@lucide/svelte/icons/circle';
import Database from '@lucide/svelte/icons/database';
import Group from '@lucide/svelte/icons/group';
import Layers from '@lucide/svelte/icons/layers';
import Shapes from '@lucide/svelte/icons/shapes';
import type { IconComponent, IconSource, TreeNode } from '@sakuzu/kata/svelte';
import {
  type Dataset,
  type Group as DrawGroup,
  type Feature,
  type FeatureStyleResolved,
  getStyleRuleChannel,
  type Layer,
  type Selection,
  type SelectionType,
} from '@sakuzu/maplibre-gl-draw';
import type { Messages } from '../messages.js';

/** The kinds of the nodes that are selected, which are the types of the selection of core */
export type NodeKind = SelectionType;

/** The kinds of every node: those that are selected, and a dataset */
export type RowKind = NodeKind | 'dataset';

/** What the tree reads of a dataset */
export type TreeDataset = Pick<Dataset, 'id' | 'order' | 'visible' | 'getThinningStats'>;

/** A node of the tree, with the entity of core it was built from */
export type LayerTreeNode = TreeNode & {
  kind: RowKind;
  data: Layer | DrawGroup | Feature | TreeDataset;
  /** The number of the rows of a dataset */
  count?: number;
};

/** Whether a node is of a kind that is selected */
export function isSelectable(kind: string | undefined): kind is NodeKind {
  return kind === 'layer' || kind === 'group' || kind === 'feature';
}

/** What building the nodes reads from the draw instance */
export interface TreeSource {
  readonly layers: {
    get(id: string): Layer | undefined;
    getOrder(): readonly string[];
  };
  /** The datasets, which are rows of the stack */
  readonly datasets?: {
    get(id: string): TreeDataset | undefined;
    list(): readonly TreeDataset[];
  };
  readonly groups: { get(id: string): DrawGroup | undefined };
  readonly features: {
    get(id: string): Feature | undefined;
    getAppliedStyle(id: string): FeatureStyleResolved | undefined;
  };
  /** What this client hides; a node it hides shows as hidden */
  readonly hidden?: { has(id: string): boolean };
}

/** Whether a node shows as visible: visible in the document, and not hidden by this client */
function shown(source: TreeSource, entity: { id: string; visible: boolean }): boolean {
  return entity.visible && !source.hidden?.has(entity.id);
}

/** What the tree shows */
export interface TreeOptions {
  /** Whether the features show under the layers and the groups */
  features: boolean;
  /** Whether the datasets show as rows of the stack; true when left out */
  datasets?: boolean;
}

/** The icons of the built-in feature types: kata's drawing glyphs where it has them */
const TYPE_ICONS: Readonly<Record<string, IconSource>> = Object.freeze({
  Point: 'point',
  MultiPoint: 'point',
  LineString: 'polyline',
  MultiLineString: 'polyline',
  Polygon: 'polygon',
  MultiPolygon: 'polygon',
  Circle: Circle as unknown as IconComponent,
  Freehand: 'pencil',
  Image: 'image',
});

/** The icon of a layer, of a group and of a dataset */
export const LAYER_ICON = Layers as unknown as IconComponent;
export const GROUP_ICON = Group as unknown as IconComponent;
export const DATASET_ICON = Database as unknown as IconComponent;
/** The icon of a feature of a custom type */
const CUSTOM_ICON = Shapes as unknown as IconComponent;

/** The icon of a feature type */
export function typeIcon(type: string): IconSource {
  return TYPE_ICONS[type] ?? CUSTOM_ICON;
}

/** The words for each built-in feature type, from the set of the interface */
export function typeLabel(type: string, m: Messages): string {
  switch (type) {
    case 'Point':
      return m.point;
    case 'MultiPoint':
      return m.multiPoint;
    case 'LineString':
      return m.line;
    case 'MultiLineString':
      return m.multiLine;
    case 'Polygon':
      return m.polygon;
    case 'MultiPolygon':
      return m.multiPolygon;
    case 'Circle':
      return m.circle;
    case 'Freehand':
      return m.freehand;
    case 'Image':
      return m.image;
    default:
      // A custom type is named by the application
      return type;
  }
}

/**
 * The name of a feature: `properties.name` (the name the interface shows and edits, by the
 * convention of the interface; core has no name of its own for a feature), or the word of its
 * type when it has none
 */
export function featureName(feature: Feature, m: Messages): string {
  const name = feature.properties?.name;
  if (typeof name === 'string' && name.trim() !== '') return name;
  if (typeof name === 'number') return String(name);
  return typeLabel(feature.type, m);
}

/**
 * The color of the mark of a feature: the color it is drawn with, of the part a style rule colors
 * (the marker of a point, the line of a line, the fill of an area). An image has none
 */
export function featureColor(
  feature: Feature,
  style: FeatureStyleResolved | undefined,
): string | undefined {
  if (!style || feature.type === 'Image') return undefined;
  const channel = getStyleRuleChannel(feature.type);
  if (channel === 'point') return style.pointColor;
  if (channel === 'stroke') return style.strokeColor;
  return style.fillColor;
}

function featureNode(source: TreeSource, feature: Feature, m: Messages): LayerTreeNode {
  return {
    id: feature.id,
    kind: 'feature',
    name: featureName(feature, m),
    icon: typeIcon(feature.type),
    iconColor: featureColor(feature, source.features.getAppliedStyle(feature.id)),
    visible: shown(source, feature),
    locked: feature.locked,
    data: feature,
  };
}

/**
 * The node of a dataset: named by its ID (core gives a dataset no name), with the number of its
 * rows (`getThinningStats().total`, which counts them without building them)
 */
function datasetNode(dataset: TreeDataset): LayerTreeNode {
  return {
    id: dataset.id,
    kind: 'dataset',
    name: dataset.id,
    icon: DATASET_ICON,
    visible: dataset.visible,
    locked: false,
    count: dataset.getThinningStats().total,
    data: dataset,
  };
}

/** Whether a node is an entry of `layers.getOrder()`: a layer, or a dataset placed among them */
export function inLayerOrder(node: LayerTreeNode): boolean {
  return (
    node.kind === 'layer' ||
    (node.kind === 'dataset' && (node.data as TreeDataset).order === 'layer-order')
  );
}

/**
 * The nodes of the tree: the stack from the front, the layers and the datasets at the root, each
 * layer with its groups and features from the front, and the features of each group from the
 * front.
 *
 * An ID of the stacking order that is neither a layer nor a dataset (an entry of the application)
 * is left out, and so is an item of a layer that is neither a group nor a feature. A feature shows
 * once, under its group when it is in one.
 */
export function buildNodes(
  source: TreeSource,
  m: Messages,
  options: TreeOptions = { features: true },
): LayerTreeNode[] {
  const seen = new Set<string>();
  const nodes: LayerTreeNode[] = [];
  const datasets = options.datasets !== false ? source.datasets : undefined;
  // From the back, as core lists them
  const all = datasets?.list() ?? [];
  const division = (order: TreeDataset['order']) =>
    all
      .filter((dataset) => dataset.order === order)
      .reverse()
      .map(datasetNode);
  nodes.push(...division('above-store'));
  for (const layerId of [...source.layers.getOrder()].reverse()) {
    const layer = source.layers.get(layerId);
    if (!layer) {
      const dataset = datasets?.get(layerId);
      if (dataset?.order === 'layer-order' && !seen.has(dataset.id)) {
        seen.add(dataset.id);
        nodes.push(datasetNode(dataset));
      }
      continue;
    }
    if (seen.has(layer.id)) continue;
    seen.add(layer.id);
    const children: LayerTreeNode[] = [];
    for (const itemId of [...layer.items].reverse()) {
      if (seen.has(itemId)) continue;
      const group = source.groups.get(itemId);
      if (group) {
        seen.add(group.id);
        const node: LayerTreeNode = {
          id: group.id,
          kind: 'group',
          name: group.name,
          icon: GROUP_ICON,
          visible: shown(source, group),
          locked: group.locked,
          data: group,
        };
        if (options.features) {
          node.children = [];
          for (const featureId of [...group.featureIds].reverse()) {
            const feature = seen.has(featureId) ? undefined : source.features.get(featureId);
            if (!feature) continue;
            seen.add(feature.id);
            node.children.push(featureNode(source, feature, m));
          }
        }
        children.push(node);
        continue;
      }
      if (!options.features) continue;
      const feature = source.features.get(itemId);
      // A feature in a group shows under the group
      if (!feature || (feature.groupId !== undefined && source.groups.get(feature.groupId))) {
        continue;
      }
      seen.add(feature.id);
      children.push(featureNode(source, feature, m));
    }
    nodes.push({
      id: layer.id,
      kind: 'layer',
      name: layer.name,
      icon: LAYER_ICON,
      visible: shown(source, layer),
      locked: layer.locked,
      children,
      data: layer,
    });
  }
  nodes.push(...division('below-store'));
  return nodes;
}

/** Every node of the tree by its ID, with the ID of its parent */
export function indexNodes(
  nodes: readonly LayerTreeNode[],
): Map<string, { node: LayerTreeNode; parentId: string | null }> {
  const index = new Map<string, { node: LayerTreeNode; parentId: string | null }>();
  const walk = (list: readonly TreeNode[], parentId: string | null) => {
    for (const node of list as LayerTreeNode[]) {
      index.set(node.id, { node, parentId });
      if (node.children) walk(node.children, node.id);
    }
  };
  walk(nodes, null);
  return index;
}

/** The rows the tree shows as selected: what draw has selected, of any of the three types */
export function selectedIds(selection: Selection): string[] {
  return selection.type ? [...selection.ids] : [];
}

/**
 * What a press in the tree selects in draw, which holds one type at a time: the IDs of the new
 * selection that are of the kind of the node pressed last. With no node pressed (a key, a range
 * without a pointer), the kind of the last ID.
 *
 * @returns The type and the IDs, or null to clear the selection
 */
export function selectionOf(
  ids: readonly string[],
  kindOf: (id: string) => NodeKind | undefined,
  pressed?: NodeKind,
): { type: NodeKind; ids: string[] } | null {
  const known = ids.filter((id) => kindOf(id) !== undefined);
  if (known.length === 0) return null;
  const type = pressed ?? (kindOf(known[known.length - 1]) as NodeKind);
  const same = known.filter((id) => kindOf(id) === type);
  return same.length > 0 ? { type, ids: same } : null;
}

/**
 * Whether a node may be dropped into a parent (null for the root): a layer only at the root, a
 * group only into a layer, a feature into a layer or a group, and a dataset only at the root when
 * it is placed among the layers (`layer-order`); the others stay in front of or behind every layer
 */
export function canDropInto(node: TreeNode, parent: TreeNode | null): boolean {
  if (node.kind === 'layer') return parent === null;
  if (node.kind === 'dataset') return parent === null && inLayerOrder(node as LayerTreeNode);
  if (node.kind === 'group') return parent?.kind === 'layer';
  if (node.kind === 'feature') return parent?.kind === 'layer' || parent?.kind === 'group';
  return false;
}

/**
 * Whether the selected features can make a new group: two or more, all in one layer
 */
export function canGroup(
  selection: Selection,
  getFeature: (id: string) => Feature | undefined,
): boolean {
  if (selection.type !== 'feature' || selection.ids.length < 2) return false;
  let layerId: string | undefined;
  for (const id of selection.ids) {
    const feature = getFeature(id);
    if (!feature) return false;
    if (layerId === undefined) layerId = feature.layerId;
    else if (feature.layerId !== layerId) return false;
  }
  return true;
}
