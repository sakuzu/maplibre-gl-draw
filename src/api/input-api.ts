// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Input API (the draw.input namespace)
 *
 * The official path for giving points to the drawing modes from numeric input (distance and
 * bearing, absolute coordinates), from tests or from automation. It synthesizes normalized
 * events of the same shape as the ones the InputNormalizer produces and sends them into the
 * same entry point of the InputRouter (dispatch).
 *
 * Because they go through the same path as real events, snapping, the distribution to the
 * plugins and the interception by the datasets all keep working. No change
 * is needed on the mode side.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { InputRouter } from '../dispatcher/input-router.js';
import type {
  KeyNormalizedEvent,
  ModifierKeys,
  MouseNormalizedEvent,
} from '../dispatcher/types.js';
import type { Coordinate } from '../store/types.js';
import type { MapLibreGLDraw } from './api.js';

/**
 * The coordinate of a synthetic input
 *
 * Either `{ lng, lat }` or `[lng, lat]` (Coordinate) can be passed. The screen position is
 * computed with `map.project`, so the caller does not prepare it.
 */
export type SyntheticLngLat = { lng: number; lat: number } | Coordinate;

/**
 * The modifier keys of a synthetic input (an omitted key is false)
 */
export interface SyntheticModifiers {
  /** Whether Shift is held */
  shift?: boolean;
  /** Whether Alt (Option) is held; by default it releases snapping */
  alt?: boolean;
  /** Whether Ctrl is held */
  ctrl?: boolean;
  /** Whether Meta (Cmd) is held */
  meta?: boolean;
}

/**
 * The options of a synthetic input (click / move)
 *
 * @example
 * ```typescript
 * // Place the point exactly where the numbers say, without snapping
 * draw.input.click([139.7, 35.68], { snap: false });
 * ```
 */
export interface SyntheticInputOptions {
  /** The modifier keys. When omitted, they are all false */
  modifiers?: SyntheticModifiers;
  /**
   * Whether to pass through snapping (default true)
   *
   * Setting it to false raises `snap: false` on the normalized event, and the InputRouter
   * distributes the raw coordinate to the modes without going through the SnapService. Use it
   * when an exact coordinate is to be given numerically.
   */
  snap?: boolean;
}

/**
 * The options of a synthetic key input
 *
 * @example
 * ```typescript
 * draw.input.key('g', { modifiers: { ctrl: true } }); // groups the selection in select mode
 * ```
 */
export interface SyntheticKeyOptions {
  /** The modifier keys. When omitted, they are all false */
  modifiers?: SyntheticModifiers;
  /**
   * The value equivalent to KeyboardEvent.code
   *
   * When omitted, it is inferred from key (alphanumerics become KeyA / Digit1, anything else
   * is the same as key).
   */
  code?: string;
}

/**
 * The synthetic input of a draw instance, reached as `draw.input`: clicks, moves and keys
 * given to the modes from code.
 *
 * It is the path for giving points to a drawing mode from numeric input (a distance and a
 * bearing, absolute coordinates), from tests and from automation. The events enter where
 * real input is dispatched, so snapping and the plugins see them as usual and a mode needs
 * no special branch. The thresholds of real input (the click / drag distinction) are not
 * involved. A synthetic event counts as mouse input, and its `originalEvent` is a stand-in
 * marked with `synthetic: true`. The input fields of a numeric input UI are not part of the
 * library.
 *
 * @example
 * ```typescript
 * draw.setMode('draw_line');
 * draw.input.click([139.7, 35.68]);
 * draw.input.click([139.71, 35.68]);
 * draw.input.click([139.71, 35.69]);
 * draw.input.key('Enter');
 * // Finishing returns to select mode with the new feature selected
 * const [line] = draw.getSelectedFeatures();
 * ```
 */
export interface InputOperations {
  /**
   * Synthesizes a click.
   *
   * So that the order matches that of a real cursor, it distributes a `mousemove` at the same
   * coordinate and then distributes a `click`. The drawing modes interpret a click by looking
   * at the state built up by the movement (the radius of a circle, the proximity test of the
   * start and end points of a line or polygon), so these two are the minimal sequence that
   * advances the drawing. Clicking the first point of a polygon again closes it; a circle takes
   * a click on its center and one on its edge.
   *
   * @param lngLat where to click
   * @param options the modifier keys and whether to snap
   *
   * @example
   * ```typescript
   * draw.setMode('draw_circle');
   * draw.input.click([139.7, 35.68]); // the center
   * draw.input.click([139.71, 35.68]); // sets the radius and finishes
   * ```
   */
  click(lngLat: SyntheticLngLat, options?: SyntheticInputOptions): void;

  /**
   * Synthesizes a mouse move.
   *
   * It moves the preview while drawing (the tentative geometry) without adding a point.
   *
   * @param lngLat where the pointer moves to
   * @param options the modifier keys and whether to snap
   */
  move(lngLat: SyntheticLngLat, options?: SyntheticInputOptions): void;

  /**
   * Synthesizes a key input (keydown).
   *
   * Enter finishes the drawing, Escape cancels it, and Backspace / Delete removes the last
   * vertex. There is no path in the library that reads keyup, so only keydown is
   * distributed.
   *
   * @param key the value of `KeyboardEvent.key` (`Enter`, `Escape`, `a` and so on)
   * @param options the modifier keys and the `KeyboardEvent.code`
   *
   * @example
   * ```typescript
   * draw.input.key('Backspace'); // remove the last vertex
   * draw.input.key('Escape'); // cancel the drawing
   * ```
   */
  key(key: string, options?: SyntheticKeyOptions): void;

  /**
   * Switches the holding of pointer-originated input.
   *
   * It is the entry point for stopping pointer interruptions while the keyboard is deciding
   * the coordinate, such as in a numeric input panel. While it is held, the click / dblclick /
   * mousemove of the real pointer no longer reach the modes, and only synthetic input (click /
   * move / key) moves the coordinate. Panning and zooming the map (mousedown / drag events)
   * keep working while it is held.
   *
   * Be sure to set it back to false once the panel is closed.
   *
   * @param held true to hold the pointer input, false to release it
   *
   * @example
   * ```typescript
   * numericPanel.onopen = () => draw.input.setPointerHold(true);
   * numericPanel.onclose = () => draw.input.setPointerHold(false);
   * ```
   */
  setPointerHold(held: boolean): void;

  /** Whether pointer-originated input is being held */
  isPointerHeld(): boolean;
}

/** @internal */
export type InputApi = Pick<MapLibreGLDraw, 'input'>;

/** @internal */
export interface InputApiDeps {
  map: MapLibreMap;
  inputRouter: InputRouter;
}

/** The state in which no modifier key is pressed */
const NO_MODIFIERS: ModifierKeys = { shift: false, ctrl: false, alt: false, meta: false };

/**
 * The marker that indicates a synthetic event
 *
 * Attaching it to originalEvent makes it distinguishable from a real event in plugins and
 * while debugging.
 *
 * @internal
 */
export const SYNTHETIC_EVENT_MARKER = 'synthetic';

function toLngLat(lngLat: SyntheticLngLat): { lng: number; lat: number } {
  return Array.isArray(lngLat) ? { lng: lngLat[0], lat: lngLat[1] } : lngLat;
}

function toModifiers(modifiers?: SyntheticModifiers): ModifierKeys {
  if (!modifiers) return { ...NO_MODIFIERS };
  return {
    shift: modifiers.shift ?? false,
    ctrl: modifiers.ctrl ?? false,
    alt: modifiers.alt ?? false,
    meta: modifiers.meta ?? false,
  };
}

/**
 * Infers the equivalent of KeyboardEvent.code from key
 */
function inferCode(key: string): string {
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === ' ') return 'Space';
  return key;
}

/**
 * A synthetic originalEvent (the equivalent of a MouseEvent)
 *
 * It is a minimal dummy that has only the members the InputRouter and the modes touch.
 * What the implementation touches is only preventDefault / stopPropagation (when the
 * InputRouter consumes onMouseDown, and the shortcuts of the select mode) and target (the
 * container test of the plugin interactions), so it is given those plus the fields for
 * reading the modifier keys and the coordinate.
 */
function createSyntheticMouseEvent(
  type: MouseNormalizedEvent['type'],
  point: { x: number; y: number },
  modifiers: ModifierKeys,
): MouseEvent {
  return {
    type,
    [SYNTHETIC_EVENT_MARKER]: true,
    button: 0,
    buttons: 0,
    // A synthetic input has no offset on the page, so put in the canvas-relative coordinate as is
    clientX: point.x,
    clientY: point.y,
    target: null,
    currentTarget: null,
    shiftKey: modifiers.shift,
    ctrlKey: modifiers.ctrl,
    altKey: modifiers.alt,
    metaKey: modifiers.meta,
    defaultPrevented: false,
    preventDefault(): void {},
    stopPropagation(): void {},
    stopImmediatePropagation(): void {},
  } as unknown as MouseEvent;
}

/**
 * A synthetic originalEvent (the equivalent of a KeyboardEvent)
 */
function createSyntheticKeyboardEvent(
  key: string,
  code: string,
  modifiers: ModifierKeys,
): KeyboardEvent {
  return {
    type: 'keydown',
    [SYNTHETIC_EVENT_MARKER]: true,
    key,
    code,
    repeat: false,
    target: null,
    currentTarget: null,
    shiftKey: modifiers.shift,
    ctrlKey: modifiers.ctrl,
    altKey: modifiers.alt,
    metaKey: modifiers.meta,
    defaultPrevented: false,
    preventDefault(): void {},
    stopPropagation(): void {},
    stopImmediatePropagation(): void {},
  } as unknown as KeyboardEvent;
}

/** @internal */
export function createInputApi(deps: InputApiDeps): InputApi {
  const { map, inputRouter } = deps;

  /**
   * Builds a normalized mouse event
   *
   * The screen point is computed with map.project (a value with the same meaning as the point
   * the InputNormalizer receives from MapLibre).
   */
  function buildMouseEvent(
    type: MouseNormalizedEvent['type'],
    lngLat: SyntheticLngLat,
    options?: SyntheticInputOptions,
  ): MouseNormalizedEvent {
    const resolved = toLngLat(lngLat);
    const projected = map.project([resolved.lng, resolved.lat]);
    const point = { x: projected.x, y: projected.y };
    const modifiers = toModifiers(options?.modifiers);

    return {
      type,
      point,
      lngLat: { lng: resolved.lng, lat: resolved.lat },
      originalEvent: createSyntheticMouseEvent(type, point, modifiers),
      modifiers,
      snap: options?.snap ?? true,
    };
  }

  return {
    input: {
      click(lngLat: SyntheticLngLat, options?: SyntheticInputOptions): void {
        // Use the same order as a real cursor (move, then click).
        inputRouter.dispatch(buildMouseEvent('mousemove', lngLat, options));
        inputRouter.dispatch(buildMouseEvent('click', lngLat, options));
      },

      move(lngLat: SyntheticLngLat, options?: SyntheticInputOptions): void {
        inputRouter.dispatch(buildMouseEvent('mousemove', lngLat, options));
      },

      setPointerHold(held: boolean): void {
        inputRouter.setPointerHold(held);
      },

      isPointerHeld(): boolean {
        return inputRouter.isPointerHeld();
      },

      key(key: string, options?: SyntheticKeyOptions): void {
        const modifiers = toModifiers(options?.modifiers);
        const code = options?.code ?? inferCode(key);
        const event: KeyNormalizedEvent = {
          type: 'keydown',
          key,
          code,
          modifiers,
          originalEvent: createSyntheticKeyboardEvent(key, code, modifiers),
        };
        inputRouter.dispatch(event);
      },
    },
  };
}
