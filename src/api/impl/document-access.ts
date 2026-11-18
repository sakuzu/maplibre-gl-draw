// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The layer over the Store of an instance (see `DocumentAccess`)
 */

import type { DocumentAccess } from '../../store/document-access.js';
import type { ClientState } from '../../store/memory/ui-state.js';
import type { Store } from '../../store/store.js';
import type {
  BoxSelection,
  DragState,
  Feature,
  FeatureType,
  FileData,
  Group,
  Layer,
  Metadata,
  Mode,
  SelectionType,
  StoreChange,
  TentativeState,
  UpdateFeatureOptions,
  UpdateSource,
  VertexSelection,
} from '../../store/types.js';

/**
 * Makes the layer over a Store: each member calls the member of the same name of the Store, with
 * the same arguments, and returns what it returned. The instance makes one and hands it to its
 * parts.
 *
 * @internal
 */
export function createDocumentAccess(store: Store): DocumentAccess {
  return {
    // The reads of the document
    getFeature: (id: string) => store.getFeature(id),
    listFeatures: () => store.listFeatures(),
    listFeaturesInOrder: () => store.listFeaturesInOrder(),
    getLayer: (id: string) => store.getLayer(id),
    listLayers: () => store.listLayers(),
    getLayerOrder: () => store.getLayerOrder(),
    getGroup: (id: string) => store.getGroup(id),
    listGroups: () => store.listGroups(),
    getFile: (id: string) => store.getFile(id),
    listFiles: () => store.listFiles(),
    getMetadata: () => store.getMetadata(),
    getMaxNameNumber: (type: FeatureType | 'Layer' | 'Group') => store.getMaxNameNumber?.(type),

    // The writes of the document, the transactions and the subscription
    createFeature: (feature: Feature) => store.createFeature(feature),
    updateFeature: (id: string, updates: Partial<Feature>, options?: UpdateFeatureOptions) =>
      store.updateFeature(id, updates, options),
    abortIntermediateUpdates: (ids: string[]) => store.abortIntermediateUpdates?.(ids),
    deleteFeature: (id: string) => store.deleteFeature(id),
    createLayer: (layer: Layer) => store.createLayer(layer),
    updateLayer: (id: string, updates: Partial<Layer>) => store.updateLayer(id, updates),
    deleteLayer: (id: string) => store.deleteLayer(id),
    setLayerOrder: (order: string[]) => store.setLayerOrder(order),
    reorderInLayer: (itemId: string, layerId: string, newIndex: number) =>
      store.reorderInLayer(itemId, layerId, newIndex),
    reorderInGroup: (featureId: string, groupId: string, newIndex: number) =>
      store.reorderInGroup(featureId, groupId, newIndex),
    createGroup: (group: Group) => store.createGroup(group),
    updateGroup: (id: string, updates: Partial<Group>) => store.updateGroup(id, updates),
    deleteGroup: (id: string) => store.deleteGroup(id),
    createFile: (file: FileData) => store.createFile(file),
    deleteFile: (id: string) => store.deleteFile(id),
    setMetadata: (metadata: Partial<Metadata>) => store.setMetadata(metadata),
    recordNameNumber: (type: FeatureType | 'Layer' | 'Group', number: number) =>
      store.recordNameNumber?.(type, number),
    subscribe: (listener: (changes: StoreChange) => void) => store.subscribe(listener),
    transact: <T>(fn: () => T, source?: UpdateSource): T => store.transact(fn, source),

    // The state of this client
    get client(): ClientState {
      return store.client;
    },
    getSelection: () => store.getSelection(),
    setSelection: (type: SelectionType | null, ids: string[]) => store.setSelection(type, ids),
    getEditingIds: () => store.getEditingIds(),
    startEditing: (ids: string[]) => store.startEditing(ids),
    endEditing: (ids: string[]) => store.endEditing(ids),
    getVertexSelection: () => store.getVertexSelection(),
    setSelectedVertices: (selection: VertexSelection | null) =>
      store.setSelectedVertices(selection),
    getMode: () => store.getMode(),
    setMode: (mode: Mode) => store.setMode(mode),
    isReadOnly: () => store.isReadOnly(),
    setReadOnly: (value: boolean) => store.setReadOnly(value),
    isInteractionLocked: () => store.isInteractionLocked(),
    setInteractionLock: (value: boolean) => store.setInteractionLock(value),
    isHidden: (id: string) => store.isHidden(id),
    listHidden: () => store.listHidden(),
    setLocallyHidden: (id: string, hidden: boolean) => store.setLocallyHidden(id, hidden),

    // The drawing state
    getTentative: () => store.getTentative(),
    setTentative: (state: TentativeState | null) => store.setTentative(state),
    getBoxSelection: () => store.getBoxSelection(),
    setBoxSelection: (box: BoxSelection | null) => store.setBoxSelection(box),
    getDragState: () => store.getDragState(),
    setDragState: (state: DragState | null) => store.setDragState(state),
    getFollowedVertices: () => store.getFollowedVertices(),
    setFollowedVertices: (selections: VertexSelection[] | null) =>
      store.setFollowedVertices(selections),
  };
}
