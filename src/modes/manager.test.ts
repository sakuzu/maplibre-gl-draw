// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the setMode gate of ModeManager
 *
 * While the interaction lock is on, transitions to drawing modes (anything other than select)
 * are ignored. Returning to select is always allowed. This is not a write gate, so it is a
 * suppression independent of readOnly.
 */

import { describe, expect, it, vi } from 'vitest';
import type { InstanceDocument } from '../store/document-access.js';
import type { Mode } from '../store/types.js';
import { createTestDocument } from '../test-utils.js';
import type { EngineModeHandler } from './handler.js';
import { ModeManagerImpl, type ModeManagerOptions } from './manager.js';

/** A manager with a plain handler registered for select and the given drawing modes */
function createManager(
  store: InstanceDocument,
  modes: Mode[] = ['drawPoint', 'drawLine', 'drawPolygon'],
  options?: ModeManagerOptions,
): ModeManagerImpl {
  const manager = new ModeManagerImpl(store, options);
  for (const mode of ['select', ...modes]) {
    manager.registerMode(mode, () => ({ modeName: mode }));
  }
  return manager;
}

describe('interaction lock gate of ModeManagerImpl.setMode', () => {
  it('ignores setMode to a drawing mode while the interaction lock is on', () => {
    const store = createTestDocument();
    const manager = createManager(store);

    store.setInteractionLock(true);
    expect(manager.setMode('drawPoint')).toBe(false);

    expect(store.getMode()).toBe('select');
  });

  it('allows the transition to select even while the interaction lock is on', () => {
    const store = createTestDocument();
    const manager = createManager(store);

    // First switch to a drawing mode, then verify that it can return to select after locking.
    manager.setMode('drawPolygon');
    expect(store.getMode()).toBe('drawPolygon');

    store.setInteractionLock(true);
    manager.setMode('select');
    expect(store.getMode()).toBe('select');
  });

  it('can transition to a drawing mode once the interaction lock is released', () => {
    const store = createTestDocument();
    const manager = createManager(store);

    store.setInteractionLock(true);
    manager.setMode('drawLine');
    expect(store.getMode()).toBe('select');

    store.setInteractionLock(false);
    manager.setMode('drawLine');
    expect(store.getMode()).toBe('drawLine');
  });
});

describe('canEnter gate of ModeManagerImpl.setMode', () => {
  it('ignores a mode that canEnter rejects and keeps the current mode', () => {
    const store = createTestDocument();
    const manager = new ModeManagerImpl(store, {
      canEnter: (handler) => !handler.writesFeatures,
    });
    manager.registerMode('drawPoint', () => ({ modeName: 'drawPoint', writesFeatures: true }));
    manager.registerMode('drawLine', () => ({ modeName: 'drawLine' }));

    manager.setMode('drawPoint');
    expect(store.getMode()).toBe('select');

    manager.setMode('drawLine');
    expect(store.getMode()).toBe('drawLine');
  });

  it('never asks canEnter for select', () => {
    const store = createTestDocument();
    const manager = new ModeManagerImpl(store, { canEnter: () => false });
    manager.registerMode('select', () => ({ modeName: 'select' }));
    store.setMode('drawLine');

    manager.setMode('select');
    expect(store.getMode()).toBe('select');
  });
});

describe('unregistered modes in ModeManagerImpl.setMode', () => {
  it('refuses a mode without a factory and leaves the Store and the handler alone', () => {
    const store = createTestDocument();
    const manager = createManager(store);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const changes: unknown[] = [];
    store.subscribe((c) => {
      if (c.mode) changes.push(c.mode);
    });
    manager.start();
    const handler = manager.getHandler();

    expect(manager.setMode('draw_polgon')).toBe(false);

    expect(store.getMode()).toBe('select');
    expect(manager.getHandler()).toBe(handler);
    expect(changes).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('returns the same false for every refusal and true for an entered mode', () => {
    const store = createTestDocument();
    const manager = createManager(store, ['drawPoint', 'drawLine'], {
      canEnter: (handler: EngineModeHandler) => handler.modeName !== 'drawLine',
    });

    expect(manager.setMode('drawLine')).toBe(false);
    store.setInteractionLock(true);
    expect(manager.setMode('drawPoint')).toBe(false);
    store.setInteractionLock(false);
    expect(manager.setMode('drawPoint')).toBe(true);
    expect(manager.setMode('drawPoint')).toBe(true);
    expect(store.getMode()).toBe('drawPoint');
  });
});

describe('removing a mode', () => {
  it('returns to select when the current mode is removed, and refuses it afterwards', () => {
    const store = createTestDocument();
    const manager = new ModeManagerImpl(store);
    manager.registerMode('select', () => ({ modeName: 'select' }));
    const onStop = vi.fn();
    const cancel = manager.registerMode('measure', () => ({ modeName: 'measure', onStop }));
    manager.start();
    manager.setMode('measure');

    cancel();

    expect(store.getMode()).toBe('select');
    expect(onStop).toHaveBeenCalledTimes(1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(manager.setMode('measure')).toBe(false);
  });

  it('does not remove a later registration of the same name', () => {
    const store = createTestDocument();
    const manager = createManager(store);
    const cancel = manager.registerMode('measure', () => ({ modeName: 'first' }));
    manager.registerMode('measure', () => ({ modeName: 'second' }));

    cancel();

    expect(manager.setMode('measure')).toBe(true);
  });
});
