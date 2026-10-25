// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `Draw`: the draw instance, its resources and the members that belong to no resource
 */

import type { Map as MaplibreMap } from 'maplibre-gl';
import type { DatasetsCollection } from './datasets.js';
import type { DocumentResource } from './document.js';
import type { DrawingResource } from './drawing.js';
import type { DrawEvents } from './events.js';
import type { StoreView, UpdateSource } from './extension/store.js';
import type { ExtensionsCollections } from './extensions.js';
import type { FeaturesCollection } from './features.js';
import type { GroupsCollection } from './groups.js';
import type { HiddenCollection } from './hidden.js';
import { createDraw as createDrawInstance } from './impl/create-draw.js';
import type { LayersCollection } from './layers.js';
import type { MemoryResource } from './memory.js';
import type { MetadataResource } from './metadata.js';
import type { DrawOptions, OptionsResource } from './options.js';
import type { SelectionResource, VertexSelectionResource } from './selection.js';
import type { SketchesCollection } from './sketches.js';
import type { GpuMemoryDiagnostics, LayerStackEntry, Mode, TerrainDiagnostics } from './state.js';

/** The options of {@link Draw.transact} */
export interface TransactOptions {
  /** Where the writes come from; `'local'` when left out */
  source?: UpdateSource;
  /**
   * Whether the writes ignore the locks of the features, groups and layers; read-only still
   * refuses them. False when left out.
   */
  ignoreLocks?: boolean;
}

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
  /** What this client has selected */
  readonly selection: SelectionResource;
  /** The selected vertices of one feature in this client */
  readonly vertexSelection: VertexSelectionResource;
  /** The shape the current drawing mode is drawing, to drive it from code */
  readonly drawing: DrawingResource;
  /** The title and the description of the document */
  readonly metadata: MetadataResource;
  /** The options that can change while the instance runs */
  readonly options: OptionsResource;
  /** The whole document, to load and to write out */
  readonly document: DocumentResource;
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

  // Transactions and events

  /**
   * Runs `fn` as one transaction: its writes arrive as one `document.changed`.
   *
   * In nested calls the source of the outermost call wins. With `ignoreLocks`, the writes of
   * `fn` through the resources of this instance ignore the locks of the features, groups and
   * layers, as a change applied again from a record needs; read-only still refuses them, and
   * what the user does with the pointer and the keys still respects the locks. A nested call
   * inside such a call ignores them as well.
   *
   * @param options - `source` names where the writes come from; `ignoreLocks` lets them
   *   change locked features, groups and layers
   * @returns What `fn` returns
   */
  transact<T>(fn: () => T, options?: TransactOptions): T;
  /**
   * Subscribes to an event.
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

  // Drawing

  /** Whether some drawing work has not finished yet. */
  hasPendingWork(): boolean;
  /** The divisions of the stacking order, one per run of layers. */
  getLayerStack(): readonly LayerStackEntry[];
  /**
   * An image of the map as it is drawn now: the base map, the document (or the document shown in
   * its place) and the datasets, as far as the map shows them, without the state of this client
   * (the selection, its handles, the shape being drawn, the box). The image is taken in the next
   * frame the map draws, which this asks for; the frames after it draw the state of this client
   * again. A size of another shape than the map is covered by the map, cut at its middle.
   *
   * It costs one frame and no other drawing of the document: a thumbnail of a document too large
   * to draw a second time is taken so.
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
   * with the code `invalid-state` (`document.load` rejects with it).
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
