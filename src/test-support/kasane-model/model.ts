// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reference model of the rows: what the rewrites of a document mean, and nothing else
 *
 * It holds the document as maps and arrays (the layers in their order, the items of each layer
 * and the members of each group back to front, the fields of every layer, group and feature) and
 * the selection, and writes each operation the plainest way it means. It is written from what a
 * rewrite means, not from how a Store does it, so that a Store is compared with the meaning:
 *
 * - a new layer goes to the front of the layers, with no items
 * - a deleted layer takes its items with it, its groups and their members
 * - a new feature goes to the front of its group, or of its layer when it has no group
 * - a deleted feature leaves its container; a group it leaves empty is deleted
 * - items moved leave their containers and are put in the place one after the other, in the
 *   order given: just above `below` (null: at the back), or without it just below `above` (null:
 *   at the front), or at the front. A feature put into a group or another layer takes their
 *   layer and group; a group put into another layer takes its members with it. A group a
 *   feature leaves empty is deleted
 * - a new group takes the place of its first feature in their layer, and its features leave the
 *   items of the layer to be its members, in the order given
 * - a deleted group puts its members in its place, in their order, out of any group
 * - the fields an update gives replace the ones held
 * - the selection holds features that are there and shown: a feature deleted, hidden, or in a
 *   group or layer hidden leaves it, and nothing selected is no type
 * - the operations of a transaction are written one after the other
 *
 * A step that cannot be done now (it names a layer when there is none, it would put a group into
 * a group) is turned into nothing: the model never makes an operation a Store would refuse.
 */

import type { Geometry } from 'geojson';
import type {
  FeatureValues,
  GroupValues,
  LayerValues,
  Placement,
  TableOperation,
  TableSnapshot,
  TableStep,
} from './types.js';

/** The shapes a step creates, by their numbers */
const SHAPES: readonly ((x: number) => Pick<FeatureValues, 'type' | 'geometry'>)[] = [
  (x) => ({ type: 'Point', geometry: { type: 'Point', coordinates: [x, 0] } }),
  (x) => ({
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [x, 0],
        [x + 0.5, 0.5],
        [x + 1, 0],
      ],
    },
  }),
  (x) => ({
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, 0],
          [x + 1, 0],
          [x + 1, 1],
          [x, 1],
          [x, 0],
        ],
      ],
    },
  }),
];

/** The styles a step writes, by their numbers */
const STYLES: readonly Readonly<Record<string, string | number>>[] = [
  {},
  { strokeColor: '#3366ff' },
  { fillColor: '#00aa44', lineStyle: 'dashed' },
  { strokeColor: '#ff0000', strokeWidth: 4, lineStyle: 'dotted' },
  { pointColor: '#222222', pointRadius: 8 },
];

/** A geometry moved along x */
function moved(geometry: Geometry, dx: number): Geometry {
  const shift = (p: readonly number[]): number[] => [p[0] + dx, ...p.slice(1)];
  switch (geometry.type) {
    case 'Point':
      return { type: 'Point', coordinates: shift(geometry.coordinates) };
    case 'LineString':
      return { type: 'LineString', coordinates: geometry.coordinates.map(shift) };
    case 'Polygon':
      return { type: 'Polygon', coordinates: geometry.coordinates.map((r) => r.map(shift)) };
    default:
      return geometry;
  }
}

/** The `n`-th of a list, modulo its length (undefined for an empty list) */
function pick<T>(list: readonly T[], n: number): T | undefined {
  return list.length === 0 ? undefined : list[((n % list.length) + list.length) % list.length];
}

/** The distinct entries of a list picked by numbers, in the order picked */
function pickMany<T>(list: readonly T[], ns: readonly number[]): T[] {
  const out: T[] = [];
  for (const n of ns) {
    const value = pick(list, n);
    if (value !== undefined && !out.includes(value)) out.push(value);
  }
  return out;
}

/** Takes an entry out of a list, if it is there */
function without(list: string[], id: string): void {
  const at = list.indexOf(id);
  if (at >= 0) list.splice(at, 1);
}

interface ModelGroup extends GroupValues {
  members: string[];
}

/**
 * The reference model of the rows
 */
export class TableModel {
  readonly #layers = new Map<string, LayerValues>();
  readonly #items = new Map<string, string[]>();
  #layerOrder: string[] = [];
  readonly #groups = new Map<string, ModelGroup>();
  readonly #features = new Map<string, FeatureValues>();
  #selection: string[] = [];
  /** The number of the next id made */
  #next = 0;

  /** The operation a step means now, or null when it cannot be done */
  resolve(step: TableStep): TableOperation | null {
    // The ids are made as the step is resolved: a step that resolves to nothing makes none
    switch (step.kind) {
      case 'createLayer': {
        const id = this.#newId('layer');
        return {
          op: 'createLayer',
          layer: { id, name: id, visible: true, locked: false, opacity: 1 },
        };
      }
      case 'updateLayer': {
        const id = pick(this.#layerOrder, step.layer);
        if (id === undefined) return null;
        return {
          op: 'updateLayer',
          id,
          update: { [step.field]: fieldValue(step.field, step.value) },
        };
      }
      case 'deleteLayer': {
        const id = pick(this.#layerOrder, step.layer);
        return id === undefined ? null : { op: 'deleteLayer', id };
      }
      case 'reorderLayers': {
        const from = pick(this.#layerOrder, step.from);
        if (from === undefined || this.#layerOrder.length < 2) return null;
        const order = this.#layerOrder.filter((id) => id !== from);
        order.splice(
          ((step.to % (order.length + 1)) + order.length + 1) % (order.length + 1),
          0,
          from,
        );
        return { op: 'setLayerOrder', order };
      }
      case 'createFeature': {
        const layerId = pick(this.#layerOrder, step.layer);
        if (layerId === undefined) return null;
        const groups = this.#groupsOf(layerId);
        const groupId = step.group === null ? undefined : pick(groups, step.group);
        const shape = pick(SHAPES, step.shape);
        if (!shape) return null;
        const id = this.#newId('feature');
        return {
          op: 'createFeature',
          feature: {
            id,
            ...shape(step.x),
            layerId,
            groupId,
            properties: { name: id },
            style: {},
            visible: true,
            locked: false,
          },
        };
      }
      case 'updateFeature': {
        const id = pick(this.#featureIds(), step.feature);
        if (id === undefined) return null;
        const feature = this.#features.get(id)!;
        switch (step.field) {
          case 'geometry':
            return {
              op: 'updateFeature',
              id,
              update: { geometry: moved(feature.geometry, (step.value % 7) / 4 - 0.75) },
            };
          case 'properties':
            return {
              op: 'updateFeature',
              id,
              update: { properties: { ...feature.properties, n: step.value % 100 } },
            };
          case 'style':
            return { op: 'updateFeature', id, update: { style: pick(STYLES, step.value)! } };
          case 'visible':
          case 'locked':
            return { op: 'updateFeature', id, update: { [step.field]: step.value % 2 === 0 } };
        }
        return null;
      }
      case 'deleteFeature': {
        const id = pick(this.#featureIds(), step.feature);
        return id === undefined ? null : { op: 'deleteFeature', id };
      }
      case 'moveItems':
        return this.#resolveMove(step);
      case 'createGroup': {
        // The features of one layer that are items of it (not in a group): the layer of the first
        const loose = this.#featureIds().filter(
          (id) => this.#features.get(id)!.groupId === undefined,
        );
        const first = pick(loose, step.features[0] ?? 0);
        if (first === undefined) return null;
        const layerId = this.#features.get(first)!.layerId;
        const sameLayer = loose.filter((id) => this.#features.get(id)!.layerId === layerId);
        const featureIds = [first, ...pickMany(sameLayer, step.features.slice(1))].filter(
          (id, i, all) => all.indexOf(id) === i,
        );
        const id = this.#newId('group');
        return {
          op: 'createGroup',
          group: { id, layerId, name: id, visible: true, locked: false },
          featureIds,
        };
      }
      case 'updateGroup': {
        const id = pick([...this.#groups.keys()].sort(), step.group);
        if (id === undefined) return null;
        return {
          op: 'updateGroup',
          id,
          update: { [step.field]: fieldValue(step.field, step.value) },
        };
      }
      case 'deleteGroup': {
        const id = pick([...this.#groups.keys()].sort(), step.group);
        return id === undefined ? null : { op: 'deleteGroup', id };
      }
      case 'select': {
        const shown = this.#featureIds().filter((id) => this.#isShown(id));
        const ids = pickMany(shown, step.features);
        return ids.length === 0 ? null : { op: 'selectFeatures', ids };
      }
      case 'clearSelection':
        return { op: 'selectFeatures', ids: [] };
      case 'transact': {
        // Each step is resolved on the model as the steps before it leave it
        const operations: TableOperation[] = [];
        const saved = this.clone();
        for (const inner of step.steps) {
          const operation = saved.resolve(inner);
          if (!operation) continue;
          saved.apply(operation);
          operations.push(operation);
        }
        this.#next = saved.#next;
        return operations.length === 0 ? null : { op: 'transact', operations };
      }
    }
  }

  /** Writes an operation */
  apply(operation: TableOperation): void {
    switch (operation.op) {
      case 'createLayer':
        this.#layers.set(operation.layer.id, operation.layer);
        this.#items.set(operation.layer.id, []);
        this.#layerOrder.push(operation.layer.id);
        break;
      case 'updateLayer':
        this.#layers.set(operation.id, { ...this.#layers.get(operation.id)!, ...operation.update });
        break;
      case 'deleteLayer': {
        for (const item of this.#items.get(operation.id) ?? []) {
          const group = this.#groups.get(item);
          if (group) {
            for (const member of group.members) this.#features.delete(member);
            this.#groups.delete(item);
          } else {
            this.#features.delete(item);
          }
        }
        this.#items.delete(operation.id);
        this.#layers.delete(operation.id);
        this.#layerOrder = this.#layerOrder.filter((id) => id !== operation.id);
        break;
      }
      case 'setLayerOrder':
        this.#layerOrder = [...operation.order];
        break;
      case 'createFeature': {
        const { feature } = operation;
        this.#features.set(feature.id, feature);
        this.#containerOf(feature).push(feature.id);
        break;
      }
      case 'updateFeature':
        this.#features.set(operation.id, {
          ...this.#features.get(operation.id)!,
          ...operation.update,
        });
        break;
      case 'deleteFeature': {
        const feature = this.#features.get(operation.id)!;
        this.#leave(feature);
        this.#features.delete(operation.id);
        break;
      }
      case 'moveItems':
        this.#move(operation.ids, operation.to);
        break;
      case 'createGroup': {
        const { group, featureIds } = operation;
        const items = this.#items.get(group.layerId)!;
        // The place of the first feature among the items that stay
        const at = items
          .slice(0, items.indexOf(featureIds[0]))
          .filter((id) => !featureIds.includes(id)).length;
        for (const id of featureIds) without(items, id);
        items.splice(at, 0, group.id);
        this.#groups.set(group.id, { ...group, members: [...featureIds] });
        for (const id of featureIds) {
          this.#features.set(id, { ...this.#features.get(id)!, groupId: group.id });
        }
        break;
      }
      case 'updateGroup': {
        const group = this.#groups.get(operation.id)!;
        this.#groups.set(operation.id, { ...group, ...operation.update, members: group.members });
        break;
      }
      case 'deleteGroup': {
        const group = this.#groups.get(operation.id)!;
        const items = this.#items.get(group.layerId)!;
        items.splice(items.indexOf(group.id), 1, ...group.members);
        for (const id of group.members) {
          this.#features.set(id, { ...this.#features.get(id)!, groupId: undefined });
        }
        this.#groups.delete(group.id);
        break;
      }
      case 'selectFeatures':
        this.#selection = [...operation.ids];
        break;
      case 'transact':
        for (const inner of operation.operations) this.apply(inner);
        break;
    }
    this.#selection = this.#selection.filter((id) => this.#isShown(id));
  }

  /** What is compared */
  snapshot(): TableSnapshot {
    return {
      layerOrder: [...this.#layerOrder],
      layers: this.#layerOrder.map((id) => ({
        ...this.#layers.get(id)!,
        items: [...this.#items.get(id)!],
      })),
      groups: [...this.#groups.values()]
        .map(({ members, ...fields }) => ({ ...fields, members: [...members] }))
        .sort((a, b) => compareIds(a.id, b.id)),
      features: [...this.#features.values()].sort((a, b) => compareIds(a.id, b.id)),
      selectionType: this.#selection.length === 0 ? null : 'feature',
      selection: [...this.#selection].sort(compareIds),
    };
  }

  /** A copy of the model, which writes apart from it */
  clone(): TableModel {
    const copy = new TableModel();
    for (const [id, layer] of this.#layers) copy.#layers.set(id, layer);
    for (const [id, items] of this.#items) copy.#items.set(id, [...items]);
    copy.#layerOrder = [...this.#layerOrder];
    for (const [id, group] of this.#groups)
      copy.#groups.set(id, { ...group, members: [...group.members] });
    for (const [id, feature] of this.#features) copy.#features.set(id, feature);
    copy.#selection = [...this.#selection];
    copy.#next = this.#next;
    return copy;
  }

  #newId(prefix: string): string {
    this.#next += 1;
    return `${prefix}-${this.#next}`;
  }

  /** The ids of the features, in the order of the document (layers, items, members) */
  #featureIds(): string[] {
    const out: string[] = [];
    for (const layerId of this.#layerOrder) {
      for (const item of this.#items.get(layerId)!) {
        const group = this.#groups.get(item);
        if (group) out.push(...group.members);
        else out.push(item);
      }
    }
    return out;
  }

  /** The groups of a layer, in its order */
  #groupsOf(layerId: string): string[] {
    return (this.#items.get(layerId) ?? []).filter((id) => this.#groups.has(id));
  }

  /** The list a feature is in: the members of its group, or the items of its layer */
  #containerOf(feature: FeatureValues): string[] {
    return feature.groupId === undefined
      ? this.#items.get(feature.layerId)!
      : this.#groups.get(feature.groupId)!.members;
  }

  /** Takes a feature out of its container (a group it leaves empty is deleted) */
  #leave(feature: FeatureValues): void {
    without(this.#containerOf(feature), feature.id);
    if (feature.groupId === undefined) return;
    const group = this.#groups.get(feature.groupId)!;
    if (group.members.length === 0) {
      without(this.#items.get(group.layerId)!, group.id);
      this.#groups.delete(group.id);
    }
  }

  /** Whether a feature is there and shown, with its group and its layer */
  #isShown(id: string): boolean {
    const feature = this.#features.get(id);
    if (!feature?.visible) return false;
    if (feature.groupId !== undefined && !this.#groups.get(feature.groupId)?.visible) return false;
    return this.#layers.get(feature.layerId)?.visible === true;
  }

  #resolveMove(step: Extract<TableStep, { kind: 'moveItems' }>): TableOperation | null {
    const layerId = pick(this.#layerOrder, step.layer);
    if (layerId === undefined) return null;
    const groupId = step.group === null ? undefined : pick(this.#groupsOf(layerId), step.group);
    // The items there: the features, and the groups when they go into a layer
    const candidates = [
      ...this.#featureIds(),
      ...(groupId === undefined ? [...this.#groups.keys()].sort() : []),
    ];
    const ids = pickMany(candidates, step.items).filter(
      // A group is not moved with one of its members, nor a member into its own group alone
      (id, _, all) => {
        const feature = this.#features.get(id);
        return !(feature?.groupId !== undefined && all.includes(feature.groupId));
      },
    );
    if (ids.length === 0) return null;
    // The items of the place, the ones moved left out, and the groups the move leaves empty
    // (they are deleted): the neighbour named is one of them
    const emptied = (id: string): boolean => {
      const group = this.#groups.get(id);
      return group?.members.every((member) => ids.includes(member)) === true;
    };
    const place = (
      groupId === undefined ? this.#items.get(layerId)! : this.#groups.get(groupId)!.members
    ).filter((id) => !ids.includes(id) && !emptied(id));
    const near = step.near === null ? null : (pick(place, step.near) ?? null);
    const to: Placement = step.byBelow
      ? { layerId, ...(groupId !== undefined && { groupId }), below: near }
      : { layerId, ...(groupId !== undefined && { groupId }), above: near };
    return { op: 'moveItems', ids, to };
  }

  #move(ids: readonly string[], to: Placement): void {
    // Out of their containers first: a group left empty by the move is deleted, unless it is
    // where they go
    for (const id of ids) {
      const feature = this.#features.get(id);
      if (feature) {
        without(this.#containerOf(feature), id);
      } else {
        const group = this.#groups.get(id)!;
        without(this.#items.get(group.layerId)!, id);
      }
    }
    const target =
      to.groupId === undefined
        ? this.#items.get(to.layerId)!
        : this.#groups.get(to.groupId)!.members;
    let at: number;
    if (to.below !== undefined) at = to.below === null ? 0 : target.indexOf(to.below) + 1;
    else if (to.above !== undefined && to.above !== null) at = target.indexOf(to.above);
    else at = target.length;
    target.splice(at, 0, ...ids);
    for (const id of ids) {
      const feature = this.#features.get(id);
      if (feature) {
        this.#features.set(id, { ...feature, layerId: to.layerId, groupId: to.groupId });
      } else {
        const group = this.#groups.get(id)!;
        group.members.forEach((member) => {
          this.#features.set(member, { ...this.#features.get(member)!, layerId: to.layerId });
        });
        this.#groups.set(id, { ...group, layerId: to.layerId });
      }
    }
    // The groups the features left empty
    for (const [id, group] of [...this.#groups]) {
      if (group.members.length > 0 || id === to.groupId) continue;
      without(this.#items.get(group.layerId)!, id);
      this.#groups.delete(id);
    }
  }
}

/** The value a step writes into a field of a layer or a group */
function fieldValue(
  field: 'name' | 'visible' | 'locked' | 'opacity',
  value: number,
): string | boolean | number {
  switch (field) {
    case 'name':
      return `name ${value % 10}`;
    case 'opacity':
      return (value % 5) / 4;
    default:
      return value % 2 === 0;
  }
}

/** Ids by their prefix, then by their number */
export function compareIds(a: string, b: string): number {
  const [pa, na] = splitId(a);
  const [pb, nb] = splitId(b);
  return pa === pb ? na - nb : pa < pb ? -1 : 1;
}

function splitId(id: string): [string, number] {
  const at = id.lastIndexOf('-');
  const n = Number(id.slice(at + 1));
  return at < 0 || !Number.isFinite(n) ? [id, 0] : [id.slice(0, at), n];
}
