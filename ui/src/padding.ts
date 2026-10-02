// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The padding of the map under the interface. kata's Shell reports how far its regions cover the
// stage from each edge (the inset of onlayout), and the map is told to keep its view (fitBounds,
// easeTo, the centre) clear of the regions that stay: the left region, beside the stage or
// floating over it (it is open until the user closes it), and the sheets at the bottom. The
// right region is left out: it opens and closes with the selection, and the view would jump each
// time; maplibre-gl's controls of the bottom right move out of its way instead (controls.ts).

/** The padding of a map in px, as maplibre-gl has it */
export interface PaddingOptions {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

/** The members of the map the padding uses */
export interface PaddingMap {
  getContainer(): HTMLElement;
  getPadding(): PaddingOptions;
  setPadding(padding: PaddingOptions): unknown;
}

/** How far the regions of the shell cover the stage from each edge, in px (kata's ShellLayout) */
export interface ShellInset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The padding of a map, kept to the regions of the interface */
export interface MapPadding {
  /** Follows the inset the shell reported */
  update(inset: ShellInset): void;
  /** Gives the map back the padding it had before */
  destroy(): void;
}

/**
 * Keeps the padding of a map to the regions of the interface: the left inset at the left and the
 * bottom inset (the sheets) at the bottom, each no more than the map's size; the top and the right
 * stay 0.
 *
 * Every call to the map is guarded: once the map is removed, or its container leaves the page,
 * nothing is done.
 */
export function mapPadding(map: PaddingMap): MapPadding {
  let before: PaddingOptions | null = null;
  try {
    before = { ...map.getPadding() };
  } catch {
    before = null;
  }
  let last = '';
  let destroyed = false;

  return {
    update(inset: ShellInset) {
      if (destroyed) return;
      try {
        const container = map.getContainer();
        if (!container.isConnected) return;
        const box = container.getBoundingClientRect();
        const clamp = (v: number, max: number) => Math.round(Math.max(0, Math.min(v, max)));
        const next = {
          top: 0,
          left: clamp(inset.left, box.width),
          right: 0,
          bottom: clamp(inset.bottom, box.height),
        };
        const key = `${next.left} ${next.bottom}`;
        if (key === last) return;
        last = key;
        map.setPadding(next);
      } catch {
        // The map is gone
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (!before || last === '') return;
      try {
        if (!map.getContainer().isConnected) return;
        map.setPadding(before);
      } catch {
        // The map is gone
      }
    },
  };
}
