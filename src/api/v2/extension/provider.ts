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
  /** The handles of a selected feature. */
  handles(feature: Feature, ctx: ScreenContext): Handle[];
  /**
   * The change a drag of one of its handles makes.
   *
   * @returns The patch to apply to the feature, or `null` for no change
   */
  onDrag(feature: Feature, handle: Handle, event: DrawPointerEvent): FeaturePatch | null;
}

/**
 * An extension that draws a companion one step below a feature, such as a leader line, and
 * hit tests it at the same step.
 */
export interface CompanionProvider {
  /** The name it is registered under */
  readonly name: string;
  /** Draws the companion of a feature. */
  draw(feature: Feature, ctx: RenderContext): void;
  /**
   * Hit tests the companion of a feature.
   *
   * @returns What was hit, or `null`
   */
  hitTest(feature: Feature, ctx: HitTestContext): Hit | null;
}
