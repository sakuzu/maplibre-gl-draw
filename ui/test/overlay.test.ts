// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrawUI, createLegend, createToolbar, type DrawUI } from '../src/index.js';
import { fakeDraw, feature, layer } from './fake-draw.js';

// createDrawUI lies over the map as kata's root in a page kata does not own, with the Shell in
// overlay, and keeps the map's padding to the panels beside it.

let ui: DrawUI | undefined;
let rect: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => {
  ui?.destroy();
  ui = undefined;
  rect?.mockRestore();
  rect = undefined;
  document.body.innerHTML = '';
});

/** A draw instance with one point, selected or not */
const withPoint = (selected: boolean) =>
  fakeDraw({
    ids: selected ? ['a'] : [],
    doc: { layers: [layer('l1', ['a'])], features: [feature('a', 'l1')] },
  });

/** jsdom lays nothing out: the boxes of the map, the shell and its regions, in px */
function layOut(shellWidth: number) {
  const box = (left: number, top: number, width: number, height: number) =>
    DOMRect.fromRect({ x: left, y: top, width, height });
  rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.matches('[data-role="shell"]')) return box(0, 0, shellWidth, 800);
    if (this.matches('[data-region="left"]')) return box(0, 0, 280, 800);
    if (this.matches('[data-region="right"]')) return box(shellWidth - 320, 0, 320, 800);
    if (this.matches('[data-region="bottom"]')) return box(0, 800, shellWidth, 0);
    if (this.matches('[data-role="drawbar"]')) return box(400, 740, 400, 48);
    if (this.querySelector('canvas')) return box(0, 0, shellWidth, 800);
    return box(0, 0, 0, 0);
  });
}

/** Waits for the shell to draw its regions and the padding to follow them */
async function settled() {
  flushSync();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createDrawUI over the map', () => {
  it('is the root of kata in the page, so that the tooltips go into it', () => {
    const fake = withPoint(false);
    ui = createDrawUI(fake.asDraw);
    expect(ui.element.hasAttribute('data-kata-root')).toBe(true);
    const toolbar = createToolbar(fake.asDraw, { target: fake.container });
    expect(toolbar.element.closest('[data-kata-root]')).not.toBeNull();
    toolbar.destroy();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const legend = createLegend(fake.asDraw, { target });
    expect(target.firstElementChild?.hasAttribute('data-kata-root')).toBe(true);
    legend.destroy();
  });

  it('lays the shell over the map, letting the pointer through but on its regions', () => {
    const fake = withPoint(false);
    ui = createDrawUI(fake.asDraw);
    const shell = ui.element.querySelector('[data-role="shell"]');
    expect(shell?.classList.contains('overlay')).toBe(true);
    // The left region is beside the stage on a wide container
    expect(shell?.getAttribute('data-width')).toBe('wide');
  });
});

describe('the padding of the map', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('is the width of the panels beside the stage and the toolbar with its gap', async () => {
    layOut(1200);
    const fake = withPoint(true);
    ui = createDrawUI(fake.asDraw);
    await settled();
    expect(fake.map.setPadding).toHaveBeenLastCalledWith({
      top: 0,
      left: 280,
      right: 320,
      bottom: 60,
    });
    // The inspector closes with the selection
    fake.select([]);
    await settled();
    expect(fake.map.setPadding).toHaveBeenLastCalledWith({
      top: 0,
      left: 280,
      right: 0,
      bottom: 60,
    });
  });

  it('is 0 at the sides while the panels float over the map', async () => {
    layOut(56 * 16);
    const fake = withPoint(true);
    ui = createDrawUI(fake.asDraw);
    await settled();
    expect(ui.element.querySelector('[data-role="shell"]')?.getAttribute('data-width')).toBe('mid');
    expect(ui.element.querySelector('[data-role="floating"] [data-region="left"]')).not.toBeNull();
    expect(fake.map.setPadding).toHaveBeenLastCalledWith({ top: 0, left: 0, right: 0, bottom: 60 });
  });

  it('is 0 at the sides while the panels are sheets', async () => {
    layOut(40 * 16);
    const fake = withPoint(true);
    ui = createDrawUI(fake.asDraw);
    await settled();
    expect(ui.element.querySelector('[data-role="shell"]')?.getAttribute('data-width')).toBe(
      'narrow',
    );
    expect(fake.map.setPadding).toHaveBeenLastCalledWith({ top: 0, left: 0, right: 0, bottom: 60 });
  });

  it('is given back when the interface is destroyed', async () => {
    layOut(1200);
    const fake = withPoint(false);
    ui = createDrawUI(fake.asDraw);
    await settled();
    expect(fake.map.setPadding).toHaveBeenCalled();
    ui.destroy();
    ui = undefined;
    expect(fake.map.setPadding).toHaveBeenLastCalledWith({
      top: 10,
      bottom: 20,
      left: 30,
      right: 40,
    });
  });

  it('is left alone once the map has left the page', async () => {
    layOut(1200);
    const fake = withPoint(false);
    ui = createDrawUI(fake.asDraw);
    await settled();
    const calls = fake.map.setPadding.mock.calls.length;
    fake.container.remove();
    ui.destroy();
    ui = undefined;
    expect(fake.map.setPadding).toHaveBeenCalledTimes(calls);
  });

  it('is left alone with padding: false', async () => {
    layOut(1200);
    const fake = withPoint(false);
    ui = createDrawUI(fake.asDraw, { padding: false });
    await settled();
    ui.destroy();
    ui = undefined;
    expect(fake.map.setPadding).not.toHaveBeenCalled();
  });
});
