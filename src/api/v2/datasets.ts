// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.datasets`: large data that is drawn but not edited, and is not part of the document
 */

import type { BBox, Feature as GeoJSONFeature, Position } from 'geojson';
import type { PreparedTable, Table } from './extension-placeholders.js';
import type { FeatureStyle, FeatureType, StyleRule } from './model.js';

/** A row of a dataset, given and read as a GeoJSON feature. */
export type DatasetRow = GeoJSONFeature;

/**
 * Where a dataset is stacked: below the layers of the document, above them, or inside the
 * layer order.
 */
export type DatasetOrder = 'below-store' | 'above-store' | 'layer-order';

/** Where a dataset goes in the stacking order. */
export interface DatasetPlacement {
  /** The division of the stacking order */
  order?: DatasetOrder;
  /** The position within the division, 0 at the back */
  index?: number;
}

/**
 * The default look of the rows of a dataset for each part a style rule colors (`point`,
 * `stroke` and `fill`). A row without a look of its own takes it.
 */
export type DatasetBaseStyle = Partial<Record<'point' | 'stroke' | 'fill', FeatureStyle>>;

/** The scale factor and the opacity the rows of a dataset are drawn with at a zoom. */
export type DatasetZoomScale = (zoom: number) => { scale: number; opacity: number };

/**
 * A function that returns the rows of the range in view, for a dataset whose rows are fetched
 * as the map moves.
 *
 * @param bbox - The range in view, in degrees
 * @param zoom - The zoom of the map
 * @returns The rows of the range
 */
export type DatasetProvider = (bbox: BBox, zoom: number) => Promise<DatasetRow[]>;

/** How the point rows of a dataset that overlap on the screen are thinned out. */
export interface DatasetCollisionThinning {
  /** Whether the thinning is on; false when it is left out */
  enabled?: boolean;
  /** The zoom from which every row is drawn; 17 when it is left out */
  fullDisplayZoom?: number;
  /** The margin around each marker, in screen pixels; 2 when it is left out */
  marginPx?: number;
}

/** What the thinning of a dataset is doing now, for a message such as "showing n of N". */
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
export interface DatasetEvents {
  /** A row was clicked */
  clicked: { datasetId: string; rowIndex: number; row: DatasetRow; lngLat: Position };
  /** The pointer moved over a row, or off every row (`rowIndex` and `row` are then `null`) */
  hovered: {
    datasetId: string;
    rowIndex: number | null;
    row: DatasetRow | null;
    lngLat: Position;
  };
  /** The rows, the look, the visibility, the selection or the thinning changed */
  changed: { reason: 'rows' | 'style' | 'visibility' | 'selection' | 'thinning' };
}

/**
 * What `datasets.add` takes. The rows are given in one of three ways, told apart by the name
 * of the field: `rows`, `table` or `provider`.
 */
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
  /** The scale factor and the opacity by zoom */
  zoomScale?: DatasetZoomScale;
  /** The thinning of overlapping points */
  collisionThinning?: DatasetCollisionThinning;
  /** Picks the point rows that another renderer draws; they are not drawn by the dataset */
  externalPointRender?: (row: DatasetRow) => boolean;
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
      /** The function that returns the rows of the range in view */
      provider: DatasetProvider;
    }
);

/**
 * Large data drawn on the map and not edited; it is not part of the document.
 */
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
  /** Replaces the style rule; `undefined` removes it. */
  setStyleRule(rule: StyleRule | undefined): void;
  /** Replaces the scale factor and the opacity by zoom; `null` removes them. */
  setZoomScale(zoomScale: DatasetZoomScale | null): void;
  /** The scale factor and the opacity by zoom, or `null` when none is set. */
  getZoomScale(): DatasetZoomScale | null;
  /** Replaces the default look; `undefined` removes it. */
  setBaseStyle(style: DatasetBaseStyle | undefined): void;
  /** Replaces the function that picks the point rows another renderer draws. */
  setExternalPointRender(predicate: ((row: DatasetRow) => boolean) | undefined): void;
  /** The default look, or `undefined` when none is set. */
  getBaseStyle(): DatasetBaseStyle | undefined;
  /** Every row, in drawing order, without the rule colors and the default look. */
  getFeatures(): DatasetRow[];
  /** The rows whose extent meets the range, with the rule colors and the default look. */
  collectVisible(bbox: BBox): DatasetRow[];
  /** The indexes of the rows drawn now whose extent meets the range, in ascending order. */
  collectDrawnRows(bbox: BBox): Int32Array;
  /** Reads a row as a GeoJSON feature; `undefined` when there is no such row. */
  getRow(index: number): DatasetRow | undefined;
  /** The ID of a row, or `null` when there is no such row or it has no ID. */
  getRowId(index: number): string | null;
  /** The type of the geometry of a row, or `null` when there is no such row. */
  getRowType(index: number): FeatureType | null;
  /** The extent of a row, or `null` when there is no such row or it has no geometry. */
  getRowBounds(index: number): BBox | null;
  /** The position of a point row, or `null` when the row is not a point. */
  getRowPoint(index: number): Position | null;
  /** The index of the row with this ID, or `null` when there is none. */
  findRow(id: string): number | null;
  /** Replaces the IDs of the selected rows. */
  setSelectedIds(ids: readonly string[]): void;
  /** The IDs of the selected rows. */
  getSelectedIds(): string[];
  /** Replaces the thinning of overlapping points; `null` turns it off. */
  setCollisionThinning(options: DatasetCollisionThinning | null): void;
  /** The thinning in effect with every default filled in, or `null` when it is off. */
  getCollisionThinning(): Required<DatasetCollisionThinning> | null;
  /** The IDs of the rows the thinning draws, or `null` when it thins nothing. */
  getVisibleFeatureIds(): ReadonlySet<string> | null;
  /** What the thinning is doing now. */
  getThinningStats(): DatasetThinningStats;
  /** A number that changes whenever the rows drawn change. */
  getDrawnRowsRevision(): number;
  /** Fetches the rows of the provider again on the next move of the map. */
  invalidateProviderCache(): void;
  /** Subscribes to an event of this dataset and returns the function that unsubscribes. */
  on<K extends keyof DatasetEvents>(
    event: K,
    listener: (payload: DatasetEvents[K]) => void,
  ): () => void;
  /** Unsubscribes from an event of this dataset. */
  off<K extends keyof DatasetEvents>(event: K, listener: (payload: DatasetEvents[K]) => void): void;
  /** Removes the dataset from the map, as `draw.datasets.remove` does. */
  remove(): void;
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
   * Adds several datasets in one transaction, all of them or none, and returns them.
   *
   * @throws `DrawError` as {@link DatasetsCollection.add} does, for any of the options;
   *   nothing is added then
   */
  addMany(options: readonly DatasetOptions[]): Dataset[];
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
