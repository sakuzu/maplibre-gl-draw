// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cornerLift, mapControls } from '../src/controls.js';
import { createDrawUI, type DrawUI } from '../src/index.js';
import { fakeDraw } from './fake-draw.js';

// maplibre-gl's own controls, which createDrawUI adds to the map and removes on destroy, and the
// bottom corners of the map kept clear of the toolbar, the right panel and the attribution. The
// control classes are stand-ins that keep their options, so no real map is needed.

vi.mock('maplibre-gl', async (original) => {
  class Stub {
    constructor(readonly options: Record<string, unknown> = {}) {}
    onAdd() {
      return document.createElement('div');
    }
    onRemove() {}
  }
  return {
    ...(await original<typeof import('maplibre-gl')>()),
    GlobeControl: class GlobeControl extends Stub {},
    NavigationControl: class NavigationControl extends Stub {},
    ScaleControl: class ScaleControl extends Stub {},
  };
});

let ui: DrawUI | undefined;
let rect: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => {
  ui?.destroy();
  ui = undefined;
  rect?.mockRestore();
  rect = undefined;
  document.body.innerHTML = '';
});

type Added = [{ constructor: { name: string }; options?: Record<string, unknown> }, string];

/** The controls added, as the name of their class, their options and their corner */
function added(fake: ReturnType<typeof fakeDraw>) {
  return (fake.map.addControl.mock.calls as unknown as Added[]).map(([control, position]) => ({
    name: control.constructor.name,
    options: control.options ?? {},
    position,
  }));
}

/**
 * The controls of each corner from the top, as maplibre-gl stacks them: a control added to a
 * bottom corner goes above those already there
 */
function stacks(fake: ReturnType<typeof fakeDraw>) {
  const out: Record<string, string[]> = {};
  for (const { name, options, position } of added(fake)) {
    const label = name === 'NavigationControl' ? (options.showCompass ? 'compass' : 'zoom') : name;
    out[position] ??= [];
    if (position.startsWith('bottom')) out[position].unshift(label);
    else out[position].push(label);
  }
  return out;
}

describe("maplibre-gl's controls", () => {
  it('are the globe, the compass and the zoom at the bottom right and the scale at the bottom left', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    expect(added(fake)).toEqual([
      {
        name: 'NavigationControl',
        options: { showZoom: true, showCompass: false },
        position: 'bottom-right',
      },
      {
        name: 'NavigationControl',
        options: { showZoom: false, showCompass: true, visualizePitch: true },
        position: 'bottom-right',
      },
      { name: 'GlobeControl', options: {}, position: 'bottom-right' },
      { name: 'ScaleControl', options: {}, position: 'bottom-left' },
    ]);
    expect(stacks(fake)).toEqual({
      'bottom-right': ['GlobeControl', 'compass', 'zoom'],
      'bottom-left': ['ScaleControl'],
    });
  });

  it('are none with mapControls: false', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { mapControls: false });
    expect(fake.map.addControl).not.toHaveBeenCalled();
    ui.destroy();
    ui = undefined;
    expect(fake.map.removeControl).not.toHaveBeenCalled();
  });

  it('are those not set to false with an object', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { mapControls: { globe: false, scale: false } });
    expect(stacks(fake)).toEqual({ 'bottom-right': ['compass', 'zoom'] });
    ui.destroy();
    ui = createDrawUI(fakeDraw().asDraw, { mapControls: true });
    ui.destroy();
    const only = fakeDraw();
    ui = createDrawUI(only.asDraw, { mapControls: { zoom: true, compass: false } });
    expect(stacks(only)).toEqual({
      'bottom-right': ['GlobeControl', 'zoom'],
      'bottom-left': ['ScaleControl'],
    });
  });

  it('are removed on destroy, once', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    const controls = fake.map.addControl.mock.calls.map(([control]) => control);
    expect(controls).toHaveLength(4);
    ui.destroy();
    ui.destroy();
    ui = undefined;
    expect(fake.map.removeControl.mock.calls.map(([control]) => control)).toEqual(controls);
  });

  it('are left alone on destroy once the map is gone', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    fake.map.removeControl.mockImplementation(() => {
      throw new Error('the map is gone');
    });
    expect(() => ui?.destroy()).not.toThrow();
    ui = undefined;
  });
});

describe('the bottom corners of the map', () => {
  /** Adds maplibre-gl's corners to the map's container, as maplibre-gl draws them */
  function corners(container: HTMLElement) {
    const holder = document.createElement('div');
    holder.className = 'maplibregl-control-container';
    for (const side of ['left', 'right']) {
      const el = document.createElement('div');
      el.className = `maplibregl-ctrl-bottom-${side}`;
      holder.appendChild(el);
    }
    container.prepend(holder);
  }

  /** jsdom lays nothing out: a map `width` px wide and 600 tall, a toolbar 400 wide */
  function layOut(width: number) {
    const box = (left: number, top: number, w: number, h: number) =>
      DOMRect.fromRect({ x: left, y: top, width: w, height: h });
    rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches('.maplibregl-ctrl-bottom-left')) return box(0, 560, 110, 40);
      if (this.matches('.maplibregl-ctrl-bottom-right')) return box(width - 50, 480, 50, 120);
      if (this.matches('[data-role="drawbar"]')) return box((width - 400) / 2, 540, 400, 44);
      if (this.querySelector('canvas')) return box(0, 0, width, 600);
      return box(0, 0, 0, 0);
    });
  }

  async function settled() {
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const lift = (el: HTMLElement) => [
    el.style.getPropertyValue('--mgd-ui-lift-left'),
    el.style.getPropertyValue('--mgd-ui-lift-right'),
  ];

  it('rise above the toolbar where it reaches them across', async () => {
    const fake = fakeDraw();
    corners(fake.container);
    layOut(440);
    ui = createDrawUI(fake.asDraw);
    await settled();
    expect(fake.container.hasAttribute('data-mgd-ui-lift')).toBe(true);
    // From the top of the toolbar to the bottom of the map
    expect(lift(fake.container)).toEqual(['60px', '60px']);
  });

  it('stay where they are on a wide map', async () => {
    const fake = fakeDraw();
    corners(fake.container);
    layOut(1200);
    ui = createDrawUI(fake.asDraw);
    await settled();
    expect(lift(fake.container)).toEqual(['0px', '0px']);
  });

  it('come back when the toolbar goes and when the interface is destroyed', async () => {
    const fake = fakeDraw();
    corners(fake.container);
    layOut(440);
    ui = createDrawUI(fake.asDraw);
    await settled();
    expect(lift(fake.container)).toEqual(['60px', '60px']);
    ui.toolbar?.destroy();
    await settled();
    expect(lift(fake.container)).toEqual(['0px', '0px']);
    ui.destroy();
    ui = undefined;
    expect(fake.container.hasAttribute('data-mgd-ui-lift')).toBe(false);
    expect(lift(fake.container)).toEqual(['', '']);
  });
});

describe('the bottom corners beside the right panel and the attribution', () => {
  /** A map's container with maplibre-gl's corners and the root of an interface with a shell */
  function scene() {
    const container = document.createElement('div');
    container.innerHTML =
      '<div class="maplibregl-control-container">' +
      '<div class="maplibregl-ctrl-bottom-left"><div class="maplibregl-ctrl maplibregl-ctrl-scale"></div></div>' +
      '<div class="maplibregl-ctrl-bottom-right">' +
      '<div class="maplibregl-ctrl maplibregl-ctrl-group" data-control="globe"></div>' +
      '<div class="maplibregl-ctrl maplibregl-ctrl-group" data-control="zoom"></div>' +
      '<div class="maplibregl-ctrl maplibregl-ctrl-attrib"></div>' +
      '</div></div>';
    const root = document.createElement('div');
    root.innerHTML = '<div data-role="shell"><div data-region="right"></div></div>';
    container.appendChild(root);
    document.body.appendChild(container);
    return { container, root };
  }

  /**
   * jsdom lays nothing out: a map `width` px wide and 600 tall, the controls of the bottom right
   * from 480 down, the right pane down to `paneBottom`, gap-md 12, and the attribution's box,
   * with the margin of the corner (10px from the right and from the bottom)
   */
  function layOut(
    width: number,
    container: HTMLElement,
    attrib: { left: number; top: number },
    paneBottom = 588,
  ) {
    const box = (left: number, top: number, w: number, h: number) =>
      DOMRect.fromRect({ x: left, y: top, width: w, height: h });
    rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === container) return box(0, 0, width, 600);
      if (this.style.width === 'var(--kata-gap-md)') return box(0, 0, 12, 0);
      if (this.matches('.maplibregl-ctrl-bottom-left')) return box(0, 560, 110, 40);
      if (this.matches('.maplibregl-ctrl-bottom-right')) return box(width - 50, 480, 50, 120);
      if (this.matches('[data-control="globe"]')) return box(width - 39, 480, 29, 29);
      if (this.matches('[data-control="zoom"]')) return box(width - 39, 519, 29, 58);
      if (this.matches('.maplibregl-ctrl-attrib')) {
        return box(attrib.left, attrib.top, width - 10 - attrib.left, 590 - attrib.top);
      }
      if (this.matches('[data-region="right"]')) {
        return box(width - 332, 12, 320, paneBottom - 12);
      }
      return box(0, 0, 0, 0);
    });
  }

  const value = (el: HTMLElement, name: string) => el.style.getPropertyValue(name);
  const inset = (right: number) => ({ top: 0, right, bottom: 0, left: 0 });

  it('move the controls of the bottom right to the left of the right panel over them', () => {
    const { container, root } = scene();
    layOut(1024, container, { left: 900, top: 570 });
    const lift = cornerLift(container, root);
    lift.update(inset(0));
    expect(value(container, '--mgd-ui-shift-right')).toBe('0px');
    // The pane covers the stage at the right, down past the controls: the inset and gap-md
    lift.update(inset(332));
    expect(value(container, '--mgd-ui-shift-right')).toBe('344px');
    lift.destroy();
    expect(value(container, '--mgd-ui-shift-right')).toBe('');
  });

  it('leave the controls of the bottom right where they are under a short right panel', () => {
    const { container, root } = scene();
    layOut(1024, container, { left: 900, top: 570 }, 300);
    const lift = cornerLift(container, root);
    lift.update(inset(332));
    expect(value(container, '--mgd-ui-shift-right')).toBe('0px');
    lift.destroy();
  });

  it('lift the scale above the attribution where its box reaches the scale across', () => {
    const { container, root } = scene();
    // Two lines across most of the map, from 550 down
    layOut(390, container, { left: 60, top: 550 });
    const lift = cornerLift(container, root);
    lift.update(inset(0));
    // From the bottom of the corner (600) to the top of the attribution
    expect(value(container, '--mgd-ui-lift-left')).toBe('50px');
    expect(value(container, '--mgd-ui-lift-right')).toBe('0px');
    lift.destroy();
  });

  it('leave the scale where it is beside a short attribution', () => {
    const { container, root } = scene();
    layOut(390, container, { left: 300, top: 570 });
    const lift = cornerLift(container, root);
    lift.update(inset(0));
    expect(value(container, '--mgd-ui-lift-left')).toBe('0px');
    // The attribution's classes are maplibre-gl's own
    expect(container.querySelector('.maplibregl-ctrl-attrib')?.className).toBe(
      'maplibregl-ctrl maplibregl-ctrl-attrib',
    );
    lift.destroy();
  });

  it('leave the scale where it is under an open attribution on a narrow map', () => {
    const { container, root } = scene();
    // The band the (i) button opens, across the scale
    layOut(390, container, { left: 60, top: 550 });
    const lift = cornerLift(container, root);
    lift.update(inset(0), true);
    expect(value(container, '--mgd-ui-lift-left')).toBe('0px');
    // Wider, the same box lifts it again
    lift.update(inset(0), false);
    expect(value(container, '--mgd-ui-lift-left')).toBe('50px');
    lift.destroy();
  });
});

describe("maplibre-gl's controls on a narrow map", () => {
  /** The names of the controls a call list holds, as stacks() labels them */
  const names = (calls: unknown[][]) =>
    (calls as unknown as Added[]).map(([control]) =>
      control.constructor.name === 'NavigationControl'
        ? control.options?.showCompass
          ? 'compass'
          : 'zoom'
        : control.constructor.name,
    );

  it('leave out the globe and the compass, and add them back above the zoom on a wider one', () => {
    const fake = fakeDraw();
    const controls = mapControls(fake.map, undefined);
    expect(fake.map.addControl).toHaveBeenCalledTimes(4);
    controls.setNarrow(true);
    expect(names(fake.map.removeControl.mock.calls)).toEqual(['compass', 'GlobeControl']);
    // Narrow again changes nothing
    controls.setNarrow(true);
    expect(fake.map.removeControl).toHaveBeenCalledTimes(2);
    controls.setNarrow(false);
    // Each goes above those there: the compass above the zoom, the globe above the compass
    const again = fake.map.addControl.mock.calls.slice(4);
    expect(names(again)).toEqual(['compass', 'GlobeControl']);
    expect(again.map(([, position]) => position)).toEqual(['bottom-right', 'bottom-right']);
    // destroy() removes the zoom, the scale and the two added back, once
    fake.map.removeControl.mockClear();
    controls.destroy();
    controls.destroy();
    expect(names(fake.map.removeControl.mock.calls).sort()).toEqual(
      ['GlobeControl', 'ScaleControl', 'compass', 'zoom'].sort(),
    );
  });

  it('keep those set to false out', () => {
    const fake = fakeDraw();
    const controls = mapControls(fake.map, { globe: false });
    controls.setNarrow(true);
    controls.setNarrow(false);
    expect(names(fake.map.addControl.mock.calls.slice(3))).toEqual(['compass']);
    controls.destroy();
  });

  /** maplibre-gl's attribution in the map's container: compact, and open as it is built */
  function attribution(holder: HTMLElement, classes: string) {
    const el = document.createElement('details');
    el.className = `maplibregl-ctrl maplibregl-ctrl-attrib ${classes}`;
    holder.appendChild(el);
    return el;
  }

  /** The map's container with maplibre-gl's control container and its bottom right corner */
  function corner(fake: ReturnType<typeof fakeDraw>) {
    const holder = document.createElement('div');
    holder.className = 'maplibregl-control-container';
    const right = document.createElement('div');
    right.className = 'maplibregl-ctrl-bottom-right';
    holder.appendChild(right);
    fake.container.prepend(holder);
    return right;
  }

  /** The mutation observer's records are delivered in a microtask */
  const delivered = () => new Promise((resolve) => setTimeout(resolve, 0));
  const open = (el: Element) => el.classList.contains('maplibregl-compact-show');

  it('fold the attribution to its (i) button each time maplibre-gl builds it open', async () => {
    const fake = fakeDraw();
    const right = corner(fake);
    const first = attribution(right, 'maplibregl-compact maplibregl-compact-show');
    const controls = mapControls(fake.map, undefined);
    controls.setNarrow(true);
    expect(open(first)).toBe(false);
    expect(first.classList.contains('maplibregl-compact')).toBe(true);

    // The (i) button opens it, and it stays open
    first.classList.add('maplibregl-compact-show');
    await delivered();
    expect(open(first)).toBe(true);

    // Added again by the page, open
    first.remove();
    const second = attribution(right, 'maplibregl-compact maplibregl-compact-show');
    await delivered();
    expect(open(second)).toBe(false);

    // Built empty, then compact and open when it fills
    second.remove();
    const third = attribution(right, 'maplibregl-attrib-empty');
    await delivered();
    third.className =
      'maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show';
    await delivered();
    expect(open(third)).toBe(false);

    // On a wider map it is left as maplibre-gl builds it
    controls.setNarrow(false);
    third.remove();
    const wide = attribution(right, 'maplibregl-compact maplibregl-compact-show');
    await delivered();
    expect(open(wide)).toBe(true);

    // And after destroy()
    controls.setNarrow(true);
    controls.destroy();
    const after = attribution(right, 'maplibregl-compact maplibregl-compact-show');
    await delivered();
    expect(open(after)).toBe(true);
  });

  it('leave the attribution alone with mapControls: false', async () => {
    const fake = fakeDraw();
    const right = corner(fake);
    const el = attribution(right, 'maplibregl-compact maplibregl-compact-show');
    const controls = mapControls(fake.map, false);
    controls.setNarrow(true);
    await delivered();
    expect(open(el)).toBe(true);
    controls.destroy();
  });

  it('follow the shell of createDrawUI', async () => {
    const observer = globalThis.ResizeObserver;
    // An observer that reports each element once it is observed, so that the shell measures
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(): void {
        queueMicrotask(() => this.callback([], this as unknown as ResizeObserver));
      }
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    try {
      // A shell 640 wide, narrower than 48rem
      rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        const width = this.matches('[data-role="shell"]') || this.querySelector('canvas') ? 640 : 0;
        return DOMRect.fromRect({ x: 0, y: 0, width, height: width ? 800 : 0 });
      });
      const fake = fakeDraw();
      const right = corner(fake);
      const el = attribution(right, 'maplibregl-compact maplibregl-compact-show');
      ui = createDrawUI(fake.asDraw);
      for (let i = 0; i < 4; i++) {
        flushSync();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(ui.element.querySelector('[data-role="shell"]')?.getAttribute('data-width')).toBe(
        'narrow',
      );
      expect(names(fake.map.removeControl.mock.calls)).toEqual(['compass', 'GlobeControl']);
      expect(open(el)).toBe(false);
    } finally {
      globalThis.ResizeObserver = observer;
    }
  });
});
