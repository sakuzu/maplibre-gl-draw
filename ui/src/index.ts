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
import { flushSync, mount, unmount } from 'svelte';
import DrawUIView from './components/DrawUI.svelte';
import InspectorView from './components/Inspector.svelte';
import LayerPanelView from './components/LayerPanel.svelte';
import LegendView from './components/Legend.svelte';
import ToolbarView from './components/Toolbar.svelte';
import { inspectorSettings, sectionsHandle } from './inspector/sections.js';
import type {
  InspectorHandle,
  InspectorOptions,
  InspectorSectionSpec,
  InspectorSettings,
} from './inspector/types.js';
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
  LayerPanelHandle,
  LayerPanelOptions,
  LeftSettings,
  LegendHandle,
  ToolbarHandle,
  ToolbarOptions,
  ToolbarSettings,
  ToolEntry,
  ToolSpec,
  ToolsHandle,
} from './types.js';

export type {
  InspectorField,
  InspectorFieldKind,
  InspectorHandle,
  InspectorOptions,
  InspectorSectionSpec,
  InspectorSectionsHandle,
  InspectorTab,
  Units,
} from './inspector/types.js';
export type { Locale, Messages } from './messages.js';
export type {
  DrawUI,
  DrawUIOptions,
  LayerPanelHandle,
  LayerPanelOptions,
  LegendHandle,
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
 * It draws the toolbar, the shortcuts, the layer panel and the legend on the left, and the
 * inspector on the right while something is selected.
 *
 * @param draw - The draw instance
 * @param options - What to show, the words and the keys
 * @returns The interface, to change and to remove
 * @throws Error when a tool of `options.toolbar.tools` is not valid, or a tab of
 *   `options.inspector.tabs` is not `style` or `attributes`
 */
export function createDrawUI(draw: Draw, options: DrawUIOptions = {}): DrawUI {
  const bar: ToolbarOptions | null =
    options.toolbar === false ? null : options.toolbar === true ? {} : (options.toolbar ?? {});
  const tools = new Box(normalizeTools(bar?.tools));
  const messages = new Box(resolveMessages(options.locale));
  const toolbar = new Box<ToolbarSettings | null>(
    bar ? { deletable: bar.delete !== false, snapping: bar.snapping !== false } : null,
  );
  const left = new Box<LeftSettings | null>(leftSettings(options));
  const inspector = new Box<InspectorSettings | null>(
    options.inspector === false
      ? null
      : inspectorSettings(options.inspector === true ? {} : options.inspector, options.units),
  );
  const sections = new Box<InspectorSectionSpec[]>([]);

  const root = createRoot(options.container ?? draw.getMap().getContainer(), true);
  applyLocale(root, messages, options.locale ?? 'en');
  const view = mount(DrawUIView, {
    target: root,
    props: {
      draw,
      tools,
      messages,
      toolbar,
      left,
      shortcuts: options.shortcuts !== false,
      inspector,
      sections,
    },
  });
  // The shell opens the left region in an effect: run it now, so that the panels are there when
  // this returns
  flushSync();

  let destroyed = false;
  const dropLeft = (part: 'layers' | 'legend') => {
    const now = left.get();
    if (!now) return;
    const next = { ...now, [part]: part === 'layers' ? null : false };
    left.set(next.layers || next.legend ? next : null);
  };
  const layersHandle: LayerPanelHandle = {
    get element() {
      return root.querySelector<HTMLElement>('[data-role="layer-panel"]') ?? root;
    },
    destroy() {
      dropLeft('layers');
    },
  };
  const legendHandle: LegendHandle = {
    get element() {
      return root.querySelector<HTMLElement>('[data-role="legend"]') ?? root;
    },
    destroy() {
      dropLeft('legend');
    },
  };
  const toolbarHandle: ToolbarHandle = {
    get element() {
      return root.querySelector<HTMLElement>('[data-role="drawbar"]') ?? root;
    },
    destroy() {
      toolbar.set(null);
    },
  };

  const inspectorHandle: InspectorHandle = {
    get element() {
      return root.querySelector<HTMLElement>('[data-role="inspector"]') ?? root;
    },
    sections: sectionsHandle(sections),
    destroy() {
      inspector.set(null);
    },
  };

  return {
    element: root,
    get toolbar() {
      return !destroyed && toolbar.get() ? toolbarHandle : null;
    },
    get inspector() {
      return !destroyed && inspector.get() ? inspectorHandle : null;
    },
    tools: toolsHandle(tools, messages),
    get layers() {
      return !destroyed && left.get()?.layers ? layersHandle : null;
    },
    get legend() {
      return !destroyed && left.get()?.legend ? legendHandle : null;
    },
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

/** The layer panel with the options filled in */
function layerSettings(options: LayerPanelOptions = {}): Required<LayerPanelOptions> {
  return {
    features: options.features !== false,
    add: options.add !== false,
    reorder: options.reorder !== false,
  };
}

/** What the left region of `createDrawUI` shows, or null for none */
function leftSettings(options: DrawUIOptions): LeftSettings | null {
  const layers =
    options.layers === false
      ? null
      : layerSettings(options.layers === true ? {} : (options.layers ?? {}));
  const legend = options.legend !== false;
  return layers || legend ? { layers, legend } : null;
}

/** Puts a component alone in an element, in a root element of the interface */
function mountAlone(
  target: HTMLElement,
  locale: Locale | undefined,
  component: typeof LayerPanelView | typeof LegendView,
  props: Record<string, unknown>,
  role: string,
): { element: HTMLElement; destroy(): void } {
  const messages = new Box(resolveMessages(locale));
  const root = createRoot(target, false);
  applyLocale(root, messages, locale ?? 'en');
  const view = mount(component as typeof LayerPanelView, {
    target: root,
    props: { ...props, messages } as never,
  });
  let destroyed = false;
  return {
    get element() {
      return root.querySelector<HTMLElement>(`[data-role="${role}"]`) ?? root;
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
 * Puts the layer panel alone in an element: the tree of the layers, their groups and their
 * features, from the front, with the eye, the lock, renaming, dragging and the add menu. It fills
 * `target`, which gives it its size and its scrolling.
 *
 * @param draw - The draw instance
 * @param options - The element to put it in, what it shows and the words (`en` by default)
 * @returns The layer panel, to remove
 */
export function createLayerPanel(
  draw: Draw,
  options: LayerPanelOptions & { target: HTMLElement; locale?: Locale },
): LayerPanelHandle {
  return mountAlone(
    options.target,
    options.locale,
    LayerPanelView,
    { draw, ...layerSettings(options) },
    'layer-panel',
  );
}

/**
 * Puts the legend alone in an element: the rows of the style rule of each layer that has one,
 * from the front. It only reads; the rules change with `draw.layers.update`.
 *
 * @param draw - The draw instance
 * @param options - The element to put it in and the words (`en` by default)
 * @returns The legend, to remove
 */
export function createLegend(
  draw: Draw,
  options: { target: HTMLElement; locale?: Locale },
): LegendHandle {
  return mountAlone(options.target, options.locale, LegendView, { draw }, 'legend');
}

/**
 * Puts the inspector alone in an element: the panel of what is selected (a feature, several
 * features, a layer or a group), with an empty state while nothing is. The panel fills the height
 * of `target`.
 *
 * @param draw - The draw instance
 * @param options - The element to put it in, the tabs, the measurements, the operations, the
 *   units and the words (`en` by default)
 * @returns The inspector, to add sections to and to remove
 * @throws Error when a tab of `options.tabs` is not `style` or `attributes`
 */
export function createInspector(
  draw: Draw,
  options: InspectorOptions & { target: HTMLElement; locale?: Locale },
): InspectorHandle {
  const settings = inspectorSettings(options);
  const messages = new Box(resolveMessages(options.locale));
  const sections = new Box<InspectorSectionSpec[]>([]);
  const root = createRoot(options.target, false);
  root.dataset.panel = '';
  applyLocale(root, messages, options.locale ?? 'en');
  const view = mount(InspectorView, {
    target: root,
    props: { draw, messages, settings, sections },
  });
  let destroyed = false;
  return {
    get element() {
      return root.querySelector<HTMLElement>('[data-role="inspector"]') ?? root;
    },
    sections: sectionsHandle(sections),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unmount(view);
      root.remove();
    },
  };
}
