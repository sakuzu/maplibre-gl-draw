// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `Draw`: the draw instance, its resources and the members that belong to no resource
 */

import type { Map as MaplibreMap } from 'maplibre-gl';
import type { Store } from '../store/built-in/types.js';
import type { DatasetsCollection } from './datasets.js';
import type { DocumentResource } from './document.js';
import type { DrawingResource } from './drawing.js';
import type { DrawEvents } from './events.js';
import type { UpdateSource } from './extension/store.js';
import type { ExtensionsCollections } from './extensions.js';
import type { FeaturesCollection } from './features.js';
import type { GroupsCollection } from './groups.js';
import type { HiddenCollection } from './hidden.js';
import { createDraw as createDrawInstance } from './impl/create-draw.js';
import type { LayersCollection } from './layers.js';
import type { MetadataResource } from './metadata.js';
import type { EditingFeaturesResource } from './model.js';
import type { DrawOptions, OptionsResource } from './options.js';
import type { SelectionResource, VertexSelectionResource } from './selection.js';
import type { LayerStackEntry, Mode, TerrainDiagnostics } from './state.js';

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
  /** The features this client marks as being edited in a field of an extension */
  readonly editingFeatures: EditingFeaturesResource;
  /** The shape the current drawing mode is drawing, to drive it from code */
  readonly drawing: DrawingResource;
  /** The title and the description of the document */
  readonly metadata: MetadataResource;
  /** The options that can change while the instance runs */
  readonly options: OptionsResource;
  /** The whole document, to load, to follow its changes and to write out */
  readonly document: DocumentResource;
  /** The plugins, modes, feature types, overlays and providers */
  readonly extensions: ExtensionsCollections;

  // The map and the Store

  /** The map the instance draws on. */
  getMap(): MaplibreMap;
  /**
   * The Store that keeps the document: the one given in the `store` option, or the one the
   * instance made (the `/store` entry). It is for an application that keeps the document
   * somewhere of its own, and for writing into the document a change made outside this
   * instance, such as one the application read from elsewhere: such a change is drawn on a
   * client that only views the document as well.
   *
   * An edit of the user is not written there: a write to the Store does not go through the
   * checks of this instance (read-only and the locks). Only a change made outside the instance
   * goes to the Store directly, with the source `'remote'`: a large document built in a Worker
   * and opened so too. The source `'load'` is that of `draw.document.load` alone.
   * The edits, the writing back of the values a change had before (`features.restore`) and the
   * bulk edits go through the resources of this instance. The state of this client (the
   * selection, the mode, read-only, the interaction lock, the hidden items, the editing and the
   * vertex selection) is read and changed through this instance, not through the Store.
   */
  getStore(): Store;

  // Mode

  /** The current mode. */
  getMode(): Mode;
  /**
   * Changes the mode.
   *
   * @returns False when the mode cannot be entered now
   * @throws `DrawError` with the code `notFound` when there is no mode with this name
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
  /** Diagnostics; their fields follow the drawing and carry a weaker promise. */
  readonly debug: {
    /** The state the terrain was drawn with. */
    terrain(): TerrainDiagnostics;
  };

  // Lifecycle

  /**
   * Removes the instance from the map and releases everything it holds. A second call does
   * nothing; every other method of the instance and of its collections then throws `DrawError`
   * with the code `invalidState` (`document.load` rejects with it).
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
