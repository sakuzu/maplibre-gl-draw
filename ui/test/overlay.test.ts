// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrawUI, createLegend, createToolbar, type DrawUI } from '../src/index.js';
import { fakeDraw, feature, layer } from './fake-draw.js';

// createDrawUI lies over the map as kata's root in a page kata does not own, with the Shell in
// overlay, and keeps the map's padding to the inset the Shell reports: the left panel and the
// sheets.

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

/**
 * jsdom lays nothing out: the boxes of the map, the shell, its stage and its regions, in px. The
 * left region is 280 wide beside the stage; floating, its pane is 320 wide gap-md (12) from the
 * stage's edges; a sheet is 300 tall
 */
function layOut(shellWidth: number) {
  const box = (left: number, top: number, width: number, height: number) =>
    DOMRect.fromRect({ x: left, y: top, width, height });
  rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.matches('[data-role="shell"]')) return box(0, 0, shellWidth, 800);
    if (this.matches('.side.left')) return box(0, 0, 280, 800);
    if (this.matches('.side.right')) return box(shellWidth - 320, 0, 320, 800);
    if (this.matches('[data-region="stage"]')) {
      const beside = !!this.closest('[data-role="shell"]')?.querySelector('.side.left');
      return beside ? box(280, 0, shellWidth - 600, 800) : box(0, 0, shellWidth, 800);
    }
    if (this.matches('[data-role="floating"]:has(> [data-region="left"])')) {
      return box(12, 12, 320, 400);
    }
    if (this.matches('[data-role="floating"]:has(> [data-region="right"])')) {
      return box(shellWidth - 332, 12, 320, 400);
    }
    if (this.parentElement?.matches('.sheet-seat')) return box(0, 500, shellWidth, 300);
    if (this.querySelector('canvas')) return box(0, 0, shellWidth, 800);
    return box(0, 0, 0, 0);
  });
}

/**
 * A ResizeObserver that reports each element once it is observed, as a browser does, so that
 * the shell measures its regions (the one of the setup never reports)
 */
class Reporting {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(): void {
    queueMicrotask(() => this.callback([], this as unknown as ResizeObserver));
  }
  unobserve(): void {}
  disconnect(): void {}
}

/** Waits for the shell to draw its regions, measure them and report the inset */
async function settled() {
  for (let i = 0; i < 4; i++) {
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
  const observer = globalThis.ResizeObserver;
  beforeEach(() => {
    vi.useRealTimers();
    globalThis.ResizeObserver = Reporting as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = observer;
  });

  it('is the width of the left panel beside the stage, and 0 for the right one', async () => {
    layOut(1200);
    const fake = withPoint(true);
    ui = createDrawUI(fake.asDraw, { side: 'beside' });
    await settled();
    expect(ui.element.querySelector('.side.right')).not.toBeNull();
    expect(fake.map.setPadding).toHaveBeenLastCalledWith({
      top: 0,
      left: 280,
      right: 0,
      bottom: 0,
    });
    // The inspector closes with the selection, and the padding stays
    const calls = fake.map.setPadding.mock.calls.length;
    fake.select([]);
    await settled();
    expect(fake.map.setPadding).toHaveBeenCalledTimes(calls);
  });

  it('is the room of the left panel floating over the map, with its gap', async () => {
    layOut(56 * 16);
    const fake = withPoint(true);
    ui = createDrawUI(fake.asDraw);
    await settled();
    expect(ui.element.querySelector('[data-role="shell"]')?.getAttribute('data-width')).toBe('mid');
    expect(ui.element.querySelector('[data-role="floating"] [data-region="left"]')).not.toBeNull();
    expect(ui.element.querySelector('[data-role="floating"] [data-region="right"]')).not.toBeNull();
    expect(fake.map.setPadding).toHaveBeenLastCalledWith({
      top: 0,
      left: 332,
      right: 0,
      bottom: 0,
    });
  });

  it('is the height of the sheets at the bottom, and 0 at the sides', async () => {
    layOut(40 * 16);
    const fake = withPoint(true);
    ui = createDrawUI(fake.asDraw);
    await settled();
    expect(ui.element.querySelector('[data-role="shell"]')?.getAttribute('data-width')).toBe(
      'narrow',
    );
    expect(fake.map.setPadding).toHaveBeenLastCalledWith({
      top: 0,
      left: 0,
      right: 0,
      bottom: 300,
    });
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
