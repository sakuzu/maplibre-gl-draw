// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';

import type { DragNormalizedEvent, MouseNormalizedEvent } from '../dispatcher/types.js';
import type { ModeManager } from '../modes/manager.js';
import type { Plugin, PluginContext } from './plugin.js';
import { createPluginManager } from './plugin-manager.js';

// handleDragMove / handleMouseMove only walk the registered plugins and call the
// matching hook, and do not use context / modeManager (they are never touched for
// a plugin that has no onInstall / modes).
// Therefore they can be unit tested with minimal stubs.
function makeManager() {
  const getContext = () => ({}) as PluginContext;
  const modeManager = {} as ModeManager;
  return createPluginManager(getContext, modeManager);
}

const dragEvent = {
  type: 'dragmove',
  lngLat: { lng: 1, lat: 2 },
} as unknown as DragNormalizedEvent;

const mouseEvent = {
  type: 'mousemove',
  lngLat: { lng: 3, lat: 4 },
} as unknown as MouseNormalizedEvent;

describe('PluginManager pointer dispatch', () => {
  it('handleDragMove calls onDragMove (and not onMouseMove)', () => {
    const onDragMove = vi.fn();
    const onMouseMove = vi.fn();
    const plugin: Plugin = { name: 'p', onDragMove, onMouseMove };
    const pm = makeManager();
    pm.register(plugin);

    pm.handleDragMove(dragEvent);

    expect(onDragMove).toHaveBeenCalledWith(dragEvent);
    expect(onMouseMove).not.toHaveBeenCalled();
  });

  it('handleMouseMove calls onMouseMove (and not onDragMove)', () => {
    const onDragMove = vi.fn();
    const onMouseMove = vi.fn();
    const plugin: Plugin = { name: 'p', onDragMove, onMouseMove };
    const pm = makeManager();
    pm.register(plugin);

    pm.handleMouseMove(mouseEvent);

    expect(onMouseMove).toHaveBeenCalledWith(mouseEvent);
    expect(onDragMove).not.toHaveBeenCalled();
  });

  it('does not throw for a plugin that does not implement onDragMove', () => {
    const pm = makeManager();
    pm.register({ name: 'noop' });

    expect(() => pm.handleDragMove(dragEvent)).not.toThrow();
  });
});

describe('PluginManager registration', () => {
  it('returns a function that unregisters the plugin and removes its modes', () => {
    const cancelMode = vi.fn();
    const modeManager = { registerMode: vi.fn(() => cancelMode) } as unknown as ModeManager;
    const onUninstall = vi.fn();
    const pm = createPluginManager(() => ({}) as PluginContext, modeManager);

    const unregister = pm.register({
      name: 'measure',
      modes: { measure: () => ({ modeName: 'measure' }) },
      onUninstall,
    });
    unregister();

    expect(pm.getPluginNames()).toEqual([]);
    expect(cancelMode).toHaveBeenCalledTimes(1);
    expect(onUninstall).toHaveBeenCalledTimes(1);
  });

  it('removes the modes of a plugin whose onInstall throws', () => {
    const cancelMode = vi.fn();
    const modeManager = { registerMode: vi.fn(() => cancelMode) } as unknown as ModeManager;
    const pm = createPluginManager(() => ({}) as PluginContext, modeManager);

    expect(() =>
      pm.register({
        name: 'broken',
        modes: { broken: () => ({ modeName: 'broken' }) },
        onInstall: () => {
          throw new Error('install failed');
        },
      }),
    ).toThrow('install failed');
    expect(cancelMode).toHaveBeenCalledTimes(1);
  });
});
