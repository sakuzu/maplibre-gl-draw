// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Import / export of the native format
 */

import { getDrawProperty } from '../../../shared/properties.js';
import { createOrderKeyBetween } from '../../../store/built-in/order-keys.js';
import type { DocumentAccess, InstanceDocument } from '../../../store/document-access.js';
import type {
  Data,
  ExportOptions,
  Feature,
  FileData,
  Layer,
  LoadResult,
} from '../../../store/types.js';
import { DrawError } from '../../errors.js';
import type { DocumentGroup, DocumentLayer } from '../../model.js';
import { NATIVE_VERSION } from './constants.js';
import { upgradeNativeData } from './native-upgrade.js';
import { validateNativeData } from './native-validation.js';
import type { PreparedLoad } from './types.js';

/** The layer that survives the replacement (it is updated in place when the data has it) */
const DEFAULT_LAYER_ID = 'default-layer';

/** A layer of the document: its fields, with the items it holds after its opacity */
function documentLayerOf(store: InstanceDocument, layer: Layer): DocumentLayer {
  const items = store.listItemIds(layer.id, 0, store.countItems(layer.id));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(layer)) {
    out[key] = (layer as unknown as Record<string, unknown>)[key];
    if (key === 'opacity') out.items = items;
  }
  if (!('items' in out)) out.items = items;
  return out as unknown as DocumentLayer;
}

/**
 * Exports the current data in the native format
 */
export function exportNative(store: InstanceDocument, options?: ExportOptions): Data {
  let features = store.listFeatures();
  const layers = store.listLayers().map((layer) => documentLayerOf(store, layer));
  // A group of the document lists its features, after its other fields
  const groups = store.listGroups().map((group) => ({
    ...group,
    featureIds: store.listGroupFeatureIds(group.id, 0, store.countGroupFeatures(group.id)),
  }));

  if (options?.featureIds && options.featureIds.length > 0) {
    const featureIdSet = new Set(options.featureIds);
    features = features.filter((f) => featureIdSet.has(f.id));
  }
  if (options?.layerIds && options.layerIds.length > 0) {
    const layerIdSet = new Set(options.layerIds);
    features = features.filter((f) => layerIdSet.has(f.layerId));
  }

  // Get only the files that are in use
  const usedFileIds = new Set<string>();
  for (const feature of features) {
    const imageFileId = getDrawProperty(feature, 'imageFileId');
    if (feature.type === 'Image' && imageFileId) {
      usedFileIds.add(imageFileId);
    }
  }

  const files = store.listFiles();
  const filesRecord: Record<string, FileData> = {};
  for (const file of files) {
    if (usedFileIds.has(file.id)) {
      filesRecord[file.id] = file;
    }
  }

  const metadata = store.getMetadata();
  const now = new Date().toISOString();

  return {
    version: NATIVE_VERSION,
    created: now,
    modified: now,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    layers,
    // The whole stacking order, entries of the application that are not layers included
    layerOrder: [...store.getLayerOrder()],
    groups,
    features,
    files: Object.keys(filesRecord).length > 0 ? filesRecord : undefined,
  };
}

/**
 * Reads the native format for a load that replaces the existing data: everything is checked
 * here, and the writes are left to the transaction of the caller
 */
export async function prepareNative(
  data: Data,
  deps: { store: DocumentAccess },
): Promise<PreparedLoad> {
  const { store } = deps;

  // Validate before applying. Since store.transact does not roll back, if an exception
  // is thrown on invalid data after the existing data has been cleared, the existing data
  // is lost. Everything the steps below rely on (the shape of the layers, groups, features
  // and files, the references between them, and the uniqueness of the ids) is checked
  // before the destructive operation, so a problem throws while the existing data is
  // still intact.
  const retainedLayerIds = new Set<string>();
  if (store.getLayer(DEFAULT_LAYER_ID)) retainedLayerIds.add(DEFAULT_LAYER_ID);
  // Data of an earlier major version is brought to the current one first
  const upgraded = upgradeNativeData(data) as Data;
  const { layers, layerOrder, groups, features, files, fileProblems } = await validateNativeData(
    upgraded,
    retainedLayerIds,
  );
  // A file whose image cannot be imported refuses the whole load, as a malformed field does;
  // an image the browser cannot encode is refused as unsupportedFormat, the same as when an
  // image file is loaded
  for (const [key, problem] of fileProblems) {
    throw new DrawError(
      problem.code,
      `Invalid native data: file "${key}" ${problem.detail}`,
      problem.cause === undefined ? undefined : { cause: problem.cause },
    );
  }
  const featureIds = features.map((f) => f.id);
  // A kept layer the data does not list goes to the back, where it stays when the data does
  // not mention it (every layer must be on the stacking order to be drawn)
  const retainedUnlisted = [...retainedLayerIds].filter((id) => !layerOrder.includes(id));

  // The writes, in the transaction of the caller, which makes them one change
  const write = (document: InstanceDocument): LoadResult => {
    // 1. Clear the existing data
    const existingFeatures = store.listFeatures();
    for (const feature of existingFeatures) {
      store.deleteFeature(feature.id);
    }

    const existingGroups = store.listGroups();
    for (const group of existingGroups) {
      store.deleteGroup(group.id);
    }

    const existingLayers = store.listLayers();
    for (const layer of existingLayers) {
      if (layer.id !== DEFAULT_LAYER_ID) {
        store.deleteLayer(layer.id);
      }
    }

    // The files belong to the features that were just removed, and the data brings its own
    // (leaving them would also make a file id of the data collide)
    for (const file of store.listFiles()) {
      store.deleteFile(file.id);
    }

    // 2. Import the layers, with no item yet
    for (const layer of layers) {
      const { items: _items, ...fields } = layer;
      if (store.getLayer(layer.id)) {
        store.updateLayer(layer.id, fields);
      } else {
        store.createLayer(fields);
      }
    }

    // 3. Import the groups and the features at the places the orders of the data give them
    placeItems(document, layers, groups, features);

    // 4. Import the files
    for (const file of files) {
      store.createFile(file);
    }

    // 5. Replace the whole stacking order. Entries that are not layers are replaced too, so
    //    nothing of the previous document is left on it
    store.setLayerOrder([...retainedUnlisted, ...layerOrder]);

    // 6. Import the metadata
    if (upgraded.metadata) {
      store.setMetadata(upgraded.metadata);
    }

    return {
      format: 'native',
      featureIds,
      replaced: true,
    };
  };
  return { write };
}

/**
 * Creates the groups and the features of a document read at the places its orders give them:
 * the keys of the order are made from the orders of the document, from the back of each
 * container. The items of a layer are those its order lists, then the groups no layer lists and
 * the features in no group no order lists, in front of them in the order of the data; the
 * features of a group are those it lists, then the others that name it, in the order of the
 * data. The groups are created with their keys and no feature, then the features in the order of
 * the data, at their keys: one write per layer
 */
function placeItems(
  document: InstanceDocument,
  layers: readonly DocumentLayer[],
  groups: readonly DocumentGroup[],
  features: readonly Feature[],
): void {
  const featureById = new Map(features.map((feature) => [feature.id, feature]));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  /** The key given last in each container */
  const lastKeys = new Map<string, string>();
  const nextKey = (container: string): string => {
    const key = createOrderKeyBetween(lastKeys.get(container), undefined);
    lastKeys.set(container, key);
    return key;
  };
  /** The layer and the key of each group */
  const groupPlaces = new Map<string, { layerId: string; key: string }>();
  const featureKeys = new Map<string, string>();
  const placeGroupIn = (group: DocumentGroup, layerId: string): void => {
    if (!groupPlaces.has(group.id)) groupPlaces.set(group.id, { layerId, key: nextKey(layerId) });
  };
  const placeFeatureIn = (feature: Feature, container: string): void => {
    if (!featureKeys.has(feature.id)) featureKeys.set(feature.id, nextKey(container));
  };
  // The items the orders of the layers list, from the back
  for (const layer of layers) {
    for (const itemId of layer.items) {
      const group = groupById.get(itemId);
      if (group) {
        placeGroupIn(group, layer.id);
        continue;
      }
      const feature = featureById.get(itemId);
      if (feature?.groupId === undefined && feature?.layerId === layer.id) {
        placeFeatureIn(feature, layer.id);
      }
    }
  }
  // In front of them, the groups no layer lists, then the features in no group no order lists
  for (const group of groups) placeGroupIn(group, group.layerId);
  for (const feature of features) {
    if (feature.groupId === undefined) placeFeatureIn(feature, feature.layerId);
  }
  // The features of each group in its order, then the others that name it
  for (const group of groups) {
    for (const id of group.featureIds) {
      const feature = featureById.get(id);
      if (feature?.groupId === group.id) placeFeatureIn(feature, group.id);
    }
  }
  for (const feature of features) placeFeatureIn(feature, feature.groupId ?? feature.layerId);

  for (const group of groups) {
    const { featureIds: _featureIds, ...fields } = group;
    const place = groupPlaces.get(group.id) as { layerId: string; key: string };
    document.placeGroup({ ...fields, layerId: place.layerId }, place.layerId, place.key);
  }
  document.createFeaturesAt(
    features,
    features.map((feature) => ({ key: featureKeys.get(feature.id) as string })),
  );
}
