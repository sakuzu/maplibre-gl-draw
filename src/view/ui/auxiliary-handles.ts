// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Extension point for the auxiliary handles
 *
 * A general-purpose hook for showing and grabbing handles on the selected feature besides the
 * vertex handles and the resize and rotate handles of the selection box. A handle says how it is
 * shown: core draws a `resize` handle as it draws the resize handles and hits it at that size,
 * and draws no `custom` handle (the extension draws it) and hits it at the size the extension
 * declares. core delegates their drags, and knows nothing at all about the meaning of a handle
 * (it only carries its kind, its position and its identifier): what a drag changes is the patches
 * the provider gives, shown by a sketch of this client and written once let go.
 *
 * There are two ways to emit handles: those bound to the selected feature (getHandles) and
 * those that can always be emitted regardless of the selection (getGlobalHandles). The
 * latter is an entry point provided for "interaction state that does not fit the concept of
 * a selection" (such as a focus held by an extension implementation), and hit testing, drag
 * delegation and the cursor all go through exactly the same machinery as the former.
 *
 * One registry belongs to one draw instance (it is part of the SelectionScope), so the handles
 * of a second draw instance on the same page never appear in, or take the drags of, the first.
 */

import type { ProjectionData } from 'maplibre-gl';
import type { DragNormalizedEvent } from '../../dispatcher/types.js';
import type { FrameDrawContext } from '../../extension/renderers.js';
import type { LngLat, ScreenPoint } from '../../shared/math/index.js';
import type { FeaturePatch } from '../../store/store.js';
import type { Coordinate, Feature } from '../../store/types.js';

/**
 * One auxiliary handle returned by an {@link AuxiliaryHandleProvider}: one core draws with the
 * look of the resize handles and hits at their size (`resize`), or one the extension draws, which
 * core hits within a square of `sizePx` (`custom`).
 */
export type AuxiliaryHandle =
  | (AuxiliaryHandleBase & { readonly kind: 'resize' })
  | (AuxiliaryHandleBase & { readonly kind: 'custom'; readonly sizePx: number });

/** What every auxiliary handle has */
interface AuxiliaryHandleBase {
  /** Identifier unique within the provider */
  id: string;
  /** Position of the handle, `[lng, lat]` in degrees */
  position: Coordinate;
  /** Cursor on hover (when omitted, 'pointer') */
  cursor?: string;
}

/**
 * The side of the square an auxiliary handle is hit in, in CSS px: the size of the resize
 * handles for a `resize` handle, the size the extension declares for a `custom` one
 *
 * @internal
 */
export function auxiliaryHandleSize(handle: AuxiliaryHandle, resizeHandleSize: number): number {
  return handle.kind === 'resize' ? resizeHandleSize : handle.sizePx;
}

/**
 * The context passed to {@link AuxiliaryHandleProvider.getHandles}: the tested point, the
 * coordinate transforms and the zoom.
 *
 * A minimal structure holding only the point being hit tested (screen px), the coordinate
 * transform and the zoom. The point is passed as is so that dynamic handles which appear
 * only near the cursor (edge affordances and the like) can be expressed. The coordinate
 * transform follows the same convention as the CoordinateTransform used by the existing
 * handle hit testing (geographic coordinates [lng, lat] <-> screen px).
 */
export interface AuxiliaryHandleContext {
  /** The point being hit tested (screen px) */
  point: ScreenPoint;
  /** Geographic coordinates -> screen px */
  project(lngLat: Coordinate): ScreenPoint;
  /** Screen px -> geographic coordinates */
  unproject(point: ScreenPoint): LngLat;
  /** Current zoom level */
  zoom: number;
}

/**
 * Which auxiliary handle of which provider was grabbed, and on which feature.
 */
export interface AuxiliaryHandleHit {
  /** The id of the provider that returned the handle */
  providerId: string;
  /** The id of the handle within the provider */
  handleId: string;
  /**
   * ID of the feature the handle sat on.
   *
   * A selection-independent handle (getGlobalHandles) has no feature, so it becomes an
   * empty string (when `global` is true).
   */
  featureId: string;
  /** Whether it came from a selection-independent handle (getGlobalHandles) */
  global?: boolean;
}

/**
 * A source of handles on the selected feature that are neither vertices nor resize handles,
 * and the receiver of their drags.
 *
 * A `HandleProvider` of `draw.extensions.handleProviders` is installed as one. The engine draws
 * the `resize` handles with the look of the resize handles, hit tests every handle at the size it
 * is shown at, and delegates their drags.
 */
export interface AuxiliaryHandleProvider {
  /** Identifier unique within the registry (re-registering with the same id overwrites) */
  id: string;
  /**
   * Returns the list of auxiliary handles for the feature in a single selection.
   * It is called on every hit test, so heavy computation must be avoided.
   */
  getHandles(feature: Feature, context: AuxiliaryHandleContext): AuxiliaryHandle[];
  /**
   * Returns the list of selection-independent handles (optional).
   *
   * They can always be emitted, whether the selection is empty or something else is
   * selected. When core has finished testing against the selected feature (getHandles) and
   * nothing was hit, it goes on to ask this one. Hit testing, drag delegation and the
   * handling of the cursor all go through exactly the same machinery as the handles of
   * getHandles.
   *
   * When one is grabbed, the AuxiliaryHandleHit has an empty featureId and global set to
   * true (because there is no feature it sits on).
   *
   * It is called on every hit test, so heavy computation must be avoided.
   */
  getGlobalHandles?(context: AuxiliaryHandleContext): AuxiliaryHandle[];
  /**
   * Drag delegation. When it returns true, core stops dragPan and routes the subsequent
   * move / end to the same provider. When false, core does not start a drag.
   */
  onHandleDragStart(hit: AuxiliaryHandleHit, event: DragNormalizedEvent): boolean;
  /**
   * Called for each move of a drag this provider accepted
   *
   * @returns The patch shown over the feature the handle is on (a sketch of this client: nothing
   *   is written), nothing for no change
   */
  onHandleDragMove(event: DragNormalizedEvent): FeaturePatch | null | undefined;
  /**
   * Called when a drag this provider accepted is let go, before it ends
   *
   * @returns The last patch, written with the patches shown; nothing writes nothing of them
   */
  onHandleDragRelease?(event: DragNormalizedEvent): FeaturePatch | null | undefined;
  /** Called at the end of a drag this provider accepted, let go or cut short */
  onHandleDragEnd(event: DragNormalizedEvent): void;
  /**
   * Draws the `custom` handles of the provider core shows: called by the selection UI only, in the
   * frame, where and while it shows the other handles of the provider (the decision of whether
   * they are shown is core's alone)
   *
   * @param feature The feature the handles are on; `null` for the handles of `getGlobalHandles`
   * @param handles The `custom` handles the provider gave, in its order (never empty)
   * @param frame The values of the frame the selection UI is drawn in
   */
  drawHandles?(
    feature: Feature | null,
    handles: readonly AuxiliaryHandle[],
    projectionData: ProjectionData,
    zoom: number,
    frame: FrameDrawContext,
  ): void;
}

/**
 * A single enumerated auxiliary handle (annotated with which provider emitted it)
 *
 * @internal
 */
export interface AuxiliaryHandleCandidate {
  providerId: string;
  handle: AuxiliaryHandle;
}

/**
 * The registered providers of auxiliary handles of one draw instance
 */
export interface AuxiliaryHandleRegistry {
  /**
   * Registers a provider (re-registering with the same id overwrites)
   *
   * @returns A function that cancels the registration (calling it after a re-registration
   *   with the same id does not remove the provider that came in later)
   */
  register(provider: AuxiliaryHandleProvider): () => void;
  /** Gets a registered provider by id */
  get(id: string): AuxiliaryHandleProvider | undefined;
  /** Enumerates the registered providers (in registration order) */
  list(): AuxiliaryHandleProvider[];
  /** Cancels every registration (called when the draw instance is destroyed) */
  clear(): void;
}

/**
 * Creates the registry of auxiliary handle providers of one draw instance
 *
 * @internal
 */
export function createAuxiliaryHandleRegistry(): AuxiliaryHandleRegistry {
  const providers = new Map<string, AuxiliaryHandleProvider>();
  return {
    register(provider) {
      providers.set(provider.id, provider);
      return () => {
        if (providers.get(provider.id) === provider) providers.delete(provider.id);
      };
    },
    get: (id) => providers.get(id),
    list: () => [...providers.values()],
    clear: () => providers.clear(),
  };
}
