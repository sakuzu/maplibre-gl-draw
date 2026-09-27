// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolution of the rendering pixel ratio (pixelRatio)
 *
 * Line widths, point sizes and glyphs are baked in by converting CSS pixels into physical
 * pixels, so the ratio of the backing store being drawn into is required. It normally matches
 * `window.devicePixelRatio`, but it does not match when a maplibre Map is brought up with an
 * arbitrary `pixelRatio` (such as a temporary instance mounted off-screen for a high-
 * resolution export). It can therefore be injected through Options, and all references are
 * collected into this helper.
 *
 * There are situations where the ratio itself needs to move at run time (as in the paper
 * preview, where, while it is shown scaled down on the screen, the dimensions fixed in screen
 * pixels should shrink by the same ratio), so the injected value accepts three forms: a
 * number, a function that returns a value each time it is called, and a provider object.
 * `createPixelRatioSource` is the actual provider, and it multiplies the resolved result by
 * the rendering scale that can be changed at run time (renderScale).
 *
 * ## The two ratios
 *
 * renderScale applies only to "dimensions fixed in screen pixels".
 *
 * - Dimensions fixed in screen pixels (`resolvePixelRatio`) ... those whose thickness on the
 *   screen does not change when the zoom changes. Point sizes, the line width of features
 *   that have no createdZoom, line widths that go through `u_width`, and so on. They do not
 *   shrink when the camera pulls back, so they have to be shrunk with renderScale in the
 *   paper preview
 * - Dimensions that scale with the zoom (`resolveContentPixelRatio`) ... those that the
 *   shader multiplies by `2^(zoom - createdZoom)`, line widths given in meters, and so on.
 *   They already shrink by the same ratio when the camera pulls back, so multiplying by
 *   renderScale shrinks them twice (the 2026-08-10 defect where only the outlines of notes
 *   thinned down to 1/k² in the paper preview)
 *
 * The side that bakes the value in chooses between the two by whether the shader scales that
 * value with the zoom.
 */

/**
 * Provider of the rendering pixel ratio (read only)
 *
 * It makes "the injected value (window when there is none)" and "the factor that can be
 * changed at run time (renderScale)" readable separately. Handing this out as is to each
 * renderer as the `PixelRatioInput` makes a change of the factor propagate from the next frame
 * to every place that reads it directly, and also lets "the ratio without the factor" be taken
 * from the same single socket.
 */
export interface PixelRatioProvider {
  /** The current rendering pixel ratio (the injected value or window x renderScale) */
  resolve: () => number;
  /** The factor of the current rendering pixel ratio (default 1) */
  getScaleFactor: () => number;
}

/**
 * The rendering pixel ratio that can be injected
 *
 * Besides a number, a function that returns the current ratio each time it is called and a
 * provider object can be passed (so that a ratio that changes at run time is followed).
 */
export type PixelRatioInput = number | (() => number) | PixelRatioProvider;

/** Whether it is a provider object */
function isProvider(value: PixelRatioInput | undefined): value is PixelRatioProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PixelRatioProvider).resolve === 'function'
  );
}

/** The ratio of window (1 in environments where it cannot be read) */
function windowPixelRatio(): number {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
}

/** Lets only finite positive numbers through */
function usable(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * Resolves the rendering pixel ratio (for dimensions fixed in screen pixels; renderScale
 * included)
 *
 * It returns the injected value if there is one, and otherwise reads
 * `window.devicePixelRatio` on every call. The value at startup is not fixed because the ratio
 * changes when the window is moved to a display with a different ratio (the behavior when
 * there is no injection is exactly the same as before).
 *
 * @param pixelRatio The injected rendering pixel ratio (when unspecified, at most 0, or not a
 *   number, it is read from window)
 */
export function resolvePixelRatio(pixelRatio?: PixelRatioInput): number {
  if (isProvider(pixelRatio)) {
    const resolved = pixelRatio.resolve();
    return usable(resolved) ? resolved : windowPixelRatio();
  }
  const value = typeof pixelRatio === 'function' ? pixelRatio() : pixelRatio;
  if (usable(value)) return value;
  return windowPixelRatio();
}

/**
 * The rendering pixel ratio for dimensions that scale with the zoom (renderScale is not
 * applied)
 *
 * Used for "dimensions that already scale with the zoom of the camera", such as line widths
 * that the shader multiplies by `2^(zoom - createdZoom)` and line widths given in meters. When
 * it is used as in the paper preview, where "the camera pulls back by δ and 2^-δ is passed to
 * renderScale", applying the factor here would apply the same reduction twice.
 *
 * When no provider is passed (a number, a function, or unspecified) there is no notion of a
 * factor, so it returns the same value as `resolvePixelRatio`.
 *
 * @param pixelRatio The injected rendering pixel ratio
 */
export function resolveContentPixelRatio(pixelRatio?: PixelRatioInput): number {
  if (!isProvider(pixelRatio)) return resolvePixelRatio(pixelRatio);
  const scale = pixelRatio.getScaleFactor();
  const resolved = resolvePixelRatio(pixelRatio);
  if (!usable(scale)) return resolved;
  return resolved / scale;
}

/**
 * Source of the rendering pixel ratio
 *
 * The read side (`PixelRatioProvider`) plus a socket for rewriting the factor.
 * Handing the source itself out to each renderer as the `PixelRatioInput` makes a change from
 * `setScaleFactor` propagate from the next frame to every place that reads it directly.
 */
export interface PixelRatioSource extends PixelRatioProvider {
  /**
   * Replaces the pixel ratio given at creation; `undefined` goes back to the ratio of the map
   *
   * @returns Whether the value changed
   */
  setPixelRatio: (pixelRatio: number | undefined) => boolean;
  /**
   * Sets the factor of the rendering pixel ratio
   *
   * It accepts only finite positive values (anything else is ignored). It returns true only
   * when the value changed, so the caller can trigger a redraw or a rebuild of the batches
   * only at that point.
   */
  setScaleFactor: (scale: number) => boolean;
}

/**
 * Creates a source of the rendering pixel ratio
 *
 * @param pixelRatio The injected rendering pixel ratio
 * @param fallback Read each time when nothing usable was injected: the ratio of the map the
 *   drawing goes into (`map.getPixelRatio()`), which follows a `pixelRatio` the map was
 *   created with. When it is omitted or returns nothing usable, window is read
 */
export function createPixelRatioSource(
  pixelRatio?: number,
  fallback?: () => number,
): PixelRatioSource {
  let renderScale = 1;
  let given = usable(pixelRatio) ? pixelRatio : undefined;
  let input: PixelRatioInput | undefined = given ?? fallback;
  return {
    setPixelRatio: (value: number | undefined) => {
      const next = usable(value) ? value : undefined;
      if (next === given) return false;
      given = next;
      input = given ?? fallback;
      return true;
    },
    resolve: () => resolvePixelRatio(input) * renderScale,
    getScaleFactor: () => renderScale,
    setScaleFactor: (scale: number) => {
      if (!Number.isFinite(scale) || scale <= 0) return false;
      if (scale === renderScale) return false;
      renderScale = scale;
      return true;
    },
  };
}
