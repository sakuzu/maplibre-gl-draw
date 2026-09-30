// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Custom feature types: the one definition that says how a type is drawn, hit, selected and
 * resized
 */

import type { Geometry, Position } from 'geojson';
import type { ScreenPoint } from '../events.js';
import type { Feature, FeaturePatch } from '../model.js';
import type { HitTestContext, ScreenContext, SnapContext } from './context.js';
import type { DrawPointerEvent } from './mode.js';
import type { Hit, SnapCandidate } from './provider.js';
import type { FeatureRenderer } from './render.js';

/** One handle on a selected feature. */
export interface Handle {
  /** The ID of the handle, unique within the feature */
  id: string;
  /** The position of the handle */
  position: Position;
  /** The kind of handle, as its provider names it */
  kind: string;
  /** The CSS cursor over the handle */
  cursor?: string;
}

/**
 * The definition of a custom feature type. Its handles and snapping candidates are written
 * here; a provider is only for the types an extension does not define.
 */
export interface FeatureTypeDefinition {
  /** The name of the type; it is registered under this name */
  readonly type: string;
  /** The kind of GeoJSON geometry the features of this type have; one kind per type */
  readonly geometry: Geometry['type'];
  /**
   * How far beyond its geometry a feature of this type can be hit, in pixels, such as the
   * half size of an icon drawn on a point. The candidates of a hit test are gathered this much
   * farther out; 0 when it is left out.
   */
  readonly hitPaddingPx?: number;
  /** How the features of this type are drawn */
  readonly renderer: FeatureRenderer;
  /**
   * Hit tests a feature of this type; the geometry is hit tested when it is left out.
   *
   * @returns What was hit, or `null`
   */
  hitTest?(feature: Feature, ctx: HitTestContext): Hit | null;
  /**
   * Whether a box selection takes a feature of this type.
   *
   * @param box - The corners of the box on the screen, in pixels
   */
  boxSelect?(
    feature: Feature,
    box: { min: ScreenPoint; max: ScreenPoint },
    ctx: HitTestContext,
  ): boolean;
  /**
   * The extent of the selection box of a feature on the screen, in pixels.
   *
   * @returns The corners of the extent, or `null` when the feature has nothing to draw
   */
  bounds?(feature: Feature, ctx: ScreenContext): { min: ScreenPoint; max: ScreenPoint } | null;
  /**
   * The outline of the selection frame of a feature on the screen, in pixels, for a type whose
   * shape turns: its four corners in the order top left, top right, bottom right, bottom left
   * of the shape as it stands unturned. The engine draws the selection frame along it when it
   * is given, and from `bounds` otherwise. For a type of any geometry but `Point`, the resize
   * and rotate handles sit on it too; a `Point` type keeps a frame with no such handles.
   *
   * @returns The four corners; anything else (or an empty array) gives the frame of `bounds`
   */
  outline?(feature: Feature, ctx: ScreenContext): ScreenPoint[];
  /**
   * The handles that resize or reshape a selected feature. The engine draws them with the
   * look of the vertex handles, hit tests them at the same size, and gives their drags to
   * `onHandleDrag`.
   */
  handles?(feature: Feature, ctx: ScreenContext): Handle[];
  /**
   * The change a drag of one of its handles makes.
   *
   * @returns The patch to apply to the feature, or `null` for no change
   */
  onHandleDrag?(feature: Feature, handle: Handle, event: DrawPointerEvent): FeaturePatch | null;
  /** The snapping candidates a feature of this type offers. */
  snapCandidates?(feature: Feature, ctx: SnapContext): SnapCandidate[];
}
