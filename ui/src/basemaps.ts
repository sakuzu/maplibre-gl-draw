// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The basemaps of the layer panel: the list its basemap row opens, the current one, its name, and
// the change of the map's style.
//
// A change replaces the style whole (diff: false). A diffed setStyle keeps the layers it did not
// serialize, the draw instance's custom layers among them, and adds the layers of the new style
// above them, so the new basemap would cover the drawing. Replaced whole, the old style goes with
// its layers and the draw instance adds its own again on top once the new style accepts layers.

import { Box } from './store.js';
import type { Basemap } from './types.js';

/** The members of the map the basemaps use */
export interface BasemapMap {
  setStyle(style: Basemap['style'], options?: { diff?: boolean }): unknown;
  /** The URL the style was loaded from (maplibre-gl 6), to find the current basemap */
  getStyleUrl?(): string | null;
  /** The style as it is now, whose name names a basemap that is none of the list */
  getStyle?(): { name?: string } | undefined;
  /** Follows the load of each new style, to read its name again */
  on?(type: 'style.load', listener: () => void): unknown;
  off?(type: 'style.load', listener: () => void): unknown;
}

/** The basemaps of the options, checked, and the ID of the current one */
export interface BasemapSettings {
  list: readonly Basemap[];
  current: string | null;
}

/**
 * Checks the basemaps of the options and finds the current one: `initial` when given, else the
 * first whose style is the URL of the map's style, else none.
 *
 * @throws Error when a basemap has no ID, no label or no style, has a preview that is not a
 *   string, two share an ID, or `initial` is the ID of none of them
 */
export function basemapSettings(
  basemaps: readonly Basemap[] | undefined,
  initial: string | undefined,
  styleUrl: string | null,
): BasemapSettings {
  const list = (basemaps ?? []).map((b) => ({ ...b }));
  const ids = new Set<string>();
  for (const b of list) {
    if (typeof b.id !== 'string' || b.id === '') throw new Error('A basemap needs an ID');
    if (typeof b.label !== 'string') throw new Error(`The basemap "${b.id}" needs a label`);
    if (typeof b.style !== 'string' && (typeof b.style !== 'object' || b.style === null)) {
      throw new Error(`The basemap "${b.id}" needs a style`);
    }
    if (b.preview !== undefined && typeof b.preview !== 'string') {
      throw new Error(`The preview of the basemap "${b.id}" must be a string`);
    }
    if (ids.has(b.id)) throw new Error(`There are two basemaps with the ID "${b.id}"`);
    ids.add(b.id);
  }
  if (initial !== undefined) {
    if (!ids.has(initial)) throw new Error(`There is no basemap "${initial}"`);
    return { list, current: initial };
  }
  const found = styleUrl === null ? undefined : list.find((b) => b.style === styleUrl);
  return { list, current: found?.id ?? null };
}

/** The basemaps on a map: the list, the current one, its name, and the change */
export interface BasemapControl {
  /** The basemaps, in the order they are offered */
  readonly list: readonly Basemap[];
  /** The ID of the current basemap, which the row and the basemaps to choose from follow */
  readonly current: Box<string | null>;
  /**
   * The name of the basemap the map shows: the label of the current basemap, else the `name` of
   * the map's style, else null. Read inside a component, it is followed
   */
  name(): string | null;
  /**
   * Replaces the map's style with the style of a basemap and calls `onchange` with it; nothing
   * happens when it is current already
   *
   * @throws Error when no basemap has this ID
   */
  set(id: string): void;
  /** The current basemap, or null */
  get(): Basemap | null;
  /** Stops following the map's style */
  destroy(): void;
}

/** The name of a style, or null when it has none */
function styleName(map: BasemapMap): string | null {
  const name = map.getStyle?.()?.name;
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}

/**
 * Keeps the current basemap of a map and changes its style. The name of the map's style is read
 * now and again on each `style.load`
 */
export function basemapControl(
  map: BasemapMap,
  settings: BasemapSettings,
  onchange?: (basemap: Basemap) => void,
): BasemapControl {
  const current = new Box<string | null>(settings.current);
  const style = new Box<string | null>(styleName(map));
  const reread = () => style.set(styleName(map));
  map.on?.('style.load', reread);
  const find = (id: string | null) => settings.list.find((b) => b.id === id);
  let destroyed = false;
  return {
    list: settings.list,
    current,
    name() {
      const label = find(current.get())?.label;
      return label !== undefined && label.trim() !== '' ? label : style.get();
    },
    set(id) {
      const next = find(id);
      if (!next) throw new Error(`There is no basemap "${id}"`);
      if (current.get() === id) return;
      map.setStyle(next.style, { diff: false });
      current.set(id);
      onchange?.({ ...next });
    },
    get() {
      const b = find(current.get());
      return b ? { ...b } : null;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      map.off?.('style.load', reread);
    },
  };
}
