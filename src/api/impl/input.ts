// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The input of the extension contract: the events a plugin and a mode receive, the order they
 * receive them in, and the modes of the contract running in the mode manager of the engine
 *
 * One rule holds for every receiver: returning true consumes the event. The receivers of the
 * plugins come first, in the order the plugins were added, then the mode.
 */

import type { ExtensionInputRoute } from '../../dispatcher/input-router.js';
import type {
  DragNormalizedEvent,
  KeyNormalizedEvent,
  MouseNormalizedEvent,
  NormalizedEvent,
} from '../../dispatcher/types.js';
import type { EngineModeHandler, SnapInputKind } from '../../modes/handler.js';
import type { SnapResult as StoredSnapResult } from '../../snapping/types.js';
import type {
  DrawKeyEvent,
  DrawPointerEvent,
  InputHandlers,
  ModeHandler,
} from '../extension/mode.js';
import type { Plugin } from '../extension/plugin.js';
import type { SnapPreference } from '../state.js';
import { toPosition, toScreenPoint, toSnapResult } from './contexts.js';

type PointerInput = MouseNormalizedEvent | DragNormalizedEvent;

/**
 * A pointer event of the engine as the contract gives it
 *
 * @param event - The event as it came, before snapping
 * @param snapped - The same event after snapping (the event itself when it was not snapped)
 * @param snap - The snapping result, or null when the position was not snapped
 * @internal
 */
export function toPointerEvent(
  event: PointerInput,
  snapped: PointerInput = event,
  snap: StoredSnapResult | null = null,
): DrawPointerEvent {
  return {
    point: toScreenPoint(event.point),
    lngLat: toPosition(event.lngLat),
    snapped: toSnapResult(snap, toPosition(snapped.lngLat)),
    modifiers: { ...event.modifiers },
    pointerType: event.pointerType ?? 'mouse',
    // The engine keeps the event of the browser it received: a pointer or mouse event, or a
    // touch event for a finger
    original: event.originalEvent as PointerEvent,
  };
}

/**
 * A key event of the engine as the contract gives it
 *
 * @internal
 */
export function toKeyEvent(event: KeyNormalizedEvent): DrawKeyEvent {
  return { key: event.key, modifiers: { ...event.modifiers }, original: event.originalEvent };
}

/**
 * Calls the receiver of an input of the contract for an event of the engine
 *
 * @returns True when the receiver consumed the event
 * @internal
 */
export function deliver(
  receivers: Partial<InputHandlers>,
  event: NormalizedEvent,
  snapped: NormalizedEvent,
  snap: StoredSnapResult | null,
): boolean {
  const pointer = () => toPointerEvent(event as PointerInput, snapped as PointerInput, snap);
  switch (event.type) {
    case 'click':
      return receivers.onClick?.(pointer()) === true;
    case 'dblclick':
      return receivers.onDoubleClick?.(pointer()) === true;
    case 'mousedown':
      return receivers.onPointerDown?.(pointer()) === true;
    case 'mouseup':
      return receivers.onPointerUp?.(pointer()) === true;
    case 'mousemove':
      return receivers.onPointerMove?.(pointer()) === true;
    case 'dragstart':
      return receivers.onDragStart?.(pointer()) === true;
    case 'dragmove':
      return receivers.onDrag?.(pointer()) === true;
    case 'dragend':
      return receivers.onDragEnd?.(pointer()) === true;
    case 'dragcancel':
      return receivers.onDragCancel?.(pointer()) === true;
    case 'keydown':
      return receivers.onKeyDown?.(toKeyEvent(event)) === true;
    case 'keyup':
      return receivers.onKeyUp?.(toKeyEvent(event)) === true;
    default:
      return false;
  }
}

/** The receiver of the contract each snapped input of the engine goes to */
const SNAP_RECEIVERS: Record<SnapInputKind, NonNullable<SnapPreference['unsnapped']>[number]> = {
  click: 'onClick',
  mousemove: 'onPointerMove',
  dragstart: 'onDragStart',
  dragmove: 'onDrag',
  dragend: 'onDragEnd',
};

/** Marks the handlers of the engine that run a mode of the contract */
const BRIDGED = Symbol('extension mode');

/**
 * A mode of the contract running in the mode manager of the engine
 *
 * @internal
 */
export interface BridgedMode extends EngineModeHandler {
  readonly [BRIDGED]: ModeHandler;
}

/**
 * Wraps the handler of a mode of the contract into a handler of the mode manager of the
 * engine. The input reaches it through {@link routeToMode}, not through the methods the
 * engine calls on its own modes.
 *
 * @param onExit - Called after the mode was left, to end what its context holds
 * @param entering - Runs the entering of the mode, so that its context knows the cursor the
 *   mode sets then
 * @internal
 */
export function bridgeMode(
  name: string,
  handler: ModeHandler,
  onExit: () => void,
  entering: (run: () => void) => void = (run) => run(),
): BridgedMode {
  const bridged: BridgedMode = {
    [BRIDGED]: handler,
    modeName: name,
    writesFeatures: handler.writes === true,
    onStart() {
      entering(() => handler.onEnter?.());
    },
    onStop() {
      try {
        handler.onExit?.();
      } finally {
        onExit();
      }
    },
    onExternalStateChange() {
      handler.onCancel?.();
    },
    undoVertex: () => handler.onUndoVertex?.() === true,
    redoVertex: () => handler.onRedoVertex?.() === true,
    getSnapPreference: () => handler.snapPreference?.prefer ?? null,
    isSnapEnabledFor(inputType) {
      const unsnapped = handler.snapPreference?.unsnapped;
      return !unsnapped?.includes(SNAP_RECEIVERS[inputType]);
    },
  };
  return bridged;
}

/**
 * The mode of the contract a handler of the engine runs, if it runs one
 *
 * @internal
 */
export function bridgedHandler(handler: EngineModeHandler | null): ModeHandler | undefined {
  return (handler as Partial<BridgedMode> | null)?.[BRIDGED];
}

/**
 * Gives an event to a mode of the contract. An Escape that the mode does not consume
 * interrupts it (`onCancel`).
 *
 * @returns Whether it consumed the event, or undefined when the handler runs no mode of the
 *   contract
 * @internal
 */
export function routeToMode(
  handler: EngineModeHandler,
  event: NormalizedEvent,
  snapped: NormalizedEvent,
  snap: StoredSnapResult | null,
): boolean | undefined {
  const mode = bridgedHandler(handler);
  if (!mode) return undefined;
  const consumed = deliver(mode, event, snapped, snap);
  if (!consumed && event.type === 'keydown' && event.key === 'Escape' && mode.onCancel) {
    mode.onCancel();
    return true;
  }
  return consumed;
}

/**
 * The route of the input to the plugins and the modes of the contract
 *
 * @param plugins - The plugins in the order they were added
 * @internal
 */
export function createInputRoute(plugins: () => readonly Plugin[]): ExtensionInputRoute {
  return {
    toPlugins(event, snapped, snap) {
      for (const plugin of plugins()) {
        if (!plugin.input) continue;
        try {
          if (deliver(plugin.input, event, snapped, snap)) return true;
        } catch (error) {
          console.error(`Error in the input of the plugin "${plugin.name}":`, error);
        }
      }
      return false;
    },
    toMode: routeToMode,
  };
}

/**
 * Tells the plugins and the mode of the contract that the pointer left the map
 *
 * @internal
 */
export function deliverPointerLeave(
  plugins: readonly Plugin[],
  handler: EngineModeHandler | null,
): void {
  for (const plugin of plugins) {
    if (plugin.input?.onPointerLeave?.() === true) return;
  }
  bridgedHandler(handler)?.onPointerLeave?.();
}
