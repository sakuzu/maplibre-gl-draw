// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cornerLift } from '../src/controls.js';
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
   * from 480 down, the right pane down to `paneBottom`, gap-md 12, and the attribution's box
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
    // Two lines across most of a narrow map, from 550 down
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
});
