// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { reveal, screenBox, visibleRegion } from '../src/reveal.js';

// Revealing the selection: how far the map pans so that the selection shows in the part of the
// map the interface leaves visible, and what that part is.

const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

describe('reveal', () => {
  // A map 1000 by 600 less a right pane 340 wide and a toolbar's band 80 tall
  const visible = box(0, 0, 660, 520);

  it('leaves a box entirely inside the visible region where it is', () => {
    expect(reveal(box(100, 100, 300, 200), visible)).toBeNull();
    // Touching the edges is inside
    expect(reveal(box(0, 0, 660, 520), visible)).toBeNull();
    // A point
    expect(reveal(box(400, 300, 400, 300), visible)).toBeNull();
  });

  it("brings the centre of a box partly outside to the region's centre", () => {
    // Under the right pane: its centre (700, 260) comes to (330, 260)
    expect(reveal(box(640, 220, 760, 300), visible)).toEqual({ x: 370, y: 0 });
    // Under the toolbar's band
    expect(reveal(box(300, 500, 360, 560), visible)).toEqual({ x: 0, y: 270 });
    // Past the top left of the map
    expect(reveal(box(-50, -40, 30, 20), visible)).toEqual({ x: -340, y: -270 });
  });

  it('centres a box larger than the region, as the zoom stays', () => {
    expect(reveal(box(-100, -100, 900, 700), visible)).toEqual({ x: 70, y: 40 });
  });
});

describe('the visible region', () => {
  let rect: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => {
    rect?.mockRestore();
    rect = undefined;
    document.body.innerHTML = '';
  });

  /** A map's container at (100, 50), 1000 by 600, with the toolbar and the attribution */
  function scene(attribTop: number | null) {
    const container = document.createElement('div');
    container.innerHTML =
      '<div class="maplibregl-control-container"><div class="maplibregl-ctrl-bottom-right">' +
      '<details class="maplibregl-ctrl maplibregl-ctrl-attrib"></details></div></div>';
    const root = document.createElement('div');
    root.innerHTML = '<div data-region="bottom"><div data-role="drawbar"></div></div>';
    container.appendChild(root);
    document.body.appendChild(container);
    const at = (left: number, top: number, width: number, height: number) =>
      DOMRect.fromRect({ x: left, y: top, width, height });
    rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === container) return at(100, 50, 1000, 600);
      if (this.matches('[data-role="drawbar"]')) return at(400, 50 + 540, 400, 44);
      if (this.matches('.maplibregl-ctrl-attrib') && attribTop !== null) {
        return at(800, 50 + attribTop, 290, 600 - 10 - attribTop);
      }
      return at(0, 0, 0, 0);
    });
    return { container, root };
  }

  it('is the container less the inset, above the toolbar and the attribution', () => {
    const { container, root } = scene(566);
    expect(visibleRegion(container, root, { top: 0, right: 344, bottom: 0, left: 332 })).toEqual(
      box(332, 0, 656, 540),
    );
  });

  it('is above the sheets, or the attribution when it is higher than the toolbar', () => {
    const { container, root } = scene(500);
    expect(visibleRegion(container, root, { top: 0, right: 0, bottom: 200, left: 0 })).toEqual(
      box(0, 0, 1000, 400),
    );
    expect(visibleRegion(container, root, { top: 0, right: 0, bottom: 0, left: 0 })).toEqual(
      box(0, 0, 1000, 500),
    );
  });

  it('leaves out what is not drawn', () => {
    const { container, root } = scene(null);
    root.innerHTML = '';
    expect(visibleRegion(container, root, { top: 0, right: 0, bottom: 0, left: 0 })).toEqual(
      box(0, 0, 1000, 600),
    );
  });
});

describe('the box of the selection', () => {
  const project = ([lng, lat]: [number, number]) => ({ x: lng * 10, y: 100 - lat * 10 });

  it('holds every position of the geometries', () => {
    expect(
      screenBox(
        [
          { type: 'Point', coordinates: [1, 2] },
          {
            type: 'Polygon',
            coordinates: [
              [
                [3, 1],
                [5, 1],
                [5, 4],
                [3, 1],
              ],
            ],
          },
          {
            type: 'GeometryCollection',
            geometries: [
              {
                type: 'LineString',
                coordinates: [
                  [-1, 0],
                  [0, 6],
                ],
              },
            ],
          },
        ],
        project,
      ),
    ).toEqual(box(-10, 40, 50, 100));
  });

  it('is null for none', () => {
    expect(screenBox([], project)).toBeNull();
  });
});
