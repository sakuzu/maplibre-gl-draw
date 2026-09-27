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
import type { HitTestContext, ScreenContext, SnapContext } from './context.js';
import type { Handle } from './feature-type.js';
import type { DrawPointerEvent } from './mode.js';
import type { RenderContext } from './render.js';

/** What a hit test found. */
export interface Hit {
  /** What was hit */
  kind: 'feature' | 'dataset' | 'companion' | 'handle';
  /** The ID of what was hit */
  id: string;
  /** The ID of the feature it belongs to */
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
  /** Draws the companion of a feature. */
  draw(feature: Feature, ctx: RenderContext): void;
  /**
   * Hit tests the companion of a feature.
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
