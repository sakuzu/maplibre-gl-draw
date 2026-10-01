// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The padding of the map under the interface. The side regions that stand beside the stage cover
// the edges of the map, and the toolbar its bottom, so the map is told to keep its view (fitBounds,
// easeTo, the centre) clear of them. A floating pane or a sheet lies over the map only for a
// moment and leaves the padding at 0.

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

/** Which side regions stand beside the stage now, open */
export interface Beside {
  left: boolean;
  right: boolean;
}

/** The padding of a map, kept to the regions of the interface */
export interface MapPadding {
  /** Measures the regions again after the layout changed, and follows their sizes */
  update(beside: Beside): void;
  /** Stops following and gives the map back the padding it had before */
  destroy(): void;
}

const ZERO: Beside = { left: false, right: false };

/**
 * Keeps the padding of a map to the regions of the interface in `root`: the width of a side region
 * beside the stage on its side, and the height of the toolbar with its gap at the bottom.
 *
 * Every call to the map is guarded: once the map is removed, or its container leaves the page,
 * nothing is done.
 */
export function mapPadding(map: PaddingMap, root: HTMLElement): MapPadding {
  let before: PaddingOptions | null = null;
  try {
    before = { ...map.getPadding() };
  } catch {
    before = null;
  }
  let beside: Beside = ZERO;
  let last = '';
  let destroyed = false;
  let observer: ResizeObserver | undefined;
  let observed: Element[] = [];

  /** The element of a region of the shell, or null */
  const region = (name: string) =>
    root.querySelector<HTMLElement>(`[data-role="shell"] [data-region="${name}"]`);

  function sources() {
    return {
      left: beside.left ? region('left') : null,
      right: beside.right ? region('right') : null,
      bottom: region('bottom'),
      bar: root.querySelector<HTMLElement>('[data-region="bottom"] [data-role="drawbar"]'),
    };
  }

  function apply() {
    if (destroyed) return;
    try {
      const container = map.getContainer();
      if (!container.isConnected) return;
      const box = container.getBoundingClientRect();
      const { left, right, bottom, bar } = sources();
      const clamp = (v: number, max: number) => Math.round(Math.max(0, Math.min(v, max)));
      const next = {
        top: 0,
        left: left ? clamp(left.getBoundingClientRect().right - box.left, box.width) : 0,
        right: right ? clamp(box.right - right.getBoundingClientRect().left, box.width) : 0,
        // The toolbar's height and its gap: from the top of the bar to the bottom edge of the
        // toolbar's place (which rises over the sheets, so a sheet does not count)
        bottom:
          bottom && bar
            ? clamp(
                bottom.getBoundingClientRect().bottom - bar.getBoundingClientRect().top,
                box.height,
              )
            : 0,
      };
      const key = `${next.left} ${next.right} ${next.bottom}`;
      if (key === last) return;
      last = key;
      map.setPadding(next);
    } catch {
      // The map is gone
    }
  }

  function follow() {
    const { left, right, bar } = sources();
    let container: HTMLElement | undefined;
    try {
      container = map.getContainer();
    } catch {
      container = undefined;
    }
    const next = [left, right, bar, container].filter((el): el is HTMLElement => !!el);
    if (next.length === observed.length && next.every((el, i) => el === observed[i])) return;
    observer?.disconnect();
    observed = next;
    if (typeof ResizeObserver === 'undefined') return;
    observer ??= new ResizeObserver(apply);
    for (const el of observed) observer.observe(el);
  }

  return {
    update(now: Beside) {
      if (destroyed) return;
      beside = { ...now };
      follow();
      apply();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect();
      observer = undefined;
      observed = [];
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
