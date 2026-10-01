// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { flushSync } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { createDrawUI, type DrawUI } from '../src/index.js';
import { fakeDraw } from './fake-draw.js';

const SVG = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/></svg>';

let ui: DrawUI | undefined;
afterEach(() => {
  ui?.destroy();
  ui = undefined;
  document.body.innerHTML = '';
});

const labels = (root: HTMLElement) =>
  [...root.querySelectorAll('[data-role="drawbar"] button')].map((b) =>
    b.getAttribute('aria-label'),
  );

function key(target: EventTarget, k: string) {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  flushSync();
  return event;
}

describe('createDrawUI', () => {
  it('lays its root element over the map container', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    expect(ui.element.parentElement).toBe(fake.container);
    expect(ui.element.classList.contains('mgd-ui')).toBe(true);
    expect(ui.element.hasAttribute('data-overlay')).toBe(true);
    expect(ui.toolbar?.element.getAttribute('role')).toBe('toolbar');
  });

  it('goes into another container when given one', () => {
    const fake = fakeDraw();
    const other = document.createElement('div');
    document.body.appendChild(other);
    ui = createDrawUI(fake.asDraw, { container: other });
    expect(ui.element.parentElement).toBe(other);
  });

  it('has no toolbar with toolbar: false', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { toolbar: false });
    expect(ui.toolbar).toBeNull();
    expect(ui.element.querySelector('[data-role="drawbar"]')).toBeNull();
  });

  it('removes the toolbar alone', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    ui.toolbar?.destroy();
    flushSync();
    expect(ui.toolbar).toBeNull();
    expect(ui.element.querySelector('[data-role="drawbar"]')).toBeNull();
  });

  it('adds and removes tools', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { toolbar: { tools: ['select', 'polygon'] } });
    const remove = ui.tools.add({ id: 'ring', mode: 'draw_ring', label: 'Ring', icon: SVG });
    flushSync();
    expect(labels(ui.element)).toEqual(['Select', 'Polygon', 'Ring', 'Delete', 'Snapping']);
    expect(ui.tools.list().map((t) => t.id)).toEqual(['select', 'polygon', 'ring']);
    expect(ui.element.querySelector('[aria-label="Ring"] svg circle')).not.toBeNull();
    [...ui.element.querySelectorAll<HTMLElement>('[aria-label="Ring"]')][0].click();
    expect(fake.draw.setMode).toHaveBeenCalledWith('draw_ring');
    remove();
    flushSync();
    expect(labels(ui.element)).toEqual(['Select', 'Polygon', 'Delete', 'Snapping']);
    expect(ui.tools.remove('polygon')).toBe(true);
    expect(ui.tools.remove('polygon')).toBe(false);
    flushSync();
    expect(labels(ui.element)).toEqual(['Select', 'Delete', 'Snapping']);
  });

  it('refuses a tool whose ID is taken', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    const spec = { id: 'select', mode: 'select', label: 'Pick', icon: SVG };
    expect(() => ui?.tools.add(spec)).toThrow(/already/);
  });

  it('lists the built-in tools with their words and icons', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { locale: 'ja', toolbar: { tools: ['circle'] } });
    expect(ui.tools.list()).toEqual([
      {
        id: 'circle',
        mode: 'draw_circle',
        label: '円',
        icon: 'circle',
        shortcut: 'C',
        group: 'draw',
      },
    ]);
  });

  it('changes its words', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { toolbar: { tools: ['polygon'] } });
    ui.setLocale('ja');
    flushSync();
    expect(labels(ui.element)).toEqual(['面', '削除', '吸着']);
    expect(ui.element.lang).toBe('ja');
    ui.setLocale({ polygon: 'Area' });
    flushSync();
    expect(labels(ui.element)).toEqual(['Area', 'Delete', 'Snapping']);
    expect(ui.element.hasAttribute('lang')).toBe(false);
  });

  it('picks a tool with its key', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    key(document.body, 'a');
    expect(fake.draw.setMode).toHaveBeenLastCalledWith('draw_polygon');
    key(fake.canvas, 'v');
    expect(fake.draw.setMode).toHaveBeenLastCalledWith('select');
  });

  it('deletes the selection with Delete, unless the key comes from the map, where core has it', () => {
    const fake = fakeDraw({ ids: ['a'] });
    ui = createDrawUI(fake.asDraw);
    key(fake.canvas, 'Delete');
    expect(fake.draw.selection.delete).not.toHaveBeenCalled();
    key(document.body, 'Backspace');
    expect(fake.draw.selection.delete).toHaveBeenCalledOnce();
  });

  it('clears the selection with Escape away from the map', () => {
    const fake = fakeDraw({ ids: ['a'] });
    ui = createDrawUI(fake.asDraw);
    key(fake.canvas, 'Escape');
    expect(fake.draw.selection.clear).not.toHaveBeenCalled();
    const event = key(document.body, 'Escape');
    expect(fake.draw.selection.clear).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('has no keys with shortcuts: false', () => {
    const fake = fakeDraw({ ids: ['a'] });
    ui = createDrawUI(fake.asDraw, { shortcuts: false });
    key(document.body, 'a');
    key(document.body, 'Delete');
    expect(fake.draw.setMode).not.toHaveBeenCalled();
    expect(fake.draw.selection.delete).not.toHaveBeenCalled();
  });

  it('stops following draw and leaves the page when destroyed', async () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    const root = ui.element;
    ui.destroy();
    ui.destroy();
    expect(root.isConnected).toBe(false);
    // Svelte lets go of the subscriptions in a microtask
    await Promise.resolve();
    expect(fake.listenerCount()).toBe(0);
    key(document.body, 'a');
    expect(fake.draw.setMode).not.toHaveBeenCalled();
    ui = undefined;
  });
});
