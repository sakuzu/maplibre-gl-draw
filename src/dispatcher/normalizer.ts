// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * InputNormalizer
 *
 * Normalizes mouse, one-finger touch, pen and keyboard events.
 * It uses the MapLibre event system, and registers keyboard events on the canvas. Drag and
 * drop of files is left to the host, which decides what a dropped file becomes.
 *
 * Touch input is written onto the same NormalizedEvents as the mouse (mousedown,
 * mousemove, dragstart, dragmove, dragend, mouseup, click, dblclick, contextmenu), with
 * `pointerType: 'touch'`. Only one finger is normalized: a gesture with two or more
 * fingers (pinch, rotate) is left to MapLibre, and a second finger that lands during a
 * press cancels the press with `dragcancel`. A pen is normalized from whichever events
 * the browser reports it with (touch events on iPadOS, mouse events elsewhere).
 *
 * The thresholds that depend on the pointer (drag distance, the click time limit, the
 * long press time) are closed inside this file (POINTER_PROFILES).
 *
 * A press also ends without a release (`dragcancel`) when the window loses focus or
 * Escape is pressed during a drag; that Escape is not delivered as a keydown. A mouse
 * press whose button is found up on a mousemove (the release happened where the page
 * could not see it) is released at its last position.
 *
 * The canvas takes the keyboard focus when it is pressed (a mode that consumes the
 * mousedown prevents the browser from moving the focus), and a dblclick that a mode
 * consumed is not zoomed by MapLibre.
 */

import type { Map as MapLibreMap, MapMouseEvent, MapTouchEvent } from 'maplibre-gl';

import type {
  DragNormalizedEvent,
  KeyNormalizedEvent,
  MouseNormalizedEvent,
  NormalizedEvent,
  PointerOriginalEvent,
  PointerType,
} from './types.js';
import { getModifiers } from './types.js';

/**
 * Options for InputNormalizer
 *
 * @internal
 */
export interface InputNormalizerOptions {
  /** Threshold for detecting a drag with the mouse (pixels) */
  dragThreshold: number;
  /** Time threshold for detecting a click with the mouse (milliseconds) */
  clickTimeThreshold: number;
}

const DEFAULT_OPTIONS: InputNormalizerOptions = {
  dragThreshold: 3,
  clickTimeThreshold: 300,
};

/**
 * The thresholds that depend on the kind of pointer
 */
interface PointerProfile {
  /** Distance a press must move before it becomes a drag (pixels) */
  dragThreshold: number;
  /** A press held longer than this is not a click (milliseconds; Infinity = no limit) */
  clickTimeThreshold: number;
  /**
   * A press held this long without moving emits contextmenu (milliseconds; null = none)
   *
   * Only the touch events use it: the mouse events already carry the contextmenu of the
   * browser (right button, or the press and hold a pen emulates).
   */
  longPressTime: number | null;
}

/** A finger is wide and wobbles, so it needs a larger slop than the mouse */
const TOUCH_DRAG_THRESHOLD = 10;
/** A pen tip wobbles a little when it lands */
const PEN_DRAG_THRESHOLD = 5;
/** The press and hold time for contextmenu on a touch screen */
const LONG_PRESS_TIME = 500;
/** Two taps closer than this in time form a dblclick (milliseconds) */
const DOUBLE_TAP_TIME = 300;
/** Two taps closer than this in distance form a dblclick (pixels) */
const DOUBLE_TAP_DISTANCE = 20;
/**
 * After a touch, the browser emits compatibility mouse events (mousemove, mousedown,
 * mouseup, click) for the same tap. They are ignored for this long after the last
 * touch ends when the browser does not tell them apart (sourceCapabilities).
 */
const TOUCH_COMPAT_WINDOW = 1000;

/** The keys MapLibre's keyboard handler acts on (pan, rotate, pitch and zoom) */
const MAP_KEYS: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  '+',
  '=',
  '-',
  '_',
]);

function createProfiles(opts: InputNormalizerOptions): Record<PointerType, PointerProfile> {
  return {
    mouse: {
      dragThreshold: opts.dragThreshold,
      clickTimeThreshold: opts.clickTimeThreshold,
      longPressTime: null,
    },
    touch: {
      dragThreshold: Math.max(opts.dragThreshold, TOUCH_DRAG_THRESHOLD),
      clickTimeThreshold: Number.POSITIVE_INFINITY,
      longPressTime: LONG_PRESS_TIME,
    },
    pen: {
      dragThreshold: Math.max(opts.dragThreshold, PEN_DRAG_THRESHOLD),
      clickTimeThreshold: Number.POSITIVE_INFINITY,
      longPressTime: LONG_PRESS_TIME,
    },
  };
}

/**
 * The InputNormalizer interface
 *
 * @internal
 */
export interface InputNormalizer {
  /** Attaches the event listeners */
  attach(): void;
  /** Detaches the event listeners */
  detach(): void;
  /** Registers an event handler */
  on(handler: (event: NormalizedEvent) => void): void;
  /** Unregisters an event handler */
  off(handler: (event: NormalizedEvent) => void): void;
  /**
   * Changes how far the mouse moves before a press becomes a drag, in pixels (a finger and a
   * pen keep their larger thresholds); it applies from the next press
   */
  setDragThreshold(px: number): void;
}

/**
 * The press in progress (from mousedown / touchstart to its release or cancel)
 */
interface Press {
  /** Which events drive the press */
  source: 'mouse' | 'touch';
  pointerType: PointerType;
  startPoint: { x: number; y: number };
  startLngLat: { lng: number; lat: number };
  startTime: number;
  /** The last known position (used by dragcancel) */
  lastPoint: { x: number; y: number };
  lastLngLat: { lng: number; lat: number };
  /** The last pointer event of the press (the originalEvent of a cancel by Escape or blur) */
  lastEvent: PointerOriginalEvent;
  dragging: boolean;
  /** The long press already emitted contextmenu, so the release is not a click */
  longPressed: boolean;
  longPressTimer: ReturnType<typeof setTimeout> | null;
}

type Point = { x: number; y: number };
type LngLat = { lng: number; lat: number };

/**
 * Whether a mouse event is the compatibility event a browser emits for a touch
 */
function firesTouchEvents(e: MouseEvent): boolean | undefined {
  const caps = (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } | null })
    .sourceCapabilities;
  return caps ? caps.firesTouchEvents === true : undefined;
}

/**
 * The pointer type of a touch event (a stylus on iPadOS reports touchType 'stylus')
 */
function touchPointerType(e: TouchEvent): PointerType {
  const touch = e.touches[0] ?? e.changedTouches[0];
  return (touch as (Touch & { touchType?: string }) | undefined)?.touchType === 'stylus'
    ? 'pen'
    : 'touch';
}

/**
 * Creates an InputNormalizer
 *
 * @internal
 */
export function createInputNormalizer(
  map: MapLibreMap,
  options: Partial<InputNormalizerOptions> = {},
): InputNormalizer {
  const canvas = map.getCanvas();
  const listeners = new Set<(event: NormalizedEvent) => void>();
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let profiles = createProfiles(opts);

  // State management
  let press: Press | null = null;
  /**
   * Whether the click that follows the last mouse release is swallowed (the press moved
   * into a drag or was held too long). The browser emits click after mouseup, so this
   * outlives the press.
   */
  let swallowNextClick = false;
  /** The pointerType of the latest pointerdown, consumed by the next mousedown */
  let pendingPointerType: string | null = null;
  /** The pointerType of the last mouse press, for the click that follows its mouseup */
  let lastMousePointerType: PointerType = 'mouse';
  /** Number of fingers currently on the map */
  let activeTouches = 0;
  /** The time the last touch ended (for filtering the compatibility mouse events) */
  let lastTouchEndTime = Number.NEGATIVE_INFINITY;
  /** The last tap (for forming a dblclick from two taps) */
  let lastTap: { point: Point; time: number } | null = null;

  /** The tabIndex the canvas had before attach, given back by detach */
  let hostTabIndex: number | null = null;
  /** The window, for the blur that ends a press (absent outside a browser) */
  const view = canvas.ownerDocument?.defaultView ?? null;

  /**
   * Gives the canvas the keyboard focus on a press
   *
   * A mode that consumes the mousedown prevents its default action, which also stops the
   * browser from focusing the canvas, and then Delete and Escape would never arrive.
   */
  function focusCanvas(): void {
    if (typeof canvas.focus !== 'function') return;
    if (canvas.ownerDocument?.activeElement === canvas) return;
    canvas.focus({ preventScroll: true });
  }

  function emit(event: NormalizedEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function mouseEvent(
    type: MouseNormalizedEvent['type'],
    point: Point,
    lngLat: LngLat,
    originalEvent: PointerOriginalEvent,
    pointerType: PointerType,
  ): MouseNormalizedEvent {
    return {
      type,
      point,
      lngLat,
      originalEvent,
      modifiers: getModifiers(originalEvent),
      pointerType,
    };
  }

  function dragEvent(
    type: DragNormalizedEvent['type'],
    current: Press,
    point: Point,
    lngLat: LngLat,
    originalEvent: PointerOriginalEvent,
  ): DragNormalizedEvent {
    return {
      type,
      point,
      lngLat,
      originalEvent,
      modifiers: getModifiers(originalEvent),
      pointerType: current.pointerType,
      dragStartPoint: current.startPoint,
      dragStartLngLat: current.startLngLat,
    };
  }

  function clearLongPress(current: Press): void {
    if (current.longPressTimer !== null) {
      clearTimeout(current.longPressTimer);
      current.longPressTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // The press, shared by the mouse and touch paths
  // --------------------------------------------------------------------------

  function beginPress(
    source: Press['source'],
    pointerType: PointerType,
    point: Point,
    lngLat: LngLat,
    originalEvent: PointerOriginalEvent,
  ): void {
    if (press) clearLongPress(press);
    const current: Press = {
      source,
      pointerType,
      startPoint: point,
      startLngLat: lngLat,
      startTime: Date.now(),
      lastPoint: point,
      lastLngLat: lngLat,
      lastEvent: originalEvent,
      dragging: false,
      longPressed: false,
      longPressTimer: null,
    };
    press = current;
    swallowNextClick = false;

    const longPressTime = source === 'touch' ? profiles[pointerType].longPressTime : null;
    if (longPressTime !== null) {
      current.longPressTimer = setTimeout(() => {
        current.longPressTimer = null;
        if (press !== current || current.dragging) return;
        current.longPressed = true;
        emit(mouseEvent('contextmenu', point, lngLat, originalEvent, pointerType));
      }, longPressTime);
    }

    emit(mouseEvent('mousedown', point, lngLat, originalEvent, pointerType));
  }

  /**
   * Moves the press: mousemove within the drag threshold, then dragstart and dragmove
   *
   * Once the press has become a drag it stays one until it is released.
   */
  function movePress(
    current: Press,
    point: Point,
    lngLat: LngLat,
    originalEvent: PointerOriginalEvent,
  ): void {
    current.lastPoint = point;
    current.lastLngLat = lngLat;
    current.lastEvent = originalEvent;

    const dx = point.x - current.startPoint.x;
    const dy = point.y - current.startPoint.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (current.dragging || distance > profiles[current.pointerType].dragThreshold) {
      clearLongPress(current);
      const type = current.dragging ? 'dragmove' : 'dragstart';
      current.dragging = true;
      emit(dragEvent(type, current, point, lngLat, originalEvent));
      return;
    }

    emit(mouseEvent('mousemove', point, lngLat, originalEvent, current.pointerType));
  }

  /**
   * Releases the press: dragend (when dragging) and mouseup. Returns whether the release
   * is a click candidate.
   */
  function releasePress(
    current: Press,
    point: Point,
    lngLat: LngLat,
    originalEvent: PointerOriginalEvent,
  ): boolean {
    clearLongPress(current);
    press = null;

    if (current.dragging) {
      emit(dragEvent('dragend', current, point, lngLat, originalEvent));
    }
    emit(mouseEvent('mouseup', point, lngLat, originalEvent, current.pointerType));

    const elapsed = Date.now() - current.startTime;
    return (
      !current.dragging &&
      !current.longPressed &&
      elapsed <= profiles[current.pointerType].clickTimeThreshold
    );
  }

  /**
   * Cancels the press: dragcancel, and nothing after it
   */
  function cancelPress(current: Press, originalEvent: PointerOriginalEvent): void {
    clearLongPress(current);
    press = null;
    // The browser's click after the release of a cancelled mouse press is not a click
    if (current.source === 'mouse') swallowNextClick = true;
    emit(dragEvent('dragcancel', current, current.lastPoint, current.lastLngLat, originalEvent));
  }

  // --------------------------------------------------------------------------
  // MapLibre mouse event handlers
  // --------------------------------------------------------------------------

  /**
   * Whether a mouse event is the browser's compatibility event for a touch
   *
   * The touch path has already normalized that tap, so it is ignored. When the
   * browser does not say (no sourceCapabilities), the mouse events while a finger is
   * down and shortly after the last one is lifted are taken for compatibility events.
   */
  function isTouchCompat(e: MouseEvent): boolean {
    const fromTouch = firesTouchEvents(e);
    if (fromTouch !== undefined) return fromTouch;
    return activeTouches > 0 || Date.now() - lastTouchEndTime < TOUCH_COMPAT_WINDOW;
  }

  function handlePointerDown(e: PointerEvent): void {
    pendingPointerType = e.pointerType;
  }

  function handleMouseDown(e: MapMouseEvent): void {
    const pointerType: PointerType = pendingPointerType === 'pen' ? 'pen' : 'mouse';
    pendingPointerType = null;

    if (e.originalEvent.button !== 0) return; // Left click only

    // Ignore clicks outside the canvas (toolbar buttons and the like)
    if (e.originalEvent.target !== canvas) return;
    if (isTouchCompat(e.originalEvent)) return;

    focusCanvas();
    beginPress(
      'mouse',
      pointerType,
      { x: e.point.x, y: e.point.y },
      { lng: e.lngLat.lng, lat: e.lngLat.lat },
      e.originalEvent,
    );
  }

  function handleMouseMove(e: MapMouseEvent): void {
    if (isTouchCompat(e.originalEvent)) return;

    const currentPoint = { x: e.point.x, y: e.point.y };
    const currentLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };

    if (press?.source === 'mouse') {
      // The left button is already up: its mouseup went where the page could not see it
      // (outside the window, or swallowed by another listener). The press is released at
      // the last position it had while the button was down, and the move is a hover.
      const { buttons } = e.originalEvent;
      if (typeof buttons === 'number' && (buttons & 1) === 0) {
        const current = press;
        releasePress(current, current.lastPoint, current.lastLngLat, e.originalEvent);
        swallowNextClick = true;
        lastMousePointerType = current.pointerType;
      } else {
        movePress(press, currentPoint, currentLngLat, e.originalEvent);
        return;
      }
    }

    // Ordinary mouse move (hover)
    emit(mouseEvent('mousemove', currentPoint, currentLngLat, e.originalEvent, 'mouse'));
  }

  function handleMouseUp(e: MapMouseEvent): void {
    if (e.originalEvent.button !== 0) return;
    if (isTouchCompat(e.originalEvent)) return;

    const currentPoint = { x: e.point.x, y: e.point.y };
    const currentLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };

    if (press?.source === 'mouse') {
      const current = press;
      swallowNextClick = !releasePress(current, currentPoint, currentLngLat, e.originalEvent);
      lastMousePointerType = current.pointerType;
      return;
    }

    // A release with no press on the canvas (pressed outside it)
    emit(mouseEvent('mouseup', currentPoint, currentLngLat, e.originalEvent, 'mouse'));
  }

  function handleClick(e: MapMouseEvent): void {
    if (e.originalEvent.button !== 0) return;

    // Ignore clicks outside the canvas (toolbar buttons and the like).
    // MapLibre fires the event for every click inside the container, so
    // only clicks on the canvas are handled.
    if (e.originalEvent.target !== canvas) return;
    if (isTouchCompat(e.originalEvent)) return;

    // A click after a drag, or after a press held too long, is not treated as a click
    if (swallowNextClick) {
      swallowNextClick = false;
      return;
    }

    emit(
      mouseEvent(
        'click',
        { x: e.point.x, y: e.point.y },
        { lng: e.lngLat.lng, lat: e.lngLat.lat },
        e.originalEvent,
        lastMousePointerType,
      ),
    );
  }

  function handleDoubleClick(e: MapMouseEvent): void {
    if (e.originalEvent.button !== 0) return;

    // Ignore double clicks outside the canvas
    if (e.originalEvent.target !== canvas) return;
    if (isTouchCompat(e.originalEvent)) return;

    emit(
      mouseEvent(
        'dblclick',
        { x: e.point.x, y: e.point.y },
        { lng: e.lngLat.lng, lat: e.lngLat.lat },
        e.originalEvent,
        lastMousePointerType,
      ),
    );
    // A mode that consumed the dblclick (InputRouter prevents its default action) keeps
    // MapLibre's double click zoom off: MapLibre reads only its own event's flag
    if (e.originalEvent.defaultPrevented) e.preventDefault();
  }

  function handleContextMenu(e: MapMouseEvent): void {
    e.preventDefault();
    // The long press of the touch path emits its own contextmenu
    if (isTouchCompat(e.originalEvent)) return;
    emit(
      mouseEvent(
        'contextmenu',
        { x: e.point.x, y: e.point.y },
        { lng: e.lngLat.lng, lat: e.lngLat.lat },
        e.originalEvent,
        'mouse',
      ),
    );
  }

  // --------------------------------------------------------------------------
  // MapLibre touch event handlers
  //
  // MapTouchEvent.preventDefault() is never called: on touchstart it would stop
  // MapLibre's pan and pinch for the gesture. A mode that takes over a one-finger
  // press disables dragPan, exactly as for the mouse.
  // --------------------------------------------------------------------------

  function handleTouchStart(e: MapTouchEvent): void {
    activeTouches = e.originalEvent.touches.length;

    // A second finger: the gesture belongs to MapLibre. A press in progress ends
    if (activeTouches !== 1) {
      lastTap = null;
      if (press?.source === 'touch') cancelPress(press, e.originalEvent);
      return;
    }

    // Ignore touches outside the canvas (controls and markers in the container)
    if (e.originalEvent.target !== canvas) return;

    const point = { x: e.point.x, y: e.point.y };
    const lngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    const pointerType = touchPointerType(e.originalEvent);

    // A touch has no hover, so the position is announced before the press, in the
    // same order as the browser's compatibility events
    emit(mouseEvent('mousemove', point, lngLat, e.originalEvent, pointerType));
    beginPress('touch', pointerType, point, lngLat, e.originalEvent);
  }

  function handleTouchMove(e: MapTouchEvent): void {
    if (press?.source !== 'touch' || e.originalEvent.touches.length !== 1) return;
    movePress(
      press,
      { x: e.point.x, y: e.point.y },
      { lng: e.lngLat.lng, lat: e.lngLat.lat },
      e.originalEvent,
    );
  }

  function handleTouchEnd(e: MapTouchEvent): void {
    activeTouches = e.originalEvent.touches.length;
    if (activeTouches === 0) lastTouchEndTime = Date.now();

    if (press?.source !== 'touch') return;
    const current = press;

    // The point of a touchend is the lifted finger (changedTouches)
    const point = { x: e.point.x, y: e.point.y };
    const lngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };

    if (!releasePress(current, point, lngLat, e.originalEvent)) {
      lastTap = null;
      return;
    }

    emit(mouseEvent('click', point, lngLat, e.originalEvent, current.pointerType));

    // Two taps close in time and place form a dblclick, after the second click (the
    // same order as the mouse)
    const now = Date.now();
    if (
      lastTap &&
      now - lastTap.time <= DOUBLE_TAP_TIME &&
      Math.hypot(point.x - lastTap.point.x, point.y - lastTap.point.y) <= DOUBLE_TAP_DISTANCE
    ) {
      lastTap = null;
      emit(mouseEvent('dblclick', point, lngLat, e.originalEvent, current.pointerType));
    } else {
      lastTap = { point, time: now };
    }
  }

  function handleTouchCancel(e: MapTouchEvent): void {
    activeTouches = e.originalEvent.touches.length;
    if (activeTouches === 0) lastTouchEndTime = Date.now();
    lastTap = null;
    if (press?.source === 'touch') cancelPress(press, e.originalEvent);
  }

  // Keyboard event handlers
  function handleKeyDown(e: KeyboardEvent): void {
    // Escape during a drag cancels the drag, and the key is used up by that
    if (e.key === 'Escape' && press?.dragging) {
      cancelPress(press, press.lastEvent);
      return;
    }
    const event: KeyNormalizedEvent = {
      type: 'keydown',
      key: e.key,
      code: e.code,
      modifiers: getModifiers(e),
      originalEvent: e,
    };
    emit(event);
    // A map key a mode used (it prevented the default action) does not also reach
    // MapLibre's keyboard handler, which listens on the map container (an arrow key would
    // move the selection and pan the map). Other keys keep bubbling to the page
    if (e.defaultPrevented && MAP_KEYS.has(e.key)) e.stopPropagation();
  }

  function handleKeyUp(e: KeyboardEvent): void {
    const event: KeyNormalizedEvent = {
      type: 'keyup',
      key: e.key,
      code: e.code,
      modifiers: getModifiers(e),
      originalEvent: e,
    };
    emit(event);
  }

  /**
   * The window lost the focus (another application or tab): a press cannot be finished,
   * so it is cancelled
   */
  function handleWindowBlur(): void {
    if (!press) return;
    cancelPress(press, press.lastEvent);
  }

  function attach(): void {
    // Make the canvas focusable (for the keyboard) while attached. Its focus outline is left
    // to the page (MapLibre and the browser show it for keyboard focus only)
    if (hostTabIndex === null) {
      hostTabIndex = canvas.tabIndex;
      canvas.tabIndex = 0;
    }

    // The handlers are fixed references inside the closure, so they can be used
    // as-is for registering and unregistering.
    // MapLibre events
    map.on('mousedown', handleMouseDown);
    map.on('mousemove', handleMouseMove);
    map.on('mouseup', handleMouseUp);
    map.on('click', handleClick);
    map.on('dblclick', handleDoubleClick);
    map.on('contextmenu', handleContextMenu);
    map.on('touchstart', handleTouchStart);
    map.on('touchmove', handleTouchMove);
    map.on('touchend', handleTouchEnd);
    map.on('touchcancel', handleTouchCancel);

    // Only read, to tell a pen from a mouse in the mouse events that follow
    canvas.addEventListener('pointerdown', handlePointerDown);

    // Keyboard events are registered on the canvas
    canvas.addEventListener('keydown', handleKeyDown);
    canvas.addEventListener('keyup', handleKeyUp);

    // A press cannot outlive the focus of the window
    view?.addEventListener('blur', handleWindowBlur);
  }

  function detach(): void {
    // MapLibre events
    map.off('mousedown', handleMouseDown);
    map.off('mousemove', handleMouseMove);
    map.off('mouseup', handleMouseUp);
    map.off('click', handleClick);
    map.off('dblclick', handleDoubleClick);
    map.off('contextmenu', handleContextMenu);
    map.off('touchstart', handleTouchStart);
    map.off('touchmove', handleTouchMove);
    map.off('touchend', handleTouchEnd);
    map.off('touchcancel', handleTouchCancel);
    canvas.removeEventListener('pointerdown', handlePointerDown);

    // A press in progress is dropped without events (nobody is listening any more)
    if (press) clearLongPress(press);
    press = null;
    swallowNextClick = false;
    activeTouches = 0;
    lastTap = null;

    // Keyboard
    canvas.removeEventListener('keydown', handleKeyDown);
    canvas.removeEventListener('keyup', handleKeyUp);

    view?.removeEventListener('blur', handleWindowBlur);

    // Give the host its own tabIndex back
    if (hostTabIndex !== null) {
      canvas.tabIndex = hostTabIndex;
      hostTabIndex = null;
    }
  }

  function on(handler: (event: NormalizedEvent) => void): void {
    listeners.add(handler);
  }

  function off(handler: (event: NormalizedEvent) => void): void {
    listeners.delete(handler);
  }

  const setDragThreshold = (px: number): void => {
    opts.dragThreshold = px;
    profiles = createProfiles(opts);
  };

  return { attach, detach, on, off, setDragThreshold };
}
