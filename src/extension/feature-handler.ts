// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The feature type handler of the engine
 *
 * The shape the engine reads a feature type that is not built in through: its renderer, its
 * hit testing, its box selection, its bounding boxes and its snapping candidates.
 * A `FeatureTypeDefinition` of the extension contract is installed as one of these by the
 * adapters of `api/impl/adapters.ts`. It is types only and sits low in the layer order, so the
 * view, snapping and operations layers read it without reaching up into api.
 */

import type { BoxSelectionStrategy } from '../dispatcher/hit-test/box-strategy.js';
import type { HitTestStrategy } from '../dispatcher/hit-test/strategies/index.js';
import type { BoundingBox, Feature } from '../shared/types/model.js';
import type { BoundingBoxCoords } from '../shared/types/selection-box.js';
import type { SnapCandidate, SnapProviderContext } from '../snapping/types.js';
import type { PointFrameExtent } from '../view/ui/selection-ui/index.js';
import type { FeatureTypeRenderer } from './renderers.js';

/**
 * A feature type that is not built in: how its features are drawn, hit, selected, resized and
 * snapped to
 *
 * `type`, `renderer` and `hitTest` are required. The rest have fallbacks: box selection and
 * the bounding box use the coordinates, and without `getSelectionBoundingBox` no selection UI
 * is drawn.
 *
 * @internal
 */
export interface FeatureTypeHandler {
  /** The feature type name */
  readonly type: string;

  /** The custom renderer */
  readonly renderer: FeatureTypeRenderer;

  /** The custom hit testing strategy */
  readonly hitTest: HitTestStrategy;

  /** The custom box selection strategy (when omitted, a coordinate-based fallback is used) */
  readonly boxSelection?: BoxSelectionStrategy;

  /**
   * Bounding box computation
   *
   * Used for viewport filtering in SpatialIndex.
   * When omitted, a simple bounding box is computed from the coordinates.
   *
   * @param feature The target feature
   * @param tileSize The tile size (512 by default)
   */
  getBoundingBox?(feature: Feature, tileSize: number): BoundingBox;

  /**
   * The additional reach for narrowing down candidates (in CSS pixels)
   *
   * The first stage of hit testing narrows down candidates with a radius equivalent to
   * clickTolerance, so when the hitTest strategy of this type treats a wider area as a hit (a
   * picture drawn around a point, say), the candidate is dropped before the precise test is
   * reached. Registering "how far from the center a hit can occur" here widens the candidate search
   * radius by that much.
   *
   * The test itself is still decided by the hitTest strategy as before (only the number of
   * candidates increases slightly). A value that changes with zoom or with settings is
   * registered as a function (it is evaluated on every query).
   */
  readonly candidateReachPx?: number | (() => number);

  /**
   * The half width and half height of the selection box of a zero-area point (in CSS pixels)
   *
   * A point keeps its zero area and is treated with the "point appearance" (box only, no resize
   * or rotation handles, move inside the box). This function only decides the dimensions of that
   * box (the special treatment of zero area itself does not change).
   *
   * When it is omitted, or returns null, the extent of the marker of a built-in point is used,
   * or else the default 12px square.
   *
   * @param feature The target feature
   */
  getPointFrameExtent?(feature: Feature): PointFrameExtent | null;

  /**
   * Bounding box computation for the selection UI
   *
   * Used for the visual feedback of the selected state (bounding box, handles).
   * Returns an OBB (Oriented Bounding Box) that takes rotation into account.
   * When omitted, no selection UI is drawn.
   *
   * @param feature The target feature
   * @param tileSize The tile size (512 by default)
   */
  getSelectionBoundingBox?(feature: Feature, tileSize: number): BoundingBoxCoords;

  /**
   * Returns the snapping candidates
   *
   * An extension point that lets a custom type provide its own vertices and edges as snapping
   * targets. The built-in vertex provider calls this when there is a registration for the type
   * of the target feature (when it is called, the standard enumeration of the vertices and edges
   * of that feature is not performed).
   *
   * The returned candidates may be either point candidates that have a coordinate
   * (kind: 'vertex' and the like) or segment candidates that have two endpoints (kind: 'edge').
   * The nearest point on a segment candidate is computed by SnapService.
   *
   * @param feature The target feature
   * @param ctx The snapping context (includes the cursor position, the tolerance and exclusions)
   */
  getSnapTargets?(feature: Feature, ctx: SnapProviderContext): SnapCandidate[];
}
