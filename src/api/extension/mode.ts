// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The input contract: the events a mode and a plugin receive, and the handler of a mode
 *
 * One rule holds for every input handler: returning true consumes the event, so that nothing
 * after the handler receives it.
 */

// biome-ignore-all lint/suspicious/noConfusingVoidType: a receiver that returns nothing does not consume the event

import type { Position } from 'geojson';
import type { ScreenPoint } from '../events.js';
import type { SnapPreference, SnapResult } from '../state.js';
import type { ModeContext } from './context.js';

/** The modifier keys held during an input. */
export interface Modifiers {
  /** Whether Shift was held */
  shift: boolean;
  /** Whether Control was held */
  ctrl: boolean;
  /** Whether Alt (Option on macOS) was held */
  alt: boolean;
  /** Whether Meta (Command on macOS) was held */
  meta: boolean;
}

/** A pointer input on the map, as a mode and a plugin receive it. */
export interface DrawPointerEvent {
  /** The point on the screen */
  point: ScreenPoint;
  /** The position on the map */
  lngLat: Position;
  /** Where the input snaps to; the position of the pointer when nothing is snapped to */
  snapped: SnapResult;
  /** The modifier keys held */
  modifiers: Modifiers;
  /** The kind of pointer */
  pointerType: 'mouse' | 'touch' | 'pen';
  /** The event of the browser */
  original: PointerEvent;
}

/** A key input, as a mode and a plugin receive it. */
export interface DrawKeyEvent {
  /** The key, as `KeyboardEvent.key` gives it */
  key: string;
  /** The modifier keys held */
  modifiers: Modifiers;
  /** The event of the browser */
  original: KeyboardEvent;
}

/**
 * The receivers of the input; `Plugin.input` and `ModeHandler` take any of them. Returning
 * true consumes the event, so that nothing after the receiver gets it.
 */
export interface InputHandlers {
  /** A pointer was pressed */
  onPointerDown(event: DrawPointerEvent): boolean | void;
  /** The pointer moved without a drag */
  onPointerMove(event: DrawPointerEvent): boolean | void;
  /** A pointer was released */
  onPointerUp(event: DrawPointerEvent): boolean | void;
  /** The pointer left the map */
  onPointerLeave(): boolean | void;
  /** A click */
  onClick(event: DrawPointerEvent): boolean | void;
  /** A double click */
  onDoubleClick(event: DrawPointerEvent): boolean | void;
  /** A drag started */
  onDragStart(event: DrawPointerEvent): boolean | void;
  /** The pointer moved during a drag */
  onDrag(event: DrawPointerEvent): boolean | void;
  /** A drag ended */
  onDragEnd(event: DrawPointerEvent): boolean | void;
  /** A drag was cancelled */
  onDragCancel(event: DrawPointerEvent): boolean | void;
  /** A key was pressed */
  onKeyDown(event: DrawKeyEvent): boolean | void;
  /** A key was released */
  onKeyUp(event: DrawKeyEvent): boolean | void;
}

/**
 * The contract of a mode: how it enters, exits and receives the input. Every member is
 * optional; returning true from an input receiver consumes the event.
 */
export interface ModeHandler extends Partial<InputHandlers> {
  /**
   * Whether the mode writes new features. Such a mode is entered only while a layer can be
   * written; false when it is left out.
   */
  readonly writes?: boolean;
  /** How the mode wants the positions of its input snapped; every input snaps when left out */
  readonly snapPreference?: SnapPreference;
  /** Called when the mode is entered */
  onEnter?(): void;
  /** Called when the mode is left */
  onExit?(): void;
  /**
   * Called when the mode is interrupted: by an Escape that neither a plugin nor the mode
   * consumed, or when the Store replaces its whole document (a notification with
   * `reset: true`). The mode drops what it was drawing and stays the current mode.
   */
  onCancel?(): void;
  /**
   * Removes the last vertex of the shape being drawn, as `ctx.drawing.undoVertex` asks.
   *
   * @returns True when a vertex was removed
   */
  onUndoVertex?(): boolean;
  /**
   * Puts back the vertex the last `onUndoVertex` removed, as `ctx.drawing.redoVertex` asks.
   *
   * @returns True when a vertex was put back
   */
  onRedoVertex?(): boolean;
}

/**
 * The function that creates the handler of a mode. It is registered once, under its name,
 * with `draw.extensions.modes.add(name, factory)`.
 */
export type ModeFactory = (ctx: ModeContext) => ModeHandler;
