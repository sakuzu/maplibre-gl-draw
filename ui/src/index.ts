// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The standard user interface of `@sakuzu/maplibre-gl-draw`: a toolbar of the drawing tools at
 * the bottom of the map, with keyboard shortcuts.
 *
 * The interface keeps nothing of the drawing. It reads the draw instance and follows its events
 * (the current tool is `draw.getMode()`, the selection `draw.selection.get()`), and every button
 * calls the public API of the draw instance, so an application can mix it with controls of its
 * own and they never disagree.
 *
 * ```ts
 * import { createDraw } from '@sakuzu/maplibre-gl-draw';
 * import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
 * import '@sakuzu/maplibre-gl-draw-ui/style.css';
 *
 * const draw = createDraw(map);
 * const ui = createDrawUI(draw, { locale: 'ja' });
 * ```
 *
 * @module maplibre-gl-draw-ui
 */

import type { Draw } from '@sakuzu/maplibre-gl-draw';
import { mount, unmount } from 'svelte';
import DrawUIView from './components/DrawUI.svelte';
import ToolbarView from './components/Toolbar.svelte';
import {
  applyKataMessages,
  type Locale,
  localeLanguage,
  type Messages,
  resolveMessages,
} from './messages.js';
import { Box } from './store.js';
import { checkSpec, entryId, insertTool, normalizeTools, toSpec } from './tools.js';
import type {
  DrawUI,
  DrawUIOptions,
  ToolbarHandle,
  ToolbarOptions,
  ToolbarSettings,
  ToolEntry,
  ToolSpec,
  ToolsHandle,
} from './types.js';

export type { Locale, Messages } from './messages.js';
export type {
  DrawUI,
  DrawUIOptions,
  ToolbarHandle,
  ToolbarOptions,
  ToolEntry,
  ToolId,
  ToolSpec,
  ToolsHandle,
} from './types.js';

/** The class of the root element of the interface */
const ROOT_CLASS = 'mgd-ui';

/** Creates the root element of the interface inside a container */
function createRoot(container: HTMLElement, overlay: boolean): HTMLElement {
  const root = document.createElement('div');
  root.className = ROOT_CLASS;
  if (overlay) root.dataset.overlay = '';
  container.appendChild(root);
  return root;
}

/** Applies a locale: the words of the interface, those of kata, and the language of the root */
function applyLocale(root: HTMLElement, messages: Box<Messages>, locale: Locale): void {
  const next = resolveMessages(locale);
  messages.set(next);
  applyKataMessages(next);
  const lang = localeLanguage(locale);
  if (lang) root.lang = lang;
  else root.removeAttribute('lang');
}

/** The tools of a toolbar, to add to and to remove from */
function toolsHandle(tools: Box<ToolEntry[]>, messages: Box<Messages>): ToolsHandle {
  const remove = (id: string): boolean => {
    const entries = tools.get();
    const next = entries.filter((entry) => entryId(entry) !== id);
    if (next.length === entries.length) return false;
    tools.set(next);
    return true;
  };
  return {
    add(spec: ToolSpec) {
      checkSpec(spec);
      if (tools.get().some((entry) => entryId(entry) === spec.id)) {
        throw new Error(`There is a tool with the ID "${spec.id}" already`);
      }
      tools.set(insertTool(tools.get(), spec));
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        remove(spec.id);
      };
    },
    remove,
    list() {
      const m = messages.get();
      return tools.get().map((entry) => toSpec(entry, m));
    },
  };
}

/**
 * Lays the interface over the map of a draw instance: kata's Shell with the toolbar at the
 * bottom and the keyboard shortcuts.
 *
 * In this version the toolbar and the shortcuts are drawn; `inspector`, `layers`, `legend` and
 * `units` are accepted and have no effect yet.
 *
 * @param draw - The draw instance
 * @param options - What to show, the words and the keys
 * @returns The interface, to change and to remove
 * @throws Error when a tool of `options.toolbar.tools` is not valid
 */
export function createDrawUI(draw: Draw, options: DrawUIOptions = {}): DrawUI {
  const bar: ToolbarOptions | null =
    options.toolbar === false ? null : options.toolbar === true ? {} : (options.toolbar ?? {});
  const tools = new Box(normalizeTools(bar?.tools));
  const messages = new Box(resolveMessages(options.locale));
  const toolbar = new Box<ToolbarSettings | null>(
    bar ? { deletable: bar.delete !== false, snapping: bar.snapping !== false } : null,
  );

  const root = createRoot(options.container ?? draw.getMap().getContainer(), true);
  applyLocale(root, messages, options.locale ?? 'en');
  const view = mount(DrawUIView, {
    target: root,
    props: { draw, tools, messages, toolbar, shortcuts: options.shortcuts !== false },
  });

  let destroyed = false;
  const toolbarHandle: ToolbarHandle = {
    get element() {
      return root.querySelector<HTMLElement>('[data-role="drawbar"]') ?? root;
    },
    destroy() {
      toolbar.set(null);
    },
  };

  return {
    element: root,
    get toolbar() {
      return !destroyed && toolbar.get() ? toolbarHandle : null;
    },
    tools: toolsHandle(tools, messages),
    setLocale(locale: Locale) {
      if (destroyed) return;
      applyLocale(root, messages, locale);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unmount(view);
      root.remove();
    },
  };
}

/**
 * Puts the toolbar alone in an element: the tools, the delete button and the snapping switch,
 * without the keyboard shortcuts. The bar floats at the bottom centre of `target`, which must be
 * positioned (the map's container, or a positioned box over the map).
 *
 * @param draw - The draw instance
 * @param options - The element to put it in, what it shows and the words (`en` by default)
 * @returns The toolbar, to remove
 * @throws Error when a tool of `options.tools` is not valid
 */
export function createToolbar(
  draw: Draw,
  options: ToolbarOptions & { target: HTMLElement; locale?: Locale },
): ToolbarHandle {
  const tools = new Box(normalizeTools(options.tools));
  const messages = new Box(resolveMessages(options.locale));
  const root = createRoot(options.target, true);
  applyLocale(root, messages, options.locale ?? 'en');
  const view = mount(ToolbarView, {
    target: root,
    props: {
      draw,
      tools,
      messages,
      deletable: options.delete !== false,
      snapping: options.snapping !== false,
    },
  });
  let destroyed = false;
  return {
    get element() {
      return root.querySelector<HTMLElement>('[data-role="drawbar"]') ?? root;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unmount(view);
      root.remove();
    },
  };
}
