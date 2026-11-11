// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The words of the reference model of the tables: the use the tables are put to, the shapes and
 * values of rows, the steps of a sequence and the operations they become, and what is read of the
 * tables after each
 *
 * The rows have the columns of every use (`MODEL_COLUMNS`): a shape, a type, a look the tables
 * keep the values of, keys and values, and two flags. A row is placed by its parent (a table, or
 * a group of a table) and its key. The uses differ by the points of their shapes: of two values,
 * of three (the third a height), or of two and a time.
 */

import type { CoordinateDimensions } from '@sakuzu/tabane';

/** A use of the tables: what the points of the rows hold, and what places a row again */
export interface ModelUse {
  /** The name of the use, for the tests */
  readonly name: string;
  /** The dimensions of the points of every table */
  readonly dims: CoordinateDimensions;
  /** The fields whose new value places a row again (`relocatingFields`) */
  readonly relocating: readonly string[];
}

/** A depth of a shape */
export type ModelDepth = 0 | 1 | 2 | 3;

/** A shape of a row: points nested `depth` deep, with the name of its form */
export interface ModelShape {
  readonly name: string;
  readonly depth: ModelDepth;
  readonly points: unknown;
}

/** The flags of a row and of a group */
export type ModelFlag = 'hidden' | 'pinned';

/** The values of a row written to the tables (each one written when given) */
export interface ModelRowValues {
  readonly type?: string;
  readonly shape?: ModelShape;
  /** The look of the row, an object (the tables keep these values) */
  readonly look?: Readonly<Record<string, unknown>>;
  /** Keys of the `keyed` column, with their values (undefined takes the key off) */
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly hidden?: boolean;
  readonly pinned?: boolean;
}

/**
 * A step of a sequence: what to do, with the rows, groups and tables picked by number among the
 * ones of the model (the model turns it into an operation, or leaves it out when it cannot be
 * done)
 */
export type ModelStep =
  | {
      readonly kind: 'create';
      readonly row: number;
      readonly parent: number;
      readonly seed: number;
    }
  | {
      readonly kind: 'addBlock';
      readonly table: number;
      readonly rows: number;
      readonly seed: number;
    }
  | {
      readonly kind: 'write';
      readonly row: number;
      readonly field: 'shape' | 'look' | 'type' | 'key' | 'parent' | 'flag' | 'attr' | 'unattr';
      readonly seed: number;
    }
  | { readonly kind: 'delete'; readonly rows: readonly number[]; readonly keep: boolean }
  | { readonly kind: 'restore'; readonly token: number }
  | { readonly kind: 'release'; readonly token: number }
  | { readonly kind: 'forget'; readonly rows: readonly number[] }
  | {
      readonly kind: 'createGroup';
      readonly group: number;
      readonly table: number;
      readonly seed: number;
    }
  | {
      readonly kind: 'writeGroup';
      readonly group: number;
      readonly field: 'key' | 'parent' | 'flag';
      readonly seed: number;
    }
  | { readonly kind: 'deleteGroup'; readonly group: number; readonly keep: boolean }
  | { readonly kind: 'restoreGroup'; readonly token: number };

/** A new row of an operation */
export interface ModelNewRow {
  readonly id: string;
  /** The id of its parent: a table, or a group */
  readonly parent: string;
  readonly key: string;
  readonly values: ModelRowValues & { readonly type: string; readonly shape: ModelShape };
}

/** An operation on the tables, with the ids it names */
export type ModelOperation =
  | { readonly kind: 'createRows'; readonly rows: readonly ModelNewRow[] }
  | { readonly kind: 'addBlock'; readonly table: string; readonly rows: readonly ModelNewRow[] }
  | {
      readonly kind: 'writeRow';
      readonly id: string;
      readonly parent?: string;
      readonly key?: string;
      readonly values: ModelRowValues;
    }
  /** Deletes rows, kept by a new token (its number among the tokens of the run) or by none */
  | { readonly kind: 'deleteRows'; readonly ids: readonly string[]; readonly token: number | null }
  /** Writes rows a token keeps not deleted: they come back as they were */
  | { readonly kind: 'restoreRows'; readonly ids: readonly string[] }
  | { readonly kind: 'release'; readonly token: number }
  | { readonly kind: 'forget'; readonly ids: readonly string[] }
  | {
      readonly kind: 'createGroup';
      readonly id: string;
      readonly handle: number;
      readonly table: string;
      readonly key: string;
      readonly flags: Readonly<Record<ModelFlag, boolean>>;
    }
  | {
      readonly kind: 'writeGroup';
      readonly id: string;
      readonly handle: number;
      readonly key?: string;
      readonly table?: string;
      readonly flags?: Readonly<Partial<Record<ModelFlag, boolean>>>;
    }
  | {
      readonly kind: 'deleteGroup';
      readonly id: string;
      readonly handle: number;
      readonly token: number | null;
    }
  | { readonly kind: 'restoreGroup'; readonly id: string; readonly handle: number };

/** An item of a table as it is read: a row outside a group, or a group with its members */
export type ModelItem =
  | { readonly row: string }
  | { readonly group: string; readonly members: readonly string[] };

/** A row as it is read */
export interface ModelRowRead {
  readonly table: string;
  /** Its group (null outside one) */
  readonly group: string | null;
  readonly key: string;
  readonly type: string;
  readonly shape: ModelShape | null;
  readonly look: unknown;
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly hidden: boolean;
  readonly pinned: boolean;
}

/** A group as it is read */
export interface ModelGroupRead {
  readonly table: string;
  readonly key: string;
  readonly hidden: boolean;
  readonly pinned: boolean;
}

/** What is read of the tables */
export interface ModelSnapshot {
  /** The items of each table, in their order */
  readonly tables: Readonly<Record<string, readonly ModelItem[]>>;
  /** Each row there by its id (`'deleted'`, `'none'` for an id not known or forgotten) */
  readonly rows: Readonly<Record<string, ModelRowRead | 'deleted' | 'none'>>;
  /**
   * Each group the tables hold, by its id: a group not deleted, and a group deleted that a token
   * keeps (it comes back as it was)
   */
  readonly groups: Readonly<Record<string, ModelGroupRead>>;
  /** The rows the tables told that nothing keeps any more, by their ids in order */
  readonly released: readonly string[];
  /** Whether the token of the last write keeps what it deleted (null before any write) */
  readonly kept: boolean | null;
}

/** The tables a sequence runs on, joined to the words of the model */
export interface ModelSubject {
  apply(operation: ModelOperation): void;
  /** Takes in what waits and makes every next version due (after each step) */
  settle(): void;
  read(): ModelSnapshot;
}
