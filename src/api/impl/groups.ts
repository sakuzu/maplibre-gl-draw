// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.groups`: the groups of the document
 */

import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import {
  featuresInStackingOrder,
  groupsInStackingOrder,
  groupsInStackingOrderOf,
  insertGroup,
} from '../../store/item-lists.js';
import type { Store } from '../../store/store.js';
import type {
  ObjectGroup,
  Feature as StoredFeature,
  Group as StoredGroup,
} from '../../store/types.js';
import { DrawError } from '../errors.js';
import type { Group, GroupFilter, GroupInput, GroupPatch, MoveTarget } from '../model.js';
import type { GroupResource } from './group-resource.js';
import { groupMemberIds, rangeOf } from './item-reads.js';
import { moveGroups, resolveMoveTarget } from './placement.js';
import type { ResourceDeps } from './shared.js';
import {
  filterEntries,
  groupLocked,
  invalidInput,
  isTaken,
  layerLocked,
  matches,
  notFound,
  onlyKeys,
  onlyLockOrVisibility,
  optionalBoolean,
  optionalString,
  requireIds,
  requireNewId,
  requireRecord,
} from './shared.js';

const INPUT_KEYS = ['members', 'layerId', 'id', 'name', 'visible', 'locked'] as const;
const PATCH_KEYS = ['name', 'visible', 'locked'] as const;
const FILTER_KEYS = ['layerId', 'visible', 'locked'] as const;

/**
 * Creates `draw.groups`
 *
 * @internal
 */
export function createGroups(deps: ResourceDeps): GroupResource {
  const { store } = deps;

  const require = (id: unknown): StoredGroup => {
    const group = typeof id === 'string' ? store.getGroup(id) : undefined;
    if (!group) throw notFound('group', id);
    return group;
  };

  /** Every group in stacking order, from the back; a group no layer lists comes last */
  const inOrder = (): StoredGroup[] => groupsInStackingOrder(store);

  const list = (filter?: GroupFilter): Group[] => {
    const entries = filterEntries(filter, FILTER_KEYS);
    return inOrder().filter((group) => matches(group, entries));
  };

  // Its members are in stacking order (`prepareGroup`)
  const createOne = (prepared: ObjectGroup): void =>
    insertGroup(store, prepared, { membersInOrder: true });

  return {
    get: (id) => store.getGroup(id),
    getMany(ids) {
      if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
      return ids.map((id) => store.getGroup(id));
    },
    list,
    count: (filter) => list(filter).length,
    has: (id) => store.getGroup(id) !== undefined,
    listMembers(id, options) {
      const group = require(id);
      return groupMemberIds(store, group, rangeOf(options));
    },

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
      store.transact(() => store.createGroups(prepared));
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
        // Each group once
        const there = [...new Set(groups.map((group) => group.id))].filter((id) =>
          store.getGroup(id),
        );
        store.deleteGroups(there);
      });
      return true;
    },

    move(id, to) {
      return moveMany([id], to);
    },

    moveMany,

    restore(id) {
      if (typeof id !== 'string') throw invalidInput('The ID must be a string');
      if (store.getGroup(id)) {
        throw new DrawError(
          'already-exists',
          `There is a group with the ID ${JSON.stringify(id)}`,
          { ids: [id] },
        );
      }
      // A Store of objects keeps no group it deleted; a Store of rows keeps the ones this client
      // deleted, by the token of the deletion, and the ones its deleted rows kept still name
      const internals = featureTablesInternals(store.tables);
      const handle = internals?.groups.handleOfId(id) ?? -1;
      const layerId = handle >= 0 ? internals?.groups.tableOf(handle) : undefined;
      if (layerId === undefined) throw notFound('group kept by a deletion', id);
      const layer = store.getLayer(layerId);
      if (!layer) throw notFound('layer', layerId);
      if (isTaken(store, id)) {
        throw new DrawError('already-exists', `The ID ${JSON.stringify(id)} is already taken`, {
          ids: [id],
        });
      }
      if (store.isReadOnly() || layerLocked(store, layer)) return null;
      // The group the Store kept comes back under its ID, which is not a new one: it is not asked
      // of the Store (Store.acceptsId), as the ID of a new group is
      const shell: GroupShell = {
        id,
        name: deps.autoNameGenerator.generateGroupName(),
        visible: true,
        locked: false,
      };
      // The Store gives it the place it had (the key of its order its rows were kept with)
      store.createGroup({ ...shell, layerId, kind: 'table' });
      return store.getGroup(id) ?? null;
    },
  };

  function moveMany(ids: readonly string[], to: MoveTarget): boolean {
    // In stacking order, read where each of them stands
    const groups = groupsInStackingOrderOf(store, [
      ...new Map(requireIds(ids).map((id) => [id, require(id)])).values(),
    ]);
    const target = resolveMoveTarget(store, to);
    if (target.kind !== 'layer') throw invalidInput('A group can only be moved to a layer');
    if (store.isReadOnly()) return false;
    if (target.locked || groups.some((group) => groupLocked(store, group))) return false;
    moveGroups(store, groups, target.layer, target.place);
    return true;
  }
}

/** The fields of a group that do not depend on its features */
export type GroupShell = Omit<ObjectGroup, 'layerId' | 'featureIds'>;

/**
 * Checks the fields of a group input other than its features and builds them: its ID, taken
 * or generated, its name and its flags; throws DrawError on a wrong input
 *
 * @param keys - The keys the input may have
 * @param pending - The IDs taken by the other entries of the same write
 * @internal
 */
export function prepareGroupShell(
  deps: Pick<ResourceDeps, 'store' | 'generateId' | 'autoNameGenerator'>,
  input: Omit<GroupInput, 'members'>,
  keys: readonly string[],
  pending: ReadonlySet<string>,
): GroupShell {
  const { store } = deps;
  requireRecord(input, 'The input');
  const record = input as unknown as Record<string, unknown>;
  onlyKeys(record, keys, 'The input');
  optionalString(record, 'name');
  optionalBoolean(record, 'visible');
  optionalBoolean(record, 'locked');
  const id = input.id === undefined ? deps.generateId() : requireNewId(store, input.id, pending);
  return {
    id,
    name: input.name ?? deps.autoNameGenerator.generateGroupName(),
    visible: input.visible ?? true,
    locked: input.locked ?? false,
  };
}

/**
 * Checks an input and builds the group to store; throws DrawError on a wrong input
 *
 * @param options - `inOrder: false` leaves its members in the order given (they are put in
 *   stacking order otherwise)
 * @internal
 */
export function prepareGroup(
  deps: ResourceDeps,
  input: GroupInput,
  pending: ReadonlySet<string>,
  claimed: ReadonlySet<string>,
  options?: { readonly inOrder?: boolean },
): ObjectGroup {
  const { store } = deps;
  requireRecord(input, 'The input');
  const ids = requireIds(input.members, 'members');
  optionalString(input as unknown as Record<string, unknown>, 'layerId');
  if (ids.length === 0) throw invalidInput('A group needs at least one feature');
  // Their layers, read without making the features (a group can take many)
  const layers = ids.map((featureId) => {
    const layer = store.getFeatureLayerId(featureId);
    if (layer === undefined) throw notFound('feature', featureId);
    if (claimed.has(featureId)) {
      throw invalidInput(`The feature ${featureId} is in two of the new groups`);
    }
    return layer;
  });
  const layerId = layers[0] as string;
  if (layers.some((layer) => layer !== layerId)) {
    throw invalidInput('The features of a group must be in the same layer');
  }
  if (input.layerId !== undefined && input.layerId !== layerId) {
    throw invalidInput(`The features of the group are not in the layer ${input.layerId}`);
  }
  const shell = prepareGroupShell(deps, input, INPUT_KEYS, pending);
  return {
    ...shell,
    layerId,
    featureIds: options?.inOrder === false ? ids : idsInStackingOrder(store, ids),
  };
}

/**
 * The IDs of features in stacking order, from the back (read by their IDs alone)
 *
 * @internal
 */
export function idsInStackingOrder(store: Store, ids: readonly string[]): string[] {
  return featuresInStackingOrder(
    store,
    ids.map((id) => ({ id }) as StoredFeature),
  ).map((feature) => feature.id);
}

/** Checks a patch and builds the updates of the Store; throws DrawError on a wrong patch */
/** @internal */
export function prepareGroupPatch(patch: GroupPatch): Partial<StoredGroup> {
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
