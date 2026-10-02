// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { flushSync } from 'svelte';
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
import { fakeDocument, fakeDraw, feature, layer } from './fake-draw.js';

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

describe("the theme of maplibre-gl's controls", () => {
  /** maplibre-gl's control container in the map's container, as maplibre-gl draws it */
  function controlContainer(container: HTMLElement) {
    const el = document.createElement('div');
    el.className = 'maplibregl-control-container';
    container.prepend(el);
    return el;
  }

  it('follows the theme of the interface, and is given back on destroy', () => {
    const system = mockSystem(false);
    const fake = fakeDraw();
    const controls = controlContainer(fake.container);
    ui = createDrawUI(fake.asDraw, { theme: 'light' });
    // The control container takes kata's tokens and the look of the root
    expect(controls.hasAttribute('data-mgd-ui-controls')).toBe(true);
    expect(mode(controls)).toBe('light');
    ui.setTheme('dark');
    expect(controls.hasAttribute('data-color-mode')).toBe(false);
    ui.setTheme('auto');
    system.change(true);
    expect(mode(controls)).toBe('light');
    system.change(false);
    expect(controls.hasAttribute('data-color-mode')).toBe(false);
    system.change(true);
    ui.destroy();
    ui = undefined;
    expect(controls.hasAttribute('data-mgd-ui-controls')).toBe(false);
    expect(controls.hasAttribute('data-color-mode')).toBe(false);
  });
});

describe('the theme button', () => {
  const button = (root: HTMLElement) =>
    root.querySelector<HTMLButtonElement>('[data-role="theme"] button');

  it('shows by default at the top right, and not with themeToggle: false', () => {
    mockSystem(false);
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    const place = ui.element.querySelector<HTMLElement>(
      '[data-role="theme"] [data-role="floating"]',
    );
    expect(place?.style.right).toBe('var(--kata-gap-md)');
    expect(place?.style.top).toBe('var(--kata-gap-md)');
    expect(button(ui.element)).not.toBeNull();
    ui.destroy();
    ui = createDrawUI(fake.asDraw, { themeToggle: false });
    expect(ui.element.querySelector('[data-role="theme"]')).toBeNull();
  });

  it('switches to the look that is not shown, with its icon and its name', () => {
    mockSystem(false);
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { theme: 'dark' });
    const root = ui.element;
    // Dark: a sun, to switch to the light
    expect(button(root)?.getAttribute('aria-label')).toBe('Switch to light');
    expect(button(root)?.querySelector('.lucide-sun')).not.toBeNull();
    button(root)?.click();
    flushSync();
    expect(mode(root)).toBe('light');
    expect(button(root)?.getAttribute('aria-label')).toBe('Switch to dark');
    expect(button(root)?.querySelector('.lucide-moon')).not.toBeNull();
    button(root)?.click();
    flushSync();
    expect(root.hasAttribute('data-color-mode')).toBe(false);
    expect(button(root)?.getAttribute('aria-label')).toBe('Switch to light');
  });

  it('pins the look the system does not prefer from auto, until setTheme("auto")', () => {
    const system = mockSystem(true);
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { locale: 'ja' });
    const root = ui.element;
    expect(mode(root)).toBe('light');
    expect(button(root)?.getAttribute('aria-label')).toBe('ダークに切り替える');
    button(root)?.click();
    flushSync();
    expect(root.hasAttribute('data-color-mode')).toBe(false);
    // Pinned: the system no longer moves it
    system.change(true);
    expect(root.hasAttribute('data-color-mode')).toBe(false);
    ui.setTheme('auto');
    flushSync();
    expect(mode(root)).toBe('light');
    system.change(false);
    flushSync();
    expect(root.hasAttribute('data-color-mode')).toBe(false);
    // The button follows the system's changes too
    expect(button(root)?.getAttribute('aria-label')).toBe('ライトに切り替える');
  });

  it('moves to the left of the inspector while it is open over the map', () => {
    mockSystem(false);
    const fake = fakeDraw({
      ids: ['a'],
      doc: { layers: [layer('l1', ['a'])], features: [feature('a', 'l1')] },
    });
    ui = createDrawUI(fake.asDraw);
    flushSync();
    const place = () =>
      ui?.element.querySelector<HTMLElement>('[data-role="theme"] [data-role="floating"]');
    expect(place()?.style.right).toBe('calc(var(--kata-width-panel) + var(--kata-gap-md) * 2)');
    fake.select([]);
    flushSync();
    expect(place()?.style.right).toBe('var(--kata-gap-md)');
  });
});
