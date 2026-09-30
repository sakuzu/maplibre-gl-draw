// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ModeManager
 *
 * Manages the switching of the drawing modes.
 * Following the SSoT architecture, the mode state is managed in the Store.
 */

import type { Store } from '../store/store.js';
import type { Mode, StoreChange } from '../store/types.js';
import type { EngineModeContext, EngineModeFactory, EngineModeHandler } from './handler.js';

/**
 * ModeManager interface
 *
 * @internal
 */
export interface ModeManager {
  /** Gets the current mode */
  getMode(): Mode;

  /**
   * Changes the mode
   *
   * Every refusal is the same: the Store is not changed, the current handler keeps running,
   * and false is returned. A mode is refused when no factory is registered for it, when it is
   * not select while the interaction lock is on, and when the `canEnter` predicate rejects it
   * (see `ModeManagerOptions`). Asking for the current mode changes nothing and returns true.
   *
   * @returns whether the mode is `mode` after the call
   */
  setMode(mode: Mode): boolean;

  /**
   * Registers a mode
   *
   * @returns the function that cancels this registration (unregisterMode, only while the
   *   factory is still the one registered for the name)
   */
  registerMode(mode: Mode, factory: EngineModeFactory): () => void;

  /**
   * Removes the mode of a name
   *
   * When it is the current mode, select is entered first, so the running handler is always
   * one that is registered.
   */
  unregisterMode(mode: Mode): void;

  /** Whether a factory is registered for the mode */
  hasMode(mode: Mode): boolean;

  /** Gets the current mode handler */
  getHandler(): EngineModeHandler | null;

  /** Sets the context */
  setContext(context: EngineModeContext): void;

  /** Starts the initial mode and starts subscribing to the Store */
  start(): void;

  /** Stops the current mode and unsubscribes */
  stop(): void;

  /**
   * Notifies the current mode handler of an external state change
   *
   * Called after an external state change (a change applied from outside the mode).
   */
  notifyStateReset(): void;

  /**
   * Notifies the current mode handler of a selection change
   *
   * Called when the selection is changed from a plugin.
   */
  notifySelectionChange(): void;

  /**
   * Undoes a vertex while drawing
   *
   * @returns whether the undo was carried out
   */
  undoVertex(): boolean;

  /**
   * Redoes a vertex that was undone
   *
   * @returns whether the redo was carried out
   */
  redoVertex(): boolean;
}

/**
 * Options of ModeManagerImpl
 */
export interface ModeManagerOptions {
  /**
   * Whether the mode of the handler can be entered now
   *
   * Asked on every setMode (except the one to select) with a handler that the factory of the
   * requested mode has just created; it reads what the mode declares (for example
   * `writesFeatures`). When it returns false the request is ignored and the current mode is
   * kept, like the interaction lock. When it is omitted, every registered mode can be entered.
   */
  canEnter?: (handler: EngineModeHandler) => boolean;
}

/**
 * ModeManager implementation
 *
 * Subscribes to the mode state of the Store and switches the handler when the mode changes.
 *
 * @internal
 */
export class ModeManagerImpl implements ModeManager {
  private currentHandler: EngineModeHandler | null = null;
  private factories = new Map<Mode, EngineModeFactory>();
  private context: EngineModeContext | null = null;
  private unsubscribe: (() => void) | null = null;
  /**
   * The handler created by setMode to ask canEnter, which starts when the Store reports the
   * mode change (so a mode is never constructed twice for one transition)
   */
  private pending: { mode: Mode; handler: EngineModeHandler } | null = null;

  constructor(
    private readonly store: Store,
    private readonly options: ModeManagerOptions = {},
  ) {}

  /**
   * Sets the context
   */
  setContext(context: EngineModeContext): void {
    this.context = context;
  }

  getMode(): Mode {
    return this.store.getMode();
  }

  setMode(mode: Mode): boolean {
    if (mode === this.store.getMode()) return true;

    // A mode without a factory is refused before the Store changes, so the Store, the
    // draw.mode.change event and the running handler never disagree (a typo in a mode name
    // is reported, not half applied).
    const factory = this.factories.get(mode);
    if (!factory) {
      console.warn(`Mode "${mode}" is not registered`);
      return false;
    }
    // While the interaction lock is on, transitions to drawing modes (anything other than
    // select) are refused. In the read-only state only select is allowed, which prevents
    // entering an editing mode. This is not a write gate, so it is a suppression independent
    // of readOnly, and returning to select is always allowed.
    if (mode !== 'select' && this.store.isInteractionLocked()) return false;
    // A mode that the canEnter predicate rejects (for example, one that writes features
    // while no layer can be written) is refused in the same way.
    const { canEnter } = this.options;
    if (canEnter && mode !== 'select') {
      const handler = factory();
      if (!canEnter(handler)) return false;
      this.pending = { mode, handler };
    }
    // Following SSoT, the mode change is carried out through the Store
    // The result of the mode change is handled in handleModeChange through the Store subscription
    this.store.setMode(mode);
    return this.store.getMode() === mode;
  }

  registerMode(mode: Mode, factory: EngineModeFactory): () => void {
    this.factories.set(mode, factory);
    return () => {
      if (this.factories.get(mode) === factory) this.unregisterMode(mode);
    };
  }

  hasMode(mode: Mode): boolean {
    return this.factories.has(mode);
  }

  unregisterMode(mode: Mode): void {
    if (!this.factories.has(mode)) return;
    if (mode !== 'select' && this.store.getMode() === mode) this.setMode('select');
    if (this.pending?.mode === mode) this.pending = null;
    this.factories.delete(mode);
  }

  getHandler(): EngineModeHandler | null {
    return this.currentHandler;
  }

  /**
   * Starts the initial mode and starts subscribing to the Store
   */
  start(): void {
    // Subscribe to the mode changes of the Store
    this.unsubscribe = this.store.subscribe((changes: StoreChange) => {
      if (changes.mode) {
        this.handleModeChange(changes.mode.mode);
      }
    });

    // Start the handler of the initial mode
    const currentMode = this.store.getMode();
    const factory = this.factories.get(currentMode);
    if (factory) {
      this.currentHandler = factory();
      if (this.context) {
        this.currentHandler.onStart?.(this.context);
      }
    }
  }

  /**
   * Stops the current mode and unsubscribes
   */
  stop(): void {
    if (this.currentHandler) {
      this.currentHandler.onStop?.();
    }
    this.currentHandler = null;

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Handles a mode change notification from the Store
   */
  private handleModeChange(mode: Mode): void {
    const factory = this.factories.get(mode);
    if (!factory) {
      console.warn(`Mode "${mode}" is not registered`);
      return;
    }

    // End the current mode
    if (this.currentHandler) {
      this.currentHandler.onStop?.();
    }

    // Start the new mode (the handler that setMode created for canEnter, when there is one)
    const pending = this.pending;
    this.pending = null;
    this.currentHandler = pending?.mode === mode ? pending.handler : factory();

    if (this.context) {
      this.currentHandler.onStart?.(this.context);
    }
  }

  /**
   * Notifies the current mode handler of an external state change
   */
  notifyStateReset(): void {
    this.currentHandler?.onExternalStateChange?.();
  }

  /**
   * Notifies the current mode handler of a selection change
   */
  notifySelectionChange(): void {
    this.currentHandler?.onSelectionChange?.();
  }

  /**
   * Undoes a vertex while drawing
   */
  undoVertex(): boolean {
    return this.currentHandler?.undoVertex?.() ?? false;
  }

  /**
   * Redoes a vertex that was undone
   */
  redoVertex(): boolean {
    return this.currentHandler?.redoVertex?.() ?? false;
  }
}
