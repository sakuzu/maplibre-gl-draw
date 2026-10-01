// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Basemap,
  createDrawUI,
  createLayerPanel,
  type DrawUI,
  type LayerPanelHandle,
} from '../src/index.js';
import { fakeDraw } from './fake-draw.js';

// The basemap row of the layer panel: the last row, under the tree, which shows the name of the
// basemap the map shows. With two or more basemaps it opens their menu, and a basemap chosen
// replaces the map's style whole and becomes the current one.

const EMPTY = { version: 8 as const, sources: {}, layers: [] };
const BASEMAPS: Basemap[] = [
  { id: 'light', label: 'Light', style: 'https://example.com/light.json' },
  { id: 'dark', label: 'Dark', style: 'https://example.com/dark.json' },
  { id: 'blank', label: 'Blank', style: EMPTY },
];

let ui: DrawUI | undefined;
let panel: LayerPanelHandle | undefined;
afterEach(() => {
  ui?.destroy();
  ui = undefined;
  panel?.destroy();
  panel = undefined;
  document.body.innerHTML = '';
});

/** The row of the basemap */
const basemapRow = (root: ParentNode) =>
  root.querySelector<HTMLElement>('[data-role="basemap"] [data-role="list-item"]');
/** The row, when it opens the menu */
const trigger = (root: ParentNode) =>
  root.querySelector<HTMLElement>('[data-role="basemap"] [aria-haspopup="menu"]');
/** The texts of the row: the label and the name of the basemap */
const texts = (root: ParentNode) =>
  [...(basemapRow(root)?.querySelectorAll('.kata-text') ?? [])].map((t) => t.textContent?.trim());

/** Opens the menu and returns its items */
function open(root: ParentNode): HTMLButtonElement[] {
  trigger(root)?.click();
  flushSync();
  return [...root.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
}

/** The ID of the item marked current in the menu */
function marked(root: ParentNode): string | null {
  const items = open(root);
  const current = items.filter((item) => item.getAttribute('aria-current') === 'true');
  // Closes it again
  trigger(root)?.click();
  flushSync();
  expect(current.length).toBeLessThanOrEqual(1);
  return current[0]?.getAttribute('data-id') ?? null;
}

describe('the basemap row', () => {
  it('is the last row of the layer panel, under the tree and apart from it', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS });
    const layerPanel = ui.element.querySelector('[data-role="layer-panel"]');
    const children = [...(layerPanel?.children ?? [])];
    expect(children.map((c) => c.getAttribute('data-role') ?? c.className)).toEqual([
      expect.stringContaining('layer-tree'),
      'rule',
      'basemap',
    ]);
    // Not a node of the tree: no tree item, no grip, no eye and no lock
    const row = basemapRow(ui.element);
    expect(row?.closest('[role="tree"]')).toBeNull();
    expect(row?.closest('[data-sortable-item]')).toBeNull();
    expect(row?.querySelector('[data-grip]')).toBeNull();
    expect(row?.querySelectorAll('button')).toHaveLength(0);
    // The place of the chevron, then the mark, as a row of the tree at the root
    expect(row?.firstElementChild?.classList.contains('seat')).toBe(true);
    expect(row?.querySelector('[data-role="markbox"] .lucide-map')).not.toBeNull();
  });

  it('shows without basemaps, and is a plain row that opens nothing with fewer than two', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    expect(basemapRow(ui.element)).not.toBeNull();
    expect(basemapRow(ui.element)?.getAttribute('role')).toBeNull();
    expect(basemapRow(ui.element)?.getAttribute('tabindex')).toBeNull();
    expect(trigger(ui.element)).toBeNull();
    expect(basemapRow(ui.element)?.querySelector('.lucide-chevron-down')).toBeNull();
    ui.destroy();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS.slice(0, 1), basemap: 'light' });
    expect(trigger(ui.element)).toBeNull();
    expect(texts(ui.element)).toEqual(['Basemap', 'Light']);
    ui.destroy();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS });
    expect(trigger(ui.element)).toBe(basemapRow(ui.element));
    expect(trigger(ui.element)?.getAttribute('role')).toBe('button');
    expect(trigger(ui.element)?.querySelector('.lucide-chevron-down')).not.toBeNull();
  });

  it('is labelled by the words of the locale and shows the name of the current basemap', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS, basemap: 'dark' });
    expect(texts(ui.element)).toEqual(['Basemap', 'Dark']);
    ui.setLocale('ja');
    flushSync();
    expect(texts(ui.element)).toEqual(['背景地図', 'Dark']);
  });

  it('names a basemap that is none of the list by the name of the map style, or not at all', () => {
    const fake = fakeDraw({ styleName: 'Streets' });
    ui = createDrawUI(fake.asDraw);
    expect(texts(ui.element)).toEqual(['Basemap', 'Streets']);
    // A new style, loaded by the application
    fake.loadStyle('Satellite');
    flushSync();
    expect(texts(ui.element)).toEqual(['Basemap', 'Satellite']);
    fake.loadStyle('  ');
    flushSync();
    expect(texts(ui.element)).toEqual(['Basemap']);
    ui.destroy();
    // A basemap of the list comes first; the style's name only when none is current
    ui = createDrawUI(fakeDraw({ styleName: 'Streets' }).asDraw, { basemaps: BASEMAPS });
    expect(texts(ui.element)).toEqual(['Basemap', 'Streets']);
    ui.setBasemap('blank');
    flushSync();
    expect(texts(ui.element)).toEqual(['Basemap', 'Blank']);
  });

  it('lists the labels in order, with the current one marked', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS, basemap: 'dark' });
    const items = open(ui.element);
    expect(trigger(ui.element)?.getAttribute('aria-expanded')).toBe('true');
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Light', 'Dark', 'Blank']);
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([null, 'true', null]);
    expect(items[1]?.querySelector('.lucide-check')).not.toBeNull();
    expect(items[0]?.querySelector('.lucide-check')).toBeNull();
  });

  it('replaces the style whole with the one chosen, shows it and reports it', () => {
    const fake = fakeDraw();
    const onbasemap = vi.fn();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS, basemap: 'light', onbasemap });
    const selection = fake.draw.selection.get();
    open(ui.element)[2]?.click();
    flushSync();
    expect(fake.map.setStyle).toHaveBeenCalledTimes(1);
    expect(fake.map.setStyle).toHaveBeenCalledWith(EMPTY, { diff: false });
    expect(onbasemap).toHaveBeenCalledWith(BASEMAPS[2]);
    expect(ui.getBasemap()).toEqual(BASEMAPS[2]);
    expect(texts(ui.element)).toEqual(['Basemap', 'Blank']);
    // The menu closed, and nothing of the tree was selected
    expect(ui.element.querySelector('[role="menu"]')).toBeNull();
    expect(fake.draw.selection.get()).toEqual(selection);
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
    expect(texts(ui.element)).toEqual(['Basemap', 'Dark']);
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
    expect(fake.mapListening('style.load')).toBe(0);
  });

  it('is gone with the floating button of the top right', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS });
    expect(ui.element.querySelector(':scope > [data-role="basemap"]')).toBeNull();
    expect(ui.element.querySelectorAll('[data-role="basemap"]')).toHaveLength(1);
    expect(
      ui.element.querySelector('[data-role="basemap"]')?.closest('[data-role="layer-panel"]'),
    ).not.toBeNull();
  });

  it('stops following the map style when the interface is removed', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS });
    expect(fake.mapListening('style.load')).toBe(1);
    ui.destroy();
    expect(fake.mapListening('style.load')).toBe(0);
  });
});

describe('the basemap row of createLayerPanel', () => {
  function target() {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  }

  it('opens the menu of its basemaps and changes the style', () => {
    const fake = fakeDraw();
    const onbasemap = vi.fn();
    const el = target();
    panel = createLayerPanel(fake.asDraw, { target: el, basemaps: BASEMAPS, onbasemap });
    expect(texts(el)).toEqual(['Basemap']);
    const items = open(el);
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Light', 'Dark', 'Blank']);
    items[1]?.click();
    flushSync();
    expect(fake.map.setStyle).toHaveBeenCalledWith('https://example.com/dark.json', {
      diff: false,
    });
    expect(onbasemap).toHaveBeenCalledWith(BASEMAPS[1]);
    expect(texts(el)).toEqual(['Basemap', 'Dark']);
    panel.destroy();
    expect(fake.mapListening('style.load')).toBe(0);
  });

  it('shows the name of the map style without basemaps, as a plain row', () => {
    const fake = fakeDraw({ styleName: 'Streets' });
    const el = target();
    panel = createLayerPanel(fake.asDraw, { target: el });
    expect(texts(el)).toEqual(['Basemap', 'Streets']);
    expect(trigger(el)).toBeNull();
  });

  it('refuses basemaps that are not valid', () => {
    const fake = fakeDraw();
    const el = target();
    expect(() =>
      createLayerPanel(fake.asDraw, { target: el, basemaps: BASEMAPS, basemap: 'satellite' }),
    ).toThrow(/no basemap "satellite"/);
    expect(el.querySelector('.mgd-ui')).toBeNull();
  });
});
