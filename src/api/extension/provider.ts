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
import type { LayerTableView, RowHandle } from '../tables.js';
import type { HitTestContext, ScreenContext, SnapContext } from './context.js';
import type { Handle } from './feature-type.js';
import type { DrawPointerEvent } from './mode.js';
import type { RenderContext } from './render.js';

/** What a hit test found. */
export interface Hit {
  /**
   * What was hit: a feature, a row of a dataset, a companion of a feature, or a handle on a
   * feature
   */
  kind: 'feature' | 'dataset' | 'companion' | 'handle';
  /**
   * The ID of what was hit: of the feature, of the row of the dataset, or the ID the companion
   * or the handle gives itself
   */
  id: string;
  /** The ID of the feature a companion or a handle belongs to; absent for a feature */
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
  candidates(ctx: SnapContext): SnapCandidate[];
}

/** An extension that shows handles of its own on the selected features and receives their drags. */
export interface HandleProvider {
  /** The name it is registered under */
  readonly name: string;
  /**
   * The handles of a selected feature. The engine draws them with the look of the vertex
   * handles, hit tests them at the same size, and gives their drags to `onDrag`.
   */
  handles(feature: Feature, ctx: ScreenContext): Handle[];
  /**
   * The handles that belong to no feature, shown whatever is selected; they are hit and
   * dragged like the others, and their drag arrives with `feature` as `null`.
   */
  globalHandles?(ctx: ScreenContext): Handle[];
  /**
   * The change a drag of one of its handles makes. It is called for every move of the drag
   * and once more when the drag ends; the patch of the end is the one that stays.
   *
   * @param feature - The feature the handle is on; `null` for a handle of `globalHandles`
   * @returns The patch to apply to the feature, or `null` for no change
   */
  onDrag(feature: Feature | null, handle: Handle, event: DrawPointerEvent): FeaturePatch | null;
  /**
   * A drag of one of its handles is about to start, before the first `onDrag`.
   *
   * @param feature - The feature the handle is on; `null` for a handle of `globalHandles`
   * @returns False to refuse the drag: the pointer then does what it would do without the
   *   handle, and no `onDrag` nor `onDragEnd` follows
   */
  onDragStart?(feature: Feature | null, handle: Handle, event: DrawPointerEvent): boolean;
  /**
   * A drag of one of its handles ended, after the last `onDrag` and its patch. It is called
   * once for every drag that started, also when the drag is cut short.
   *
   * @param feature - The feature the handle is on as it is now; `null` for a handle of
   *   `globalHandles`, or when the feature is gone
   */
  onDragEnd?(feature: Feature | null, handle: Handle, event: DrawPointerEvent): void;
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
  has(view: LayerTableView, handle: RowHandle): boolean;
}

/**
 * An extension that draws a companion one step below a feature, such as a leader line, and
 * hit tests it at the same step.
 */
export interface CompanionProvider {
  /** The name it is registered under */
  readonly name: string;
  /**
   * Whether a feature has a companion. It is asked for every feature on every frame and
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
   * @returns What was hit, or `null`
   */
  hitTest(feature: Feature, ctx: HitTestContext): Hit | null;
  /**
   * A companion was clicked.
   *
   * @param hit - What `hitTest` returned
   * @returns True to consume the click, which then changes nothing else; false, or nothing,
   *   to leave it to the select mode as a click on the feature
   */
  onClick?(feature: Feature, hit: Hit, event: DrawPointerEvent): boolean;
}
