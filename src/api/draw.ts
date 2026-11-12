// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `Draw`: the draw instance, its resources and the members that belong to no resource
 */

import type { Map as MaplibreMap } from 'maplibre-gl';
import type { DatasetsCollection } from './datasets.js';
import type { DocumentResource } from './document.js';
import type { Drawing, DrawingResource } from './drawing.js';
import type { DrawEvents, Observable } from './events.js';
import type { StoreView } from './extension/store.js';
import type { ExtensionsCollections } from './extensions.js';
import type { FeaturesCollection } from './features.js';
import type { GroupsCollection } from './groups.js';
import type { HiddenCollection } from './hidden.js';
import { createDraw as createDrawInstance } from './impl/create-draw.js';
import type { LayersCollection } from './layers.js';
import type { MemoryResource } from './memory.js';
import type { DrawOptions, OptionsResource } from './options.js';
import type { RenderedResource } from './rendered.js';
import type { SelectionResource, VertexSelectionResource } from './selection.js';
import type { SketchesCollection } from './sketches.js';
import type { GpuMemoryDiagnostics, LayerStackEntry, Mode, TerrainDiagnostics } from './state.js';
import type { View } from './view.js';
import type {
  OpenResult,
  OpenSource,
  TaskOptions,
  Transaction,
  Write,
  WriteOptions,
} from './write.js';

/** The options of {@link Draw.captureImage} */
export interface CaptureImageOptions {
  /**
   * The width of the image in pixels (the width of the canvas of the map when left out, or the
   * one that keeps its shape with `height`)
   */
  width?: number;
  /** The height of the image in pixels (the one that keeps the shape of the map when left out) */
  height?: number;
  /** The type of the image, as a canvas encodes it (`'image/png'` when left out) */
  type?: string;
  /** The quality of a type that loses detail (`'image/jpeg'`, `'image/webp'`), from 0 to 1 */
  quality?: number;
}

/**
 * A draw instance on a map: the collections and resources of the document and of this
 * client, and the members that belong to no resource.
 */
export interface Draw {
  // Resources

  /** The features of the document */
  readonly features: FeaturesCollection;
  /** The layers of the document */
  readonly layers: LayersCollection;
  /** The groups of the document */
  readonly groups: GroupsCollection;
  /** The large data that is drawn but not edited, outside the document */
  readonly datasets: DatasetsCollection;
  /** What this client hides without changing the document */
  readonly hidden: HiddenCollection;
  /** The edits drawn over the document before they are written */
  readonly sketches: SketchesCollection;
  /** The features as this client draws them, with the sketches, and their selection boxes */
  readonly rendered: RenderedResource;
  /** What this client has selected */
  readonly selection: SelectionResource;
  /** The selected vertices of one feature in this client */
  readonly vertexSelection: VertexSelectionResource;
  /** The shape the current drawing mode is drawing, to drive it from code */
  readonly drawing: DrawingResource;
  /** The options that can change while the instance runs */
  readonly options: OptionsResource;
  /** The whole document, to load and to write out */
  readonly document: DocumentResource;
  /** What this client shows in place of the document */
  readonly view: View;
  /** The plugins, modes, feature types, overlays and providers */
  readonly extensions: ExtensionsCollections;
  /** The memory the documents drawn on the page take, against the limit of the device */
  readonly memory: MemoryResource;

  // The map and the Store

  /** The map the instance draws on. */
  getMap(): MaplibreMap;
  /** The Store, to read the document and the state and to subscribe to their changes. */
  getStore(): StoreView;

  // Mode

  /**
   * The current mode, told again each time it changes (what `getMode` returns), the way to change
   * it, and the shape a drawing mode is drawing, driven from code
   */
  readonly mode: Observable<Mode> & {
    /**
     * Changes the mode. Nothing changes for a drawing mode while the interaction lock is on or
     * while no layer can be written. With `repeat`, a drawing mode stays the current one once it
     * has created a feature (or asked for an image), ready for the next; Escape still leaves it.
     *
     * @throws `DrawError` with the code `not-found` when there is no mode with this name, or
     *   `invalid-input` when an option has the wrong type
     */
    set(mode: Mode, options?: { readonly repeat?: boolean }): void;
    /** The shape the current drawing mode is drawing, driven from code */
    readonly drawing: Drawing;
  };
  /** The current mode. */
  getMode(): Mode;
  /**
   * Changes the mode.
   *
   * @returns False when the mode cannot be entered now
   * @throws `DrawError` with the code `not-found` when there is no mode with this name
   */
  setMode(mode: Mode): boolean;

  // Read-only and interaction lock

  /** Whether the document is read-only. */
  isReadOnly(): boolean;
  /** Turns read-only on or off. */
  setReadOnly(value: boolean): void;
  /** Whether the interaction lock is on. */
  isInteractionLocked(): boolean;
  /** Turns the interaction lock on or off. */
  setInteractionLocked(value: boolean): void;

  // Writing

  /**
   * Makes one transaction: the writes of `fn` are kept in its transaction `tx` and committed at
   * once when `fn` ends. A commit is one step of undo, one `change`, and one commit of the
   * document.
   *
   * There is no lock: the commits are made in the order their functions end, and the later one
   * stays. `fn` is not run again. A write of `fn` that fails fails the whole transaction (even when
   * `fn` catches its error), and nothing is committed; a write whose target is gone when it is
   * committed (a feature deleted from elsewhere) is left out, counted in `result.skipped`.
   *
   * The commit is always made after `write` returns, for one feature as for many: a read made
   * before the promise settles reads the document before it. Stopped by `signal` before it is
   * committed, nothing is written. Keep `fn` short: make the long calls (a `fetch`) before it.
   *
   * Calling `write` in the synchronous part of `fn` throws `nested-write`: give `tx` to a function
   * instead.
   *
   * ```ts
   * const point = await draw.write((tx) =>
   *   tx.features.create({ type: 'Feature', geometry: { type: 'Point', coordinates: [139.7, 35.7] }, properties: {} }),
   * );
   * ```
   *
   * @returns A promise of what `fn` returned, settled once the commit is made here
   * @throws `DrawError` with the code `nested-write` when called in the synchronous part of the
   *   function of another write
   */
  write<T>(fn: (tx: Transaction) => T | Promise<T>, options?: WriteOptions): Write<T>;
  /**
   * Takes back the last commit of this client: a commit of its own, told with the source `undo`.
   *
   * @throws `DrawError` (the promise rejects) with the code `invalid-state` when there is nothing
   *   to undo
   */
  undo(options?: TaskOptions): Write<void>;
  /**
   * Makes again the last commit undone, told with the source `redo`.
   *
   * @throws `DrawError` (the promise rejects) with the code `invalid-state` when there is nothing
   *   to redo
   */
  redo(options?: TaskOptions): Write<void>;
  /**
   * Replaces the whole document with what a source holds: a document of the library replaces
   * everything, GeoJSON replaces the features and the groups and keeps the layers. It is one
   * `change` with the source `open`, and the steps of undo are dropped. A source is added to the
   * document with `tx.import`.
   *
   * @throws `DrawError` (the promise rejects) with the code `unsupported-format` when the source
   *   cannot be read, `invalid-input` when it is not valid, `not-editable` when the document is
   *   read-only, or `invalid-state` when no source is given (there is no storage to open from)
   */
  open(source?: OpenSource, options?: TaskOptions): Promise<OpenResult>;

  // Events
  /**
   * Subscribes to an event.
   *
   * @returns The function that unsubscribes
   * @throws `DrawError` with the code `invalid-input` when there is no event of this name
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

  // Drawing

  /** Whether some drawing work has not finished yet. */
  hasPendingWork(): boolean;
  /** The divisions of the stacking order, one per run of layers. */
  getLayerStack(): readonly LayerStackEntry[];
  /**
   * An image of the map as it is drawn now: the base map, the document (or the document shown in
   * its place) and the datasets, as far as the map shows them, without the state of this client
   * (the selection, its handles, the shape being drawn, the box). The document is drawn in it as
   * it is written: the sketches of every owner (`draw.sketches`) are not drawn, so what a drag or
   * the arrow keys move is drawn where it was before, and a shape being drawn is not drawn. The
   * image is taken in the next draw of the map, which this asks for; the draws after it draw the
   * state of this client and the sketches again. A size of another shape than the map is covered
   * by the map, cut at its middle.
   *
   * It costs one draw of the map and no other drawing of the document: a thumbnail of a document
   * too large to draw a second time is taken so.
   *
   * @returns The image, once encoded
   * @throws `DrawError` (the promise rejects) with the code `invalid-input` when an option has the
   *   wrong type, or `invalid-state` when there is no canvas to copy the map onto or the type
   *   cannot be encoded
   */
  captureImage(options?: CaptureImageOptions): Promise<Blob>;
  /** Diagnostics; their fields follow the drawing and carry a weaker promise. */
  readonly debug: {
    /** The state the terrain was drawn with. */
    terrain(): TerrainDiagnostics;
    /** The GPU memory the drawing holds. */
    gpu(): GpuMemoryDiagnostics;
  };

  // Lifecycle

  /**
   * Removes the instance from the map and releases everything it holds. A second call does
   * nothing; every other method of the instance and of its collections then throws `DrawError`
   * with the code `invalid-state` (`write`, `open`, `undo` and `redo` reject with it).
   */
  destroy(): void;
}

/**
 * Puts a draw instance on a map and returns it.
 *
 * It can be called before, while or after the map loads. The layers are added on top of the map
 * as soon as the style accepts them. After `setStyle`, with or without `diff`, they are on top
 * again: added again after a full replacement, and moved above the layers of the new style after
 * a diff. A layer added to the map later goes above them and stays there until the style changes.
 * Unless `initDefaultLayer: false` is given, the document starts with one empty layer. Several
 * instances can share a page, each on its own map.
 *
 * @param map - The map to draw on
 * @param options - The options; every one can be omitted
 * @returns The draw instance
 */
export function createDraw(map: MaplibreMap, options?: DrawOptions): Draw {
  return createDrawInstance(map, options);
}
