// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin Manager
 *
 * Component responsible for registering and managing plugins and running hooks.
 */

import type {
  DragNormalizedEvent,
  KeyNormalizedEvent,
  MouseNormalizedEvent,
} from '../dispatcher/types.js';
import type { ModeFactory } from '../modes/handler.js';
import type { ModeManager } from '../modes/manager.js';

import type { Hooks, MutationContext, Plugin, PluginContext } from './plugin.js';

/** The name of a plugin hook (a key of Hooks) */
export type HookName = keyof Hooks;

/**
 * Interface of the plugin manager
 */
export interface PluginManager {
  /**
   * Register a plugin
   *
   * @returns the function that unregisters it (it does nothing for a plugin of the same name
   *   that was already registered, which is skipped)
   */
  register(plugin: Plugin): () => void;

  /** Unregister a plugin */
  unregister(name: string): void;

  /** Run a hook */
  runHook<K extends HookName>(hookName: K, ...args: Parameters<NonNullable<Hooks[K]>>): void;

  /** Get the API of a plugin */
  getPluginApi<T>(name: string): T | undefined;

  /** Get the registered modes */
  getModes(): Record<string, ModeFactory>;

  /** Get the names of the registered plugins */
  getPluginNames(): string[];

  /**
   * Handle a keyboard event
   *
   * Calls onKeyDown of the registered plugins in order.
   * If any plugin returns true, the event is regarded as consumed.
   *
   * @param event Normalized keyboard event
   * @returns true when any plugin consumed the event
   */
  handleKeyDown(event: KeyNormalizedEvent): boolean;

  /**
   * Handle a mouse move event
   *
   * Calls onMouseMove of the registered plugins in order.
   *
   * @param event Normalized mouse move event
   */
  handleMouseMove(event: MouseNormalizedEvent): void;

  /**
   * Handle a drag move event
   *
   * Calls onDragMove of the registered plugins in order (the counterpart of
   * onMouseMove).
   *
   * @param event Normalized drag event
   */
  handleDragMove(event: DragNormalizedEvent): void;

  /**
   * Handle a mouse leave event
   *
   * Calls onMouseLeave of the registered plugins in order.
   */
  handleMouseLeave(): void;

  /**
   * Filter the selection candidates
   *
   * Applies filterSelection of the registered plugins in order.
   */
  filterSelectionCandidates(candidateIds: string[]): string[];

  // === Interaction hooks ===

  /**
   * Notify the plugins that an already selected feature was clicked
   *
   * @param event The click, which the plugins of the extension contract receive
   * @returns true when any plugin handled it
   */
  handleFeatureClick(featureId: string, event?: MouseNormalizedEvent): boolean;

  /**
   * Notify the plugins that a feature was double-clicked
   *
   * @param event The double click, which the plugins of the extension contract receive
   * @returns true when any plugin handled it
   */
  handleFeatureDoubleClick(featureId: string, event?: MouseNormalizedEvent): boolean;

  /**
   * Whether any plugin is in the middle of an interaction
   */
  isPluginInteracting(): boolean;

  /**
   * Complete the interaction of all plugins
   */
  finishPluginInteraction(): void;

  /**
   * Cancel the interaction of all plugins
   */
  cancelPluginInteraction(): void;

  /**
   * Get the DOM container of a plugin's interaction
   */
  getPluginInteractionContainer(): HTMLElement | null;

  /**
   * Notify the plugins that a feature was created
   */
  notifyFeatureCreated(featureId: string, featureType: string): void;
}

/**
 * Create a plugin manager
 *
 * @param getContext Function that obtains the PluginContext lazily (made lazy
 *   because of the circular initialization inside createMapLibreGLDraw)
 * @param modeManager Reference to the ModeManager used to register
 *   Plugin.modes automatically
 *
 * @internal
 */
export function createPluginManager(
  getContext: () => PluginContext,
  modeManager: ModeManager,
): PluginManager {
  const plugins = new Map<string, Plugin>();
  /** The cancel functions of the modes each plugin registered */
  const pluginModes = new Map<string, Array<() => void>>();
  const hookHandlers = new Map<HookName, Array<NonNullable<Hooks[HookName]>>>();

  // Remove the hook handlers of a plugin from hookHandlers.
  // Shared by the rollback on a failed register and by unregister.
  function removeHookHandlers(plugin: Plugin): void {
    if (!plugin.hooks) return;
    for (const [hookName, handler] of Object.entries(plugin.hooks)) {
      if (!handler) continue;
      const handlers = hookHandlers.get(hookName as HookName);
      if (!handlers) continue;
      const index = handlers.indexOf(handler as NonNullable<Hooks[HookName]>);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    }
  }

  /** Removes the modes a plugin registered (a mode it is running falls back to select) */
  function removeModes(name: string): void {
    for (const cancel of pluginModes.get(name) ?? []) cancel();
    pluginModes.delete(name);
  }

  function register(plugin: Plugin): () => void {
    if (plugins.has(plugin.name)) {
      console.warn(`Plugin "${plugin.name}" is already registered. Skipping.`);
      return () => {};
    }

    plugins.set(plugin.name, plugin);

    // Register Plugin.modes with the ModeManager automatically.
    // Done before onInstall so that setMode can be called inside onInstall.
    if (plugin.modes) {
      const cancels: Array<() => void> = [];
      for (const [name, factory] of Object.entries(plugin.modes)) {
        cancels.push(modeManager.registerMode(name, factory));
      }
      pluginModes.set(plugin.name, cancels);
    }

    // Register the hooks
    if (plugin.hooks) {
      for (const [hookName, handler] of Object.entries(plugin.hooks)) {
        if (handler) {
          const name = hookName as HookName;
          if (!hookHandlers.has(name)) {
            hookHandlers.set(name, []);
          }
          hookHandlers.get(name)?.push(handler as NonNullable<Hooks[HookName]>);
        }
      }
    }

    // Call onInstall. On failure, roll back the registered hooks, the modes and the
    // plugin entry and rethrow the exception (so that no half-finished
    // registration state is left behind).
    try {
      plugin.onInstall?.(getContext());
    } catch (error) {
      removeHookHandlers(plugin);
      removeModes(plugin.name);
      plugins.delete(plugin.name);
      throw error;
    }

    return () => {
      if (plugins.get(plugin.name) === plugin) unregister(plugin.name);
    };
  }

  function unregister(name: string): void {
    const plugin = plugins.get(name);
    if (!plugin) {
      return;
    }

    // Isolate with try/finally so that an exception from onUninstall does not
    // skip the unregistration work.
    try {
      // The modes go first, so a mode of the plugin that is running stops (falling back to
      // select) while the plugin is still installed
      removeModes(name);
      plugin.onUninstall?.();
    } catch (error) {
      console.error(`Error in plugin "${name}" onUninstall:`, error);
    } finally {
      // Unregister the hooks (and the modes, when removing them threw)
      removeHookHandlers(plugin);
      removeModes(name);

      plugins.delete(name);
    }
  }

  function runHook<K extends HookName>(
    hookName: K,
    ...args: Parameters<NonNullable<Hooks[K]>>
  ): void {
    const handlers = hookHandlers.get(hookName);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (handler as (...args: unknown[]) => void)(...args);
      } catch (error) {
        console.error(`Error in plugin hook "${hookName}":`, error);
      }
    }
  }

  function getPluginApi<T>(name: string): T | undefined {
    const plugin = plugins.get(name);
    return plugin?.api as T | undefined;
  }

  function getModes(): Record<string, ModeFactory> {
    const modes: Record<string, ModeFactory> = {};
    for (const plugin of plugins.values()) {
      if (plugin.modes) {
        Object.assign(modes, plugin.modes);
      }
    }
    return modes;
  }

  function getPluginNames(): string[] {
    return Array.from(plugins.keys());
  }

  function handleKeyDown(event: KeyNormalizedEvent): boolean {
    for (const plugin of plugins.values()) {
      if (plugin.onKeyDown) {
        try {
          const consumed = plugin.onKeyDown(event);
          if (consumed) {
            return true;
          }
        } catch (error) {
          console.error(`Error in plugin "${plugin.name}" onKeyDown:`, error);
        }
      }
    }
    return false;
  }

  function handleMouseMove(event: MouseNormalizedEvent): void {
    for (const plugin of plugins.values()) {
      if (plugin.onMouseMove) {
        try {
          plugin.onMouseMove(event);
        } catch (error) {
          console.error(`Error in plugin "${plugin.name}" onMouseMove:`, error);
        }
      }
    }
  }

  function handleDragMove(event: DragNormalizedEvent): void {
    for (const plugin of plugins.values()) {
      if (plugin.onDragMove) {
        try {
          plugin.onDragMove(event);
        } catch (error) {
          console.error(`Error in plugin "${plugin.name}" onDragMove:`, error);
        }
      }
    }
  }

  function handleMouseLeave(): void {
    for (const plugin of plugins.values()) {
      if (plugin.onMouseLeave) {
        try {
          plugin.onMouseLeave();
        } catch (error) {
          console.error(`Error in plugin "${plugin.name}" onMouseLeave:`, error);
        }
      }
    }
  }

  function filterSelectionCandidates(candidateIds: string[]): string[] {
    let filtered = candidateIds;
    for (const plugin of plugins.values()) {
      if (plugin.filterSelection) {
        try {
          filtered = plugin.filterSelection(filtered);
        } catch (error) {
          console.error(`Error in plugin "${plugin.name}" filterSelection:`, error);
        }
      }
    }
    return filtered;
  }

  /** A click hook, called with the event too (the plugins of the extension contract read it) */
  type ClickHook = (featureId: string, event?: MouseNormalizedEvent) => boolean;

  function handleFeatureClick(featureId: string, event?: MouseNormalizedEvent): boolean {
    for (const plugin of plugins.values()) {
      if (plugin.onFeatureClick) {
        try {
          if ((plugin.onFeatureClick as ClickHook).call(plugin, featureId, event)) {
            return true;
          }
        } catch (error) {
          console.error(`Error in plugin "${plugin.name}" onFeatureClick:`, error);
        }
      }
    }
    return false;
  }

  function handleFeatureDoubleClick(featureId: string, event?: MouseNormalizedEvent): boolean {
    for (const plugin of plugins.values()) {
      if (plugin.onFeatureDoubleClick) {
        try {
          if ((plugin.onFeatureDoubleClick as ClickHook).call(plugin, featureId, event)) {
            return true;
          }
        } catch (error) {
          console.error(`Error in plugin "${plugin.name}" onFeatureDoubleClick:`, error);
        }
      }
    }
    return false;
  }

  function isPluginInteracting(): boolean {
    for (const plugin of plugins.values()) {
      if (plugin.isInteracting?.()) {
        return true;
      }
    }
    return false;
  }

  function finishPluginInteraction(): void {
    for (const plugin of plugins.values()) {
      if (plugin.isInteracting?.()) {
        try {
          plugin.finishInteraction?.();
        } catch (error) {
          console.error(`Error in plugin "${plugin.name}" finishInteraction:`, error);
        }
      }
    }
  }

  function cancelPluginInteraction(): void {
    for (const plugin of plugins.values()) {
      if (plugin.isInteracting?.()) {
        try {
          plugin.cancelInteraction?.();
        } catch (error) {
          console.error(`Error in plugin "${plugin.name}" cancelInteraction:`, error);
        }
      }
    }
  }

  function getPluginInteractionContainer(): HTMLElement | null {
    for (const plugin of plugins.values()) {
      if (plugin.isInteracting?.()) {
        const container = plugin.getInteractionContainer?.();
        if (container) return container;
      }
    }
    return null;
  }

  function notifyFeatureCreated(featureId: string, featureType: string): void {
    for (const plugin of plugins.values()) {
      if (plugin.onFeatureCreated) {
        try {
          plugin.onFeatureCreated(featureId, featureType);
        } catch (error) {
          console.error(`Error in plugin "${plugin.name}" onFeatureCreated:`, error);
        }
      }
    }
  }

  return {
    register,
    unregister,
    runHook,
    getPluginApi,
    getModes,
    getPluginNames,
    handleKeyDown,
    handleMouseMove,
    handleDragMove,
    handleMouseLeave,
    filterSelectionCandidates,
    handleFeatureClick,
    handleFeatureDoubleClick,
    isPluginInteracting,
    finishPluginInteraction,
    cancelPluginInteraction,
    getPluginInteractionContainer,
    notifyFeatureCreated,
  };
}

/**
 * Create the default MutationContext
 *
 * @internal
 */
export function createMutationContext(
  source: MutationContext['source'] = 'local',
  batchId?: string,
): MutationContext {
  return { source, batchId };
}
