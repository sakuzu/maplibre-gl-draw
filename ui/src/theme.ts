// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The theme of the root element of the interface. kata's tokens are dark; data-color-mode="light"
// on the root element switches every one of them to kata's light theme (the build moves kata's
// light block onto the root element), and the root's color-scheme with them.
//
// - light: data-color-mode="light" on the root element
// - dark: no attribute, kata's own theme
// - auto: light while the system prefers light (prefers-color-scheme), and it follows a change
//   at once
//
// A page that sets data-color-mode="light" on an element around the root turns it light too,
// whatever the theme of the interface.

/** The theme of the interface: `light`, `dark`, or `auto` to follow the system */
export type Theme = 'light' | 'dark' | 'auto';

/** The query of the system's preference that `auto` follows */
export const LIGHT_QUERY = '(prefers-color-scheme: light)';

const THEMES: readonly Theme[] = ['light', 'dark', 'auto'];

/** The theme of the options, `auto` when left out */
export function checkTheme(theme: Theme | undefined): Theme {
  if (theme === undefined) return 'auto';
  if (!THEMES.includes(theme)) throw new Error(`There is no theme "${String(theme)}"`);
  return theme;
}

/** The light or dark of a root element, or of another element that takes kata's tokens */
export function setLight(root: HTMLElement, light: boolean): void {
  if (light) root.setAttribute('data-color-mode', 'light');
  else root.removeAttribute('data-color-mode');
}

/** The theme of a root element, to change and to stop following the system */
export interface ThemeControl {
  /** Changes the theme */
  set(theme: Theme): void;
  /** Stops following the system. A second call does nothing */
  destroy(): void;
}

/**
 * Keeps the theme of a root element. With `auto`, it follows the system's preference while it
 * lasts; without `window.matchMedia`, `auto` is dark.
 *
 * `onlook` is called with the look applied (true for light) each time it is applied: at once,
 * on each change of the theme and, with `auto`, on each change of the system's preference.
 *
 * @throws Error when the theme is not `light`, `dark` or `auto`
 */
export function themeControl(
  root: HTMLElement,
  theme: Theme | undefined,
  onlook?: (light: boolean) => void,
): ThemeControl {
  let query: MediaQueryList | null = null;
  const look = (light: boolean) => {
    setLight(root, light);
    onlook?.(light);
  };
  const onchange = (e: MediaQueryListEvent) => look(e.matches);
  const stop = () => {
    query?.removeEventListener('change', onchange);
    query = null;
  };
  const apply = (next: Theme) => {
    stop();
    if (next !== 'auto') {
      look(next === 'light');
      return;
    }
    const media = typeof window !== 'undefined' ? window.matchMedia : undefined;
    query = typeof media === 'function' ? media.call(window, LIGHT_QUERY) : null;
    query?.addEventListener('change', onchange);
    look(query?.matches ?? false);
  };
  apply(checkTheme(theme));
  let destroyed = false;
  return {
    set(next) {
      if (destroyed) return;
      apply(checkTheme(next));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
    },
  };
}
