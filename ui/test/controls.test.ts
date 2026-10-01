// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDrawUI, type DrawUI } from '../src/index.js';
import { fakeDraw } from './fake-draw.js';

// maplibre-gl's own controls, which createDrawUI adds to the map and removes on destroy, and the
// bottom corners of the map lifted above the toolbar where it reaches them. The control classes
// are stand-ins that keep their options, so no real map is needed.

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
