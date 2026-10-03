// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Revealing the selection. When the selection of drawn features changes, the map pans once so that
// the selection shows in the part of the map the interface leaves visible: the map's container
// less the left and the right regions of the shell (the right one while it is open), the sheets
// at the bottom, the toolbar's band and the attribution's box. A selection already inside it
// (one clicked on the map) does not move the map, and the zoom never changes.
//
// reveal() decides; the interface (index.ts) measures the boxes, calls it once the shell has laid
// out its regions for the selection, and pans the map (easeTo, the centre only).

import type { ShellInset } from './padding.js';

/** A box on the map's container, in px from its top left corner */
export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * How far to pan the map so that a box shows in the visible region: null when the box is entirely
 * inside the region, else the distance from the centre of the region to the centre of the box,
 * which the centre of the view moves by. The zoom is never changed, so a box larger than the
 * region is centred in it.
 *
 * @param bbox - The box of the selection on the map's container
 * @param visible - The visible region of the map's container
 */
export function reveal(bbox: ScreenBox, visible: ScreenBox): { x: number; y: number } | null {
  if (
    bbox.left >= visible.left &&
    bbox.right <= visible.right &&
    bbox.top >= visible.top &&
    bbox.bottom <= visible.bottom
  ) {
    return null;
  }
  return {
    x: (bbox.left + bbox.right) / 2 - (visible.left + visible.right) / 2,
    y: (bbox.top + bbox.bottom) / 2 - (visible.top + visible.bottom) / 2,
  };
}

/**
 * The visible region of the map's container: less the inset of the shell at each edge (the left
 * and the right regions, the sheets at the bottom), and above the toolbar's band and the
 * attribution's box, each taken from its top to the bottom of the map
 *
 * @param container - The map's container
 * @param root - The root element of the interface
 * @param inset - The inset the shell reported last
 */
export function visibleRegion(
  container: HTMLElement,
  root: HTMLElement,
  inset: ShellInset,
): ScreenBox {
  const box = container.getBoundingClientRect();
  let bottom = box.height - inset.bottom;
  const bands = [
    root.querySelector('[data-region="bottom"] [data-role="drawbar"]'),
    container.querySelector(':scope > .maplibregl-control-container .maplibregl-ctrl-attrib'),
  ];
  for (const el of bands) {
    const r = el?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) bottom = Math.min(bottom, r.top - box.top);
  }
  return { left: inset.left, top: inset.top, right: box.width - inset.right, bottom };
}

/** A GeoJSON geometry, as far as its positions go */
interface AnyGeometry {
  type: string;
  coordinates?: unknown;
  geometries?: readonly AnyGeometry[];
}

/** Calls `visit` with each position of a geometry */
export function eachPosition(geometry: AnyGeometry, visit: (lng: number, lat: number) => void) {
  if (geometry.geometries) {
    for (const part of geometry.geometries) eachPosition(part, visit);
    return;
  }
  const walk = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      visit(value[0], value[1]);
      return;
    }
    for (const item of value) walk(item);
  };
  walk(geometry.coordinates);
}

/**
 * The box of geometries on the map's container, from the points `project` gives for their
 * positions; null for none
 */
export function screenBox(
  geometries: readonly AnyGeometry[],
  project: (lngLat: [number, number]) => { x: number; y: number },
): ScreenBox | null {
  let box: ScreenBox | null = null;
  for (const geometry of geometries) {
    eachPosition(geometry, (lng, lat) => {
      const p = project([lng, lat]);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      box = box
        ? {
            left: Math.min(box.left, p.x),
            top: Math.min(box.top, p.y),
            right: Math.max(box.right, p.x),
            bottom: Math.max(box.bottom, p.y),
          }
        : { left: p.x, top: p.y, right: p.x, bottom: p.y };
    });
  }
  return box;
}
