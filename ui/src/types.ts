// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The types of the API.

import type { Draw, Mode } from '@sakuzu/maplibre-gl-draw';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { InspectorHandle, InspectorOptions } from './inspector/types.js';
import type { Locale } from './messages.js';
import type { Theme } from './theme.js';

/** The name of a built-in tool */
export type ToolId = 'select' | 'point' | 'line' | 'polygon' | 'circle' | 'freehand' | 'image';

/** A tool of the toolbar */
export interface ToolSpec {
  /** The name of the tool, unique in the toolbar */
  id: string;
  /** The mode of core the tool enters */
  mode: Mode;
  /** The name shown in its tooltip and read by assistive technology */
  label: string;
  /**
   * The icon: SVG markup (an `<svg>` element drawn with `currentColor`, shown at the size of the
   * icons of the toolbar), or the name of a built-in icon (a built-in tool's ID, `delete` or
   * `snapping`). The markup is inserted as it is, so it must come from the application, never
   * from a user
   */
  icon: string;
  /** The key that picks the tool, such as `T`, or with modifiers joined by `+` (`shift+t`) */
  shortcut?: string;
  /** Tools of the same group sit together; a tool without one is in a group of its own */
  group?: string;
}

/** A tool as the options name it: a built-in tool by its ID, or a tool of the application */
export type ToolEntry = ToolId | ToolSpec;

/** Where a part of the interface put alone goes, its words and its theme */
export interface AloneOptions {
  /** The element to put it in */
  target: HTMLElement;
  /** The words: `en` (the default), `ja`, or words laid over English */
  locale?: Locale;
  /**
   * The theme: `light`, `dark`, or `auto` (the default) to follow the system's preference
   * (prefers-color-scheme), also when it changes
   */
  theme?: Theme;
}

/** What the toolbar shows */
export interface ToolbarOptions {
  /**
   * The tools, in order: built-in tools by their ID and tools of the application. All seven
   * built-in tools when left out
   */
  tools?: ToolEntry[];
  /** Whether the delete button shows; true when left out */
  delete?: boolean;
  /** Whether the snapping switch shows; true when left out */
  snapping?: boolean;
}

/**
 * What `createDrawUI` puts on the map. The basemaps (`basemaps`, `basemap`, `onbasemap`) are
 * those of the basemap section at the bottom of its layer panel
 */
export interface DrawUIOptions extends BasemapOptions {
  /**
   * The element the interface is laid over, which must be positioned (relative, absolute or
   * fixed). The map's container when left out
   */
  container?: HTMLElement;
  /** The toolbar at the bottom, or false for none; true when left out */
  toolbar?: boolean | ToolbarOptions;
  /**
   * The inspector on the right, open while something is selected, or false for none; true when
   * left out
   */
  inspector?: boolean | InspectorOptions;
  /**
   * The layer panel on the left, in a tab beside the legend, or false for none; true when left
   * out
   */
  layers?: boolean | Omit<LayerPanelOptions, keyof BasemapOptions>;
  /** The legend, in a tab beside the layer panel, or false for none; true when left out */
  legend?: boolean;
  /** The words: `en` (the default), `ja`, or words laid over English */
  locale?: Locale;
  /**
   * The theme: `light`, `dark`, or `auto` (the default) to follow the system's preference
   * (prefers-color-scheme), also when it changes
   */
  theme?: Theme;
  /**
   * The units of the measurements of the inspector, unless its options name others; metric when
   * left out
   */
  units?: 'metric' | 'imperial';
  /**
   * Whether the keyboard shortcuts are on: the keys of the tools, Delete and Backspace for the
   * selection, and ? for the list of the shortcuts; true when left out
   */
  shortcuts?: boolean;
  /**
   * Whether the map's padding follows the interface: the width of a panel that stands beside the
   * map on its side, and the toolbar's height with its gap at the bottom, so that `fitBounds` and
   * `easeTo` keep clear of them. Floating panels and sheets leave it at 0. The padding the map
   * had is given back by `destroy()`. True when left out
   */
  padding?: boolean;
  /**
   * Where the side panels go on a wide map: `'floating'` lays them over the map, gap-md from
   * its edges and as tall as their content (the default, as the reference layout); `'beside'`
   * docks them beside the map from 64rem. Below 48rem both become sheets
   */
  side?: 'floating' | 'beside';
  /**
   * Whether a button at the top right of the map switches between the light and the dark look:
   * it sets the theme to the look that is not shown now (from `auto`, the one the system does not
   * prefer). True when left out
   */
  themeToggle?: boolean;
  /**
   * maplibre-gl's own controls, added to the map as maplibre-gl draws them: at the bottom right,
   * from the top, the globe, the compass and the zoom; at the bottom left, the scale. True (all
   * four) when left out; false for none, as for a page that adds controls of its own; an object
   * for some of them. `destroy()` removes them
   */
  mapControls?: boolean | MapControlsOptions;
}

/**
 * The basemaps of the basemap row, the one row of the last section of the layer panel: the back
 * of the stack, under the layers
 */
export interface BasemapOptions {
  /**
   * The basemaps to choose from. With two or more, a press on the row opens them: on the right in
   * the place of the inspector (`createDrawUI`), or in the place of the layer panel's sections
   * (`createLayerPanel`). Choosing one replaces the map's style with its `style`
   * (`map.setStyle(style, { diff: false })`), and the draw instance adds its layers again on top
   * of the new style. With fewer, or none (the default), the row only shows the name of the
   * basemap
   */
  basemaps?: Basemap[];
  /**
   * The ID of the basemap shown as current at the start. When left out, the first of `basemaps`
   * whose `style` is the URL of the map's style (`map.getStyleUrl()`), or none
   */
  basemap?: string;
  /** Called with the basemap after it changed, from the basemaps to choose from or `setBasemap` */
  onbasemap?: (basemap: Basemap) => void;
}

/** A basemap of the basemap row of the layer panel */
export interface Basemap {
  /** The name of the basemap, unique in the list */
  id: string;
  /** The name shown in the row and among the basemaps to choose from */
  label: string;
  /**
   * The preview beside the label among the basemaps to choose from: a value of CSS `background`
   * (an image, a gradient or a color), such as `linear-gradient(135deg, #e8efe3, #cfdcc6)`. A
   * neutral square when left out
   */
  preview?: string;
  /**
   * The style of the map, as `map.setStyle` takes it: the URL of a style or a style object
   * (maplibre-gl's StyleSpecification)
   */
  style: NonNullable<Parameters<MapLibreMap['setStyle']>[0]>;
}

/** Which of maplibre-gl's own controls `createDrawUI` adds to the map; each is true when left out */
export interface MapControlsOptions {
  /** The globe control (GlobeControl), which switches between the globe and the flat map */
  globe?: boolean;
  /** The compass (a NavigationControl without zoom), which resets the bearing and the pitch */
  compass?: boolean;
  /** The zoom buttons (a NavigationControl without compass) */
  zoom?: boolean;
  /** The scale bar (ScaleControl) */
  scale?: boolean;
}

/** A toolbar on the page */
export interface ToolbarHandle {
  /** The element of the toolbar */
  readonly element: HTMLElement;
  /** Removes the toolbar. A second call does nothing */
  destroy(): void;
}

/** The tools of the toolbar, to add to and to remove from */
export interface ToolsHandle {
  /**
   * Adds a tool after the last tool of its group, or at the end
   *
   * @returns The function that removes it again
   * @throws Error when the tool is not valid or its ID is taken
   */
  add(spec: ToolSpec): () => void;
  /**
   * Removes a tool, built-in or added
   *
   * @returns Whether there was a tool with this ID
   */
  remove(id: string): boolean;
  /** The tools in the order of the toolbar; a built-in tool has its built-in icon's name */
  list(): ToolSpec[];
}

/** The interface on a map */
export interface DrawUI {
  /** The root element of the interface (the class `mgd-ui`) */
  readonly element: HTMLElement;
  /** The toolbar, or null when there is none */
  readonly toolbar: ToolbarHandle | null;
  /** The tools of the toolbar */
  readonly tools: ToolsHandle;
  /** The layer panel, or null when there is none */
  readonly layers: LayerPanelHandle | null;
  /** The legend, or null when there is none */
  readonly legend: LegendHandle | null;
  /** The inspector, or null when there is none */
  readonly inspector: InspectorHandle | null;
  /** Changes the words */
  setLocale(locale: Locale): void;
  /**
   * Changes the theme
   *
   * @throws Error when the theme is not `light`, `dark` or `auto`
   */
  setTheme(theme: Theme): void;
  /**
   * Changes the basemap: replaces the map's style with the style of the basemap of `basemaps`
   * that has this ID, shows it in the basemap row and calls `onbasemap`. Nothing happens when
   * it is current already
   *
   * @throws Error when no basemap of `basemaps` has this ID
   */
  setBasemap(id: string): void;
  /** The current basemap, or null when none of `basemaps` is */
  getBasemap(): Basemap | null;
  /** Removes the interface and stops following the draw instance. A second call does nothing */
  destroy(): void;
}

/** What the toolbar of `createDrawUI` shows, or null when there is no toolbar */
export interface ToolbarSettings {
  /** Whether the delete button shows */
  deletable: boolean;
  /** Whether the snapping switch shows */
  snapping: boolean;
}

/** The members of a draw instance that the toolbar uses */
export type ToolbarDraw = Pick<Draw, 'getMode' | 'setMode' | 'on' | 'off'> & {
  readonly selection: Pick<Draw['selection'], 'get' | 'delete'>;
  readonly options: Pick<Draw['options'], 'get' | 'update'>;
};

/** The members of a draw instance that the whole interface uses */
export type DrawUIDraw = ToolbarDraw &
  Pick<Draw, 'getMap'> & {
    readonly selection: Pick<Draw['selection'], 'get' | 'delete' | 'clear'>;
  };

/**
 * What the layer panel shows. Its last section is the basemap: the label of the current one of
 * `basemaps`, else the `name` of the map's style
 */
export interface LayerPanelOptions extends BasemapOptions {
  /**
   * The features under the layers and the groups: `true` (the default) lists up to 1,000 features
   * in each layer, a number sets that limit, and `false` lists none (the groups alone). A layer
   * that holds more, those of its groups included, lists none of them and none of its groups, and
   * shows their number instead, with a hint to select them on the map: each row costs its
   * drawing, and many thousands make the panel slow
   */
  features?: boolean | number;
  /**
   * Whether the datasets (`draw.datasets`) show as rows of the stack, in their place among the
   * layers, with the eye; true when left out
   */
  datasets?: boolean;
  /** Whether the add menu (a new layer, a new group) shows; true when left out */
  add?: boolean;
  /** Whether the rows can be dragged to reorder them; true when left out */
  reorder?: boolean;
}

/** What the layer panel shows, with the options filled in; the basemaps are kept apart */
export type LayerSettings = Required<Omit<LayerPanelOptions, keyof BasemapOptions>>;

/** A layer panel on the page */
export interface LayerPanelHandle {
  /** The element of the layer panel */
  readonly element: HTMLElement;
  /** Removes the layer panel. A second call does nothing */
  destroy(): void;
}

/** A legend on the page */
export interface LegendHandle {
  /** The element of the legend */
  readonly element: HTMLElement;
  /** Removes the legend. A second call does nothing */
  destroy(): void;
}

/** What the left region of `createDrawUI` shows, or null when there is no left region */
export interface LeftSettings {
  /** The layer panel, or null for none */
  layers: LayerSettings | null;
  /** Whether the legend shows */
  legend: boolean;
}

/** The members of a draw instance that the layer panel uses */
export type LayerPanelDraw = Pick<Draw, 'on' | 'off'> & {
  readonly layers: Pick<
    Draw['layers'],
    'get' | 'getOrder' | 'reorder' | 'create' | 'update' | 'getActive' | 'setActive'
  >;
  readonly groups: Pick<Draw['groups'], 'get' | 'update' | 'move'>;
  readonly features: Pick<Draw['features'], 'get' | 'update' | 'move' | 'getAppliedStyle'>;
  readonly selection: Pick<Draw['selection'], 'get' | 'set' | 'clear' | 'group'>;
  readonly hidden: Pick<Draw['hidden'], 'has' | 'remove'>;
  readonly datasets: Pick<Draw['datasets'], 'get' | 'list'>;
};

/** The members of a draw instance that the legend uses */
export type LegendDraw = Pick<Draw, 'on' | 'off'> & {
  readonly layers: Pick<Draw['layers'], 'get' | 'getOrder'>;
  readonly features: Pick<Draw['features'], 'list'>;
};
