// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Extension point for the auxiliary handles
 *
 * A general-purpose hook for showing and grabbing handles on the selected feature that are
 * "neither a vertex nor a resize handle". Core draws them with the look of the vertex handles
 * (the selection UI), hit tests them at the same size and delegates their drags. core knows
 * nothing at all about the meaning of a handle (it only carries the position and the
 * identifier).
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

import type { DragNormalizedEvent } from '../../dispatcher/types.js';
import type { LngLat, ScreenPoint } from '../../shared/math/index.js';
import type { Coordinate, Feature } from '../../store/types.js';

/**
 * One auxiliary handle returned by an {@link AuxiliaryHandleProvider}.
 */
export interface AuxiliaryHandle {
  /** Identifier unique within the provider */
  id: string;
  /** Position of the handle, `[lng, lat]` in degrees */
  position: Coordinate;
  /** Cursor on hover (when omitted, 'pointer') */
  cursor?: string;
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
 * the handles with the look of the vertex handles, hit tests them and delegates their drags.
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
  /** Called for each move of a drag this provider accepted */
  onHandleDragMove(event: DragNormalizedEvent): void;
  /** Called at the end of a drag this provider accepted */
  onHandleDragEnd(event: DragNormalizedEvent): void;
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
