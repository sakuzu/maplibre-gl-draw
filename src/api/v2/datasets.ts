// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.datasets`: large data that is drawn but not edited, and is not part of the document
 */

import type { BBox, Feature as GeoJSONFeature, Position } from 'geojson';
import type { PreparedTable, Table } from './extension-placeholders.js';
import type { FeatureStyle, StyleRule } from './model.js';

/** A row of a dataset, given and read as a GeoJSON feature. */
export type DatasetRow = GeoJSONFeature;

/**
 * Where a dataset is stacked: below the layers of the document, above them, or inside the
 * layer order.
 */
// TODO(api-2): confirm the values (carried over)
export type DatasetOrder = 'below-store' | 'above-store' | 'layer-order';

/** Where a dataset goes in the stacking order. */
// TODO(api-2): confirm the fields (carried over)
export interface DatasetPlacement {
  /** The division of the stacking order */
  order?: DatasetOrder;
  /** The position within the division, 0 at the back */
  index?: number;
}

/**
 * The default look of the rows of a dataset for each part a style rule colors. A row without
 * a look of its own takes it.
 */
// TODO(api-2): confirm the shape (the previous type was a record keyed by the same three parts)
export interface DatasetBaseStyle {
  /** The look of points */
  point?: FeatureStyle;
  /** The look of lines */
  stroke?: FeatureStyle;
  /** The look of areas */
  fill?: FeatureStyle;
}

/** The size and the opacity the rows of a dataset are drawn with at a zoom. */
// TODO(api-2): confirm the shape (the previous type was a function type)
export interface DatasetZoomScale {
  /**
   * @param zoom - The zoom of the map
   * @returns The scale factor and the opacity at that zoom
   */
  (zoom: number): { scale: number; opacity: number };
}

/** How the point rows of a dataset that overlap on the screen are thinned out. */
// TODO(api-2): confirm the fields (carried over)
export interface DatasetCollisionThinning {
  /** Whether the thinning is on; false when it is left out */
  enabled?: boolean;
  /** The zoom from which every row is drawn; 17 when it is left out */
  fullDisplayZoom?: number;
  /** The margin around each marker, in screen pixels; 2 when it is left out */
  marginPx?: number;
}

/** What the thinning of a dataset is doing now, for a message such as "showing n of N". */
// TODO(api-2): confirm the fields (carried over)
export interface DatasetThinningStats {
  /** Whether the thinning is on */
  enabled: boolean;
  /** Whether it is thinning out rows at the current zoom */
  active: boolean;
  /** The number of rows */
  total: number;
  /** The number of rows drawn */
  visible: number;
  /** The zoom band the drawn rows were chosen for, or `null` */
  band: number | null;
}

/** The events of one dataset, by name, with their payloads. */
// TODO(api-2): confirm the names and payloads (carried over; the naming rule of the events is resource.pastParticiple)
export interface DatasetEvents {
  /** A row was clicked */
  click: { datasetId: string; row: DatasetRow; index: number; lngLat: Position };
  /** The pointer moved over a row, or off every row (`row` and `index` are then `null`) */
  hover: {
    datasetId: string;
    row: DatasetRow | null;
    index: number | null;
    lngLat: Position;
  };
  /** The rows, the look, the visibility, the selection or the thinning changed */
  change: { reason: 'rows' | 'style' | 'visibility' | 'selection' | 'thinning' };
}

/**
 * What `datasets.add` takes. The rows are given in one of three ways, told apart by the name
 * of the field: `rows`, `table` or `provider`.
 */
// TODO(api-2): confirm the common fields (carried over) and the signature of provider
export type DatasetOptions = {
  /** The ID */
  id: string;
  /** The rule that colors the rows from their attributes */
  styleRule?: StyleRule;
  /** The default look */
  baseStyle?: DatasetBaseStyle;
  /** Whether the rows can be clicked and snapped to */
  interactive?: boolean;
  /** Where it is stacked */
  order?: DatasetOrder;
  /** The size and the opacity by zoom */
  zoomScale?: DatasetZoomScale;
  /** The thinning of overlapping points */
  collisionThinning?: DatasetCollisionThinning;
} & (
  | {
      /** The rows as GeoJSON features */
      rows: readonly DatasetRow[];
    }
  | {
      /** The rows as a table, prepared or not */
      table: Table | PreparedTable;
    }
  | {
      /** A function that returns the rows of the range in view */
      provider: (bbox: BBox, zoom: number) => Promise<DatasetRow[]>;
    }
);

/**
 * Large data drawn on the map and not edited; it is not part of the document.
 */
// TODO(api-2): confirm the members (the design names setRows, setTable and getRow; the rest are carried over)
export interface Dataset {
  /** The ID */
  readonly id: string;
  /** Where it is stacked */
  readonly order: DatasetOrder;
  /** Whether the rows can be clicked and snapped to */
  readonly interactive: boolean;
  /** Whether it is visible */
  readonly visible: boolean;
  /** Shows or hides the dataset. */
  setVisible(visible: boolean): void;
  /** Replaces every row. */
  setRows(rows: readonly DatasetRow[]): void;
  /** Replaces every row with a table. */
  setTable(table: Table | PreparedTable): void;
  /** Reads a row as a GeoJSON feature; `undefined` when there is no such row. */
  getRow(index: number): DatasetRow | undefined;
  /** Replaces the style rule; `undefined` removes it. */
  setStyleRule(rule: StyleRule | undefined): void;
  /** Replaces the default look; `undefined` removes it. */
  setBaseStyle(style: DatasetBaseStyle | undefined): void;
  /** The default look. */
  getBaseStyle(): DatasetBaseStyle | undefined;
  /** Replaces the size and the opacity by zoom; `null` removes them. */
  setZoomScale(zoomScale: DatasetZoomScale | null): void;
  /** The size and the opacity by zoom. */
  getZoomScale(): DatasetZoomScale | null;
  /** Replaces the thinning of overlapping points; `null` turns it off. */
  setCollisionThinning(options: DatasetCollisionThinning | null): void;
  /** What the thinning is doing now. */
  getThinningStats(): DatasetThinningStats;
  /** Subscribes to an event of this dataset and returns the function that unsubscribes. */
  on<K extends keyof DatasetEvents>(
    event: K,
    listener: (payload: DatasetEvents[K]) => void,
  ): () => void;
  /** Unsubscribes from an event of this dataset. */
  off<K extends keyof DatasetEvents>(event: K, listener: (payload: DatasetEvents[K]) => void): void;
}

/**
 * The datasets on the map, in stacking order.
 */
export interface DatasetsCollection {
  /**
   * Gets a dataset by ID.
   *
   * @returns The dataset, or `undefined` when there is none with this ID
   */
  get(id: string): Dataset | undefined;
  /** Lists the datasets in stacking order. */
  list(): Dataset[];
  /** Counts the datasets. */
  count(): number;
  /** Whether a dataset with this ID exists. */
  has(id: string): boolean;
  /**
   * Adds a dataset and returns it.
   *
   * @throws `DrawError` with the code `already-exists` when the ID is taken, or
   *   `invalid-input` when the options are wrong
   */
  add(options: DatasetOptions): Dataset;
  /**
   * Removes a dataset.
   *
   * @returns True when it was removed
   * @throws `DrawError` with the code `not-found` when there is no dataset with this ID
   */
  remove(id: string): boolean;
  /**
   * Removes several datasets in one transaction: all of them or none.
   *
   * @returns True when they were removed
   * @throws `DrawError` with the code `not-found` when one of the IDs does not exist; nothing
   *   is removed then
   */
  removeMany(ids: readonly string[]): boolean;
  /**
   * Moves a dataset in the stacking order.
   *
   * @returns True when it moved
   * @throws `DrawError` with the code `not-found` when there is no dataset with this ID
   */
  move(id: string, placement: DatasetPlacement): boolean;
}
