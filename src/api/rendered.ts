// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.rendered`: the features as this client draws them
 */

import type { DraggedRows } from '../feature-table/dragged-rows.js';
import type { Footprint } from './extension/feature-type.js';
import type { Feature } from './model.js';

/**
 * The features as this client draws them: the document with the sketches applied over it
 * (`draw.sketches`, those with an owner first, then those of this client), and their selection
 * boxes in the view drawn last. What is drawn around a feature reads it here, so that it follows
 * the feature as it is drawn, also while it is edited and not written yet; what writes reads the
 * document (`draw.features`). It tells the shapes that changed with `rendered.changed`, once a
 * draw of the map that draws the change is done; the look and the selection box are read at each
 * draw. It has no look of its own: a renderer reads the look a feature is drawn with in its render
 * context (`RenderContext.appliedStyle`).
 */
export interface RenderedResource {
  /**
   * A feature as it is drawn: the feature of the document with the sketches applied over it.
   *
   * @returns The feature, or `undefined` when there is none with this ID in the document
   */
  get(id: string): Feature | undefined;
  /**
   * Features as they are drawn, in the order of the IDs.
   *
   * @returns One entry per ID: the feature, or `undefined` when there is none with that ID
   */
  getMany(ids: readonly string[]): (Feature | undefined)[];
  /**
   * The selection box of a feature as it is drawn, in the view drawn last: its footprint (the
   * one its type declares, or that of its geometry) with the margin of `selectionStyle.box`
   * added, as the library draws and hits it. A footprint laid on the map has the margin laid on
   * the map at the scale of that view; a footprint of the screen has it added to its half sizes.
   * The answer is the same whether the feature is selected or not.
   *
   * @returns The selection box, or `null` when there is no feature with this ID or it has nothing
   *   to draw
   */
  getSelectionBox(id: string): Footprint | null;
  /**
   * The footprint of a feature as it is drawn, in the view drawn last: what it covers, without
   * the margin of the selection box. For a custom type, the footprint its type declares
   * (`FeatureTypeDefinition.footprint`); for a built-in type and a type that declares none, the
   * footprint of its geometry as the library makes it (the four corners of an image, turned and
   * scaled as it is drawn; the extent of the positions of a shape; a box of a fixed size on the
   * screen around a point, the size of its marker). It is the box `getSelectionBox` adds the
   * margin to.
   *
   * @returns The footprint, or `null` when there is no feature with this ID or it has nothing to
   *   draw
   */
  getFootprint(id: string): Footprint | null;
  /**
   * The rows of a layer held as rows being dragged in bulk, and where each of them is drawn, while
   * they are drawn moved and not written yet: what is drawn with such a row reads where it is
   * drawn here, in each draw of the map. Its type is in `@sakuzu/maplibre-gl-draw/kasane`.
   *
   * @returns What reads them, or `null` when no row is dragged
   * @experimental
   */
  getDraggedRows(): DraggedRows | null;
}
