// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDrawUI,
  createInspector,
  createLayerPanel,
  createLegend,
  createToolbar,
  type DrawUI,
  type Theme,
} from '../src/index.js';
import { LIGHT_QUERY } from '../src/theme.js';
import { fakeDocument, fakeDraw } from './fake-draw.js';

// The theme of the root element: light sets data-color-mode="light", dark removes it, and auto
// follows the system's preference (a mocked matchMedia: jsdom has none).

/** A stand-in of the system's preference, which the tests change */
function mockSystem(light: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const list = {
    matches: light,
    media: LIGHT_QUERY,
    addEventListener: vi.fn((_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn)),
    removeEventListener: vi.fn((_: string, fn: (e: MediaQueryListEvent) => void) =>
      listeners.delete(fn),
    ),
  };
  const matchMedia = vi.fn((query: string) => {
    expect(query).toBe(LIGHT_QUERY);
    return list as unknown as MediaQueryList;
  });
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    matchMedia,
    listeners,
    change(next: boolean) {
      list.matches = next;
      for (const fn of [...listeners]) fn({ matches: next } as MediaQueryListEvent);
    },
  };
}

let ui: DrawUI | undefined;
beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  ui?.destroy();
  ui = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const mode = (el: HTMLElement) => el.getAttribute('data-color-mode');

describe('the theme', () => {
  it('is light or dark as the option says', () => {
    const system = mockSystem(true);
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { theme: 'light' });
    expect(mode(ui.element)).toBe('light');
    ui.destroy();
    ui = createDrawUI(fake.asDraw, { theme: 'dark' });
    expect(ui.element.hasAttribute('data-color-mode')).toBe(false);
    // Neither follows the system
    system.change(true);
    expect(ui.element.hasAttribute('data-color-mode')).toBe(false);
  });

  it('follows the system with auto, the default, and its changes at once', () => {
    const system = mockSystem(false);
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    expect(system.matchMedia).toHaveBeenCalled();
    expect(ui.element.hasAttribute('data-color-mode')).toBe(false);
    system.change(true);
    expect(mode(ui.element)).toBe('light');
    system.change(false);
    expect(ui.element.hasAttribute('data-color-mode')).toBe(false);
  });

  it('changes with setTheme, and stops following the system when set', () => {
    const system = mockSystem(true);
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { theme: 'auto' });
    expect(mode(ui.element)).toBe('light');
    ui.setTheme('dark');
    expect(ui.element.hasAttribute('data-color-mode')).toBe(false);
    expect(system.listeners.size).toBe(0);
    system.change(true);
    expect(ui.element.hasAttribute('data-color-mode')).toBe(false);
    ui.setTheme('light');
    expect(mode(ui.element)).toBe('light');
    ui.setTheme('auto');
    system.change(false);
    expect(ui.element.hasAttribute('data-color-mode')).toBe(false);
    expect(() => ui?.setTheme('sepia' as Theme)).toThrow(/theme/);
  });

  it('stops following the system when destroyed', () => {
    const system = mockSystem(false);
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    expect(system.listeners.size).toBe(1);
    ui.destroy();
    ui = undefined;
    expect(system.listeners.size).toBe(0);
  });

  it('is dark with auto where there is no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    expect(ui.element.hasAttribute('data-color-mode')).toBe(false);
  });

  it('refuses a theme it does not know, before it puts anything on the page', () => {
    const fake = fakeDraw();
    expect(() => createDrawUI(fake.asDraw, { theme: 'sepia' as Theme })).toThrow(/theme/);
    expect(fake.container.querySelector('.mgd-ui')).toBeNull();
  });

  it('is an option of each part put alone', () => {
    const system = mockSystem(false);
    const fake = fakeDraw();
    const doc = fakeDocument();
    const target = () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      return el;
    };
    const roots = (handles: { destroy(): void }[]) => {
      const out = [...document.querySelectorAll<HTMLElement>('.mgd-ui')];
      const done = () => {
        for (const h of handles) h.destroy();
      };
      return { out, done };
    };
    const light = [
      createToolbar(fake.asDraw, { target: fake.container, theme: 'light' }),
      createLayerPanel(fake.asDraw, { target: target(), theme: 'light' }),
      createLegend(fake.asDraw, { target: target(), theme: 'light' }),
      createInspector(doc.asDraw, { target: target(), theme: 'light' }),
    ];
    const lit = roots(light);
    expect(lit.out).toHaveLength(4);
    for (const root of lit.out) expect(mode(root)).toBe('light');
    lit.done();
    const auto = [
      createToolbar(fake.asDraw, { target: fake.container }),
      createLayerPanel(fake.asDraw, { target: target() }),
      createLegend(fake.asDraw, { target: target() }),
      createInspector(doc.asDraw, { target: target(), theme: 'auto' }),
    ];
    const followed = roots(auto);
    for (const root of followed.out) expect(root.hasAttribute('data-color-mode')).toBe(false);
    system.change(true);
    for (const root of followed.out) expect(mode(root)).toBe('light');
    followed.done();
    expect(system.listeners.size).toBe(0);
  });
});
