// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Basemap, createDrawUI, type DrawUI } from '../src/index.js';
import { fakeDraw, feature, layer } from './fake-draw.js';

// The basemap menu of createDrawUI: it shows with two or more basemaps, beside the theme button,
// and a basemap chosen replaces the map's style whole and becomes the current one.

const EMPTY = { version: 8 as const, sources: {}, layers: [] };
const BASEMAPS: Basemap[] = [
  { id: 'light', label: 'Light', style: 'https://example.com/light.json' },
  { id: 'dark', label: 'Dark', style: 'https://example.com/dark.json' },
  { id: 'blank', label: 'Blank', style: EMPTY },
];

let ui: DrawUI | undefined;
afterEach(() => {
  ui?.destroy();
  ui = undefined;
  document.body.innerHTML = '';
});

const trigger = (root: HTMLElement) =>
  root.querySelector<HTMLButtonElement>('[data-role="basemap"] button[aria-haspopup="menu"]');
const place = (root: HTMLElement, role: string) =>
  root.querySelector<HTMLElement>(`[data-role="${role}"] [data-role="floating"]`);

/** Opens the menu and returns its items */
function open(root: HTMLElement): HTMLButtonElement[] {
  trigger(root)?.click();
  flushSync();
  return [...root.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
}

/** The ID of the item marked current in the menu */
function marked(root: HTMLElement): string | null {
  const items = open(root);
  const current = items.filter((item) => item.getAttribute('aria-current') === 'true');
  // Closes it again
  trigger(root)?.click();
  flushSync();
  expect(current.length).toBeLessThanOrEqual(1);
  return current[0]?.getAttribute('data-id') ?? null;
}

describe('the basemap menu', () => {
  it('shows only with two or more basemaps', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    expect(ui.element.querySelector('[data-role="basemap"]')).toBeNull();
    ui.destroy();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS.slice(0, 1) });
    expect(ui.element.querySelector('[data-role="basemap"]')).toBeNull();
    ui.destroy();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS });
    expect(trigger(ui.element)).not.toBeNull();
  });

  it('is named by the words of the locale and shows the map icon', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS });
    const button = trigger(ui.element);
    expect(button?.getAttribute('aria-label')).toBe('Basemap');
    expect(button?.querySelector('.lucide-map')).not.toBeNull();
    ui.setLocale('ja');
    flushSync();
    expect(trigger(ui.element)?.getAttribute('aria-label')).toBe('背景地図');
  });

  it('lists the labels in order, with the current one marked', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS, basemap: 'dark' });
    const items = open(ui.element);
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Light', 'Dark', 'Blank']);
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([null, 'true', null]);
    expect(items[1]?.querySelector('.lucide-check')).not.toBeNull();
    expect(items[0]?.querySelector('.lucide-check')).toBeNull();
  });

  it('replaces the style whole with the one chosen, marks it current and reports it', () => {
    const fake = fakeDraw();
    const onbasemap = vi.fn();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS, basemap: 'light', onbasemap });
    open(ui.element)[2]?.click();
    flushSync();
    expect(fake.map.setStyle).toHaveBeenCalledTimes(1);
    expect(fake.map.setStyle).toHaveBeenCalledWith(EMPTY, { diff: false });
    expect(onbasemap).toHaveBeenCalledWith(BASEMAPS[2]);
    expect(ui.getBasemap()).toEqual(BASEMAPS[2]);
    // The menu closed
    expect(ui.element.querySelector('[role="menu"]')).toBeNull();
    expect(marked(ui.element)).toBe('blank');
    // The current one again does nothing
    open(ui.element)[2]?.click();
    flushSync();
    expect(fake.map.setStyle).toHaveBeenCalledTimes(1);
    expect(onbasemap).toHaveBeenCalledTimes(1);
  });

  it('changes with setBasemap, which getBasemap reads', () => {
    const fake = fakeDraw();
    const onbasemap = vi.fn();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS, onbasemap });
    expect(ui.getBasemap()).toBeNull();
    ui.setBasemap('dark');
    flushSync();
    expect(fake.map.setStyle).toHaveBeenCalledWith('https://example.com/dark.json', {
      diff: false,
    });
    expect(onbasemap).toHaveBeenCalledWith(BASEMAPS[1]);
    expect(ui.getBasemap()).toEqual(BASEMAPS[1]);
    expect(marked(ui.element)).toBe('dark');
    ui.setBasemap('dark');
    expect(fake.map.setStyle).toHaveBeenCalledTimes(1);
    expect(() => ui?.setBasemap('satellite')).toThrow(/no basemap "satellite"/);
    expect(ui.getBasemap()?.id).toBe('dark');
  });

  it('starts on the basemap whose style is the URL of the map, or on none', () => {
    const fake = fakeDraw({ styleUrl: 'https://example.com/dark.json' });
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS });
    expect(ui.getBasemap()?.id).toBe('dark');
    expect(marked(ui.element)).toBe('dark');
    ui.destroy();
    // The option comes first
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS, basemap: 'blank' });
    expect(ui.getBasemap()?.id).toBe('blank');
    ui.destroy();
    ui = createDrawUI(fakeDraw({ styleUrl: 'https://example.com/other.json' }).asDraw, {
      basemaps: BASEMAPS,
    });
    expect(ui.getBasemap()).toBeNull();
    expect(marked(ui.element)).toBeNull();
    expect(fake.map.setStyle).not.toHaveBeenCalled();
  });

  it('refuses basemaps that are not valid, before it puts anything on the page', () => {
    const fake = fakeDraw();
    const refuse = (options: Parameters<typeof createDrawUI>[1], message: RegExp) => {
      expect(() => createDrawUI(fake.asDraw, options)).toThrow(message);
      expect(fake.container.querySelector('.mgd-ui')).toBeNull();
    };
    refuse({ basemaps: BASEMAPS, basemap: 'satellite' }, /no basemap "satellite"/);
    refuse({ basemaps: [...BASEMAPS, { ...BASEMAPS[0] } as Basemap] }, /two basemaps/);
    refuse({ basemaps: [{ id: '', label: 'None', style: EMPTY }] }, /needs an ID/);
    refuse({ basemaps: [{ id: 'x', label: 'X' } as Basemap] }, /needs a style/);
  });

  it('stands to the left of the theme button and moves with it beside the inspector', () => {
    const fake = fakeDraw({
      ids: ['a'],
      doc: { layers: [layer('l1', ['a'])], features: [feature('a', 'l1')] },
    });
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS });
    flushSync();
    const root = ui.element;
    const beside = 'var(--kata-width-panel) + var(--kata-gap-md) * 2';
    const step =
      'var(--kata-height-icon-button) + var(--kata-border-width) * 2 + var(--kata-gap-sm)';
    expect(place(root, 'theme')?.style.right).toBe(`calc(${beside})`);
    expect(place(root, 'basemap')?.style.right).toBe(`calc(${beside} + ${step})`);
    expect(place(root, 'basemap')?.style.top).toBe('var(--kata-gap-md)');
    fake.select([]);
    flushSync();
    expect(place(root, 'theme')?.style.right).toBe('var(--kata-gap-md)');
    expect(place(root, 'basemap')?.style.right).toBe(`calc(var(--kata-gap-md) + ${step})`);
  });

  it('takes the place of the theme button without it', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS, themeToggle: false });
    expect(place(ui.element, 'basemap')?.style.right).toBe('calc(var(--kata-gap-md))');
  });
});
