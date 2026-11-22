// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.groups`: the groups of the document
 */

import type { Group as StoredGroup } from '../../store/types.js';
import { DrawError } from '../errors.js';
import type { GroupsCollection } from '../groups.js';
import type { Group, GroupFilter, GroupInput, GroupPatch, MoveTarget } from '../model.js';
import { requireRange } from './layers.js';
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

/** The most groups a list returns at once */
const LIST_LIMIT = 10_000;

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

  /** Every group in stacking order, from the back; a group that stands in no layer comes last */
  const inOrder = (): StoredGroup[] => inStackingOrder(store.listGroups().map((group) => group.id));

  /** The groups of the IDs given in stacking order, from the back */
  const inStackingOrder = (ids: readonly string[]): StoredGroup[] =>
    store
      .sortGroupsInStackingOrder(ids)
      .map((id) => store.getGroup(id))
      .filter((group): group is StoredGroup => group !== undefined);

  const matching = (filter?: GroupFilter): StoredGroup[] => {
    const entries = filterEntries(filter, FILTER_KEYS);
    return inOrder().filter((group) => matches(group, entries));
  };

  const list = (filter?: GroupFilter): Group[] => {
    const groups = matching(filter);
    if (groups.length > LIST_LIMIT) {
      throw new DrawError(
        'tooManyItems',
        `${groups.length} groups match, more than the ${LIST_LIMIT} a list returns; read them with groups.iterate`,
        { count: groups.length },
      );
    }
    return groups;
  };

  /** The groups that match when it starts, each read as it is when the iterator reaches it */
  function* iterate(filter?: GroupFilter): IterableIterator<Group> {
    const ids = matching(filter).map((group) => group.id);
    for (const id of ids) {
      const group = store.getGroup(id);
      if (group) yield group;
    }
  }

  /** Creates a group where its frontmost feature stood, in the transaction of the caller */
  const createOne = ({ group, featureIds }: PreparedGroup): void => {
    store.createGroupWith(group, featureIds);
  };

  return {
    get: (id) => store.getGroup(id),
    getMany(ids) {
      if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
      return ids.map((id) => store.getGroup(id));
    },
    list,
    iterate(filter) {
      // The filter is checked when it is called, not when the iterator first reads
      filterEntries(filter, FILTER_KEYS);
      return iterate(filter);
    },
    count: (filter) => matching(filter).length,
    has: (id) => store.getGroup(id) !== undefined,
    countFeatures(id) {
      return store.countGroupFeatures(require(id).id);
    },
    listFeatureIds(id, range) {
      const group = require(id);
      const { start, end } = requireRange(range);
      return store.listGroupFeatureIds(group.id, start, end);
    },

    create(input) {
      const prepared = prepareGroup(deps, input, new Set(), new Set());
      if (store.isReadOnly()) return null;
      if (store.transactUntilRefused(() => createOne(prepared)) === null) return null;
      return store.getGroup(prepared.group.id) ?? null;
    },

    createMany(inputs) {
      if (!Array.isArray(inputs)) throw invalidInput('The inputs must be an array');
      const pending = new Set<string>();
      const claimed = new Set<string>();
      const prepared = inputs.map((input) => {
        const group = prepareGroup(deps, input, pending, claimed);
        pending.add(group.group.id);
        for (const featureId of group.featureIds) claimed.add(featureId);
        return group;
      });
      if (store.isReadOnly()) return null;
      const written = store.transactUntilRefused(() => {
        for (const group of prepared) createOne(group);
        return true;
      });
      if (written === null) return null;
      return prepared.map(({ group }) => store.getGroup(group.id) as StoredGroup);
    },

    update(id, patch) {
      const group = require(id);
      const updates = prepareGroupPatch(patch);
      if (store.isReadOnly()) return null;
      if (groupLocked(store, group) && !onlyLockOrVisibility(patch)) return null;
      if (!store.updateGroup(group.id, updates)) return null;
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
      const written = store.transactUntilRefused(() => {
        for (const { group, updates } of prepared) store.updateGroup(group.id, updates);
        return true;
      });
      if (written === null) return null;
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
      const written = store.transactUntilRefused(() => {
        for (const group of groups) {
          if (store.getGroup(group.id)) store.deleteGroup(group.id);
        }
        return true;
      });
      return written !== null;
    },

    move(id, to) {
      return moveMany([id], to);
    },

    moveMany,
  };

  function moveMany(ids: readonly string[], to: MoveTarget): boolean {
    const wanted = new Set(requireIds(ids).map((id) => require(id).id));
    const groups = inStackingOrder([...wanted]);
    const target = resolveMoveTarget(store, to);
    if (target.kind !== 'layer') throw invalidInput('A group can only be moved to a layer');
    if (store.isReadOnly()) return false;
    if (target.locked || groups.some((group) => groupLocked(store, group))) return false;
    return moveGroups(store, groups, target.layer, target.index);
  }
}

/** The fields of a group that do not depend on its features */
export type GroupShell = Omit<StoredGroup, 'layerId'>;

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
  input: Omit<GroupInput, 'featureIds'>,
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
  let id: string;
  if (input.id === undefined) {
    id = deps.generateId();
  } else {
    id = requireId(input.id);
    if (isTaken(store, id) || pending.has(id)) {
      throw new DrawError('alreadyExists', `The ID ${JSON.stringify(id)} is already taken`, {
        id,
      });
    }
  }
  return {
    id,
    name: input.name ?? deps.autoNameGenerator.generateGroupName(),
    visible: input.visible ?? true,
    locked: input.locked ?? false,
  };
}

/** A group checked and built from an input, with the IDs of its features in stacking order */
interface PreparedGroup {
  /** The group to store */
  group: StoredGroup;
  /** Its features, from the back */
  featureIds: string[];
}

/** Checks an input and builds the group to store; throws DrawError on a wrong input */
function prepareGroup(
  deps: ResourceDeps,
  input: GroupInput,
  pending: ReadonlySet<string>,
  claimed: ReadonlySet<string>,
): PreparedGroup {
  const { store } = deps;
  requireRecord(input, 'The input');
  const ids = requireIds(input.featureIds, 'featureIds');
  if (ids.length === 0) throw invalidInput('A group needs at least one feature');
  const members = ids.map((featureId) => {
    // The group writes its members: the edit being written in parts is applied to them first
    store.applyEditFirst?.(featureId);
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
  const shell = prepareGroupShell(deps, input, INPUT_KEYS, pending);
  return {
    group: { ...shell, layerId },
    featureIds: store.sortInStackingOrder(ids),
  };
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
