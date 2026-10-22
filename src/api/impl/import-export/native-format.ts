// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Import / export of the native format
 */

import { rewriteReferences, type Value } from '@sakuzu/tabane';
import { getDrawProperty } from '../../../shared/properties.js';
import { setOwnProperty } from '../../../shared/utils/own-property.js';
import {
  deleteFeaturesAndGroups,
  featuresInOrder,
  listedGroups,
  listedLayers,
} from '../../../store/feature-stream.js';
import type { Store } from '../../../store/store.js';
import type {
  Data,
  ExportOptions,
  Feature,
  FileData,
  Group,
  Layer,
  LoadResult,
} from '../../../store/types.js';
import { DrawError } from '../../errors.js';
import { NATIVE_VERSION } from './constants.js';
import { upgradeNativeData } from './native-upgrade.js';
import { validateNativeData } from './native-validation.js';
import type { PreparedLoad } from './types.js';

/** The layer that survives the replacement (it is updated in place when the data has it) */
const DEFAULT_LAYER_ID = 'default-layer';

/**
 * Exports the current data in the native format
 */
export function exportNative(store: Store, options?: ExportOptions): Data {
  // A Store of rows: its features made from its rows one at a time, in the order they are drawn.
  // Every layer and group is written with the items and the members it lists (those of a layer
  // held as rows read from its rows): the format has no layer of rows
  let features = store.tables ? [...featuresInOrder(store)] : store.listFeatures();
  const layers = listedLayers(store);
  const groups = listedGroups(store);

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
  deps: { store: Store; generateId?: () => string },
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
  // an image the browser cannot encode is refused as unsupported-format, the same as when an
  // image file is loaded
  for (const [key, problem] of fileProblems) {
    throw new DrawError(
      problem.code,
      `Invalid native data: file "${key}" ${problem.detail}`,
      problem.cause === undefined ? undefined : { cause: problem.cause },
    );
  }
  // The layers, groups and features whose ids the Store does not take get new ones
  renameRefusedIds(store, deps.generateId, layers, groups, features, layerOrder);
  const featureIds = features.map((f) => f.id);
  // A kept layer the data does not list goes to the back, where it stays when the data does
  // not mention it (every layer must be on the stacking order to be drawn)
  const retainedUnlisted = [...retainedLayerIds].filter((id) => !layerOrder.includes(id));

  // The writes, in the transaction of the caller, which makes them one change
  const write = (): LoadResult => {
    // 1. Clear the existing data
    deleteFeaturesAndGroups(store);

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

    // 2. Import the layers
    for (const layer of layers) {
      if (store.getLayer(layer.id)) {
        store.updateLayer(layer.id, layer);
      } else {
        store.createLayer(layer);
      }
    }

    // 3. Import the groups
    for (const group of groups) {
      store.createGroup(group);
    }

    // 4. Import the features
    for (const feature of features) {
      store.createFeature(feature);
    }

    // 5. Import the files
    for (const file of files) {
      store.createFile(file);
    }

    // 6. Replace the whole stacking order. Entries that are not layers are replaced too, so
    //    nothing of the previous document is left on it
    store.setLayerOrder([...retainedUnlisted, ...layerOrder]);

    // 7. Import the metadata
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
 * Gives the layers, groups and features of the data whose ids the Store does not take
 * (`Store.acceptsId`) new ids, and makes every reference to them name the new ones: the layer and
 * the group of a feature, the layer of a group, the items of a layer, the members of a group, the
 * stacking order, and the references in the properties of the features. The data is changed in
 * place
 */
function renameRefusedIds(
  store: Store,
  generateId: (() => string) | undefined,
  layers: Layer[],
  groups: Group[],
  features: Feature[],
  layerOrder: string[],
): void {
  const renamed: Record<string, string> = {};
  if (!store.acceptsId || !generateId) return;
  const used = new Set<string>();
  for (const list of [layers, groups, features]) for (const item of list) used.add(item.id);
  const newId = (): string => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = generateId();
      if (!used.has(id) && store.acceptsId?.(id) !== false) {
        used.add(id);
        return id;
      }
    }
    throw new DrawError('invalid-input', 'Failed to generate an id the store takes');
  };
  for (const list of [layers, groups, features]) {
    for (const item of list) {
      if (store.getLayer(item.id) || store.acceptsId(item.id)) continue;
      setOwnProperty(renamed, item.id, newId());
    }
  }
  if (Object.keys(renamed).length === 0) return;
  const to = (id: string): string =>
    (Object.getOwnPropertyDescriptor(renamed, id)?.value as string | undefined) ?? id;
  layers.forEach((layer, i) => {
    const items = (layer as { items?: readonly string[] }).items;
    layers[i] = { ...layer, id: to(layer.id), ...(items && { items: items.map(to) }) } as Layer;
  });
  groups.forEach((group, i) => {
    const members = (group as { featureIds?: readonly string[] }).featureIds;
    groups[i] = {
      ...group,
      id: to(group.id),
      layerId: to(group.layerId),
      ...(members && { featureIds: members.map(to) }),
    } as Group;
  });
  features.forEach((feature, i) => {
    features[i] = {
      ...feature,
      id: to(feature.id),
      layerId: to(feature.layerId),
      ...(feature.groupId !== undefined && { groupId: to(feature.groupId) }),
      properties: rewriteReferences(feature.properties as Value, renamed) as Feature['properties'],
    };
  });
  layerOrder.splice(0, layerOrder.length, ...layerOrder.map(to));
}
