// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The contexts an extension works through
 *
 * Each kind of extension receives one narrow context with only what that kind needs. Every
 * type a context holds is part of the public API and follows semver.
 */

import type { BBox, Position } from 'geojson';
import type { DatasetRow } from '../datasets.js';
import type { Draw } from '../draw.js';
import type { DrawEvents, ScreenPoint } from '../events.js';
import type { ExtensionsCollections } from '../extensions.js';
import type { Feature, FeatureInput, FeatureType } from '../model.js';
import type { SelectionStyleOptions } from '../options.js';
import type { Mode, SnapResult } from '../state.js';
import type { Hit } from './provider.js';
import type { StoreView } from './store.js';

/** The positions and the heights on the terrain, for placing things on it. */
export interface TerrainAnchors {
  /**
   * The point on the screen of a position lifted to the ground.
   *
   * @returns The point, or `null` when the terrain is off or not ready
   */
  project(lngLat: Position): ScreenPoint | null;
  /**
   * The height of the ground at a position.
   *
   * @returns The height in meters; 0 when the terrain is off
   */
  elevation(lngLat: Position): number;
  /**
   * The opacity for a mark at a position: lower when the terrain hides it from the camera.
   *
   * @returns A value from 0 to 1; 1 when the terrain is off
   */
  ghostOpacity(lngLat: Position): number;
  /** A number that changes whenever the heights `elevation` returns may have changed. */
  generation(): number;
}

/** The automatic names of new features, layers and groups. */
export interface NameGenerator {
  /**
   * The next name for a type.
   *
   * @returns The name, or `undefined` for a feature when automatic names are off
   */
  next(type: FeatureType | 'Layer' | 'Group'): string | undefined;
}

/** The conversion between positions on the map and points on the screen. */
export interface ScreenContext {
  /** The point on the screen of a position. */
  project(lngLat: Position): ScreenPoint;
  /** The position on the map of a point on the screen. */
  unproject(point: ScreenPoint): Position;
  /**
   * The extent of a feature on the screen, in pixels; a feature off the screen still has
   * one.
   *
   * @returns The corners of the extent, or `null` when the feature has nothing to draw
   */
  bounds(feature: Feature): { min: ScreenPoint; max: ScreenPoint } | null;
  /** The zoom of the map */
  readonly zoom: number;
  /** The pixel ratio the drawing uses */
  readonly pixelRatio: number;
}

/**
 * What every context of an extension has: the public API, the Store, the events, the
 * terrain, the automatic names, the screen and a way to redraw, and the shape being drawn.
 */
export interface ExtensionContext {
  /** The whole public API; an extension reads and writes the document through it */
  readonly draw: Draw;
  /** The Store, to read the document and the state and to subscribe to their changes */
  readonly store: StoreView;
  /**
   * Subscribes to an event, with the same names as `draw.on`. The subscription ends by itself
   * when the extension is removed.
   *
   * @returns The function that unsubscribes
   */
  on<K extends keyof DrawEvents>(event: K, listener: (payload: DrawEvents[K]) => void): () => void;
  /** Unsubscribes from an event. */
  off<K extends keyof DrawEvents>(event: K, listener: (payload: DrawEvents[K]) => void): void;
  /**
   * Subscribes to the next occurrence of an event only.
   *
   * @returns The function that unsubscribes before it occurs
   */
  once<K extends keyof DrawEvents>(
    event: K,
    listener: (payload: DrawEvents[K]) => void,
  ): () => void;
  /** The positions and the heights on the terrain */
  readonly terrain: TerrainAnchors;
  /** The automatic names of new features, layers and groups */
  readonly names: NameGenerator;
  /** The conversion between the map and the screen */
  readonly screen: ScreenContext;
  /**
   * Asks for the features to be drawn again.
   *
   * @param filter - Only the features of this type, or with these IDs; every feature when it
   *   is left out
   */
  invalidate(filter?: { type?: string; ids?: string[] }): void;
  /** The shape being drawn by the current mode, for undoing and redoing its vertices */
  readonly drawing: {
    /**
     * Removes the last vertex of the shape being drawn.
     *
     * @returns True when a vertex was removed; false when nothing is being drawn or the mode
     *   has no vertex to remove
     */
    undoVertex(): boolean;
    /**
     * Puts back the vertex the last `undoVertex` removed.
     *
     * @returns True when a vertex was put back
     */
    redoVertex(): boolean;
    /** Whether the current mode is drawing a shape that is not created yet */
    isDrawing(): boolean;
  };
}

/**
 * The context of a plugin.
 */
export interface PluginContext extends ExtensionContext {
  /**
   * The same collections as `draw.extensions`. What a plugin adds through them is removed by
   * itself when the plugin is removed.
   */
  readonly extensions: ExtensionsCollections;
}

/**
 * The context of a mode.
 */
export interface ModeContext extends ExtensionContext {
  /**
   * Changes the mode.
   *
   * @returns False when the mode cannot be entered now
   */
  setMode(mode: Mode): boolean;
  /**
   * The topmost feature or dataset row at a point on the screen.
   *
   * @param options - `tolerancePx` is how far from the point a hit may be, in pixels
   * @returns What was hit, or `null`
   */
  hitTest(point: ScreenPoint, options?: { tolerancePx?: number }): Hit | null;
  /** Where a point on the screen snaps to; its own position when nothing is snapped to. */
  snap(point: ScreenPoint): SnapResult;
  /**
   * Creates a feature the way the built-in modes do: the writable layer, the ID, the
   * automatic name and the reference zoom follow the same rules.
   *
   * @returns The new feature, or `null` when it is refused (read-only, a lock)
   */
  commitFeature(input: FeatureInput): Feature | null;
  /** Shows the shape being drawn before it is created. */
  readonly preview: {
    /** Shows this shape as the one being drawn */
    set(feature: FeatureInput): void;
    /** Stops showing it */
    clear(): void;
  };
  /** The cursor of the map. */
  readonly cursor: {
    /** Sets the cursor, as a CSS cursor value */
    set(cursor: string): void;
    /** Goes back to the cursor of the mode */
    reset(): void;
  };
  /** The look of the selected features. */
  readonly selectionStyle: Required<SelectionStyleOptions>;
  /**
   * The rows of the datasets that a shape can trace along, within an extent. Empty when
   * snapping to the datasets is off.
   *
   * @param bbox - The extent, as `[west, south, east, north]` in degrees
   */
  listTraceRows(bbox: BBox): DatasetRow[];
}

/** What a hit test of a custom feature type or a companion receives. */
export interface HitTestContext {
  /** The point on the screen */
  point: ScreenPoint;
  /** The position on the map */
  lngLat: Position;
  /** How far from the point a hit may be, in pixels */
  tolerancePx: number;
  /** The conversion between the map and the screen */
  screen: ScreenContext;
}

/** What a provider of snapping candidates receives. */
export interface SnapContext {
  /** The point on the screen */
  point: ScreenPoint;
  /** The position on the map */
  lngLat: Position;
  /** How far from the point a candidate may be, in pixels */
  tolerancePx: number;
  /** The conversion between the map and the screen */
  screen: ScreenContext;
  /** The IDs of the features that must not be snapped to, such as the one being drawn */
  excludeIds: ReadonlySet<string>;
}
