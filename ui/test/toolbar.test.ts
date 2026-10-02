// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { flushSync } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolbar, type ToolbarHandle } from '../src/index.js';
import { fakeDocument, fakeDraw } from './fake-draw.js';

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

/** The switches of the snapping settings, by their text */
function switches(): Map<string, HTMLInputElement> {
  const out = new Map<string, HTMLInputElement>();
  for (const input of document.querySelectorAll<HTMLInputElement>('[role="switch"]')) {
    out.set(input.closest('label')?.textContent?.trim() ?? '', input);
  }
  return out;
}

function toggle(name: string): HTMLInputElement {
  const found = switches().get(name);
  if (!found) throw new Error(`no switch "${name}"`);
  return found;
}

/** The popover of the snapping settings, or null while it is closed */
const popover = () => document.querySelector('[data-role="snapping"] [data-role="popover"]');

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

  it('is off while draw is read-only, whatever is selected', () => {
    const fake = fakeDocument({ selection: { type: 'feature', ids: ['a'] }, readOnly: true });
    bar = createToolbar(fake.asDraw, { target: fake.container });
    expect(button('Delete').disabled).toBe(true);
    fake.setReadOnly(false);
    flushSync();
    expect(button('Delete').disabled).toBe(false);
    fake.setReadOnly(true);
    flushSync();
    expect(button('Delete').disabled).toBe(true);
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

describe('the snapping settings', () => {
  // The toolbar holds the settings once its effects have run
  it('open from the magnet, which stays pressed while snapping is on', () => {
    const fake = fakeDraw({ snapping: true });
    bar = createToolbar(fake.asDraw, { target: fake.container });
    flushSync();
    expect(pressed('Snapping')).toBe('true');
    expect(popover()).toBeNull();
    button('Snapping').click();
    flushSync();
    expect(popover()).not.toBeNull();
    expect(fake.draw.options.update).not.toHaveBeenCalled();
    expect([...switches().keys()]).toEqual([
      'Snapping',
      'Vertices',
      'Edges',
      'Intersections',
      'Guides',
      'Snap to datasets',
      'Trace edges',
      'Move shared vertices',
    ]);
    expect(popover()?.textContent).toContain('Snapping pauses while Alt is held');
  });

  it('close on Escape and on a second press of the magnet', () => {
    const fake = fakeDraw();
    bar = createToolbar(fake.asDraw, { target: fake.container });
    flushSync();
    button('Snapping').click();
    flushSync();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(popover()).toBeNull();
    button('Snapping').click();
    flushSync();
    expect(popover()).not.toBeNull();
    button('Snapping').click();
    flushSync();
    expect(popover()).toBeNull();
  });

  it('write each switch through the options of draw', () => {
    const fake = fakeDraw();
    bar = createToolbar(fake.asDraw, { target: fake.container });
    flushSync();
    button('Snapping').click();
    flushSync();
    const cases: [string, unknown][] = [
      ['Vertices', { snapping: { kinds: { vertex: false } } }],
      ['Edges', { snapping: { kinds: { edge: false } } }],
      ['Intersections', { snapping: { kinds: { intersection: false } } }],
      ['Guides', { snapping: { kinds: { guide: false } } }],
      ['Snap to datasets', { snapping: { datasets: false } }],
      ['Trace edges', { tracing: { enabled: false } }],
      ['Move shared vertices', { topology: { sharedVertexDrag: true } }],
      ['Snapping', { snapping: { enabled: false } }],
    ];
    for (const [name, patch] of cases) {
      toggle(name).click();
      flushSync();
      expect(fake.draw.options.update).toHaveBeenLastCalledWith(patch);
    }
    const now = fake.draw.options.get();
    expect(now.snapping?.kinds).toEqual({
      vertex: false,
      edge: false,
      intersection: false,
      guide: false,
    });
    expect(now.topology?.sharedVertexDrag).toBe(true);
    expect(pressed('Snapping')).toBe('false');
  });

  it('turn the kinds off while snapping is off', () => {
    const fake = fakeDraw({ snapping: false });
    bar = createToolbar(fake.asDraw, { target: fake.container });
    flushSync();
    expect(pressed('Snapping')).toBe('false');
    button('Snapping').click();
    flushSync();
    for (const name of ['Vertices', 'Edges', 'Intersections', 'Guides']) {
      expect(toggle(name).disabled).toBe(true);
    }
    for (const name of ['Snapping', 'Snap to datasets', 'Trace edges']) {
      expect(toggle(name).disabled).toBe(false);
    }
    toggle('Snapping').click();
    flushSync();
    expect(toggle('Vertices').disabled).toBe(false);
  });

  it('follow a change of the options made by code', () => {
    const fake = fakeDraw();
    bar = createToolbar(fake.asDraw, { target: fake.container });
    flushSync();
    button('Snapping').click();
    flushSync();
    expect(toggle('Edges').checked).toBe(true);
    fake.draw.options.update({
      snapping: { enabled: false, kinds: { edge: false } },
      tracing: { enabled: false },
      topology: { sharedVertexDrag: true },
    });
    flushSync();
    expect(toggle('Snapping').checked).toBe(false);
    expect(toggle('Edges').checked).toBe(false);
    expect(toggle('Vertices').checked).toBe(true);
    expect(toggle('Trace edges').checked).toBe(false);
    expect(toggle('Move shared vertices').checked).toBe(true);
    expect(pressed('Snapping')).toBe('false');
  });

  it('name the key that pauses snapping, and nothing when there is none', () => {
    const fake = fakeDraw();
    bar = createToolbar(fake.asDraw, { target: fake.container, locale: 'ja' });
    flushSync();
    button('吸着').click();
    flushSync();
    expect(popover()?.textContent).toContain('Alt を押している間は吸着を止めます');
    fake.draw.options.update({ snapping: { disableKey: 'shift' } });
    flushSync();
    expect(popover()?.textContent).toContain('Shift を押している間は吸着を止めます');
    fake.draw.options.update({ snapping: { disableKey: 'none' } });
    flushSync();
    expect(popover()?.textContent).not.toContain('押している間');
  });
});
