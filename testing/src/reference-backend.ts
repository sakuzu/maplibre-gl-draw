// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reference storage: a storage of the first shape that keeps the document in memory
 */

import {
  type Answer,
  applyOperations,
  type Backend,
  type BackendContext,
  createPartCollector,
  createStoredDocument,
  type FeatureRecord,
  type LayerRecord,
  type StoredDocument,
  type ValueBatch,
  type ValueOperation,
} from '@sakuzu/maplibre-gl-draw/extend';

/** A document of the library, as `load` gives it */
type LoadedDocument = Extract<
  Awaited<ReturnType<Backend['load']>>,
  { readonly layerOrder: unknown }
>;

const LAYER_KEY = 'maplibre-gl-draw:layerId';
const GROUP_KEY = 'maplibre-gl-draw:groupId';

/**
 * A storage of the first shape that keeps the document in memory: the ground of the tests of a
 * storage and of the examples. It holds what a storage has to:
 *
 * - The parts of a commit are applied once every part is there (`createPartCollector`), in the
 *   one way the operations apply (`applyOperations`)
 * - A batch whose `Batch.id` it applied is not applied again: a batch sent again is answered as
 *   the first time
 * - `abandon` lets go of the parts of a commit received so far
 *
 * `load` gives the document as a document of the library: its layers, groups and features in the
 * order of their keys. Such a document carries no keys of the order, so `connect` gives them
 * right after the document is open, as `place` operations through `context.receive`: the
 * instance then holds the keys the storage holds, and what is made here and what is received later
 * stand in the same order on both sides.
 *
 * Once connected, it gives the result of each commit it applies, in its order, through
 * `context.receive({ commit, operations })`: a commit of this client applied after a commit made
 * elsewhere that wrote one of its keys holds here what the storage holds.
 */
export function createReferenceBackend(): Backend & { readonly document: StoredDocument } {
  const document = createStoredDocument();
  const collector = createPartCollector();
  // The batches of the commits applied, by their ID: a batch sent again is not applied again
  const applied = new Set<string>();
  // The batches of the commits not complete, by commit
  const received = new Map<string, Set<string>>();
  let connected: BackendContext | null = null;
  return {
    document,
    async load() {
      return documentOf(document);
    },
    async connect(context: BackendContext) {
      connected = context;
      await context.receive({ operations: keysOf(document) });
      return () => {
        if (connected === context) connected = null;
      };
    },
    async send(batch: ValueBatch): Promise<Answer> {
      const last = batch.part.index === batch.part.count - 1;
      if (applied.has(batch.id)) return last ? { status: 'accepted' } : { status: 'partial' };
      const operations = collector.add(batch);
      if (operations === null) {
        const ids = received.get(batch.commit) ?? new Set<string>();
        received.set(batch.commit, ids);
        ids.add(batch.id);
        return { status: 'partial' };
      }
      applyOperations(document, operations);
      for (const id of received.get(batch.commit) ?? []) applied.add(id);
      received.delete(batch.commit);
      applied.add(batch.id);
      // The result of the commit, in the order the storage applied it
      if (connected) await connected.receive({ commit: batch.commit, operations });
      return { status: 'accepted' };
    },
    async abandon(commit: string) {
      collector.abandon(commit);
      received.delete(commit);
    },
  };
}

/** The IDs of records in the order of their keys */
function byKey(records: Iterable<readonly [string, { readonly key: string }]>): string[] {
  return [...records]
    .sort(([a, x], [b, y]) => (x.key < y.key ? -1 : x.key > y.key ? 1 : a < b ? -1 : 1))
    .map(([id]) => id);
}

/**
 * What the document shows, by parent: a group with a member in a layer there, a feature whose
 * layer (its group's, when its group is shown) is there
 */
function shownOf(document: StoredDocument) {
  const members = new Set<string>();
  for (const record of document.features.values()) {
    const group = record.properties[GROUP_KEY];
    if (typeof group === 'string') members.add(group);
  }
  const groups = [...document.groups].filter(
    ([id, group]) => members.has(id) && document.layers.has(group.layerId),
  );
  const shownGroups = new Map(groups);
  const underLayer = new Map<string, [string, { key: string }][]>();
  const underGroup = new Map<string, [string, { key: string }][]>();
  const put = (
    map: Map<string, [string, { key: string }][]>,
    parent: string,
    item: [string, { key: string }],
  ) => {
    const items = map.get(parent) ?? [];
    map.set(parent, items);
    items.push(item);
  };
  for (const [id, group] of groups) put(underLayer, group.layerId, [id, group]);
  for (const [id, record] of document.features) {
    const groupId = record.properties[GROUP_KEY];
    const group = typeof groupId === 'string' ? shownGroups.get(groupId) : undefined;
    if (group && typeof groupId === 'string') {
      put(underGroup, groupId, [id, record]);
      continue;
    }
    const layerId = record.properties[LAYER_KEY];
    if (typeof layerId === 'string' && document.layers.has(layerId))
      put(underLayer, layerId, [id, record]);
  }
  return { groups, underLayer, underGroup };
}

/** The document as a document of the library, in the order of the keys */
function documentOf(document: StoredDocument): LoadedDocument {
  const { groups, underLayer, underGroup } = shownOf(document);
  const layerOrder = byKey(document.layers);
  // The features in the order they are shown, from the back (a Store of rows reads that order)
  const shown: string[] = [];
  for (const layerId of layerOrder) {
    for (const id of byKey(underLayer.get(layerId) ?? [])) {
      if (document.features.has(id)) shown.push(id);
      else shown.push(...byKey(underGroup.get(id) ?? []));
    }
  }
  return {
    version: '4.0.0',
    metadata: {
      ...(document.title !== '' && { title: document.title }),
      ...(document.description !== '' && { description: document.description }),
    },
    layerOrder,
    layers: layerOrder.map((id) => {
      const layer = document.layers.get(id) as LayerRecord;
      return {
        id,
        name: layer.name,
        visible: layer.visible,
        locked: layer.locked,
        opacity: layer.opacity,
        styleRule: ruleOf(layer.styleRule),
        metadata: undefined,
        items: byKey(underLayer.get(id) ?? []),
      };
    }),
    groups: groups.map(([id, group]) => ({
      id,
      layerId: group.layerId,
      name: group.name,
      visible: group.visible,
      locked: group.locked,
      featureIds: byKey(underGroup.get(id) ?? []),
    })),
    // The values of a feature are those of the feature the library reads
    features: shown.map((id) => {
      const record = document.features.get(id) as FeatureRecord;
      return {
        type: 'Feature' as const,
        id,
        geometry: record.geometry,
        properties: record.properties,
      };
    }) as LoadedDocument['features'],
    files: Object.fromEntries(
      [...document.files].map(([id, file]) => [
        id,
        { id, mimeType: file.mediaType, dataURL: `data:${file.mediaType};base64,${file.content}` },
      ]),
    ),
  };
}

/** The keys of the order of the layers and of the items under each parent, as `place` operations */
function keysOf(document: StoredDocument): ValueOperation[] {
  const { underLayer, underGroup } = shownOf(document);
  const layers = byKey(document.layers);
  const operations: ValueOperation[] = [];
  if (layers.length > 0) {
    operations.push({
      type: 'place',
      kind: 'layer',
      ids: layers,
      parentId: null,
      keys: layers.map((id) => (document.layers.get(id) as LayerRecord).key),
    });
  }
  const places = (parent: string, items: readonly [string, { key: string }][]): void => {
    const groups = items.filter(([id]) => document.groups.has(id) && !document.features.has(id));
    const features = items.filter(([id]) => document.features.has(id));
    for (const [kind, of] of [
      ['group', groups],
      ['feature', features],
    ] as const) {
      if (of.length === 0) continue;
      operations.push({
        type: 'place',
        kind,
        ids: of.map(([id]) => id),
        parentId: parent,
        keys: of.map(([, record]) => record.key),
      });
    }
  };
  for (const [layer, items] of underLayer) places(layer, items);
  for (const [group, items] of underGroup) places(group, items);
  return operations;
}

/** The style rule of a layer as the library reads it */
function ruleOf(rule: LayerRecord['styleRule']) {
  if (!rule) return undefined;
  switch (rule.type) {
    case 'single':
      return { kind: 'single' as const, color: rule.color };
    case 'categorical':
      return {
        kind: 'categorical' as const,
        property: rule.property,
        map: { ...rule.colors },
        other: rule.other,
      };
    case 'graduated':
      return {
        kind: 'graduated' as const,
        property: rule.property,
        breaks: [...rule.breaks],
        colors: [...rule.colors],
        other: rule.other,
      };
    case 'continuous':
      return {
        kind: 'continuous' as const,
        property: rule.property,
        min: rule.min,
        max: rule.max,
        ramp: [rule.ramp[0], rule.ramp[1]] as [string, string],
        other: rule.other,
      };
  }
}
