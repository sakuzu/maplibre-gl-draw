// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.features`: the features of the document
 */

import type { BBox } from '../geometry/types.js';
import type {
  AppliedStyle,
  Feature,
  FeatureFilter,
  FeatureListOptions,
  FeatureRow,
  FeatureStyleResolved,
} from './model.js';
import type { VertexRef } from './state.js';
import type { TaskOptions } from './write.js';

/** The options of {@link FeaturesCollection.scan} */
export interface ScanOptions extends TaskOptions {
  /** Reads only the features that match every key given */
  readonly query?: FeatureFilter;
}

/**
 * The features of the document, to read: what was committed, never a write under way. They are
 * written through the transaction of `draw.write` (`tx.features`).
 *
 * A wrong argument (an input of the wrong shape) throws a `DrawError`. A feature that is not there
 * is not an error: `get` returns `undefined`.
 */
export interface FeaturesCollection {
  /**
   * Gets a feature by ID, as the document holds it. A feature as it is drawn, with the sketches
   * applied over it, is `draw.rendered.get`.
   *
   * @returns The feature, or `undefined` when there is none with this ID
   */
  get(id: string): Feature | undefined;
  /**
   * Gets features by ID, in the order of the IDs, as the document holds them.
   *
   * @returns One entry per ID: the feature, or `undefined` when there is none with that ID
   */
  getMany(ids: readonly string[]): (Feature | undefined)[];
  /**
   * Lists the features in stacking order, from the back.
   *
   * With `limit`, at most that many features are made, from the first or from the one after
   * `after`: the pages of a long list are read one after the other, each from the last feature of
   * the one before. A Store that holds its features as rows is listed only so: its features are
   * made when they are read, and it can hold more than can be made at once.
   *
   * @param filter - Keeps only the features that match every key given
   * @param options - The number of features made at most, and the feature read last
   * @returns The features, from the back (fewer than `limit` once the last page is read)
   * @throws `DrawError` with the code `invalidState` when the Store holds its features as rows
   *   and no limit is given, `notFound` when there is no feature `after` (it was deleted
   *   meanwhile), or `invalidInput` when the filter or the options have the wrong shape
   *
   * @example Reading every feature, a page at a time
   * ```ts
   * let after: string | undefined;
   * for (;;) {
   *   const page = draw.features.list(undefined, { limit: 1000, after });
   *   page.forEach(read);
   *   if (page.length < 1000) break;
   *   after = page[page.length - 1].id;
   * }
   * ```
   */
  list(filter?: FeatureFilter, options?: FeatureListOptions): Feature[];
  /**
   * Counts the features, without making them. Over a Store that holds its features as rows, a
   * count by a layer, a group or both and nothing else reads the number the tables keep rather
   * than the rows, so `count({ groupId })` is the cheap count of the features of a group.
   *
   * @param filter - Counts only the features that match every key given
   */
  count(filter?: FeatureFilter): number;
  /**
   * The extent of the features, without making them, as `[west, south, east, north]` in
   * degrees: the extent the instance draws them in (the circle of a Circle, the image of an
   * Image at the zoom it was placed at). Over a Store that holds its features as rows, it is
   * read from the boxes of the rows the tables keep. Crossing the ±180 degree meridian is not
   * handled.
   *
   * @param filter - Reads only the features that match every key given
   * @returns The extent, or `null` when no feature matches (or none has a position)
   *
   * @example Fitting the map to a layer
   * ```ts
   * const box = draw.features.bbox({ layerId: 'buildings' });
   * if (box) map.fitBounds(box, { padding: 40 });
   * ```
   */
  bbox(filter?: FeatureFilter): BBox | null;
  /** Whether a feature with this ID exists. */
  has(id: string): boolean;
  /**
   * Whether the feature can be edited now: the document is not read-only, and neither the
   * feature nor its group nor its layer is locked. A write refused for the same reasons fails
   * with `notEditable` or `locked`.
   *
   * @throws `DrawError` with the code `notFound` when there is no feature with this ID
   */
  isEditable(id: string): boolean;
  /**
   * The look of a feature of the document, as its values are: the default, the layer rule and
   * the style of the feature put on top of each other. The default is the look the custom type of
   * the feature declares (`FeatureTypeDefinition.defaultStyle`) over the defaults of the `style`
   * option for its geometry. The sketches are not applied: a feature being edited has the look of
   * its values written. The renderer of a custom type reads the look of the feature it draws,
   * the sketches applied, from its render context (`RenderContext.appliedStyle`).
   *
   * The colors of the `style` option, of the look a type declares and of the style of the
   * feature are the strings they were given, alpha included; the color of a layer rule is
   * `#rrggbb`, as {@link evaluateStyleRule} gives it, and a built-in default is `#rrggbb`.
   *
   * @returns The look, or `undefined` when there is no feature with this ID
   */
  getAppliedStyle(id: string): FeatureStyleResolved | undefined;
  /**
   * The look of a feature of the document, as `getAppliedStyle` reads it.
   *
   * @returns The look, or `undefined` when there is no feature with this ID
   */
  appliedStyle(id: string): AppliedStyle | undefined;
  /**
   * The features at a point of the screen, from the top: what the frame drawn last shows there. The
   * features are as that frame draws them: the sketches of every owner applied (what a drag of this
   * client moves included, where it is drawn) and the features moved as a whole by a drag of many
   * where they are drawn. A feature hidden, or in a layer or a group hidden, is not there; the
   * datasets are not features of the document, and hide none. A type of a plugin is hit by its own
   * test, which is not asked of what this client drags.
   *
   * @param point - The point, as `[x, y]` in CSS pixels of the map, or the `point` of an event of
   *   the map
   * @param options - How far from a feature the point still hits it, in CSS pixels (the
   *   `clickTolerance` of the options when left out)
   * @returns The features hit, from the top, each once
   * @throws `DrawError` with the code `invalidInput` when the point or the tolerance is not finite
   */
  pick(
    point: readonly [number, number] | { readonly x: number; readonly y: number },
    options?: { readonly tolerancePixels?: number },
  ): readonly { readonly feature: Feature; readonly vertex?: VertexRef }[];
  /**
   * Reads many features without making them: `visit` is given each feature of the document in
   * stacking order, from the back, as a row read where it is written. It reads the document as the
   * reads of the instance read it when the scan begins (the one before a commit made over several
   * tasks, until its last step) to the end, in one task: no commit made meanwhile is mixed in.
   *
   * The row is read only within `visit`: the same object is moved to the next feature after it. A
   * feature to keep is made with `row.toFeature()`.
   *
   * @returns A promise settled once every feature is read
   * @throws `DrawError` (the promise rejects) with the code `invalidInput` when `visit` is not a
   *   function or the options have the wrong shape, or `aborted` when the signal is aborted; what
   *   `visit` throws, which ends the scan
   */
  scan(visit: (row: FeatureRow) => void, options?: ScanOptions): Promise<void>;
}
