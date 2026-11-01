// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The contexts an extension works through
 *
 * Each kind of extension receives one narrow context with only what that kind needs. Every
 * type a context holds is part of the public API and follows semver.
 *
 * The three contexts of what is read on the screen:
 *
 * - {@link ScreenContext}: the conversion between the map and the screen alone, in the frame
 *   drawn last. Every context has it (`ctx.screen`); a type receives it alone where it answers
 *   from the feature only (`footprint`)
 * - {@link PointContext}: a point on the screen being tested, with its position, its tolerance
 *   and what the reading leaves out, for a hit test, a box selection and snapping candidates
 * - {@link HandleContext}: what places the handles of a feature, the selection box the library
 *   draws (its margin included) and the look of the selection, for `handles` and `globalHandles`
 */

import type { Position } from 'geojson';
import type { BBox } from '../../geometry/types.js';
import type { DatasetRow } from '../datasets.js';
import type { Draw } from '../draw.js';
import type { DrawEvents, ScreenPoint } from '../events.js';
import type { ExtensionsCollections } from '../extensions.js';
import type { Feature, FeatureInput, FeatureType, Layer } from '../model.js';
import type { SelectionStyleOptions } from '../options.js';
import type { Mode, SnapResult } from '../state.js';
import type { Footprint } from './feature-type.js';
import type { Hit } from './provider.js';
import type { StoreView } from './store.js';

/**
 * The surface of the terrain of the map, for placing marks on it: its heights, and where it hides
 * a position from the camera. Where a position is on the screen, on the terrain when it is on, is
 * {@link ScreenContext.project}.
 */
export interface TerrainSurface {
  /**
   * The height of the terrain at a position.
   *
   * @returns The height in meters; 0 when the terrain is off
   */
  elevation(lngLat: Position): number;
  /**
   * The opacity to draw a mark at a position with for what of it the terrain hides from the
   * camera: 1 where it is in view, lower behind a slope. Multiply it into the opacity of the
   * mark.
   *
   * @returns A value from 0 to 1; 1 when the terrain is off
   */
  occlusionOpacity(lngLat: Position): number;
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

/**
 * The conversion between positions on the map and points on the screen, in the frame drawn last:
 * what is drawn, also when the camera moved since (by code, between two frames). While a frame is
 * drawn, it answers for that frame. Before the first frame, it answers for the camera of the map.
 */
export interface ScreenContext {
  /**
   * The point on the screen where a position is drawn: on the terrain when it is on, as the
   * shared renderers lay what they draw on it.
   */
  project(lngLat: Position): ScreenPoint;
  /** The position drawn at a point on the screen, on the terrain when it is on. */
  unproject(point: ScreenPoint): Position;
  /**
   * The length on the ground that a CSS pixel spans at a position, in the frame drawn last.
   *
   * The engine turns the sizes in pixels of what it draws on the map for the current view (the
   * margin of the selection box, the distance of the rotate handle, the move of an arrow key)
   * into meters with it, and lays them on the plane tangent to the sphere of the map at the
   * feature (maplibre's sphere, of a radius of 6,371,008.8 m), so they tilt and turn with the map
   * and keep their place on it. It follows the projection: on Web Mercator the scale at the
   * latitude of the position, on the globe the scale at the center of the view, and the mix of
   * the two while the map goes from one to the other. It is read from the frame drawn last, so a
   * hit test between two frames finds what that frame drew; before the first frame it is the
   * scale of the camera on Web Mercator. On a map turned flat and untilted, without terrain, a
   * length of `n * metersPerPixel(position)` meters is `n` pixels on the screen; tilted, on the
   * globe away from the center, or over terrain, it is foreshortened as the map is.
   *
   * @returns The meters of a CSS pixel
   */
  metersPerPixel(lngLat: Position): number;
  /** The zoom of the frame */
  readonly zoom: number;
  /** The pixel ratio the drawing uses */
  readonly pixelRatio: number;
}

/**
 * What every context of an extension has: the public API, the Store, the events, the
 * terrain, the automatic names, the screen and a way to redraw.
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
  /** The heights of the terrain and where it hides a position */
  readonly terrain: TerrainSurface;
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
  /**
   * Sends an event of the plugin to the subscribers of `draw.on` and `ctx.on`, at once. The
   * plugin declares the event in `DrawEvents` by declaration merging, named
   * `resource.pastParticiple` as the events of the library are, so that it is in the one list
   * applications and extensions subscribe to:
   *
   * ```ts
   * declare module '@sakuzu/maplibre-gl-draw' {
   *   interface DrawEvents {
   *     'counter.changed': { count: number };
   *   }
   * }
   * ```
   *
   * @throws `DrawError` with the code `invalid-input` when the event is one of the library's own,
   *   which only the library sends
   */
  emit<K extends keyof DrawEvents>(event: K, payload: DrawEvents[K]): void;
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
   * What is topmost at a point on the screen, as a click there finds it: a feature (`kind:
   * 'feature'`, its ID in `id`), a companion of a feature (`'companion'`, with the feature in
   * `featureId`) or a row of a dataset (`'dataset'`, with the dataset in `datasetId`).
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
    /**
     * Shows this shape as the one being drawn.
     *
     * @param options - `confirmedVertices` is how many vertices from the start are placed:
     *   the line up to them is drawn solid and the rest, up to the pointer, dashed (every
     *   vertex when it is left out); `highlightVertex` is the index of a vertex drawn
     *   highlighted, such as the first vertex of an area the next click would close
     */
    set(
      feature: FeatureInput,
      options?: { confirmedVertices?: number; highlightVertex?: number },
    ): void;
    /** Stops showing it */
    clear(): void;
  };
  /** The cursor of the map. */
  readonly cursor: {
    /** Sets the cursor, as a CSS cursor value */
    set(cursor: string): void;
    /**
     * Goes back to the cursor of the mode: the one it set in `onEnter`, or the cursor of the
     * map when it set none there. The cursor the mode set is taken back when it is left.
     */
    reset(): void;
  };
  /** The look of the selected features. */
  readonly selectionStyle: Required<SelectionStyleOptions>;
  /**
   * The layer a new feature goes into: the active layer when it can be written (it exists,
   * is visible, is not locked and not hidden on this client), otherwise the first layer that
   * can.
   *
   * @returns The layer, or `null` when no layer can be written
   */
  writableLayer(): Layer | null;
  /**
   * The rows of the datasets that a shape can trace along, within an extent. Empty when
   * snapping to the datasets is off.
   *
   * @param bbox - The extent, as `[west, south, east, north]` in degrees
   * @returns The rows, each with the ID of its dataset and its index there; the dataset finds
   *   a row by the ID of a snapping target with `draw.datasets.get(datasetId).findRow(id)`
   */
  listTraceRows(bbox: BBox): { datasetId: string; rowIndex: number; row: DatasetRow }[];
}

/**
 * What an extension receives for a point on the screen: a hit test of a custom feature type or a
 * companion (`hitTest`, `boxSelect`), and the snapping candidates of a type or of a provider
 * (`snapCandidates`, `SnapProvider.candidates`). What one reads and the other does not is told
 * here, in `excludeIds`.
 */
export interface PointContext {
  /** The point on the screen, in the frame drawn last */
  point: ScreenPoint;
  /** The position on the map drawn at the point */
  lngLat: Position;
  /** How far from the point a hit or a candidate may be, in pixels */
  tolerancePx: number;
  /** The conversion between the map and the screen, in the frame drawn last */
  screen: ScreenContext;
  /**
   * The IDs of the features this reading leaves out, absent when it leaves out none: for a hit
   * test, the features this client is dragging as a whole; for snapping, those and the features
   * that must not be snapped to, such as the one being drawn
   */
  excludeIds?: ReadonlySet<string>;
}

/**
 * What an extension receives to place the handles of a selected feature (the `handles` of a
 * custom feature type and of a handle provider) and the handles of no feature
 * (`HandleProvider.globalHandles`): the screen, the selection box of the feature, and the look of
 * the selection.
 */
export interface HandleContext {
  /** The conversion between the map and the screen, in the frame drawn last */
  readonly screen: ScreenContext;
  /**
   * The selection box of the feature, as the library draws and hits it, in the frame drawn last
   * (what `draw.rendered.getSelectionBox` answers): its footprint with the margin of
   * `selectionStyle.box` added, so not the footprint itself. A handle placed on it sits on the box
   * drawn. `null` when the feature has nothing to draw, and for the handles of no feature
   */
  readonly selectionBox: Footprint | null;
  /** The look of the selection: the box, and the size and look of every kind of handle */
  readonly selectionStyle: Required<SelectionStyleOptions>;
}
