// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The contents of a dataset, whatever their input form (`DisplaySource`)
 *
 * The dataset reads its contents only through this contract: rows numbered in draw order,
 * the bbox of each row, the spatial chunks and the spatial index over them, the id and the feature
 * of a row, what the collision thinning reads, and how the rows of a chunk are collected into the
 * GPU arrays. The drawing, the hit testing, the selection, the thinning and the analytic drape
 * are written against it, so a new input form is one more implementation of this contract.
 *
 * - `FeatureArraySource` (here): an array of features (`features`, `setFeatures`, a provider)
 * - `ColumnarSource` (`columnar/source.ts`): a columnar table (`columnar`, `setColumnar`)
 */

import type { Feature } from '../shared/types/model.js';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import { computeFeatureBounds, type DisplayChunk, partitionIntoChunks } from './chunk.js';
import { chunkTargetSizeFor } from './partition.js';
import type { ChunkCollector, CollectOptions } from './retained.js';
import { collectFeatures } from './retained.js';
import { maxStylePointRadiusOf } from './selection.js';
import { DisplaySpatialIndex } from './spatial.js';
import type { DisplayFeatureStyler } from './style.js';
import { featureThinningRole, type ThinningRole, type ThinningRows } from './thinning.js';

/**
 * What the dataset hands to a source to collect the rows of a chunk
 *
 * @internal
 */
export interface SourceCollectContext extends CollectOptions {
  /** The rule colors and the base style of the dataset */
  styler: DisplayFeatureStyler;
  /** Whether a row survived the thinning */
  isDrawn(row: number): boolean;
  /**
   * A key that changes whenever what the styler resolves may have changed (the style revision
   * of the dataset). A source that caches resolved styles drops them when it changes
   */
  styleKey: number;
}

/**
 * The contents of a dataset
 *
 * @internal
 */
export interface DisplaySource extends ThinningRows {
  /** The number of rows (the rows are numbered in draw order: the last is in front) */
  readonly length: number;
  /** The bbox of every row, `[minX, minY, maxX, maxY]` (NaN for a row without a geometry) */
  readonly bounds: Float64Array;
  /** The spatial chunks over the rows with a geometry */
  readonly chunks: readonly DisplayChunk[];
  /** The spatial index over the rows with a geometry */
  readonly index: DisplaySpatialIndex;
  /** The largest point radius given by an individual style (px; 0 when none is given) */
  readonly maxStylePointRadius: number;
  /** Whether the row has a geometry (a row without one is neither drawn nor hit) */
  hasGeometry(row: number): boolean;
  /** The feature of a row (without the rule colors); it may be built on demand */
  featureAt(row: number): Feature;
  /** The id of a row */
  idOf(row: number): string;
  /** The geometry type of a row (null for a row without a geometry) */
  typeOf(row: number): Feature['type'] | null;
  /** The rows whose id is in the set, in draw order (only rows with a geometry) */
  rowsOfIds(ids: ReadonlySet<string>): number[];
  /** The row of an id: the last (frontmost) when several rows share it; -1 when none has it */
  rowOfId(id: string): number;
  /** Every row with a geometry as a feature, in draw order (it may be built on demand) */
  features(): Feature[];
  /** What the row is to the collision thinning */
  thinningRole(row: number): ThinningRole;
  /** The `[lng, lat]` of a row whose thinning role is `point` */
  pointOf(row: number): readonly [number, number];
  /** The point radius of the individual style of a row (undefined for none) */
  styleRadiusOf(row: number): number | undefined;
  /** Walks the rows of a chunk into the intermediate data of its build */
  collector(rows: Int32Array, context: SourceCollectContext): ChunkCollector;
}

/**
 * The contents given as an array of features
 *
 * @internal
 */
export class FeatureArraySource implements DisplaySource {
  readonly length: number;
  readonly bounds: Float64Array;
  readonly chunks: readonly DisplayChunk[];
  readonly index = new DisplaySpatialIndex();
  readonly maxStylePointRadius: number;
  /** The row of each id, built on the first request */
  private rowById: Map<string, number> | null = null;

  /**
   * @param list The normalized features, in draw order
   */
  constructor(private readonly list: Feature[]) {
    this.length = list.length;
    // The bboxes are shared by the spatial index and the chunk splitting (not computed twice)
    this.bounds = computeFeatureBounds(list);
    this.index.load(this.bounds);
    this.chunks = partitionIntoChunks(list, chunkTargetSizeFor(list.length), this.bounds);
    this.maxStylePointRadius = maxStylePointRadiusOf(list);
  }

  hasGeometry(row: number): boolean {
    return !Number.isNaN(this.bounds[row * 4]);
  }

  featureAt(row: number): Feature {
    return this.list[row];
  }

  idOf(row: number): string {
    return this.list[row].id;
  }

  typeOf(row: number): Feature['type'] | null {
    return this.hasGeometry(row) ? this.list[row].type : null;
  }

  rowsOfIds(ids: ReadonlySet<string>): number[] {
    const rows: number[] = [];
    if (ids.size === 0) return rows;
    for (let row = 0; row < this.list.length; row++) {
      if (ids.has(this.list[row].id)) rows.push(row);
    }
    return rows;
  }

  rowOfId(id: string): number {
    if (!this.rowById) {
      const map = new Map<string, number>();
      for (let row = 0; row < this.list.length; row++) map.set(this.list[row].id, row);
      this.rowById = map;
    }
    return this.rowById.get(id) ?? -1;
  }

  features(): Feature[] {
    return this.list;
  }

  thinningRole(row: number): ThinningRole {
    return featureThinningRole(this.list[row]);
  }

  pointOf(row: number): readonly [number, number] {
    return coordinatesOf(this.list[row]) as [number, number];
  }

  styleRadiusOf(row: number): number | undefined {
    return this.list[row].style?.pointRadius;
  }

  collector(rows: Int32Array, context: SourceCollectContext): ChunkCollector {
    const list = this.list;
    return collectFeatures(
      rows.length,
      (index) => {
        const row = rows[index];
        return context.isDrawn(row) ? context.styler.prepareIfStyled(list[row]) : null;
      },
      context,
    );
  }
}
