// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Providers: extensions that add snapping candidates, handles or companions to feature types
 * they do not define
 *
 * A custom feature type describes its own handles and candidates in its definition; a
 * provider is for the built-in types and the types of other extensions.
 */

import type { Position } from 'geojson';
import type { Feature, FeaturePatch } from '../model.js';
import type { LayerTableView, RowRef } from '../tables.js';
import type { HandleContext, PointContext } from './context.js';
import type { CustomHandle, Handle } from './feature-type.js';
import type { DrawPointerEvent } from './mode.js';
import type { RenderContext } from './render.js';

/**
 * What a hit test of the library found (`ModeContext.hitTest`, `map.clicked`, the hit a
 * companion provider is given back in `onClick`). The library fills it in: a feature type answers
 * its hit test with the distance only, and a companion provider with its ID and the distance.
 */
export interface Hit {
  /** What was hit: a feature, a row of a dataset, or a companion of a feature */
  kind: 'feature' | 'dataset' | 'companion';
  /**
   * The ID of what was hit: of the feature, of the row of the dataset, or the ID the companion
   * gives itself
   */
  id: string;
  /** The ID of the feature a companion belongs to; absent for a feature and a row */
  featureId?: string;
  /** The ID of the dataset, for a row of a dataset */
  datasetId?: string;
  /** The distance from the point, in pixels */
  distancePx: number;
}

/** One snapping candidate. */
export interface SnapCandidate {
  /** The position to snap to */
  position: Position;
  /** The kind of candidate; a provider may use a kind of its own */
  kind: 'vertex' | 'edge' | 'intersection' | 'guide' | (string & {});
  /** The priority among candidates at the same distance; higher wins */
  priority?: number;
  /** Where the candidate came from, for display */
  source?: string;
}

/** An extension that adds snapping candidates. */
export interface SnapProvider {
  /** The name it is registered under */
  readonly name: string;
  /** The candidates near the point of the context. */
  candidates(ctx: PointContext): SnapCandidate[];
}

/** An extension that shows handles of its own on the selected features and receives their drags. */
export interface HandleProvider {
  /** The name it is registered under */
  readonly name: string;
  /**
   * The handles of a selected feature: handles the library draws as resize handles
   * (`kind: 'resize'`), and handles the provider draws itself in `drawHandles`
   * (`kind: 'custom'`). Their drags go to `onHandleDrag`. The library asks for them while one feature
   * only is selected, and shows them under the conditions told on {@link Handle}. Place them from
   * the selection box of the context (`ctx.selectionBox`), so that they sit on the box the
   * library draws.
   */
  handles(feature: Feature, ctx: HandleContext): Handle[];
  /**
   * The handles that belong to no feature, shown whatever is selected (while the select mode is
   * on and the document is neither read-only nor under the interaction lock), of the same two
   * kinds; they are hit and dragged like the others, and their drag arrives with `feature` as
   * `null`. Their context has no selection box (`ctx.selectionBox` is `null`).
   */
  globalHandles?(ctx: HandleContext): Handle[];
  /**
   * Draws the custom handles of the provider (`kind: 'custom'`), with the shared renderers of the
   * draw. The library calls it, after drawing the selection, exactly when it shows them: for the
   * handles of a selected feature under the conditions told on {@link Handle}, and for those of
   * `globalHandles` while they are shown. A provider draws its marks here and tests nothing; it is
   * not called when no custom handle is shown. Draw each mark `sizePx` wide, the size it is hit
   * at.
   *
   * @param feature - The feature the handles are on; `null` for the handles of `globalHandles`
   * @param handles - The custom handles given, in their order
   */
  drawHandles?(feature: Feature | null, handles: readonly CustomHandle[], ctx: RenderContext): void;
  /**
   * The change a drag of one of its handles makes.
   *
   * It is called for every move of the pointer during the drag, with the feature as it is then
   * (the patches of the earlier moves applied), and once more when the pointer is let go, at that
   * position: the patch of each move is shown by a sketch (`draw.sketches`) and nothing is written
   * while the drag goes on, and the patch of the end is written with them, in one write. A drag
   * whose last call gives no patch writes nothing, and so does one cut short (Esc): the sketch
   * goes, and this is not called for the end. It is not called for a drag that
   * `onHandleDragStart` refused.
   *
   * @param feature - The feature the handle is on; `null` for a handle of `globalHandles`
   * @returns The patch to apply to the feature, or `null` for no change
   */
  onHandleDrag(
    feature: Feature | null,
    handle: Handle,
    event: DrawPointerEvent,
  ): FeaturePatch | null;
  /**
   * A drag of one of its handles is about to start, before the first `onHandleDrag`.
   *
   * @param feature - The feature the handle is on; `null` for a handle of `globalHandles`
   * @returns False to refuse the drag: the pointer then does what it would do without the
   *   handle, and no `onHandleDrag` nor `onHandleDragEnd` follows
   */
  onHandleDragStart?(feature: Feature | null, handle: Handle, event: DrawPointerEvent): boolean;
  /**
   * A drag of one of its handles ended, after the last `onHandleDrag` and its patch. It is called
   * once for every drag that started, also when the drag is cut short.
   *
   * @param feature - The feature the handle is on as it is now; `null` for a handle of
   *   `globalHandles`, or when the feature is gone
   */
  onHandleDragEnd?(feature: Feature | null, handle: Handle, event: DrawPointerEvent): void;
}

/**
 * What a companion provider answers from the rows of a layer held as rows
 * (`CompanionProvider.rows`), without making features of them
 *
 * @experimental
 */
export interface CompanionProviderRows {
  /**
   * Whether the feature of a row has a companion: the answer `CompanionProvider.has` gives for
   * the feature of the row (the two must agree). Without it, a feature is made from each row to
   * ask `has` whenever the rows are classified for the drawing, so a provider should have it.
   */
  has(view: LayerTableView, handle: RowRef): boolean;
  /**
   * The keys of `properties` the answers of `has` and `CompanionProvider.has` read, so that a
   * write of other attributes of a row is drawn without asking them again. Without it, they are
   * asked again for a row whenever any of its attributes is written. A write of the geometry, the
   * style or the type of a row asks them again in either case. A key the answers read that is left
   * out here keeps the row drawn with the answer it had (its companion drawn or not drawn) after
   * a write of that key. It is read once, when the provider is added.
   */
  readonly classifyKeys?: readonly string[];
}

/**
 * An extension that draws a companion one step below a feature, such as a ring around it, and
 * hit tests it at the same step.
 */
export interface CompanionProvider {
  /** The name it is registered under */
  readonly name: string;
  /**
   * Whether a feature has a companion. It is asked for every feature on every draw of the map and
   * every hit test, so it must answer at once.
   */
  has(feature: Feature): boolean;
  /**
   * What the provider answers from the rows of a layer held as rows, without making features of
   * them. Its type is in `@sakuzu/maplibre-gl-draw/kasane`.
   *
   * @experimental
   */
  readonly rows?: CompanionProviderRows;
  /** Draws the companion of a feature. */
  draw(feature: Feature, ctx: RenderContext): void;
  /**
   * Hit tests the companion of a feature.
   *
   * It is asked at the step of the feature in the stacking order: when the point missed the
   * feature itself, and before the feature behind it. At one point, the handles of the
   * selection come first; then, from the front, each feature and then its companions, so a
   * feature (its marker, its line or its area, with the click tolerance) wins over its own
   * companion and a companion wins over the features behind its feature; the rows of a
   * dataset come only after the features and the companions in front of them.
   *
   * @returns The ID the companion gives itself (`Hit.id`) and the distance from the point in
   *   pixels, or `null` when the point misses it. The library makes the {@link Hit} of it, with
   *   the kind `companion` and the feature in `featureId`
   */
  hitTest(feature: Feature, ctx: PointContext): { id: string; distancePx: number } | null;
  /**
   * A companion was clicked.
   *
   * @param hit - The hit the library made of what `hitTest` returned: the kind `companion`, the
   *   ID of the companion, the feature in `featureId` and the distance
   * @returns True to consume the click, which then changes nothing else; false, or nothing,
   *   to leave it to the select mode as a click on the feature
   */
  onClick?(feature: Feature, hit: Hit, event: DrawPointerEvent): boolean;
}
