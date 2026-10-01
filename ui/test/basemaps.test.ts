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
import { fakeDraw, feature, layer } from './fake-draw.js';

// The basemap section of the layer panel: one row, under the tree of the stack, which shows the
// name of the basemap the map shows. With two or more basemaps, a press on it opens the basemaps
// to choose from on the right, in the place of the inspector; a basemap chosen replaces the map's
// style whole and becomes the current one.

const EMPTY = { version: 8 as const, sources: {}, layers: [] };
const BASEMAPS: Basemap[] = [
  {
    id: 'light',
    label: 'Light',
    style: 'https://example.com/light.json',
    preview: 'linear-gradient(135deg, #ffffff, #eeeeee)',
  },
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
  root.querySelector<HTMLElement>(
    '[role="treeitem"][data-role="basemap"] > [data-role="list-item"]',
  );
/** The texts of the row */
const texts = (root: ParentNode) =>
  [...(basemapRow(root)?.querySelectorAll('.kata-text') ?? [])].map((t) => t.textContent?.trim());
/** The basemaps to choose from */
const chooser = (root: ParentNode) =>
  root.querySelector<HTMLElement>('[data-role="basemap-panel"]');
/** The rows of the basemaps to choose from */
const choices = (root: ParentNode) => [
  ...(chooser(root)?.querySelectorAll<HTMLElement>('[data-role="list-item"]') ?? []),
];

/** Presses the row, and returns the basemaps to choose from */
function open(root: ParentNode): HTMLElement[] {
  basemapRow(root)?.click();
  flushSync();
  return choices(root);
}

/** The ID of the basemap marked current among the basemaps to choose from */
function marked(root: ParentNode): string | null {
  const current = choices(root).filter((item) => item.getAttribute('aria-current') === 'true');
  expect(current.length).toBeLessThanOrEqual(1);
  return current[0]?.getAttribute('data-id') ?? null;
}

/** A drawing with one feature, to select */
function drawing(options: Parameters<typeof fakeDraw>[0] = {}) {
  return fakeDraw({
    ...options,
    doc: { layers: [layer('l1', ['a'])], features: [feature('a', 'l1')] },
  });
}

describe('the basemap section', () => {
  it('is the last section of the layer panel, one row apart from the tree of the stack', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS });
    const layerPanel = ui.element.querySelector('[data-role="layer-panel"]');
    const heads = [...(layerPanel?.querySelectorAll('[data-role="section-head"]') ?? [])];
    expect(heads.map((h) => h.querySelector('.label')?.textContent)).toEqual(['Stack', 'Basemap']);
    // Its own tree of one row: not dragged, hidden, locked or expanded
    const row = basemapRow(ui.element);
    expect(row?.closest('[role="tree"]')?.getAttribute('aria-label')).toBe('Basemap');
    expect(row?.closest('[data-sortable-item]')).toBeNull();
    expect(row?.querySelector('[data-grip]')).toBeNull();
    expect(row?.querySelectorAll('button')).toHaveLength(0);
    expect(row?.querySelector('[data-role="markbox"] .lucide-globe')).not.toBeNull();
    // The name alone
    expect(texts(ui.element)).toEqual(['Basemap']);
  });

  it('always shows, and opens nothing with fewer than two basemaps', () => {
    const fake = drawing();
    ui = createDrawUI(fake.asDraw);
    expect(basemapRow(ui.element)?.getAttribute('role')).toBeNull();
    expect(basemapRow(ui.element)?.getAttribute('tabindex')).toBeNull();
    basemapRow(ui.element)?.click();
    flushSync();
    expect(chooser(ui.element)).toBeNull();
    ui.destroy();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS.slice(0, 1), basemap: 'light' });
    expect(texts(ui.element)).toEqual(['Light']);
    expect(basemapRow(ui.element)?.getAttribute('role')).toBeNull();
    ui.destroy();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS });
    expect(basemapRow(ui.element)?.getAttribute('role')).toBe('button');
    expect(basemapRow(ui.element)?.querySelector('.lucide-chevron-down')).toBeNull();
  });

  it('shows the name of the current basemap, and the words of the locale', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS, basemap: 'dark' });
    expect(texts(ui.element)).toEqual(['Dark']);
    ui.setLocale('ja');
    flushSync();
    const heads = [...ui.element.querySelectorAll('[data-role="section-head"] .label')];
    expect(heads.map((h) => h.textContent)).toEqual(['スタック', '背景地図']);
    expect(texts(ui.element)).toEqual(['Dark']);
  });

  it('names a basemap that is none of the list by the name of the map style, else by its word', () => {
    const fake = fakeDraw({ styleName: 'Streets' });
    ui = createDrawUI(fake.asDraw);
    expect(texts(ui.element)).toEqual(['Streets']);
    // A new style, loaded by the application
    fake.loadStyle('Satellite');
    flushSync();
    expect(texts(ui.element)).toEqual(['Satellite']);
    fake.loadStyle('  ');
    flushSync();
    expect(texts(ui.element)).toEqual(['Basemap']);
    ui.destroy();
    // A basemap of the list comes first; the style's name only when none is current
    ui = createDrawUI(fakeDraw({ styleName: 'Streets' }).asDraw, { basemaps: BASEMAPS });
    expect(texts(ui.element)).toEqual(['Streets']);
    ui.setBasemap('blank');
    flushSync();
    expect(texts(ui.element)).toEqual(['Blank']);
  });
});

describe('the basemaps to choose from', () => {
  it('open on the right, in the place of the inspector, and clear the selection', () => {
    const fake = drawing();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS, basemap: 'dark' });
    fake.select(['a']);
    flushSync();
    expect(
      ui.element.querySelector('[data-region="right"] [data-role="inspector"]'),
    ).not.toBeNull();
    const items = open(ui.element);
    expect(fake.draw.selection.get().ids).toEqual([]);
    const right = ui.element.querySelector('[data-region="right"]');
    expect(chooser(ui.element)?.closest('[data-region="right"]')).toBe(right);
    expect(right?.querySelector('[data-role="inspector"]')).toBeNull();
    // The head: the title and the close button
    expect(chooser(ui.element)?.querySelector('[data-role="toolbar"]')?.textContent).toContain(
      'Basemap',
    );
    // The row shows as chosen while they are open
    expect(basemapRow(ui.element)?.classList.contains('sel')).toBe(true);
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Light', 'Dark', 'Blank']);
  });

  it('list the basemaps with their previews and the current one checked', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS, basemap: 'dark' });
    const items = open(ui.element);
    expect(marked(ui.element)).toBe('dark');
    expect(items.map((item) => item.classList.contains('sel'))).toEqual([false, true, false]);
    expect(items[1]?.querySelector('.lucide-check')).not.toBeNull();
    expect(items[0]?.querySelector('.lucide-check')).toBeNull();
    const previews = items.map((item) => item.querySelector<HTMLElement>('.preview'));
    expect(previews[0]?.style.getPropertyValue('--preview')).toBe(
      'linear-gradient(135deg, #ffffff, #eeeeee)',
    );
    // Without a preview, a neutral square
    expect(previews[1]?.style.getPropertyValue('--preview')).toBe('');
  });

  it('switch the basemap and stay open, and report it', () => {
    const fake = fakeDraw();
    const onbasemap = vi.fn();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS, basemap: 'light', onbasemap });
    open(ui.element)[2]?.click();
    flushSync();
    expect(fake.map.setStyle).toHaveBeenCalledTimes(1);
    expect(fake.map.setStyle).toHaveBeenCalledWith(EMPTY, { diff: false });
    expect(onbasemap).toHaveBeenCalledWith(BASEMAPS[2]);
    expect(ui.getBasemap()).toEqual(BASEMAPS[2]);
    expect(texts(ui.element)).toEqual(['Blank']);
    expect(chooser(ui.element)).not.toBeNull();
    expect(marked(ui.element)).toBe('blank');
    // The current one again does nothing
    choices(ui.element)[2]?.click();
    flushSync();
    expect(fake.map.setStyle).toHaveBeenCalledTimes(1);
    expect(onbasemap).toHaveBeenCalledTimes(1);
  });

  it('close with the close button and with Escape, and the inspector comes back', () => {
    const fake = drawing();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS });
    open(ui.element);
    chooser(ui.element)?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    flushSync();
    expect(chooser(ui.element)).toBeNull();
    expect(basemapRow(ui.element)?.classList.contains('sel')).toBe(false);
    open(ui.element);
    choices(ui.element)[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    flushSync();
    expect(chooser(ui.element)).toBeNull();
    open(ui.element);
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    flushSync();
    expect(chooser(ui.element)).toBeNull();
    fake.select(['a']);
    flushSync();
    expect(
      ui.element.querySelector('[data-region="right"] [data-role="inspector"]'),
    ).not.toBeNull();
  });

  it('close when a feature is selected on the map or in the tree', () => {
    const fake = drawing();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS });
    open(ui.element);
    fake.select(['a']);
    flushSync();
    expect(chooser(ui.element)).toBeNull();
    expect(
      ui.element.querySelector('[data-region="right"] [data-role="inspector"]'),
    ).not.toBeNull();
    open(ui.element);
    ui.element
      .querySelector<HTMLElement>('[role="treeitem"][data-node="a"] > [data-role="list-item"]')
      ?.click();
    flushSync();
    expect(chooser(ui.element)).toBeNull();
    expect(fake.draw.selection.get().ids).toEqual(['a']);
  });

  it('open without the inspector too', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { basemaps: BASEMAPS, inspector: false });
    expect(open(ui.element)).toHaveLength(3);
  });
});

describe('the current basemap', () => {
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
    expect(texts(ui.element)).toEqual(['Dark']);
    open(ui.element);
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
    open(ui.element);
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
    open(ui.element);
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
    refuse(
      { basemaps: [{ id: 'x', label: 'X', style: EMPTY, preview: 3 } as unknown as Basemap] },
      /preview of the basemap "x"/,
    );
    expect(fake.mapListening('style.load')).toBe(0);
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

  it('opens the basemaps in the place of the sections, and changes the style', () => {
    const fake = fakeDraw();
    const onbasemap = vi.fn();
    const el = target();
    panel = createLayerPanel(fake.asDraw, { target: el, basemaps: BASEMAPS, onbasemap });
    expect(texts(el)).toEqual(['Basemap']);
    const items = open(el);
    expect(chooser(el)?.closest('[data-role="layer-panel"]')).not.toBeNull();
    expect(el.querySelector('[data-role="section-head"]')).toBeNull();
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Light', 'Dark', 'Blank']);
    items[1]?.click();
    flushSync();
    expect(fake.map.setStyle).toHaveBeenCalledWith('https://example.com/dark.json', {
      diff: false,
    });
    expect(onbasemap).toHaveBeenCalledWith(BASEMAPS[1]);
    expect(marked(el)).toBe('dark');
    // Closed, the sections come back
    chooser(el)?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    flushSync();
    expect(chooser(el)).toBeNull();
    expect(texts(el)).toEqual(['Dark']);
    panel.destroy();
    expect(fake.mapListening('style.load')).toBe(0);
  });

  it('shows the name of the map style without basemaps, as a row that opens nothing', () => {
    const fake = fakeDraw({ styleName: 'Streets' });
    const el = target();
    panel = createLayerPanel(fake.asDraw, { target: el });
    expect(texts(el)).toEqual(['Streets']);
    expect(basemapRow(el)?.getAttribute('role')).toBeNull();
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
