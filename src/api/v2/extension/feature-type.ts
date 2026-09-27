// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Custom feature types: the one definition that says how a type is drawn, hit, selected and
 * resized
 */

import type { BBox, Geometry, Position } from 'geojson';
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
  /** The kind of GeoJSON geometry the features of this type have */
  // TODO(api-2): confirm whether a type may have more than one kind of geometry
  readonly geometry: Geometry['type'];
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
   * @param box - The box on the screen, as `[minX, minY, maxX, maxY]` in pixels
   */
  boxSelect?(feature: Feature, box: BBox, ctx: HitTestContext): boolean;
  /** The extent of the selection box of a feature, as `[minX, minY, maxX, maxY]` in pixels. */
  bounds?(feature: Feature, ctx: ScreenContext): BBox;
  /** The handles that resize or reshape a selected feature. */
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
