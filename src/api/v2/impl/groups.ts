// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.groups`: the groups of the document
 */

import { listEveryFeatureInOrder } from '../../../store/ordering.js';
import type { Store } from '../../../store/store.js';
import type { Feature as StoredFeature, Group as StoredGroup } from '../../../store/types.js';
import { DrawError } from '../errors.js';
import type { GroupsCollection } from '../groups.js';
import type { Group, GroupFilter, GroupInput, GroupPatch, MoveTarget } from '../model.js';
import { moveGroups, resolveMoveTarget } from './placement.js';
import type { ResourceDeps } from './shared.js';
import {
  filterEntries,
  groupLocked,
  invalidInput,
  isTaken,
  matches,
  notFound,
  onlyKeys,
  onlyLockOrVisibility,
  optionalBoolean,
  optionalString,
  requireId,
  requireIds,
  requireRecord,
} from './shared.js';

const INPUT_KEYS = ['featureIds', 'id', 'name', 'visible', 'locked'] as const;
const PATCH_KEYS = ['name', 'visible', 'locked'] as const;
const FILTER_KEYS = ['layerId', 'visible', 'locked'] as const;

/**
 * Creates `draw.groups`
 *
 * @internal
 */
export function createGroups(deps: ResourceDeps): GroupsCollection {
  const { store } = deps;

  const require = (id: unknown): StoredGroup => {
    const group = typeof id === 'string' ? store.getGroup(id) : undefined;
    if (!group) throw notFound('group', id);
    return group;
  };

  /** Every group in stacking order, from the back; a group no layer lists comes last */
  const inOrder = (): StoredGroup[] => {
    const result: StoredGroup[] = [];
    for (const layerId of store.getLayerOrder()) {
      for (const itemId of store.getLayer(layerId)?.items ?? []) {
        const group = store.getGroup(itemId);
        if (group) result.push(group);
      }
    }
    if (result.length < store.listGroups().length) {
      const listed = new Set(result.map((group) => group.id));
      result.push(...store.listGroups().filter((group) => !listed.has(group.id)));
    }
    return result;
  };

  const list = (filter?: GroupFilter): Group[] => {
    const entries = filterEntries(filter, FILTER_KEYS);
    return inOrder().filter((group) => matches(group, entries));
  };

  /** Creates a prepared group where its frontmost member was */
  const createOne = (prepared: StoredGroup): void => {
    const members = new Set(prepared.featureIds);
    const layer = store.getLayer(prepared.layerId);
    if (layer) {
      // The group takes the place of its frontmost member standing in the layer
      let at = -1;
      for (let i = layer.items.length - 1; i >= 0; i--) {
        if (members.has(layer.items[i])) {
          at = i;
          break;
        }
      }
      const items: string[] = [];
      layer.items.forEach((itemId, i) => {
        if (i === at) items.push(prepared.id);
        if (!members.has(itemId)) items.push(itemId);
      });
      if (at === -1) items.push(prepared.id);
      store.updateLayer(layer.id, { items });
    }
    store.createGroup(prepared);
  };

  return {
    get: (id) => store.getGroup(id),
    getMany(ids) {
      if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
      return ids.map((id) => store.getGroup(id));
    },
    list,
    count: (filter) => list(filter).length,
    has: (id) => store.getGroup(id) !== undefined,

    create(input) {
      const prepared = prepareGroup(deps, input, new Set(), new Set());
      if (store.isReadOnly()) return null;
      store.transact(() => createOne(prepared));
      return store.getGroup(prepared.id) ?? null;
    },

    createMany(inputs) {
      if (!Array.isArray(inputs)) throw invalidInput('The inputs must be an array');
      const pending = new Set<string>();
      const claimed = new Set<string>();
      const prepared = inputs.map((input) => {
        const group = prepareGroup(deps, input, pending, claimed);
        pending.add(group.id);
        for (const featureId of group.featureIds) claimed.add(featureId);
        return group;
      });
      if (store.isReadOnly()) return null;
      store.transact(() => {
        for (const group of prepared) createOne(group);
      });
      return prepared.map((group) => store.getGroup(group.id) as StoredGroup);
    },

    update(id, patch) {
      const group = require(id);
      const updates = prepareGroupPatch(patch);
      if (store.isReadOnly()) return null;
      if (groupLocked(store, group) && !onlyLockOrVisibility(patch)) return null;
      store.updateGroup(group.id, updates);
      return store.getGroup(group.id) ?? null;
    },

    updateMany(patches) {
      if (!Array.isArray(patches)) throw invalidInput('The patches must be an array');
      const seen = new Set<string>();
      const prepared = patches.map((entry) => {
        requireRecord(entry, 'Each entry');
        const group = require((entry as { id: unknown }).id);
        if (seen.has(group.id)) throw invalidInput(`The ID ${group.id} is given twice`);
        seen.add(group.id);
        return { group, patch: entry.patch, updates: prepareGroupPatch(entry.patch) };
      });
      if (store.isReadOnly()) return null;
      const refused = prepared.some(
        ({ group, patch }) => groupLocked(store, group) && !onlyLockOrVisibility(patch),
      );
      if (refused) return null;
      store.transact(() => {
        for (const { group, updates } of prepared) store.updateGroup(group.id, updates);
      });
      return prepared.map(({ group }) => store.getGroup(group.id) as StoredGroup);
    },

    delete(id) {
      const group = require(id);
      if (store.isReadOnly() || groupLocked(store, group)) return false;
      // The Store puts the features where the group was in its layer
      return store.deleteGroup(group.id);
    },

    deleteMany(ids) {
      const groups = requireIds(ids).map(require);
      if (store.isReadOnly() || groups.some((group) => groupLocked(store, group))) return false;
      store.transact(() => {
        for (const group of groups) {
          if (store.getGroup(group.id)) store.deleteGroup(group.id);
        }
      });
      return true;
    },

    move(id, to) {
      return moveMany([id], to);
    },

    moveMany,
  };

  function moveMany(ids: readonly string[], to: MoveTarget): boolean {
    const wanted = new Set(requireIds(ids).map((id) => require(id).id));
    const groups = inOrder().filter((group) => wanted.has(group.id));
    const target = resolveMoveTarget(store, to);
    if (target.kind !== 'layer') throw invalidInput('A group can only be moved to a layer');
    if (store.isReadOnly()) return false;
    if (target.locked || groups.some((group) => groupLocked(store, group))) return false;
    moveGroups(store, groups, target.layer, target.index);
    return true;
  }
}

/** Checks an input and builds the group to store; throws DrawError on a wrong input */
function prepareGroup(
  deps: ResourceDeps,
  input: GroupInput,
  pending: ReadonlySet<string>,
  claimed: ReadonlySet<string>,
): StoredGroup {
  const { store } = deps;
  requireRecord(input, 'The input');
  const record = input as unknown as Record<string, unknown>;
  onlyKeys(record, INPUT_KEYS, 'The input');
  optionalString(record, 'name');
  optionalBoolean(record, 'visible');
  optionalBoolean(record, 'locked');
  const ids = requireIds(input.featureIds, 'featureIds');
  if (ids.length === 0) throw invalidInput('A group needs at least one feature');
  const members = ids.map((featureId) => {
    const feature = store.getFeature(featureId);
    if (!feature) throw notFound('feature', featureId);
    if (claimed.has(featureId)) {
      throw invalidInput(`The feature ${featureId} is in two of the new groups`);
    }
    return feature;
  });
  const layerId = members[0].layerId;
  if (members.some((feature) => feature.layerId !== layerId)) {
    throw invalidInput('The features of a group must be in the same layer');
  }

  let id: string;
  if (input.id === undefined) {
    id = deps.generateId();
  } else {
    id = requireId(input.id);
    if (isTaken(store, id) || pending.has(id)) {
      throw new DrawError('already-exists', `The ID ${JSON.stringify(id)} is already taken`, {
        id,
      });
    }
  }

  return {
    id,
    layerId,
    name: input.name ?? deps.autoNameGenerator.generateGroupName(),
    featureIds: inStackingOrder(store, members).map((feature) => feature.id),
    visible: input.visible ?? true,
    locked: input.locked ?? false,
  };
}

/** The features in stacking order, from the back */
function inStackingOrder(store: Store, features: StoredFeature[]): StoredFeature[] {
  const position = new Map(listEveryFeatureInOrder(store).map((f, index) => [f.id, index]));
  return [...features].sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
}

/** Checks a patch and builds the updates of the Store; throws DrawError on a wrong patch */
function prepareGroupPatch(patch: GroupPatch): Partial<StoredGroup> {
  requireRecord(patch, 'The patch');
  const record = patch as unknown as Record<string, unknown>;
  onlyKeys(record, PATCH_KEYS, 'The patch');
  optionalString(record, 'name');
  optionalBoolean(record, 'visible');
  optionalBoolean(record, 'locked');
  const updates: Partial<StoredGroup> = {};
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.visible !== undefined) updates.visible = patch.visible;
  if (patch.locked !== undefined) updates.locked = patch.locked;
  return updates;
}
