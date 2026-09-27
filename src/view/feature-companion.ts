// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The extension point for companion rendering and companion hits (feature companion)
 *
 * A hook for the extension implementation to add "things that are not the feature itself,
 * but that accompany the feature, are drawn at the same z position, and are grabbable in
 * that same z order". core knows nothing at all about what a companion means (it only asks
 * where they are with has, lets them draw with draw, asks for hits with hitTest, and hands
 * a click that hit back to the provider).
 *
 * Rendering and hit testing are given to the same provider so that what is visible and
 * what is grabbable agree (they are resolved at the same position in the z scan).
 *
 * Where they are called:
 *   - Rendering: immediately before the feature itself is drawn (= one step lower in the
 *     z order). core flushes the batch in progress before and after the call to keep z
 *     consistency
 *   - Hits: in the front-to-back scan of a click, immediately after the test of the feature
 *     itself misses and before moving on to the next (one step further back) feature
 *
 * `has` is called for every feature inside the per-frame z scan and the hit scan, so it
 * must be O(1) (an index, or an O(1) derivation from the feature). As long as it returns
 * false, no batch flush, no draw and no hitTest happen at all, and the conventional
 * rendering efficiency and hit testing path are kept as they were.
 *
 * Unlike the extension points of auxiliary handles and the selection UI, there is one
 * registry per draw instance (createFeatureCompanionRegistry). When several instances
 * (the hidden renderers of printing and thumbnails) hold different Stores that have the
 * same feature ids, the provider has no way to tell "is this a feature of my own Store?"
 * (a replaced DocumentStore may return a new object from getFeature every time, so identity
 * cannot be used), so ownership is expressed by separating the registries.
 */

import type { ProjectionData } from 'maplibre-gl';
import type { MouseNormalizedEvent } from '../dispatcher/types.js';
import type { FrameDrawContext } from '../extension/index.js';
import type { LngLat, ScreenPoint } from '../shared/math/index.js';
import type { Coordinate, Feature, Layer } from '../store/types.js';

/**
 * A hit on a companion, as returned by {@link FeatureCompanionProvider.hitTest}.
 *
 * core does not interpret the contents. The provider puts its own identifier in and
 * receives it back through `onCompanionClick`.
 */
export interface CompanionHit {
  /** The identifier inside the provider */
  id: string;
}

/**
 * The context passed to {@link FeatureCompanionProvider.hitTest}.
 *
 * A minimal structure holding the point being tested (screen px) plus the coordinate
 * transform, the zoom and the click tolerance. The coordinate transform follows the same
 * style as the context of auxiliary handles (AuxiliaryHandleContext)
 * (geographic coordinates [lng, lat] <-> screen px).
 */
export interface CompanionHitContext {
  /** The point being tested (screen px) */
  point: ScreenPoint;
  /** Geographic coordinates -> screen px */
  project(lngLat: Coordinate): ScreenPoint;
  /** Screen px -> geographic coordinates */
  unproject(point: ScreenPoint): LngLat;
  /** The current zoom level */
  zoom: number;
  /** The click tolerance (screen px; the same value as core's hit testing setting) */
  tolerancePx: number;
}

/**
 * Draws something that accompanies a feature (a label, a callout) right below it in the
 * draw order, and makes it clickable in the same order.
 *
 * A `CompanionProvider` of `draw.extensions.companionProviders` is installed as one. What is
 * drawn and what
 * is hit are resolved at the same position of the z order, so what is visible is what can be
 * grabbed. A click on a companion does not change the selection; it is handed to
 * `onCompanionClick`.
 */
export interface FeatureCompanionProvider {
  /** An identifier unique within the registry (re-registering with the same id overwrites) */
  id: string;
  /**
   * Whether this feature has companions.
   *
   * It is called for every feature in the per-frame z scan and the hit scan, so it must
   * be O(1).
   */
  has(feature: Feature): boolean;
  /**
   * Called immediately before the feature itself (= one z step lower).
   *
   * core flushes the batch in progress before and after the call, so what is drawn always
   * comes below this feature and above the feature one step further back.
   */
  draw(
    feature: Feature,
    projectionData: ProjectionData,
    zoom: number,
    context: FrameDrawContext,
  ): void;
  /**
   * Called in the z scan of click resolution, after the feature itself misses and before
   * the next feature.
   *
   * If it returns a hit, core consumes that click (it does not change the selection state,
   * nor does it clear the selection as an empty click would) and calls
   * `onCompanionClick`.
   */
  hitTest(feature: Feature, point: ScreenPoint, context: CompanionHitContext): CompanionHit | null;
  /**
   * The notification of a click on the companion.
   *
   * @param featureId The ID of the feature that owns the companion
   * @param hit The hit returned by hitTest
   * @param event The click, when the engine has one to give
   * @returns False to leave the click to the select mode, as a click on the feature that owns
   *   the companion; anything else consumes it
   */
  onCompanionClick(
    featureId: string,
    hit: CompanionHit,
    event?: MouseNormalizedEvent,
  ): boolean | undefined;
}

/**
 * A companion hit resolved in the z scan, with the provider and the feature it belongs to.
 */
export interface FeatureCompanionHitResult {
  /** The id of the provider that returned the hit */
  providerId: string;
  /** The id of the feature that owns the companion */
  featureId: string;
  /** The hit as the provider returned it */
  hit: CompanionHit;
}

/**
 * The registered {@link FeatureCompanionProvider}s of one draw instance.
 *
 * One is held per draw instance. It has the same scope as the renderers of custom type
 * features (customLayer.registerFeatureRenderer), so the providers of other instances
 * (the hidden renderers of printing, thumbnails and previews) do not get mixed in.
 *
 * It must not be made a module-level singleton. A provider closes over its own Store, and
 * feature IDs agree across several instances when the document is the same, so sharing it
 * would draw things twice with the geometry of another instance's Store. The provider
 * cannot tell "is this my own feature?" (depending on the Store implementation, getFeature
 * builds a different object every time, so object identity cannot be used). Ownership is
 * expressed by separating the registries.
 */
export interface FeatureCompanionRegistry {
  /**
   * Registers a provider
   *
   * @returns The function that cancels the registration (calling it after a re-registration
   *   with the same id does not remove the provider that came in later)
   */
  register(provider: FeatureCompanionProvider): () => void;
  /** Gets a registered provider by id */
  get(id: string): FeatureCompanionProvider | undefined;
  /** Enumerates the registered providers (in registration order) */
  list(): FeatureCompanionProvider[];
  /**
   * Whether even one provider is registered
   *
   * An O(1) early exit looked at once at the entrance of a scan. If false, the path is the
   * conventional one.
   */
  any(): boolean;
  /**
   * The generation number (for deciding cache invalidation)
   *
   * It increases on every registration and cancellation. The cache of retained mode
   * (view/layer/store-retained) caches the classification that "cuts features having
   * companions out into the immediate rendering run", and that classification can change
   * as registrations come and go. Watch the generation number change and discard the cache.
   */
  generation(): number;
  /** Cancels all registrations */
  clear(): void;
  /** Whether there is a provider that has companions for this feature */
  has(feature: Feature): boolean;
}

/**
 * Creates an empty {@link FeatureCompanionRegistry}, for testing a provider in isolation.
 * Each draw instance holds its own; do not share one between instances.
 *
 * @returns A new registry with no provider
 */
export function createFeatureCompanionRegistry(): FeatureCompanionRegistry {
  const providers = new Map<string, FeatureCompanionProvider>();
  let generation = 0;

  return {
    register(provider: FeatureCompanionProvider): () => void {
      providers.set(provider.id, provider);
      generation++;

      return () => {
        if (providers.get(provider.id) === provider) {
          providers.delete(provider.id);
          generation++;
        }
      };
    },

    get: (id: string) => providers.get(id),
    list: () => [...providers.values()],
    any: () => providers.size > 0,
    generation: () => generation,

    clear(): void {
      if (providers.size === 0) return;
      providers.clear();
      generation++;
    },

    has(feature: Feature): boolean {
      if (providers.size === 0) return false;
      for (const provider of providers.values()) {
        if (provider.has(feature)) return true;
      }
      return false;
    },
  };
}

/**
 * The batch frame of the render loop (a minimal structure of the same shape as BatchManager)
 *
 * @internal
 */
export interface CompanionBatchFrame {
  beginFrame(projectionData: ProjectionData, zoom: number, layer?: Layer): void;
  endFrame(): void;
}

/**
 * Draws the things accompanying a feature after closing the batch frame (registration order)
 *
 * A batch is not painted until endFrame, so without a flush here the companions would be
 * drawn before the features further back within the same layer (the same reason as the
 * immediate rendering of custom type features). Once drawing is done, the frame is opened
 * again for the features that follow.
 *
 * For features without companions, neither endFrame nor beginFrame is called. As long as
 * has is false, the conventional batching efficiency is not harmed at all.
 *
 * @param restoreBlendState Restores the blend state that an external renderer may have
 *   rewritten (if omitted, nothing is restored)
 * @returns Whether even one thing was drawn
 *
 * @internal
 */
export function drawFeatureCompanionsInFrame(
  registry: FeatureCompanionRegistry,
  feature: Feature,
  batch: CompanionBatchFrame,
  projectionData: ProjectionData,
  zoom: number,
  layer: Layer | undefined,
  context: FrameDrawContext,
  restoreBlendState?: () => void,
): boolean {
  if (!registry.any()) return false;

  let drawn = false;
  for (const provider of registry.list()) {
    if (!provider.has(feature)) continue;
    if (!drawn) {
      batch.endFrame();
      drawn = true;
    }
    provider.draw(feature, projectionData, zoom, context);
  }

  if (drawn) {
    restoreBlendState?.();
    batch.beginFrame(projectionData, zoom, layer);
  }
  return drawn;
}

/**
 * Asks for hits on the things accompanying a feature (registration order; returns the
 * first one that hits)
 *
 * @internal
 */
export function hitTestFeatureCompanions(
  registry: FeatureCompanionRegistry,
  feature: Feature,
  context: CompanionHitContext,
): FeatureCompanionHitResult | null {
  if (!registry.any()) return null;

  for (const provider of registry.list()) {
    if (!provider.has(feature)) continue;
    const hit = provider.hitTest(feature, context.point, context);
    if (hit) return { providerId: provider.id, featureId: feature.id, hit };
  }
  return null;
}

/**
 * Hands a click on a companion to its provider
 *
 * If the provider has already been unregistered, nothing happens (the click stays
 * consumed and the selection state does not change).
 *
 * @returns Whether the click was consumed; false when the provider leaves it to the select
 *   mode
 * @internal
 */
export function notifyFeatureCompanionClick(
  registry: FeatureCompanionRegistry,
  result: FeatureCompanionHitResult,
  event?: MouseNormalizedEvent,
): boolean {
  const provider = registry.get(result.providerId);
  if (!provider) return true;
  const consumed =
    event === undefined
      ? provider.onCompanionClick(result.featureId, result.hit)
      : provider.onCompanionClick(result.featureId, result.hit, event);
  return consumed !== false;
}
