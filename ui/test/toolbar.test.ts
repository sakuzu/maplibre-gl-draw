// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { flushSync } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolbar, type ToolbarHandle } from '../src/index.js';
import { fakeDraw } from './fake-draw.js';

let bar: ToolbarHandle | undefined;
afterEach(() => {
  bar?.destroy();
  bar = undefined;
  document.body.innerHTML = '';
});

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`no button "${name}"`);
  return found;
}

const pressed = (name: string) => button(name).getAttribute('aria-pressed');

describe('createToolbar', () => {
  it('puts the seven tools, delete and snapping in the target', () => {
    const fake = fakeDraw();
    bar = createToolbar(fake.asDraw, { target: fake.container });
    const names = [...bar.element.querySelectorAll('button')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(names).toEqual([
      'Select',
      'Point',
      'Line',
      'Polygon',
      'Circle',
      'Freehand',
      'Image',
      'Delete',
      'Snapping',
    ]);
    expect(bar.element.getAttribute('aria-label')).toBe('Drawing tools');
    expect(fake.container.querySelector(':scope > .mgd-ui')).not.toBeNull();
  });

  it('enters the mode of a tool that is pressed', () => {
    const fake = fakeDraw();
    bar = createToolbar(fake.asDraw, { target: fake.container });
    button('Polygon').click();
    expect(fake.draw.setMode).toHaveBeenCalledWith('draw_polygon');
  });

  it('shows the current mode of draw, whoever changed it', () => {
    const fake = fakeDraw({ mode: 'draw_line' });
    bar = createToolbar(fake.asDraw, { target: fake.container });
    expect(pressed('Line')).toBe('true');
    fake.setModeFromOutside('draw_circle');
    flushSync();
    expect(pressed('Line')).toBe('false');
    expect(pressed('Circle')).toBe('true');
    button('Select').click();
    flushSync();
    expect(pressed('Select')).toBe('true');
    expect(pressed('Circle')).toBe('false');
  });

  it('presses no tool for a mode it does not show', () => {
    const fake = fakeDraw({ mode: 'draw_line' });
    bar = createToolbar(fake.asDraw, { target: fake.container, tools: ['select', 'polygon'] });
    for (const name of ['Select', 'Polygon']) expect(pressed(name)).toBe('false');
  });

  it('deletes the selection, and is off while nothing is selected', () => {
    const fake = fakeDraw();
    bar = createToolbar(fake.asDraw, { target: fake.container });
    expect(button('Delete').disabled).toBe(true);
    fake.select(['a', 'b']);
    flushSync();
    expect(button('Delete').disabled).toBe(false);
    button('Delete').click();
    flushSync();
    expect(fake.draw.selection.delete).toHaveBeenCalledOnce();
    expect(fake.draw.setMode).not.toHaveBeenCalled();
    expect(button('Delete').disabled).toBe(true);
  });

  it('switches snapping through the options of draw', () => {
    const fake = fakeDraw({ snapping: true });
    bar = createToolbar(fake.asDraw, { target: fake.container });
    expect(pressed('Snapping')).toBe('true');
    button('Snapping').click();
    flushSync();
    expect(fake.draw.options.update).toHaveBeenCalledWith({ snapping: { enabled: false } });
    expect(pressed('Snapping')).toBe('false');
  });

  it('leaves out delete and snapping when asked', () => {
    const fake = fakeDraw();
    bar = createToolbar(fake.asDraw, {
      target: fake.container,
      tools: ['select'],
      delete: false,
      snapping: false,
    });
    expect(bar.element.querySelectorAll('button')).toHaveLength(1);
  });

  it('shows the words of the locale', () => {
    const fake = fakeDraw();
    bar = createToolbar(fake.asDraw, { target: fake.container, locale: 'ja' });
    expect(button('面')).toBeDefined();
    expect(bar.element.closest('.mgd-ui')?.getAttribute('lang')).toBe('ja');
  });

  it('stops following draw and leaves the target when destroyed', async () => {
    const fake = fakeDraw();
    bar = createToolbar(fake.asDraw, { target: fake.container });
    expect(fake.listenerCount()).toBeGreaterThan(0);
    bar.destroy();
    bar.destroy();
    // Svelte lets go of the subscriptions in a microtask
    await Promise.resolve();
    expect(fake.listenerCount()).toBe(0);
    expect(fake.container.querySelector('.mgd-ui')).toBeNull();
  });
});
