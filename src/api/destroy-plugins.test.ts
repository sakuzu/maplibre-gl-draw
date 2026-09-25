// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the plugin uninstallation of draw.destroy()
 *
 * A plugin holds things outside the draw instance (timers, subscriptions), so destroy runs
 * every onUninstall. The registries of the extension points belong to each draw instance, so
 * the provider of a dead instance can no longer reach a live one either way; this test pins
 * down that the plugins are uninstalled.
 *
 * The symptom seen in the field: after opening a preview (a separate draw instance), deleting
 * the target that a plugin-drawn line is bound to in the editor draws two lines
 * (one toward the correct anchor, and a phantom one toward the position before the
 * deletion that the Store of the dead instance still holds). While the bound target is
 * alive the two overlap exactly, so this is invisible.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';

import type { Plugin } from '../plugins/plugin.js';
import { createPluginManager } from '../plugins/plugin-manager.js';
import { createPixelRatioSource } from '../shared/utils/pixel-ratio.js';
import { createInstanceApi, type InstanceApiDeps } from './instance-api.js';

/** Prepares the dependencies destroy calls in a minimal form that only counts calls */
function createApi(plugins: Plugin[]) {
  const map = {
    triggerRepaint: vi.fn(),
    getLayer: () => undefined,
    removeLayer: vi.fn(),
    boxZoom: { enable: vi.fn() },
  } as unknown as MapLibreMap;

  const pluginManager = createPluginManager(() => ({}) as never, {
    registerMode: vi.fn(),
  } as never);
  for (const plugin of plugins) pluginManager.register(plugin);

  const api = createInstanceApi({
    map,
    pluginManager,
    pixelRatioSource: createPixelRatioSource(1),
    inputRouter: { stop: vi.fn() },
    inputNormalizer: { detach: vi.fn() },
    eventBridge: { stop: vi.fn() },
    modeManager: { stop: vi.fn() },
    renderCoordinator: { stop: vi.fn() },
    autoNameGenerator: { dispose: vi.fn() },
    customLayer: { id: 'draw' },
  } as unknown as InstanceApiDeps);

  return { api, pluginManager };
}

describe('the plugin uninstallation of draw.destroy()', () => {
  it('calls onUninstall of every registered plugin', () => {
    const first = { name: 'first', onUninstall: vi.fn() };
    const second = { name: 'second', onUninstall: vi.fn() };
    const { api, pluginManager } = createApi([first, second]);

    expect(pluginManager.getPluginNames()).toEqual(['first', 'second']);

    api.destroy();

    expect(first.onUninstall).toHaveBeenCalledTimes(1);
    expect(second.onUninstall).toHaveBeenCalledTimes(1);
    expect(pluginManager.getPluginNames()).toEqual([]);
  });

  it('unregisters from the extension points (a destroyed instance leaves no rendering)', () => {
    // Registering and unregistering the provider is done in onInstall / onUninstall and
    // the teardown they return (the usual shape of a plugin that registers a provider)
    const registry = new Set<string>();
    const plugin: Plugin = {
      name: 'companion-owner',
      onInstall: () => {
        registry.add('provider:1');
      },
      onUninstall: () => {
        registry.delete('provider:1');
      },
    };

    const { api } = createApi([plugin]);
    expect(registry.has('provider:1')).toBe(true);

    api.destroy();
    expect(registry.has('provider:1')).toBe(false);
  });

  it('keeps uninstalling the other plugins even when onUninstall throws', () => {
    const throwing = {
      name: 'throwing',
      onUninstall: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    const healthy = { name: 'healthy', onUninstall: vi.fn() };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { api, pluginManager } = createApi([throwing, healthy]);
    expect(() => api.destroy()).not.toThrow();

    expect(healthy.onUninstall).toHaveBeenCalledTimes(1);
    expect(pluginManager.getPluginNames()).toEqual([]);
    consoleError.mockRestore();
  });

  it('can be destroyed even with no plugins', () => {
    const { api } = createApi([]);
    expect(() => api.destroy()).not.toThrow();
  });
});
