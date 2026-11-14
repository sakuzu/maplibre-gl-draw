// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The part that joins the reference model of the Store to a Store of core: the calls of each
 * operation, and the reading of what is compared
 *
 * It is all that knows the Store, and it is kept thin: an operation is one call (or one
 * transaction), and the reading goes through the reads every Store has (the layers held as rows
 * read from their tables, the others from their items), so that another Store, or another way to
 * write the rows, is joined by another function of this shape.
 */

import type { Geometry } from 'geojson';
import { ITEM_GROUP } from '../../api/tables.js';
import type { Store } from '../../store/store.js';
import type { Feature } from '../../store/types.js';
import { compareIds } from './model.js';
import type {
  FeatureValues,
  GroupSnapshot,
  LayerSnapshot,
  TableOperation,
  TableSnapshot,
  TableSubject,
} from './types.js';

/** A Store behind the operations of the model */
export function storeSubject(store: Store, settle?: () => void): TableSubject {
  const apply = (operation: TableOperation): void => {
    switch (operation.op) {
      case 'createLayer':
        store.createLayer({
          ...operation.layer,
          items: [],
          metadata: undefined,
          styleRule: undefined,
        });
        return;
      case 'updateLayer':
        store.updateLayer(operation.id, operation.update);
        return;
      case 'deleteLayer':
        store.deleteLayer(operation.id);
        return;
      case 'setLayerOrder':
        store.setLayerOrder([...operation.order]);
        return;
      case 'createFeature':
        store.createFeature(featureOf(operation.feature));
        return;
      case 'updateFeature':
        store.updateFeature(operation.id, operation.update as Partial<Feature>);
        return;
      case 'deleteFeature':
        store.deleteFeature(operation.id);
        return;
      case 'moveItems':
        store.moveItems(operation.ids, operation.to);
        return;
      case 'createGroup':
        store.createGroup({ ...operation.group, featureIds: [...operation.featureIds] });
        return;
      case 'updateGroup':
        store.updateGroup(operation.id, operation.update);
        return;
      case 'deleteGroup':
        store.deleteGroup(operation.id);
        return;
      case 'selectFeatures':
        store.setSelection(operation.ids.length === 0 ? null : 'feature', [...operation.ids]);
        return;
      case 'transact':
        store.transact(() => {
          for (const inner of operation.operations) apply(inner);
        });
        return;
    }
  };
  return {
    apply,
    read: () => readStore(store),
    ...(settle && { settle }),
  };
}

/** A feature of the model as the Store takes it */
function featureOf(values: FeatureValues): Feature {
  return {
    id: values.id,
    type: values.type,
    geometry: values.geometry,
    layerId: values.layerId,
    groupId: values.groupId,
    properties: { ...values.properties },
    style: { ...values.style },
    visible: values.visible,
    locked: values.locked,
  };
}

/** The items of a layer and the members of its groups, back to front */
function itemsOf(
  store: Store,
  layerId: string,
): { items: string[]; members: Map<string, string[]> } {
  const layer = store.getLayer(layerId);
  const members = new Map<string, string[]>();
  if (!layer) return { items: [], members };
  if (layer.kind !== 'table') {
    for (const id of layer.items) {
      const group = store.getGroup(id);
      if (group && group.kind !== 'table') members.set(id, [...group.featureIds]);
    }
    return { items: [...layer.items], members };
  }
  const tables = store.tables;
  const view = tables?.get(layerId);
  if (!tables || !view) return { items: [], members };
  const listed = view.listItems(0, view.itemCount);
  const items: string[] = [];
  for (let i = 0; i < listed.types.length; i++) {
    const handle = listed.refs[i];
    if (listed.types[i] === ITEM_GROUP) {
      const id = tables.getGroupId(handle) ?? `?group ${handle}`;
      items.push(id);
      const rows = view.listGroupMembers(handle, 0, view.countGroupMembers(handle));
      members.set(
        id,
        Array.from(rows, (row) => tables.getRowId(row) ?? `?row ${row}`),
      );
    } else {
      items.push(tables.getRowId(handle) ?? `?row ${handle}`);
    }
  }
  return { items, members };
}

/** What is compared, read from a Store */
export function readStore(store: Store): TableSnapshot {
  const layerOrder = [...store.getLayerOrder()];
  const layers: LayerSnapshot[] = [];
  const groups: GroupSnapshot[] = [];
  const features: FeatureValues[] = [];
  for (const layerId of layerOrder) {
    const layer = store.getLayer(layerId);
    if (!layer) continue;
    const { items, members } = itemsOf(store, layerId);
    layers.push({
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      items,
    });
    for (const item of items) {
      const group = store.getGroup(item);
      const ids = members.get(item);
      if (group && ids) {
        groups.push({
          id: group.id,
          layerId: group.layerId,
          name: group.name,
          visible: group.visible,
          locked: group.locked,
          members: ids,
        });
      }
      for (const id of ids ?? [item]) {
        const feature = store.getFeature(id);
        if (feature) features.push(valuesOf(feature));
      }
    }
  }
  const selection = store.getSelection();
  // Features selected in bulk are read from their rows
  const bulk = selection.bulk ? store.getSelectedRows() : null;
  const selected = bulk
    ? Array.from(bulk.handles, (row) => store.tables?.getRowId(row) ?? `?row ${row}`)
    : selection.ids;
  return {
    layerOrder,
    layers,
    groups: groups.sort((a, b) => compareIds(a.id, b.id)),
    features: features.sort((a, b) => compareIds(a.id, b.id)),
    selectionType: selection.type,
    selection: [...selected].sort(compareIds),
  };
}

/** The fields of a feature the model holds */
function valuesOf(feature: Feature): FeatureValues {
  return {
    id: feature.id,
    type: feature.type as FeatureValues['type'],
    geometry: feature.geometry as Geometry,
    layerId: feature.layerId,
    groupId: feature.groupId,
    properties: { ...feature.properties } as FeatureValues['properties'],
    style: { ...feature.style } as FeatureValues['style'],
    visible: feature.visible,
    locked: feature.locked,
  };
}
