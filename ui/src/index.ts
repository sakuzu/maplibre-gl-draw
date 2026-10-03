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
import { type ActionsState, actionsHandle, actionsState, checkToolKey } from './actions.js';
import { type BasemapControl, basemapControl, basemapSettings } from './basemaps.js';
import DrawUIView from './components/DrawUI.svelte';
import InspectorView from './components/Inspector.svelte';
import LayerPanelView from './components/LayerPanel.svelte';
import LegendView from './components/Legend.svelte';
import ToolbarView from './components/Toolbar.svelte';
import { cornerLift, mapControls } from './controls.js';
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
import { type MapPadding, mapPadding, type ShellInset } from './padding.js';
import { reveal, screenBox, visibleRegion } from './reveal.js';
import { Box } from './store.js';
import { checkTheme, setLight, type Theme, themeControl } from './theme.js';
import { checkSpec, entryId, insertTool, normalizeTools, toSpec } from './tools.js';
import type {
  AloneOptions,
  BasemapOptions,
  DrawUI,
  DrawUIOptions,
  LayerPanelHandle,
  LayerPanelOptions,
  LayerSettings,
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
export type { Theme } from './theme.js';
export type {
  ActionSpec,
  ActionsHandle,
  AloneOptions,
  Basemap,
  BasemapOptions,
  DrawUI,
  DrawUIOptions,
  LayerPanelHandle,
  LayerPanelOptions,
  LegendHandle,
  MapControlsOptions,
  ToolbarHandle,
  ToolbarOptions,
  ToolEntry,
  ToolId,
  ToolSpec,
  ToolsHandle,
} from './types.js';

/** The class of the root element of the interface */
const ROOT_CLASS = 'mgd-ui';

/**
 * The attribute on maplibre-gl's control container of the map under the interface, which takes
 * kata's tokens (build/scope-css) and the look of the theme, so that root.css paints the map's
 * controls with them
 */
const CONTROLS_ATTRIBUTE = 'data-mgd-ui-controls';

/**
 * Creates the root element of the interface inside a container. It is kata's root in a page kata
 * does not own (data-kata-root): the tooltips and the probes of the tokens that kata appends go
 * into it, where the tokens, the language and the theme apply.
 */
function createRoot(container: HTMLElement, overlay: boolean): HTMLElement {
  const root = document.createElement('div');
  root.className = ROOT_CLASS;
  root.setAttribute('data-kata-root', '');
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
function toolsHandle(
  tools: Box<ToolEntry[]>,
  messages: Box<Messages>,
  actions?: ActionsState,
): ToolsHandle {
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
      if (actions) checkToolKey(spec.id, spec.shortcut, actions.list.get());
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
 * inspector on the right while something is selected. The map's padding follows the interface:
 * the room the left panel takes (beside the map or floating over it) at the left and the sheets
 * at the bottom, so that `fitBounds` and `easeTo` keep clear of them; `destroy()` gives the map
 * its padding back. When the selection of drawn features changes, the map pans once (the zoom
 * stays) so that it shows clear of the panels, the sheets, the toolbar and the attribution,
 * unless it shows there already. The last section of the layer panel is the basemap, whose row opens the
 * basemaps of `options.basemaps` to choose from on the right, in the place of the inspector, when
 * there are two or more. A button at the top right switches between the
 * light and the dark look, and maplibre-gl's own controls go to the bottom corners of the map (the
 * globe, the compass and the zoom at the right, the scale at the left), which move out of the way
 * of the toolbar, the right panel and the attribution; a narrow map (below 48rem) shows no globe
 * and no compass, and its attribution folded to its (i) button; `destroy()` removes them. The actions of
 * the application (`options.actions`, `ui.actions`) are rows of a card at the bottom left, above
 * the scale and the attribution, each with its key.
 *
 * @param draw - The draw instance
 * @param options - What to show, the words and the keys
 * @returns The interface, to change and to remove
 * @throws Error when a tool of `options.toolbar.tools` is not valid, a tab of
 *   `options.inspector.tabs` is not `style` or `attributes`, the theme is not `light`, `dark` or
 *   `auto`, the limit of the features of `options.layers.features` is a number less than 0, a
 *   basemap of `options.basemaps` has no ID, no label or no style or shares its ID,
 *   `options.basemap` is the ID of none of them, or an action of `options.actions` is not valid,
 *   shares its ID, or has a key of the interface or of another action
 */
export function createDrawUI(draw: Draw, options: DrawUIOptions = {}): DrawUI {
  const themeName = checkTheme(options.theme);
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
  const actions = actionsState(options.actions, tools.get(), messages.get());

  const map = draw.getMap();
  const basemaps = basemapsOf(draw, options);
  const root = createRoot(options.container ?? map.getContainer(), true);
  // maplibre-gl's controls in the map's container follow the theme: the control container takes
  // kata's tokens and the look of the root
  const controlContainer = map
    .getContainer()
    .querySelector<HTMLElement>(':scope > .maplibregl-control-container');
  controlContainer?.setAttribute(CONTROLS_ATTRIBUTE, '');
  // The look the root shows, which the theme button follows
  const light = new Box(false);
  const theme = themeControl(root, themeName, (next) => {
    light.set(next);
    if (controlContainer) setLight(controlContainer, next);
  });
  applyLocale(root, messages, options.locale ?? 'en');
  // maplibre-gl's own controls at the bottom corners, kept clear of the toolbar, the right region
  // and the attribution; a narrow map has no globe and no compass, and its attribution folded
  const controls = mapControls(map, options.mapControls);
  const lift = cornerLift(map.getContainer(), root);
  // The map keeps its view clear of the left region and of the sheets
  const padding: MapPadding | null = options.padding === false ? null : mapPadding(map);
  // A new selection of drawn features is brought into the part of the map left visible
  const revealing = selectionReveal(draw, root);
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
      oninset: (inset: ShellInset, narrow: boolean) => {
        padding?.update(inset);
        controls.setNarrow(narrow);
        lift.update(inset, narrow);
        revealing.inset(inset);
      },
      side: options.side,
      light,
      themeToggle: options.themeToggle !== false,
      ontheme: (next: Theme) => theme.set(next),
      basemaps,
      actions,
      actionsTitle: options.actionsTitle,
      actionsOpen: options.actionsOpen,
      corner: map.getContainer(),
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
    tools: toolsHandle(tools, messages, actions),
    actions: actionsHandle(actions, tools, messages),
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
    setTheme(next: Theme) {
      if (destroyed) return;
      theme.set(next);
    },
    setBasemap(id: string) {
      if (destroyed) return;
      basemaps.set(id);
    },
    getBasemap() {
      return basemaps.get();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      theme.destroy();
      controlContainer?.removeAttribute(CONTROLS_ATTRIBUTE);
      controlContainer?.removeAttribute('data-color-mode');
      basemaps.destroy();
      padding?.destroy();
      revealing.destroy();
      lift.destroy();
      controls.destroy();
      unmount(view);
      root.remove();
    },
  };
}

/** The selection revealed, following the inset of the shell */
interface SelectionReveal {
  /** Takes the inset the shell reported; a selection waiting for it is revealed in the next task */
  inset(inset: ShellInset): void;
  /** Stops following the selection */
  destroy(): void;
}

/**
 * Reveals the selection of drawn features each time it changes (reveal.ts), once the shell's
 * insets have settled for it: the right region opens with a selection, and the shell measures it
 * in a ResizeObserver delivery and reports the inset in the next frame. So the selection is
 * revealed in the task after the next inset, or, when none comes within two frames (the regions
 * did not change), in the task after those. The map pans with `easeTo`, the centre only.
 *
 * Every call to the map is guarded: once the map is removed, or its container leaves the page,
 * nothing is done.
 */
function selectionReveal(draw: Draw, root: HTMLElement): SelectionReveal {
  const map = draw.getMap();
  let inset: ShellInset = { top: 0, right: 0, bottom: 0, left: 0 };
  let pending = false;
  let destroyed = false;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  /** Reveals in the next task */
  const soon = () => {
    cancel();
    timer = setTimeout(run, 0);
  };
  function run() {
    cancel();
    if (destroyed || !pending) return;
    pending = false;
    try {
      const container = map.getContainer();
      if (!container.isConnected) return;
      const selection = draw.selection.get();
      if (selection.type !== 'feature') return;
      const geometries = selection.ids.flatMap((id) => {
        const feature = draw.features.get(id);
        return feature ? [feature.geometry] : [];
      });
      const box = screenBox(geometries, (lngLat) => map.project(lngLat));
      if (!box) return;
      const by = reveal(box, visibleRegion(container, root, inset));
      if (!by) return;
      const centre = map.project(map.getCenter());
      map.easeTo({ center: map.unproject([centre.x + by.x, centre.y + by.y]) });
    } catch {
      // The map is gone
    }
  }
  const off = draw.on('selection.changed', ({ selection }) => {
    cancel();
    pending = selection.type === 'feature' && selection.ids.length > 0;
    if (!pending) return;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = 0;
        soon();
      });
    });
  });
  return {
    inset(next: ShellInset) {
      if (destroyed) return;
      inset = { ...next };
      if (pending) soon();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancel();
      off();
    },
  };
}

/**
 * Puts the toolbar alone in an element: the tools, the delete button and the magnet that opens
 * the snapping settings, without the keyboard shortcuts. The bar floats at the bottom centre of `target`, which must be
 * positioned (the map's container, or a positioned box over the map).
 *
 * @param draw - The draw instance
 * @param options - The element to put it in, what it shows, the words (`en` by default) and the
 *   theme (`auto` by default)
 * @returns The toolbar, to remove
 * @throws Error when a tool of `options.tools` is not valid, or the theme is not `light`, `dark`
 *   or `auto`
 */
export function createToolbar(draw: Draw, options: ToolbarOptions & AloneOptions): ToolbarHandle {
  const tools = new Box(normalizeTools(options.tools));
  const themeName = checkTheme(options.theme);
  const messages = new Box(resolveMessages(options.locale));
  const root = createRoot(options.target, true);
  const theme = themeControl(root, themeName);
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
      theme.destroy();
      unmount(view);
      root.remove();
    },
  };
}

/**
 * The basemaps of the options on the map of a draw instance
 *
 * @throws Error when a basemap has no ID, no label or no style or shares its ID, or `basemap` is
 *   the ID of none of them
 */
function basemapsOf(draw: Draw, options: BasemapOptions): BasemapControl {
  const map = draw.getMap();
  const settings = basemapSettings(
    options.basemaps,
    options.basemap,
    typeof map.getStyleUrl === 'function' ? map.getStyleUrl() : null,
  );
  return basemapControl(map, settings, options.onbasemap);
}

/** The layer panel with the options filled in */
function layerSettings(options: Omit<LayerPanelOptions, keyof BasemapOptions> = {}): LayerSettings {
  const features = options.features ?? true;
  if (typeof features === 'number' && !(features >= 0)) {
    throw new Error('The limit of the features of the layer panel must be 0 or more');
  }
  return {
    features,
    datasets: options.datasets !== false,
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

/**
 * Puts a component alone in an element, in a root element of the interface; `cleanup` runs once
 * when it is removed
 */
function mountAlone(
  { target, locale, theme: themeOption }: AloneOptions,
  component: typeof LayerPanelView | typeof LegendView,
  props: Record<string, unknown>,
  role: string,
  cleanup?: () => void,
): { element: HTMLElement; destroy(): void } {
  const themeName = checkTheme(themeOption);
  const messages = new Box(resolveMessages(locale));
  const root = createRoot(target, false);
  const theme = themeControl(root, themeName);
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
      theme.destroy();
      unmount(view);
      root.remove();
      cleanup?.();
    },
  };
}

/**
 * Puts the layer panel alone in an element: the tree of the stack from the front (the layers,
 * their groups and their features, and the datasets), with the eye, the lock, dragging and the
 * add menu, and under it the basemap, the back of the stack, whose row opens the basemaps
 * of `options.basemaps` to choose from in the place of the panel's sections when there are two or
 * more. It fills `target`, which gives it its size and its scrolling.
 *
 * @param draw - The draw instance
 * @param options - The element to put it in, what it shows, the basemaps, the words (`en` by
 *   default) and the theme (`auto` by default)
 * @returns The layer panel, to remove
 * @throws Error when the theme is not `light`, `dark` or `auto`, `options.features` is a number
 *   less than 0, a basemap of `options.basemaps` has no ID, no label or no style or shares its ID,
 *   or `options.basemap` is the ID of none of them
 */
export function createLayerPanel(
  draw: Draw,
  options: LayerPanelOptions & AloneOptions,
): LayerPanelHandle {
  checkTheme(options.theme);
  const settings = layerSettings(options);
  const basemaps = basemapsOf(draw, options);
  return mountAlone(options, LayerPanelView, { draw, ...settings, basemaps }, 'layer-panel', () =>
    basemaps.destroy(),
  );
}

/**
 * Puts the legend alone in an element: the rows of the style rule of each layer and each dataset
 * that has one, in the order of the stack from the front. It only reads; the rules change with
 * `draw.layers.update` and a dataset's `setStyleRule`.
 *
 * @param draw - The draw instance
 * @param options - The element to put it in, the words (`en` by default) and the theme (`auto` by
 *   default)
 * @returns The legend, to remove
 * @throws Error when the theme is not `light`, `dark` or `auto`
 */
export function createLegend(draw: Draw, options: AloneOptions): LegendHandle {
  return mountAlone(options, LegendView, { draw }, 'legend');
}

/**
 * Puts the inspector alone in an element: the panel of what is selected (a feature, several
 * features, a layer or a group), with an empty state while nothing is. The panel fills the height
 * of `target`.
 *
 * @param draw - The draw instance
 * @param options - The element to put it in, the tabs, the measurements, the operations, the
 *   units, the words (`en` by default) and the theme (`auto` by default)
 * @returns The inspector, to add sections to and to remove
 * @throws Error when a tab of `options.tabs` is not `style` or `attributes`, or the theme is not
 *   `light`, `dark` or `auto`
 */
export function createInspector(
  draw: Draw,
  options: InspectorOptions & AloneOptions,
): InspectorHandle {
  const settings = inspectorSettings(options);
  const themeName = checkTheme(options.theme);
  const messages = new Box(resolveMessages(options.locale));
  const sections = new Box<InspectorSectionSpec[]>([]);
  const root = createRoot(options.target, false);
  const theme = themeControl(root, themeName);
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
      theme.destroy();
      unmount(view);
      root.remove();
    },
  };
}
