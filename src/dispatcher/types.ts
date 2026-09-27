// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Input Types
 *
 * Type definitions for event normalization
 */

/**
 * The state of the modifier keys at the time of an input.
 */
export interface ModifierKeys {
  /** Whether Shift was held */
  shift: boolean;
  /** Whether Control was held */
  ctrl: boolean;
  /** Whether Alt (Option on macOS) was held */
  alt: boolean;
  /** Whether Meta (Command on macOS, the Windows key on Windows) was held */
  meta: boolean;
}

/**
 * The kind of pointer an input came from.
 *
 * `'touch'` is one finger of a touch screen, `'pen'` a stylus (reported either through
 * the touch events, as on iPadOS, or through the mouse events the browser emits for
 * it), and `'mouse'` everything else. Input with no `pointerType` (synthetic input
 * of the tests, for example) is treated as `'mouse'`.
 */
export type PointerType = 'mouse' | 'touch' | 'pen';

/**
 * The original browser event of a pointer input.
 *
 * Input that arrives through the mouse events (a mouse, or a pen the browser reports as
 * one) carries the MouseEvent; input that arrives through the touch events (a finger,
 * or a stylus on iPadOS) carries the TouchEvent. Both have `target`, the modifier keys,
 * `preventDefault` and `stopPropagation`; code that needs `button` or `clientX`
 * narrows with `'touches' in originalEvent`.
 */
export type PointerOriginalEvent = MouseEvent | TouchEvent;

/**
 * A normalized pointer event that is not a drag: a click, a press, a release or a move.
 *
 * Despite the name it is also produced by one-finger touch and pen input; the
 * `pointerType` field tells them apart. A mode receives it through its handler methods.
 */
export interface MouseNormalizedEvent {
  /** The kind of input */
  type: 'click' | 'dblclick' | 'mousedown' | 'mouseup' | 'mousemove' | 'contextmenu';
  /** The position in CSS px, relative to the top left of the map container */
  point: { x: number; y: number };
  /** The position in degrees; after snapping when snapping applied */
  lngLat: { lng: number; lat: number };
  /** The original event (a TouchEvent for touch input) */
  originalEvent: PointerOriginalEvent;
  /** Modifier keys */
  modifiers: ModifierKeys;
  /** The kind of pointer (`'mouse'` when omitted) */
  pointerType?: PointerType;
  /**
   * Whether to apply snapping (snapping is applied when omitted)
   *
   * InputRouter looks at this just before delivering the event to the mode. An event
   * with this set to false is not passed through SnapService. It is the marker with
   * which synthetic input chooses whether to go through snapping.
   */
  snap?: boolean;
}

/**
 * A normalized drag event: the start, each move, the end or the cancellation of a press
 * that moved.
 *
 * `dragcancel` ends a press without a release: a second finger touched the screen
 * (the gesture is left to MapLibre's pinch and rotate), the browser cancelled the
 * touch, the window lost the focus, or Escape was pressed during the drag (that Escape
 * is not delivered as a keydown). It follows the `mousedown` of the press, with or without a `dragstart` before
 * it, and no `dragend`, `mouseup` or `click` follows it. A mode aborts what the press
 * started and keeps nothing of it.
 */
export interface DragNormalizedEvent {
  /** The phase of the drag */
  type: 'dragstart' | 'dragmove' | 'dragend' | 'dragcancel';
  /**
   * The current position in CSS px relative to the map container (the last known position for
   * dragcancel)
   */
  point: { x: number; y: number };
  /** The current position in degrees (the last known position for dragcancel) */
  lngLat: { lng: number; lat: number };
  /**
   * The original event (a TouchEvent for touch input). For a `dragcancel` by Escape or by
   * the window losing the focus, the last pointer event of the press
   */
  originalEvent: PointerOriginalEvent;
  /** Modifier keys */
  modifiers: ModifierKeys;
  /** The kind of pointer (`'mouse'` when omitted) */
  pointerType?: PointerType;
  /** The position at the start of the drag, in CSS px relative to the map container */
  dragStartPoint: { x: number; y: number };
  /** The position at the start of the drag, in degrees */
  dragStartLngLat: { lng: number; lat: number };
  /**
   * Whether to apply snapping (snapping is applied when omitted)
   *
   * Same meaning as snap on MouseNormalizedEvent.
   */
  snap?: boolean;
}

/**
 * A normalized keyboard event, delivered while the map canvas has the keyboard focus.
 */
export interface KeyNormalizedEvent {
  /** Whether the key went down or up */
  type: 'keydown' | 'keyup';
  /** Key name (e.g. "Escape", "Enter", "a") */
  key: string;
  /** Key code (e.g. "Escape", "Enter", "KeyA") */
  code: string;
  /** Modifier keys */
  modifiers: ModifierKeys;
  /** The original event */
  originalEvent: KeyboardEvent;
}

// The payload of draw.map.click is defined in shared/ with the other event payloads
export type { MapClickEventPayload } from '../shared/types/events.js';

/**
 * Any input event after normalization, as a mode receives it; narrow it with `type`.
 */
export type NormalizedEvent = MouseNormalizedEvent | DragNormalizedEvent | KeyNormalizedEvent;

/**
 * Mapping from event type to normalized event type
 *
 * @internal
 */
export type NormalizedEventMap = {
  click: MouseNormalizedEvent;
  dblclick: MouseNormalizedEvent;
  mousedown: MouseNormalizedEvent;
  mouseup: MouseNormalizedEvent;
  mousemove: MouseNormalizedEvent;
  contextmenu: MouseNormalizedEvent;
  dragstart: DragNormalizedEvent;
  dragmove: DragNormalizedEvent;
  dragend: DragNormalizedEvent;
  dragcancel: DragNormalizedEvent;
  keydown: KeyNormalizedEvent;
  keyup: KeyNormalizedEvent;
};

/**
 * Helper function that extracts ModifierKeys
 *
 * @internal
 */
export function getModifiers(event: MouseEvent | TouchEvent | KeyboardEvent): ModifierKeys {
  return {
    shift: event.shiftKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    meta: event.metaKey,
  };
}
