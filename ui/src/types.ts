// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The types of the API.

import type { Draw, Mode } from '@sakuzu/maplibre-gl-draw';
import type { Locale } from './messages.js';

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

/** What `createDrawUI` puts on the map */
export interface DrawUIOptions {
  /**
   * The element the interface is laid over, which must be positioned (relative, absolute or
   * fixed). The map's container when left out
   */
  container?: HTMLElement;
  /** The toolbar at the bottom, or false for none; true when left out */
  toolbar?: boolean | ToolbarOptions;
  /** The inspector on the right. Accepted, and not drawn yet in this version */
  inspector?: boolean;
  /** The layer panel on the left. Accepted, and not drawn yet in this version */
  layers?: boolean;
  /** The legend beside the layer panel. Accepted, and not drawn yet in this version */
  legend?: boolean;
  /** The words: `en` (the default), `ja`, or words laid over English */
  locale?: Locale;
  /** The units of the measurements. Accepted, and not used yet in this version */
  units?: 'metric' | 'imperial';
  /**
   * Whether the keyboard shortcuts are on: the keys of the tools, Delete and Backspace for the
   * selection, and ? for the list of the shortcuts; true when left out
   */
  shortcuts?: boolean;
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
  /** Changes the words */
  setLocale(locale: Locale): void;
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
