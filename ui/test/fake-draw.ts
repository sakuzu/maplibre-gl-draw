// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for a draw instance with only the members the interface uses, and the map's
// container and canvas.

import type { Draw, Mode } from '@sakuzu/maplibre-gl-draw';
import { vi } from 'vitest';

type Listener = (payload: unknown) => void;

export function fakeDraw(options: { mode?: Mode; ids?: string[]; snapping?: boolean } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  let mode: Mode = options.mode ?? 'select';
  let ids: string[] = options.ids ?? [];
  let snapping = options.snapping ?? true;
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  container.appendChild(canvas);
  document.body.appendChild(container);

  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  const off = (event: string, listener: Listener) => {
    listeners.get(event)?.delete(listener);
  };
  const select = (next: string[]) => {
    const previous = { type: ids.length ? 'feature' : null, ids };
    ids = next;
    emit('selection.changed', {
      selection: { type: ids.length ? 'feature' : null, ids },
      previous,
    });
  };

  const draw = {
    getMode: () => mode,
    setMode: vi.fn((next: Mode) => {
      const previous = mode;
      mode = next;
      emit('mode.changed', { mode: next, previous });
      return true;
    }),
    on: vi.fn((event: string, listener: Listener) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return () => off(event, listener);
    }),
    off: vi.fn(off),
    selection: {
      get: () => ({ type: ids.length ? 'feature' : null, ids }),
      delete: vi.fn(() => {
        if (ids.length === 0) return false;
        select([]);
        return true;
      }),
      clear: vi.fn(() => select([])),
    },
    options: {
      get: () => ({ snapping: { enabled: snapping } }),
      update: vi.fn((patch: { snapping?: { enabled?: boolean } }) => {
        if (patch.snapping?.enabled !== undefined) snapping = patch.snapping.enabled;
      }),
    },
    getMap: () => ({ getContainer: () => container, getCanvas: () => canvas }),
  };

  return {
    draw,
    /** The stand-in as the API types it */
    asDraw: draw as unknown as Draw,
    container,
    canvas,
    /** Changes the selection from outside the interface, as a click on the map would */
    select,
    /** Changes the mode from outside the interface */
    setModeFromOutside(next: Mode) {
      const previous = mode;
      mode = next;
      emit('mode.changed', { mode: next, previous });
    },
    /** How many listeners are attached now */
    listenerCount() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}
