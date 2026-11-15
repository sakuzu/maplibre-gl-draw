// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How the document a storage of the first shape has is read: what is shown, and what is kept aside
 * until its container comes back
 *
 * A storage applies the operations it is sent as they name things (`applyOperations`): what one
 * commit deletes or moves is only what it names. Commits made at the same time, or a commit taken
 * out under later ones, can leave records that no longer fit in one tree: a member of a group whose
 * `maplibre-gl-draw:layerId` is not the layer of its group, a feature whose layer or group is gone,
 * a group with no member. Every client reads such a document by the same rules, so that each shows
 * the same:
 *
 * - A member of a group is in the layer of its group (its `maplibre-gl-draw:layerId` is not read)
 * - A feature whose group is not there is in its own layer (`maplibre-gl-draw:layerId`), at its own
 *   key; it goes back into the group once the group is there again
 * - A feature or a group whose layer is not there is not shown: it is kept, and shown again with
 *   its layer once the layer is there again
 * - A group with no member is not shown: it is kept, and shown once a member comes
 *
 * The Store holds what is shown; what is kept aside is held here (`KeptRecords`), with what the
 * storage has of the place of a feature shown elsewhere than its keys say.
 *
 * @internal
 */

import type { FeatureRecord, GroupRecord, StoredDocument } from './values.js';
import { createStoredDocument } from './values.js';

const LAYER_KEY = 'maplibre-gl-draw:layerId';
const GROUP_KEY = 'maplibre-gl-draw:groupId';

/**
 * Where a record of a feature says it is: its layer and its group
 *
 * @internal
 */
export interface PlacementKeys {
  readonly layerId: string;
  readonly groupId: string | undefined;
}

/**
 * The layer and the group a record of a feature names (`maplibre-gl-draw:layerId` and `groupId`)
 *
 * @internal
 */
export function placementOf(record: FeatureRecord): PlacementKeys {
  const layer = record.properties[LAYER_KEY];
  const group = record.properties[GROUP_KEY];
  return {
    layerId: typeof layer === 'string' ? layer : '',
    groupId: typeof group === 'string' ? group : undefined,
  };
}

/**
 * A record of a feature naming the layer and the group given
 *
 * @internal
 */
export function withPlacement(record: FeatureRecord, keys: PlacementKeys): FeatureRecord {
  const now = placementOf(record);
  if (now.layerId === keys.layerId && now.groupId === keys.groupId) return record;
  const properties = { ...record.properties };
  properties[LAYER_KEY] = keys.layerId;
  if (keys.groupId === undefined) delete properties[GROUP_KEY];
  else properties[GROUP_KEY] = keys.groupId;
  return { ...record, properties };
}

/**
 * What a storage has that the Store does not show, and where the storage has the features shown
 * elsewhere than their keys say
 *
 * @internal
 */
export class KeptRecords {
  /** The features not shown (their layer is not there), as the storage has them */
  readonly features = new Map<string, FeatureRecord>();
  /** The groups not shown (their layer is not there, or they have no member) */
  readonly groups = new Map<string, GroupRecord>();
  /**
   * The keys of the place of features shown elsewhere than they say: a member of a group whose
   * layer key is another layer, a feature whose group is not there
   */
  readonly placements = new Map<string, PlacementKeys>();

  /** Whether nothing is kept */
  get empty(): boolean {
    return this.features.size === 0 && this.groups.size === 0 && this.placements.size === 0;
  }

  /** Gives features other IDs (from the old to the new) */
  rename(ids: ReadonlyMap<string, string>): void {
    for (const [from, to] of ids) {
      const record = this.features.get(from);
      if (record) {
        this.features.delete(from);
        this.features.set(to, record);
      }
      const keys = this.placements.get(from);
      if (keys) {
        this.placements.delete(from);
        this.placements.set(to, keys);
      }
    }
  }

  /** Drops everything (the whole document replaced) */
  clear(): void {
    this.features.clear();
    this.groups.clear();
    this.placements.clear();
  }
}

/**
 * Reads the document a storage has by the rules (see the description of the module): what is
 * shown, each feature with the layer and the group it is shown in, and what is kept aside. One
 * pass over the records; a record shown where its keys say is not copied.
 *
 * @internal
 */
export function readStoredDocument(document: StoredDocument): {
  readonly shown: StoredDocument;
  readonly kept: KeptRecords;
} {
  const shown = createStoredDocument();
  const kept = new KeptRecords();
  shown.title = document.title;
  shown.description = document.description;
  for (const [id, file] of document.files) shown.files.set(id, file);
  for (const [id, layer] of document.layers) shown.layers.set(id, layer);
  // The groups that have a member
  const members = new Set<string>();
  for (const record of document.features.values()) {
    const group = record.properties[GROUP_KEY];
    if (typeof group === 'string' && document.groups.has(group)) members.add(group);
  }
  for (const [id, group] of document.groups) {
    if (document.layers.has(group.layerId) && members.has(id)) shown.groups.set(id, group);
    else kept.groups.set(id, group);
  }
  for (const [id, record] of document.features) {
    const keys = placementOf(record);
    const group = keys.groupId === undefined ? undefined : document.groups.get(keys.groupId);
    const at: PlacementKeys = group
      ? { layerId: group.layerId, groupId: keys.groupId }
      : { layerId: keys.layerId, groupId: undefined };
    if (!document.layers.has(at.layerId)) {
      kept.features.set(id, record);
      continue;
    }
    if (at.layerId === keys.layerId && at.groupId === keys.groupId) {
      shown.features.set(id, record);
      continue;
    }
    shown.features.set(id, withPlacement(record, at));
    kept.placements.set(id, keys);
  }
  return { shown, kept };
}
