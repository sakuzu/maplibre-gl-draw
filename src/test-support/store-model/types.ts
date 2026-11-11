// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The words the reference model of the Store and a Store compared with it share
 *
 * - {@link TableOperation}: one rewrite of the document (or of the selection), with its ids
 *   resolved. It is all a Store compared with the model is given, so the part that joins the
 *   model to a Store is one function from an operation to the calls of that Store
 * - {@link TableSnapshot}: what is compared after every operation, read from the model and from
 *   the Store the same way
 * - {@link TableStep}: one step of a sequence, written without ids (it picks what it acts on
 *   among what is there when it runs), so that a sequence still runs once steps are taken out of
 *   it. The model turns a step into an operation, or into nothing when it cannot be done now
 */

import type { Geometry } from 'geojson';

/** The fields of a layer the model holds */
export interface LayerValues {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly opacity: number;
}

/** The fields of a group of features the model holds (its members are in its order) */
export interface GroupValues {
  readonly id: string;
  readonly layerId: string;
  readonly name: string;
  readonly visible: boolean;
  readonly locked: boolean;
}

/** The fields of a feature the model holds (its place is in the order of its container) */
export interface FeatureValues {
  readonly id: string;
  readonly type: 'Point' | 'LineString' | 'Polygon';
  readonly geometry: Geometry;
  readonly layerId: string;
  readonly groupId: string | undefined;
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
  readonly style: Readonly<Record<string, string | number>>;
  readonly visible: boolean;
  readonly locked: boolean;
}

/** The fields of a feature an update writes (the fields given replace the ones held) */
export type FeatureUpdate = Partial<
  Pick<FeatureValues, 'geometry' | 'properties' | 'style' | 'visible' | 'locked'>
>;

/** The fields of a layer an update writes */
export type LayerUpdate = Partial<Pick<LayerValues, 'name' | 'visible' | 'locked' | 'opacity'>>;

/** The fields of a group an update writes */
export type GroupUpdate = Partial<Pick<GroupValues, 'name' | 'visible' | 'locked'>>;

/**
 * Where items are put: in a layer, or in a group of it, just above `below` (null: at the back)
 * or, without `below`, just below `above` (null: at the front); at the front without either
 */
export interface Placement {
  readonly layerId: string;
  readonly groupId?: string;
  readonly below?: string | null;
  readonly above?: string | null;
}

/** One rewrite, with its ids resolved */
export type TableOperation =
  | { readonly op: 'createLayer'; readonly layer: LayerValues }
  | { readonly op: 'updateLayer'; readonly id: string; readonly update: LayerUpdate }
  | { readonly op: 'deleteLayer'; readonly id: string }
  | { readonly op: 'setLayerOrder'; readonly order: readonly string[] }
  | { readonly op: 'createFeature'; readonly feature: FeatureValues }
  | { readonly op: 'updateFeature'; readonly id: string; readonly update: FeatureUpdate }
  | { readonly op: 'deleteFeature'; readonly id: string }
  | { readonly op: 'moveItems'; readonly ids: readonly string[]; readonly to: Placement }
  | {
      readonly op: 'createGroup';
      readonly group: GroupValues;
      readonly featureIds: readonly string[];
    }
  | { readonly op: 'updateGroup'; readonly id: string; readonly update: GroupUpdate }
  | { readonly op: 'deleteGroup'; readonly id: string }
  | { readonly op: 'selectFeatures'; readonly ids: readonly string[] }
  | { readonly op: 'transact'; readonly operations: readonly TableOperation[] };

/** A layer as it is compared: its fields and its items (features and groups), back to front */
export interface LayerSnapshot extends LayerValues {
  readonly items: readonly string[];
}

/** A group as it is compared: its fields and its members, back to front */
export interface GroupSnapshot extends GroupValues {
  readonly members: readonly string[];
}

/** What is compared after every operation */
export interface TableSnapshot {
  /** The ids of the layers, back to front */
  readonly layerOrder: readonly string[];
  /** The layers, in the order of `layerOrder` */
  readonly layers: readonly LayerSnapshot[];
  /** The groups, by id */
  readonly groups: readonly GroupSnapshot[];
  /** The features, by id */
  readonly features: readonly FeatureValues[];
  /** What the selection holds: features, or nothing */
  readonly selectionType: 'feature' | 'group' | 'layer' | null;
  /** The ids of the items selected, by id (empty when nothing is selected) */
  readonly selection: readonly string[];
}

/**
 * Something compared with the model: a Store behind the operations
 *
 * `writeRows` makes the calls of one operation (a throw is a difference of the run); `read` reads
 * what is compared. Keep the implementations thin: the model knows nothing of them.
 */
export interface TableSubject {
  apply(operation: TableOperation): void;
  read(): TableSnapshot;
  /** Lets the time a Store waits for go by (its writes done later), after each step */
  settle?(): void;
  dispose?(): void;
}

/** A shape a step creates, by its number among the shapes of the model */
export type ShapeChoice = number;

/**
 * One step of a sequence. The numbers pick among what is there when the step runs (the
 * `n`-th modulo the number there), so a step never names an id
 */
export type TableStep =
  | { readonly kind: 'createLayer' }
  | {
      readonly kind: 'updateLayer';
      readonly layer: number;
      readonly field: 'name' | 'visible' | 'locked' | 'opacity';
      readonly value: number;
    }
  | { readonly kind: 'deleteLayer'; readonly layer: number }
  | { readonly kind: 'reorderLayers'; readonly from: number; readonly to: number }
  | {
      readonly kind: 'createFeature';
      readonly layer: number;
      /** The group of the layer it goes into, or null for an item of the layer */
      readonly group: number | null;
      readonly shape: ShapeChoice;
      readonly x: number;
    }
  | {
      readonly kind: 'updateFeature';
      readonly feature: number;
      readonly field: 'geometry' | 'properties' | 'style' | 'visible' | 'locked';
      readonly value: number;
    }
  | { readonly kind: 'deleteFeature'; readonly feature: number }
  | {
      readonly kind: 'moveItems';
      /** The items moved, by their numbers among the items there */
      readonly items: readonly number[];
      readonly layer: number;
      /** The group they go into (features only), or null */
      readonly group: number | null;
      /** Where among the items of the place: a number among them, or null for an end */
      readonly near: number | null;
      /** Whether the place is given by the item below (else by the item above) */
      readonly byBelow: boolean;
    }
  | { readonly kind: 'createGroup'; readonly features: readonly number[] }
  | {
      readonly kind: 'updateGroup';
      readonly group: number;
      readonly field: 'name' | 'visible' | 'locked';
      readonly value: number;
    }
  | { readonly kind: 'deleteGroup'; readonly group: number }
  | { readonly kind: 'select'; readonly features: readonly number[] }
  | { readonly kind: 'clearSelection' }
  | { readonly kind: 'transact'; readonly steps: readonly TableStep[] };
