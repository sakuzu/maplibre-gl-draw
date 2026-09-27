// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `Draw`: the draw instance, its resources and the members that belong to no resource
 */

import type { Map as MaplibreMap } from 'maplibre-gl';
import type { DatasetsCollection } from './datasets.js';
import type { DocumentResource } from './document.js';
import type { DrawEvents } from './events.js';
import type { StoreView } from './extension/store.js';
import type { ExtensionsCollections } from './extensions.js';
import type { FeaturesCollection } from './features.js';
import type { GroupsCollection } from './groups.js';
import type { HiddenCollection } from './hidden.js';
import type { LayersCollection } from './layers.js';
import type { MetadataResource } from './metadata.js';
import type { DrawOptions, OptionsResource } from './options.js';
import type { SelectionResource, VertexSelectionResource } from './selection.js';
import type { LayerStackEntry, Mode, TerrainDiagnostics } from './state.js';

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
  /** What this client has selected */
  readonly selection: SelectionResource;
  /** The selected vertices of one feature in this client */
  readonly vertexSelection: VertexSelectionResource;
  /** The title and the description of the document */
  readonly metadata: MetadataResource;
  /** The options that can change while the instance runs */
  readonly options: OptionsResource;
  /** The whole document, to load and to write out */
  readonly document: DocumentResource;
  /** The plugins, modes, feature types, overlays and providers */
  readonly extensions: ExtensionsCollections;

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
   * In nested calls the source of the outermost call wins.
   *
   * @param options - `source` names where the writes come from
   * @returns What `fn` returns
   */
  transact<T>(fn: () => T, options?: { source?: string }): T;
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
  /** Diagnostics; their fields follow the drawing and carry a weaker promise. */
  readonly debug: {
    /** The state the terrain was drawn with. */
    terrain(): TerrainDiagnostics;
  };

  // Lifecycle

  /** Removes the instance from the map and releases everything it holds. */
  destroy(): void;
}

/**
 * The function that puts a draw instance on a map.
 *
 * @param map - The map to draw on
 * @param options - The options
 * @returns The draw instance
 */
export type CreateDraw = (map: MaplibreMap, options?: DrawOptions) => Draw;

/** Puts a draw instance on a map and returns it. */
export declare const createDraw: CreateDraw;
