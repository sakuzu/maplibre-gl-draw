// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values of rows and of groups as core names them, and as the tables of `@sakuzu/kasane`
 * name them: the one place core turns the ones into the others
 *
 * Core names the rows and the groups of its values by their handles (`RowValues.handles`,
 * `TableGroupPatch.handles`, `GroupEntry.handle`), as its entries give them; the tables name them
 * by their references (`rows`, `groups`, `group`). The arrays are not copied.
 *
 * A pure module: it depends on nothing but `@sakuzu/kasane` and the types of `shared/`, so it
 * runs in a Worker as well.
 */

import type {
  RowField,
  GroupEntry as TablesGroupEntry,
  TableGroupPatch as TablesGroupPatch,
  PageBuilderOptions as TablesPageBuilderOptions,
  PageMerge as TablesPageMerge,
  RowValues as TablesRowValues,
} from '@sakuzu/kasane';
import type { RowValues, TableGroupPatch } from '../shared/types/model.js';

/**
 * A group the rows can belong to: its handle, its id and the key of its order
 */
export interface GroupEntry {
  /** The handle of the group, which a row names */
  readonly handle: number;
  /** The id of the group */
  readonly id: string;
  /** The key of the order of the group among the items of its layer */
  readonly key: string;
}

/**
 * The options of `createPageBuilder`: those of the builder of the tables, the groups named by
 * their handles
 */
export interface PageBuilderOptions extends Omit<TablesPageBuilderOptions, 'groups'> {
  /** The groups the rows can belong to (none when omitted) */
  readonly groups?: readonly GroupEntry[];
}

/**
 * What `mergePages` merges: what the merge of the tables merges, the groups named by their
 * handles
 */
export interface PageMerge extends Omit<TablesPageMerge, 'groups'> {
  /** The groups the rows name (their keys order their members) */
  readonly groups?: readonly GroupEntry[] | null;
}

/**
 * Values of rows as the tables take them
 *
 * @internal
 */
export function tablesValuesOf(values: RowValues): TablesRowValues {
  return values.deleted
    ? { rows: values.handles, fields: values.fields, deleted: values.deleted }
    : { rows: values.handles, fields: values.fields };
}

/**
 * Values of rows the tables read, as core gives them
 *
 * @internal
 */
export function rowValuesOfTables(values: TablesRowValues): RowValues {
  return values.deleted
    ? { handles: values.rows, fields: values.fields, deleted: values.deleted }
    : { handles: values.rows, fields: values.fields };
}

/**
 * What a check of the shape of values of rows given by a caller is given: the values as the
 * tables name them when they are an object, anything else as it is
 *
 * @internal
 */
export function tablesValuesToCheck(values: unknown): unknown {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return values;
  const { handles, fields, deleted } = values as Partial<RowValues>;
  return deleted === undefined ? { rows: handles, fields } : { rows: handles, fields, deleted };
}

/**
 * The fields the tables read for values of rows (`Tables.readValues`): their fields, and
 * `deleted` when they hold the deletion
 *
 * @internal
 */
export function fieldsToRead(values: RowValues): RowField[] {
  const fields = [...values.fields.keys()];
  if (values.deleted) fields.push('deleted');
  return fields;
}

/**
 * Values of groups as the tables take them
 *
 * @internal
 */
export function tablesGroupPatchOf(patch: TableGroupPatch): TablesGroupPatch {
  return patch.deleted
    ? { groups: patch.handles, fields: patch.fields, deleted: patch.deleted }
    : { groups: patch.handles, fields: patch.fields };
}

/**
 * Groups as the builder and the merge of the tables take them
 *
 * @internal
 */
export function tablesGroupsOf(groups: readonly GroupEntry[]): TablesGroupEntry[] {
  return groups.map(({ handle, id, key }) => ({ group: handle, id, key }));
}

/**
 * Groups the tables give, as core gives them
 *
 * @internal
 */
export function groupsOfTables(groups: readonly TablesGroupEntry[]): GroupEntry[] {
  return groups.map(({ group, id, key }) => ({ handle: group, id, key }));
}

/**
 * The options of the builder as the builder of the tables takes them
 *
 * @internal
 */
export function tablesBuilderOptionsOf(options: PageBuilderOptions): TablesPageBuilderOptions {
  const { groups, ...rest } = options;
  return groups ? { ...rest, groups: tablesGroupsOf(groups) } : rest;
}

/**
 * A merge as the merge of the tables takes it
 *
 * @internal
 */
export function tablesMergeOf(merge: PageMerge): TablesPageMerge {
  const { groups, ...rest } = merge;
  return groups ? { ...rest, groups: tablesGroupsOf(groups) } : rest;
}
