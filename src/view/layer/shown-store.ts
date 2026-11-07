// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Store the drawing reads (`ShownStore`)
 *
 * The drawing of an instance reads its Store, through this view of it. Two switches change what
 * the view gives:
 *
 * - Another document shown in place of the document (`setShown`): its layers, groups, features,
 *   rows and stacking order are read instead (a document held as rows, read only), and the
 *   document of the instance is not drawn. The Store of the instance goes on taking its changes;
 *   the drawing keeps what it built of it, and draws it again once the other document is no
 *   longer shown.
 * - The state of this client left out (`setEditingHidden`, and while another document is shown):
 *   no selection, no shape being drawn, no box, no drag, no vertex selected, so that the frame
 *   draws the documents only (an image of the map, the other document).
 *
 * The sketches of the document of a Store of objects are read through it as well: a feature a
 * sketch edits is read as the sketches leave it, in its place, and a feature a sketch creates is
 * read in the place it will be created in, while the document is drawn. A Store of rows draws its
 * sketches among its rows.
 *
 * Everything else (the writes, the subscription, the internals of the Store of core) goes to the
 * Store of the instance.
 *
 * What the drawing reads of the shapes it reads from `drawn` (`DrawnShapes`): the shapes as they
 * are seen (`RenderedShapes`) behind these two switches. An image of the map leaves the shape
 * being drawn out, and a document shown in place has no edit under way.
 */

import type { TentativeState } from '../../shared/types/model.js';
import { RenderedShapes } from '../../sketches/rendered-shapes.js';
import { getDisplayFeatures, isLocallyHidden } from '../../store/local-visibility.js';
import type { Store, StoreContractView } from '../../store/store.js';
import type { Feature, Selection } from '../../store/types.js';

/** The reads of the document, given by the document shown in place of the document */
const DOCUMENT_READS: ReadonlySet<PropertyKey> = new Set<keyof StoreContractView>([
  'getFeature',
  'listFeatures',
  'listFeaturesInOrder',
  'getLayer',
  'listLayers',
  'getLayerOrder',
  'getGroup',
  'listGroups',
  'getFile',
  'listFiles',
  'getMetadata',
  'tables',
  'isHidden',
  'listHidden',
]);

const NO_SELECTION: Selection = Object.freeze({ type: null, ids: Object.freeze([]) as never });
const NO_IDS: readonly string[] = Object.freeze([]);
const NO_HIDDEN: ReadonlySet<string> = new Set();
const NO_DRAWINGS: readonly TentativeState[] = Object.freeze([]);

/** The reads of the state of this client, and what they give while it is left out */
const EDITING_READS: ReadonlyMap<PropertyKey, unknown> = new Map<PropertyKey, unknown>([
  ['getSelection', () => NO_SELECTION],
  ['getEditingIds', () => NO_IDS],
  ['getVertexSelection', () => null],
  ['getBoxSelection', () => null],
  ['getDragState', () => null],
  ['getFollowedVertices', () => null],
  ['getSelectedRows', () => null],
  ['isSelectedRowLocked', () => false],
  ['getUnlockedSelectedRows', () => null],
]);

/**
 * The shapes the drawing reads: those of the document shown, as they are seen
 *
 * @internal
 */
export interface DrawnShapes {
  /** A feature as it is seen */
  get(id: string): Feature | undefined;
  /** A feature as it is seen, when it is shown (undefined when hidden, here or for everyone) */
  shown(id: string): Feature | undefined;
  /** The features shown, as they are seen, in the stacking order */
  displayed(): Feature[];
  /** The shapes being drawn, in the order they are drawn */
  drawings(): readonly TentativeState[];
}

/**
 * The Store the drawing reads, and its switches
 *
 * @internal
 */
export interface ShownStore {
  /** The view the drawing reads */
  readonly store: Store;
  /** The shapes the drawing reads */
  readonly drawn: DrawnShapes;
  /** The Store of the instance */
  readonly own: Store;
  /** The document shown in place of the document of the instance (null for none) */
  getShown(): StoreContractView | null;
  /** Shows another document in place of the document of the instance (null: the document again) */
  setShown(other: StoreContractView | null): void;
  /** Whether the state of this client is left out of the drawing */
  isEditingHidden(): boolean;
  /** Leaves the state of this client out of the drawing (or draws it again) */
  setEditingHidden(hidden: boolean): void;
}

/**
 * Creates the view of a Store the drawing reads
 *
 * @internal
 */
export function createShownStore(
  own: Store,
  shapes: RenderedShapes = new RenderedShapes(own),
): ShownStore {
  let shown: StoreContractView | null = null;
  let editingHidden = false;
  /** The methods of the Store of the instance, bound to it (it keeps private fields) */
  const ownMethods = new Map<PropertyKey, unknown>();
  /** The methods of the document shown, bound to it */
  let shownMethods = new Map<PropertyKey, unknown>();
  const boundOf = (
    target: object,
    methods: Map<PropertyKey, unknown>,
    property: PropertyKey,
  ): unknown => {
    const value = Reflect.get(target, property, target);
    if (typeof value !== 'function') return value;
    let bound = methods.get(property);
    if (bound === undefined) {
      bound = (value as (...args: unknown[]) => unknown).bind(target);
      methods.set(property, bound);
    }
    return bound;
  };
  /** The reads of the features with the sketches of a Store of objects */
  const sketchReads = new Map<PropertyKey, unknown>([
    ['getFeature', (id: string): Feature | undefined => shapes.get(id)],
    ['listFeatures', (): Feature[] => shapes.drawnFeatures()],
    ['listFeaturesInOrder', (): Feature[] => shapes.drawnFeaturesInOrder()],
  ]);
  const store = new Proxy(own, {
    get(target, property) {
      if (sketchReads.has(property) && shown === null && shapes.sketched) {
        return sketchReads.get(property);
      }
      if (shown !== null && DOCUMENT_READS.has(property)) {
        if (property === 'listHidden' && typeof shown.listHidden !== 'function')
          return () => NO_HIDDEN;
        return boundOf(shown, shownMethods, property);
      }
      if (shown !== null || editingHidden) {
        const read = EDITING_READS.get(property);
        if (read !== undefined) return read;
      }
      return boundOf(target, ownMethods, property);
    },
  });
  const drawn: DrawnShapes = {
    get: (id) => (shown === null ? shapes.get(id) : (shown.getFeature(id) as Feature | undefined)),
    shown(id) {
      const feature = drawn.get(id);
      return feature?.visible && !isLocallyHidden(feature, store) ? feature : undefined;
    },
    displayed: () => getDisplayFeatures(store),
    drawings: () => (shown === null && !editingHidden ? shapes.drawings() : NO_DRAWINGS),
  };
  return {
    store,
    drawn,
    own,
    getShown: () => shown,
    setShown(other) {
      shown = other;
      shownMethods = new Map();
    },
    isEditingHidden: () => editingHidden,
    setEditingHidden(hidden) {
      editingHidden = hidden;
    },
  };
}
