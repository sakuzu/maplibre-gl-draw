// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reference model of the tables: what a write of rows and of groups means, as plainly as it
 * can be said
 *
 * A table holds rows; a row is placed by its parent (the table, or a group of the table) and its
 * key. The items of a table are its rows outside a group and its groups that hold a row not
 * deleted, in the order of their keys, then of their ids; the members of a group are in the order
 * of their keys, then of their ids. A row deleted is kept by the token it was deleted with, until
 * the token is let go of: written not deleted, it comes back as it was. A row nothing keeps can be
 * forgotten, and its id is then new again; written with all it is made of, it is made again.
 */

import type { CoordinateDimensions } from '@sakuzu/tabane';
import type {
  ModelDepth,
  ModelGroupRead,
  ModelItem,
  ModelNewRow,
  ModelOperation,
  ModelRowRead,
  ModelRowValues,
  ModelShape,
  ModelSnapshot,
  ModelStep,
  ModelUse,
} from './types.js';

/** The tables a sequence uses */
export const TABLE_IDS: readonly string[] = ['t0', 't1', 't2'];

/** The ids of the rows a sequence uses */
export const ROW_IDS: readonly string[] = Array.from({ length: 24 }, (_, i) => `r${i}`);

/** The ids of the groups a sequence uses, and their handles */
export const GROUP_IDS: readonly string[] = Array.from({ length: 6 }, (_, i) => `g${i}`);
export const GROUP_HANDLE_BASE = 1000;

/** The names of the forms of the shapes, by depth */
const FORM_NAMES: readonly string[] = ['dot', 'path', 'area', 'areas'];

/** The types of the rows */
const TYPES: readonly string[] = ['plain', 'note', 'mark'];

/** The keys of the `keyed` column */
const ATTR_KEYS: readonly string[] = ['w', 'h', 'n', 's'];

/** The letters the keys of the order are made of */
const KEY_LETTERS = 'abc';

/** The number of values of a point of each dimensions */
function strideOf(dims: CoordinateDimensions): number {
  return dims.length;
}

/** Numbers from 0 to 1 made from a seed (mulberry32) */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What values are made from: a seed */
class Values {
  private readonly random: () => number;
  constructor(
    seed: number,
    private readonly dims: CoordinateDimensions,
  ) {
    this.random = seededRandom(seed);
  }

  int(n: number): number {
    return Math.floor(this.random() * n);
  }

  key(): string {
    const length = 1 + this.int(2);
    let key = '';
    for (let i = 0; i < length; i++) key += KEY_LETTERS[this.int(KEY_LETTERS.length)];
    return key;
  }

  type(): string {
    return TYPES[this.int(TYPES.length)];
  }

  /** A point: of every value of the dimensions, or now and then of two values only */
  point(): number[] {
    const stride = strideOf(this.dims);
    const length = stride > 2 && this.int(5) === 0 ? 2 : stride;
    return Array.from({ length }, () => (this.int(41) - 20) / 2);
  }

  list(): number[][] {
    return Array.from({ length: 1 + this.int(3) }, () => this.point());
  }

  shape(): ModelShape {
    const depth = this.int(4) as ModelDepth;
    const points =
      depth === 0
        ? this.point()
        : depth === 1
          ? this.list()
          : depth === 2
            ? Array.from({ length: 1 + this.int(2) }, () => this.list())
            : Array.from({ length: 1 + this.int(2) }, () =>
                Array.from({ length: 1 + this.int(2) }, () => this.list()),
              );
    return { name: FORM_NAMES[depth], depth, points };
  }

  look(): Record<string, unknown> {
    const r = this.int(3);
    if (r === 0) return {};
    if (r === 1) return { tone: this.int(3) };
    return { tone: this.int(3), line: 'thin' };
  }

  attrValue(): unknown {
    const r = this.int(4);
    if (r === 0) return this.int(100);
    if (r === 1) return `v${this.int(5)}`;
    if (r === 2) return this.int(2) === 0;
    return null;
  }

  attrs(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of ATTR_KEYS) if (this.int(3) === 0) out[key] = this.attrValue();
    return out;
  }
}

/**
 * A shape as the tables read it back: every point of the values of the dimensions, NaN for a
 * value not given, and a point read without the NaN values at its end (past its first two)
 */
function shapeRead(shape: ModelShape, dims: CoordinateDimensions): ModelShape {
  const stride = strideOf(dims);
  const point = (p: readonly number[]): number[] => {
    const out = Array.from({ length: stride }, (_, k) => (k < p.length ? p[k] : Number.NaN));
    while (out.length > 2 && Number.isNaN(out[out.length - 1])) out.pop();
    return out;
  };
  const nest = (value: unknown, depth: number): unknown =>
    depth === 0
      ? point(value as number[])
      : (value as unknown[]).map((inner) => nest(inner, depth - 1));
  return { name: shape.name, depth: shape.depth, points: nest(shape.points, shape.depth) };
}

/** The order of two strings by their code points (the order of their UTF-8 bytes) */
function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface RowState {
  status: 'live' | 'deleted' | 'none';
  table: string;
  group: string | null;
  key: string;
  type: string;
  shape: ModelShape | null;
  look: unknown;
  attrs: Record<string, unknown>;
  hidden: boolean;
  pinned: boolean;
  /** The token that keeps it deleted (null for none) */
  keptBy: number | null;
}

interface GroupState {
  status: 'live' | 'deleted' | 'none';
  table: string;
  key: string;
  hidden: boolean;
  pinned: boolean;
  keptBy: number | null;
}

/**
 * The model of the tables
 */
export class TablesModel {
  private readonly rows = new Map<string, RowState>();
  private readonly groups = new Map<string, GroupState>();
  /** The rows and the groups each token was given to keep, in the order they were deleted */
  private readonly tokenRows: string[][] = [];
  private readonly tokenGroups: string[][] = [];
  /** The tokens not let go of */
  private readonly liveTokens = new Set<number>();
  private readonly released: string[] = [];
  private kept: boolean | null = null;

  constructor(readonly use: ModelUse) {}

  private rowOf(id: string): RowState | undefined {
    return this.rows.get(id);
  }

  private statusOf(id: string): RowState['status'] {
    return this.rows.get(id)?.status ?? 'none';
  }

  private groupStatusOf(id: string): GroupState['status'] {
    return this.groups.get(id)?.status ?? 'none';
  }

  private liveGroups(): string[] {
    return GROUP_IDS.filter((id) => this.groupStatusOf(id) === 'live');
  }

  /** The parents a row can be given: the tables, and the groups not deleted */
  private parents(): string[] {
    return [...TABLE_IDS, ...this.liveGroups()];
  }

  /** Whether a group is named by a row the tables still hold */
  private named(group: string): boolean {
    for (const row of this.rows.values()) {
      if (row.status !== 'none' && row.group === group) return true;
    }
    return false;
  }

  private newRow(id: string, parent: string, values: Values): ModelNewRow {
    return {
      id,
      parent,
      key: values.key(),
      values: {
        type: values.type(),
        shape: values.shape(),
        look: values.look(),
        attrs: values.attrs(),
        hidden: values.int(4) === 0,
        pinned: values.int(4) === 0,
      },
    };
  }

  /** The operation a step is now (null when it cannot be done) */
  resolve(step: ModelStep): ModelOperation | null {
    const dims = this.use.dims;
    switch (step.kind) {
      case 'create': {
        const id = ROW_IDS[step.row % ROW_IDS.length];
        const row = this.rowOf(id);
        // A new row, or one deleted that nothing keeps (made again from nothing)
        if (row && !(row.status === 'deleted' && row.keptBy === null)) return null;
        const parents = this.parents();
        const values = new Values(step.seed, dims);
        return {
          kind: 'createRows',
          rows: [this.newRow(id, parents[step.parent % parents.length], values)],
        };
      }
      case 'addBlock': {
        const table = TABLE_IDS[step.table % TABLE_IDS.length];
        const values = new Values(step.seed, dims);
        const free = ROW_IDS.filter((id) => this.statusOf(id) === 'none');
        if (free.length === 0) return null;
        const groups = this.liveGroups().filter((g) => this.groups.get(g)?.table === table);
        const parents = [table, ...groups];
        const start = values.int(free.length);
        const ids = [...free.slice(start), ...free.slice(0, start)].slice(0, 1 + (step.rows % 4));
        const rows = ids.map((id) => this.newRow(id, parents[values.int(parents.length)], values));
        return { kind: 'addBlock', table, rows };
      }
      case 'write': {
        const live = ROW_IDS.filter((id) => this.statusOf(id) === 'live');
        if (live.length === 0) return null;
        const id = live[step.row % live.length];
        const row = this.rowOf(id) as RowState;
        const values = new Values(step.seed, dims);
        switch (step.field) {
          case 'shape':
            return { kind: 'writeRow', id, values: { shape: values.shape() } };
          case 'look':
            return { kind: 'writeRow', id, values: { look: values.look() } };
          case 'type':
            return { kind: 'writeRow', id, values: { type: values.type() } };
          case 'key':
            return { kind: 'writeRow', id, key: values.key(), values: {} };
          case 'parent': {
            const parents = this.parents();
            return {
              kind: 'writeRow',
              id,
              parent: parents[values.int(parents.length)],
              values: {},
            };
          }
          case 'flag':
            return values.int(2) === 0
              ? { kind: 'writeRow', id, values: { hidden: !row.hidden } }
              : { kind: 'writeRow', id, values: { pinned: !row.pinned } };
          case 'attr':
            return {
              kind: 'writeRow',
              id,
              values: { attrs: { [ATTR_KEYS[values.int(ATTR_KEYS.length)]]: values.attrValue() } },
            };
          case 'unattr': {
            const keys = Object.keys(row.attrs);
            const key = keys.length > 0 ? keys[values.int(keys.length)] : ATTR_KEYS[values.int(4)];
            return { kind: 'writeRow', id, values: { attrs: { [key]: undefined } } };
          }
        }
        return null;
      }
      case 'delete': {
        const live = ROW_IDS.filter((id) => this.statusOf(id) === 'live');
        if (live.length === 0) return null;
        const ids = [...new Set(step.rows.map((r) => live[r % live.length]))];
        return { kind: 'deleteRows', ids, token: step.keep ? this.tokenRows.length : null };
      }
      case 'restore': {
        const tokens = [...this.liveTokens].filter((token) =>
          this.tokenRows[token].some((id) => this.rowOf(id)?.keptBy === token),
        );
        if (tokens.length === 0) return null;
        const token = tokens[step.token % tokens.length];
        const ids = this.tokenRows[token].filter((id) => this.rowOf(id)?.keptBy === token);
        return { kind: 'restoreRows', ids };
      }
      case 'release': {
        const tokens = [...this.liveTokens];
        if (tokens.length === 0) return null;
        return { kind: 'release', token: tokens[step.token % tokens.length] };
      }
      case 'forget': {
        const loose = ROW_IDS.filter((id) => {
          const row = this.rowOf(id);
          return row?.status === 'deleted' && row.keptBy === null;
        });
        if (loose.length === 0) return null;
        return { kind: 'forget', ids: [...new Set(step.rows.map((r) => loose[r % loose.length]))] };
      }
      case 'createGroup': {
        const id = GROUP_IDS[step.group % GROUP_IDS.length];
        if (this.groupStatusOf(id) !== 'none') return null;
        const values = new Values(step.seed, dims);
        return {
          kind: 'createGroup',
          id,
          handle: GROUP_HANDLE_BASE + GROUP_IDS.indexOf(id),
          table: TABLE_IDS[step.table % TABLE_IDS.length],
          key: values.key(),
          flags: { hidden: values.int(4) === 0, pinned: values.int(4) === 0 },
        };
      }
      case 'writeGroup': {
        const live = this.liveGroups();
        if (live.length === 0) return null;
        const id = live[step.group % live.length];
        const group = this.groups.get(id) as GroupState;
        const handle = GROUP_HANDLE_BASE + GROUP_IDS.indexOf(id);
        const values = new Values(step.seed, dims);
        switch (step.field) {
          case 'key':
            return { kind: 'writeGroup', id, handle, key: values.key() };
          case 'parent':
            return {
              kind: 'writeGroup',
              id,
              handle,
              table: TABLE_IDS[values.int(TABLE_IDS.length)],
            };
          case 'flag':
            return values.int(2) === 0
              ? { kind: 'writeGroup', id, handle, flags: { hidden: !group.hidden } }
              : { kind: 'writeGroup', id, handle, flags: { pinned: !group.pinned } };
        }
        return null;
      }
      case 'deleteGroup': {
        // A group no row names: what is done of the rows of a group deleted is the user's
        const free = this.liveGroups().filter((id) => !this.named(id));
        if (free.length === 0) return null;
        const id = free[step.group % free.length];
        return {
          kind: 'deleteGroup',
          id,
          handle: GROUP_HANDLE_BASE + GROUP_IDS.indexOf(id),
          token: step.keep ? this.tokenRows.length : null,
        };
      }
      case 'restoreGroup': {
        const kept = GROUP_IDS.filter((id) => {
          const group = this.groups.get(id);
          return group?.status === 'deleted' && group.keptBy !== null;
        });
        if (kept.length === 0) return null;
        const id = kept[step.token % kept.length];
        return { kind: 'restoreGroup', id, handle: GROUP_HANDLE_BASE + GROUP_IDS.indexOf(id) };
      }
    }
  }

  /** Places a row by its parent */
  private place(row: { table: string; group: string | null }, parent: string): void {
    const group = this.groups.get(parent);
    if (group && GROUP_IDS.includes(parent)) {
      row.table = group.table;
      row.group = parent;
    } else {
      row.table = parent;
      row.group = null;
    }
  }

  private writeValues(row: RowState, values: ModelRowValues): void {
    if (values.type !== undefined) row.type = values.type;
    if (values.shape !== undefined) row.shape = shapeRead(values.shape, this.use.dims);
    if (values.look !== undefined) row.look = values.look;
    if (values.hidden !== undefined) row.hidden = values.hidden;
    if (values.pinned !== undefined) row.pinned = values.pinned;
    for (const [key, value] of Object.entries(values.attrs ?? {})) {
      if (value === undefined) delete row.attrs[key];
      else row.attrs[key] = value;
    }
  }

  private newToken(token: number | null): void {
    if (token === null) return;
    this.tokenRows[token] = [];
    this.tokenGroups[token] = [];
    this.liveTokens.add(token);
  }

  /** Does an operation */
  apply(operation: ModelOperation): void {
    switch (operation.kind) {
      case 'createRows':
      case 'addBlock': {
        for (const { id, parent, key, values } of operation.rows) {
          const row: RowState = {
            status: 'live',
            table: '',
            group: null,
            key,
            type: '',
            shape: null,
            look: {},
            attrs: {},
            hidden: false,
            pinned: false,
            keptBy: null,
          };
          this.place(row, parent);
          this.writeValues(row, values);
          this.rows.set(id, row);
        }
        this.kept = false;
        return;
      }
      case 'writeRow': {
        const row = this.rowOf(operation.id) as RowState;
        if (operation.parent !== undefined) this.place(row, operation.parent);
        if (operation.key !== undefined) row.key = operation.key;
        this.writeValues(row, operation.values);
        this.kept = false;
        return;
      }
      case 'deleteRows': {
        this.newToken(operation.token);
        for (const id of operation.ids) {
          const row = this.rowOf(id) as RowState;
          row.status = 'deleted';
          row.keptBy = operation.token;
          if (operation.token !== null) this.tokenRows[operation.token].push(id);
        }
        this.kept = operation.token !== null && operation.ids.length > 0;
        return;
      }
      case 'restoreRows': {
        for (const id of operation.ids) {
          const row = this.rowOf(id) as RowState;
          row.status = 'live';
          row.keptBy = null;
        }
        this.kept = false;
        return;
      }
      case 'release': {
        const token = operation.token;
        this.liveTokens.delete(token);
        for (const id of this.tokenRows[token]) {
          const row = this.rowOf(id);
          if (row?.keptBy !== token) continue;
          row.keptBy = null;
          this.released.push(id);
        }
        for (const id of this.tokenGroups[token]) {
          const group = this.groups.get(id);
          if (group?.keptBy !== token) continue;
          group.keptBy = null;
          // A group deleted that no row names is taken out
          group.status = 'none';
        }
        return;
      }
      case 'forget': {
        for (const id of operation.ids) {
          const row = this.rowOf(id) as RowState;
          row.status = 'none';
        }
        return;
      }
      case 'createGroup': {
        this.groups.set(operation.id, {
          status: 'live',
          table: operation.table,
          key: operation.key,
          hidden: operation.flags.hidden,
          pinned: operation.flags.pinned,
          keptBy: null,
        });
        this.kept = false;
        return;
      }
      case 'writeGroup': {
        const group = this.groups.get(operation.id) as GroupState;
        if (operation.key !== undefined) group.key = operation.key;
        if (operation.flags?.hidden !== undefined) group.hidden = operation.flags.hidden;
        if (operation.flags?.pinned !== undefined) group.pinned = operation.flags.pinned;
        if (operation.table !== undefined) {
          group.table = operation.table;
          // The rows of the group go with it
          for (const row of this.rows.values()) {
            if (row.status !== 'none' && row.group === operation.id) row.table = operation.table;
          }
        }
        this.kept = false;
        return;
      }
      case 'deleteGroup': {
        this.newToken(operation.token);
        const group = this.groups.get(operation.id) as GroupState;
        if (operation.token === null) {
          group.status = 'none';
        } else {
          group.status = 'deleted';
          group.keptBy = operation.token;
          this.tokenGroups[operation.token].push(operation.id);
        }
        this.kept = operation.token !== null;
        return;
      }
      case 'restoreGroup': {
        const group = this.groups.get(operation.id) as GroupState;
        group.status = 'live';
        group.keptBy = null;
        this.kept = false;
        return;
      }
    }
  }

  /** What the tables give to read now */
  snapshot(): ModelSnapshot {
    const tables: Record<string, ModelItem[]> = {};
    for (const table of TABLE_IDS) {
      const items: Array<{ key: string; id: string; item: ModelItem }> = [];
      const members = new Map<string, Array<{ key: string; id: string }>>();
      for (const [id, row] of this.rows) {
        if (row.status !== 'live' || row.table !== table) continue;
        if (row.group === null) items.push({ key: row.key, id, item: { row: id } });
        else {
          let list = members.get(row.group);
          if (!list) {
            list = [];
            members.set(row.group, list);
          }
          list.push({ key: row.key, id });
        }
      }
      for (const [group, list] of members) {
        list.sort((a, b) => compareCodePoints(a.key, b.key) || compareCodePoints(a.id, b.id));
        const state = this.groups.get(group) as GroupState;
        items.push({
          key: state.key,
          id: group,
          item: { group, members: list.map(({ id }) => id) },
        });
      }
      items.sort((a, b) => compareCodePoints(a.key, b.key) || compareCodePoints(a.id, b.id));
      tables[table] = items.map(({ item }) => item);
    }
    const rows: Record<string, ModelRowRead | 'deleted' | 'none'> = {};
    for (const id of ROW_IDS) {
      const row = this.rows.get(id);
      if (!row || row.status === 'none') rows[id] = 'none';
      else if (row.status === 'deleted') rows[id] = 'deleted';
      else {
        rows[id] = {
          table: row.table,
          group: row.group,
          key: row.key,
          type: row.type,
          shape: row.shape,
          look: row.look,
          attrs: { ...row.attrs },
          hidden: row.hidden,
          pinned: row.pinned,
        };
      }
    }
    const groups: Record<string, ModelGroupRead> = {};
    for (const id of GROUP_IDS) {
      const group = this.groups.get(id);
      if (!group || group.status === 'none') continue;
      groups[id] = {
        table: group.table,
        key: group.key,
        hidden: group.hidden,
        pinned: group.pinned,
      };
    }
    return { tables, rows, groups, released: [...this.released], kept: this.kept };
  }
}
