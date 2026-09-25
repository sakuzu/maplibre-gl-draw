// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Snapping API (the draw.snapping namespace)
 *
 * Provides enabling and disabling of snapping, and the registration of external providers.
 * The actual resolution is done by the SnapService, and the replacement of the coordinates
 * is done by the InputRouter for click / mousemove / dragmove.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { ScreenPoint } from '../shared/math/index.js';
import type {
  ResolvedSnapOptions,
  SnapContext,
  SnapLngLat,
  SnapProvider,
  SnapResult,
  SnapService,
  SnapTargetKind,
} from '../snapping/types.js';
import type { MapLibreGLDraw } from './api.js';

/**
 * The snapping of a draw instance, reached as `draw.snapping`: switching it at runtime,
 * reading its settings and adding candidates.
 *
 * Snapping replaces the coordinate of a click, a move or a drag with the nearest candidate
 * within the tolerance, before any mode sees it, so it works the same way in every mode and
 * for vertex dragging. The initial settings come from {@link Options.snap}. Holding the
 * modifier of `disableKey` (Alt by default) releases it while held. Every change of the
 * result is announced by the `draw.snap.change` event.
 *
 * @example
 * ```typescript
 * draw.snapping.setEnabled(false);
 * draw.snapping.setKindEnabled('guide', false); // turn off guides only
 * const unregister = draw.snapping.register(myProvider);
 * unregister();
 * ```
 */
export interface SnappingOperations {
  /**
   * Registers a provider of snapping candidates.
   *
   * The candidates are mixed in on top of the built-in providers (the vertices and edges of
   * the Store) and compete with them by distance and priority. On a destroyed instance the
   * registration is ignored.
   *
   * @param provider the provider to register
   * @returns a function that unregisters it
   */
  register(provider: SnapProvider): () => void;

  /**
   * Enables or disables snapping.
   *
   * The initial value is `options.snap.enabled` (default true). A change takes effect from the
   * next input.
   *
   * @param enabled true to snap, false to pass every coordinate through as it is
   */
  setEnabled(enabled: boolean): void;

  /** Whether snapping is enabled */
  isEnabled(): boolean;

  /**
   * Enables or disables snapping per kind (vertex / edge / intersection / guide).
   *
   * The initial value is `options.snap.kinds` (all true by default). The candidates of a
   * disabled kind are excluded from the evaluation, even when a provider returns them.
   *
   * @param kind the kind of target
   * @param enabled whether that kind is snapped to
   */
  setKindEnabled(kind: SnapTargetKind, enabled: boolean): void;

  /**
   * Whether the kind is enabled
   *
   * @param kind the kind of target
   */
  isKindEnabled(kind: SnapTargetKind): boolean;

  /**
   * Switches whether datasets (data that is only displayed) are included as
   * snapping targets.
   *
   * The initial value is `options.snap.datasets` (default true). Setting it to false stops
   * only the snapping to that data; snapping to the features of the Store remains.
   *
   * @param enabled whether datasets are snapping targets
   */
  setDatasetsEnabled(enabled: boolean): void;

  /** Whether datasets are snapping targets */
  isDatasetsEnabled(): boolean;

  /**
   * Sets the step angle of the built-in north-based guides.
   *
   * The initial value is `options.snap.guideStepDegrees` (default 45, which gives 8 guides).
   * The change takes effect from the next snapping query. A value of 0 or less, or a
   * non-finite value, gives the default 45. The current value is in
   * `getOptions().guideStepDegrees`. Guides added with `createGuideSnapProvider` keep their
   * own step.
   *
   * @param degrees the step angle in degrees, counted from true north
   *
   * @example
   * ```typescript
   * draw.snapping.setGuideStep(15); // 24 guides, every 15 degrees
   * ```
   */
  setGuideStep(degrees: number): void;

  /**
   * Gets the snapping options with the defaults filled in.
   *
   * enabled, kinds, display and guideStepDegrees are the current values, reflecting the changes made at runtime.
   * `kinds` is a copy with every kind filled in, so changing it has no effect. A settings UI
   * reads its current values here.
   */
  getOptions(): ResolvedSnapOptions;

  /**
   * Gets the most recent snapping result.
   *
   * null if nothing has been resolved yet. When nothing is snapped, it returns a SnapResult
   * with no target.
   */
  getResult(): SnapResult | null;

  /**
   * Resolves snapping for a coordinate.
   *
   * There is no need to call it for normal input, because the InputRouter passes it through
   * automatically. It is the entry point for when a coordinate produced outside the library,
   * such as numeric input or synthetic input, should be passed through snapping.
   *
   * @param lngLat the input coordinate
   * @param point the screen coordinate (when omitted, it is computed with map.project)
   * @param ctx overrides for the context (when omitted, zoom is the current zoom and
   *   modifiers are all false)
   * @returns the snapped coordinate and what it snapped to; the input coordinate with no
   *   target when nothing is within the tolerance
   *
   * @example
   * ```typescript
   * const { lngLat, target } = draw.snapping.resolve({ lng: 139.7, lat: 35.68 });
   * if (target) console.log('snapped to a', target.kind);
   * ```
   */
  resolve(lngLat: SnapLngLat, point?: ScreenPoint, ctx?: Partial<SnapContext>): SnapResult;
}

/** @internal */
export type SnappingApi = Pick<MapLibreGLDraw, 'snapping'>;

/** @internal */
export interface SnappingApiDeps {
  snapService: SnapService;
  map: MapLibreMap;
}

/** The state in which no modifier key is pressed */
const NO_MODIFIERS = { shift: false, ctrl: false, alt: false, meta: false } as const;

/** @internal */
export function createSnappingApi(deps: SnappingApiDeps): SnappingApi {
  const { snapService, map } = deps;

  return {
    snapping: {
      register(provider: SnapProvider): () => void {
        return snapService.register(provider);
      },

      setEnabled(enabled: boolean): void {
        snapService.setEnabled(enabled);
      },

      isEnabled(): boolean {
        return snapService.isEnabled();
      },

      setKindEnabled(kind: SnapTargetKind, enabled: boolean): void {
        snapService.setKindEnabled(kind, enabled);
      },

      isKindEnabled(kind: SnapTargetKind): boolean {
        return snapService.isKindEnabled(kind);
      },

      setDatasetsEnabled(enabled: boolean): void {
        snapService.setDatasetsEnabled(enabled);
      },

      isDatasetsEnabled(): boolean {
        return snapService.isDatasetsEnabled();
      },

      setGuideStep(degrees: number): void {
        snapService.setGuideStep(degrees);
      },

      getOptions(): ResolvedSnapOptions {
        return snapService.getOptions();
      },

      getResult(): SnapResult | null {
        return snapService.getResult();
      },

      resolve(lngLat: SnapLngLat, point?: ScreenPoint, ctx?: Partial<SnapContext>): SnapResult {
        const screenPoint = point ?? map.project([lngLat.lng, lngLat.lat]);
        return snapService.resolve(
          lngLat,
          { x: screenPoint.x, y: screenPoint.y },
          {
            zoom: map.getZoom(),
            modifiers: { ...NO_MODIFIERS },
            ...ctx,
          },
        );
      },
    },
  };
}
