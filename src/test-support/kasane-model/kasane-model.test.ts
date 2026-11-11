// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tables compared with their reference model, after every step
 *
 * Every sequence runs in three uses of the tables, which differ by the points of their shapes:
 * a plane (two values a point, the type placing a row again), a space with a height (three
 * values), and a plane in time (two values and a time). The same words answer in each.
 *
 * The sequences written by hand come first, each for what a write must keep; then sequences
 * made from fixed seeds. With `KASANE_MODEL_REPORT` set, a seed that fails is printed, made
 * short.
 */

import { describe, expect, it } from 'vitest';
import {
  type ModelNewRow,
  type ModelOperation,
  type ModelShape,
  type ModelUse,
  randomModelSteps,
  runModelOperations,
  runModelSteps,
  shrinkModelSteps,
  tablesSubject,
} from './index.js';

const USES: readonly ModelUse[] = [
  { name: 'a plane', dims: 'xy', relocating: ['type'] },
  { name: 'a space with a height', dims: 'xyz', relocating: [] },
  { name: 'a plane in time', dims: 'xym', relocating: [] },
];

/** A shape of one point, of the values given */
function dot(...point: number[]): ModelShape {
  return { name: 'dot', depth: 0, points: point };
}

/** A shape of a list of points */
function path(...points: number[][]): ModelShape {
  return { name: 'path', depth: 1, points };
}

/** A shape of lists of points */
function area(...lists: number[][][]): ModelShape {
  return { name: 'area', depth: 2, points: lists };
}

/** A point of every value of the dimensions of a use */
function pointOf(use: ModelUse, x: number, y: number): number[] {
  return use.dims === 'xy' ? [x, y] : [x, y, x + y];
}

/** A new row */
function row(
  id: string,
  parent: string,
  key: string,
  shape: ModelShape,
  type = 'plain',
): ModelNewRow {
  return {
    id,
    parent,
    key,
    values: { type, shape, look: { tone: 1 }, attrs: { n: 1 }, hidden: false, pinned: false },
  };
}

function create(...rows: ModelNewRow[]): ModelOperation {
  return { kind: 'createRows', rows };
}

/** The sequences written by hand, each with what it keeps */
const SEQUENCES: ReadonlyArray<{
  readonly name: string;
  readonly operations: (use: ModelUse) => readonly ModelOperation[];
}> = [
  {
    name: 'places the items of a table by their keys, then their ids',
    operations: (use) => [
      create(
        row('r1', 't0', 'b', dot(...pointOf(use, 1, 1))),
        row('r0', 't0', 'b', dot(...pointOf(use, 0, 0))),
        row('r2', 't0', 'a', path(pointOf(use, 0, 0), pointOf(use, 1, 2))),
      ),
      { kind: 'writeRow', id: 'r2', key: 'c', values: {} },
    ],
  },
  {
    name: 'puts the members of a group at the key of the group, in the order of their keys',
    operations: (use) => [
      {
        kind: 'createGroup',
        id: 'g0',
        handle: 1000,
        table: 't0',
        key: 'b',
        flags: { hidden: false, pinned: true },
      },
      create(
        row('r0', 't0', 'a', dot(...pointOf(use, 0, 0))),
        row('r1', 'g0', 'b', dot(...pointOf(use, 1, 0))),
        row('r2', 'g0', 'a', dot(...pointOf(use, 2, 0))),
        row('r3', 't0', 'c', dot(...pointOf(use, 3, 0))),
      ),
      // A new key of the group takes its members with it
      { kind: 'writeGroup', id: 'g0', handle: 1000, key: 'd' },
      // A row given the group for its parent joins its members
      { kind: 'writeRow', id: 'r3', parent: 'g0', values: {} },
      // The group given another table takes its members there
      { kind: 'writeGroup', id: 'g0', handle: 1000, table: 't1' },
    ],
  },
  {
    name: 'keeps the rows a token keeps until it is let go of, and forgets them then',
    operations: (use) => [
      create(
        row('r0', 't0', 'a', dot(...pointOf(use, 0, 0))),
        row('r1', 't0', 'b', area([pointOf(use, 0, 0), pointOf(use, 1, 0), pointOf(use, 1, 1)])),
      ),
      { kind: 'deleteRows', ids: ['r0', 'r1'], token: 0 },
      // Written not deleted, they come back as they were
      { kind: 'restoreRows', ids: ['r0', 'r1'] },
      { kind: 'deleteRows', ids: ['r1'], token: 1 },
      // Let go of, the token tells the rows it kept; forgotten, their ids are new again
      { kind: 'release', token: 1 },
      { kind: 'release', token: 0 },
      { kind: 'forget', ids: ['r1'] },
      create(row('r1', 't1', 'a', dot(...pointOf(use, 5, 5)), 'note')),
    ],
  },
  {
    name: 'makes a row deleted that nothing keeps again from what it is written with',
    operations: (use) => [
      create(row('r0', 't0', 'a', dot(...pointOf(use, 0, 0)))),
      { kind: 'writeRow', id: 'r0', values: { hidden: true, attrs: { w: 'x' } } },
      { kind: 'deleteRows', ids: ['r0'], token: null },
      {
        kind: 'createRows',
        rows: [
          {
            id: 'r0',
            parent: 't2',
            key: 'b',
            values: { type: 'mark', shape: path(pointOf(use, 2, 2), pointOf(use, 3, 3)) },
          },
        ],
      },
    ],
  },
  {
    name: 'writes a shape of another form and the values of every column in place',
    operations: (use) => [
      create(row('r0', 't0', 'a', path(pointOf(use, 0, 0), pointOf(use, 1, 1)))),
      // The same form: written in place
      {
        kind: 'writeRow',
        id: 'r0',
        values: { shape: path(pointOf(use, 2, 0), pointOf(use, 3, 1)) },
      },
      // Another depth, and points given two values only (the others are not held)
      {
        kind: 'writeRow',
        id: 'r0',
        values: {
          shape: area(
            [
              [0, 0],
              [4, 0],
              [4, 4],
            ],
            [[1, 1]],
          ),
        },
      },
      { kind: 'writeRow', id: 'r0', values: { look: { tone: 2, line: 'thin' } } },
      { kind: 'writeRow', id: 'r0', values: { attrs: { n: undefined, s: 'v' } } },
      { kind: 'writeRow', id: 'r0', values: { type: 'mark', pinned: true } },
    ],
  },
  {
    name: 'takes in a block of rows built among the rows written',
    operations: (use) => [
      {
        kind: 'createGroup',
        id: 'g1',
        handle: 1001,
        table: 't0',
        key: 'b',
        flags: { hidden: true, pinned: false },
      },
      create(row('r0', 't0', 'a', dot(...pointOf(use, 0, 0)))),
      {
        kind: 'addBlock',
        table: 't0',
        rows: [
          row('r5', 't0', 'ab', dot(...pointOf(use, 5, 0))),
          row('r6', 'g1', 'a', dot(...pointOf(use, 6, 0))),
          row('r7', 't0', 'c', path(pointOf(use, 7, 0), pointOf(use, 7, 1))),
        ],
      },
      { kind: 'deleteRows', ids: ['r5'], token: 0 },
    ],
  },
  {
    name: 'keeps a group a token keeps, and brings it back as it was',
    operations: () => [
      {
        kind: 'createGroup',
        id: 'g2',
        handle: 1002,
        table: 't0',
        key: 'a',
        flags: { hidden: true, pinned: true },
      },
      { kind: 'deleteGroup', id: 'g2', handle: 1002, token: 0 },
      { kind: 'restoreGroup', id: 'g2', handle: 1002 },
      { kind: 'deleteGroup', id: 'g2', handle: 1002, token: null },
    ],
  },
];

/** The seeds of the sequences made from them, and their length */
const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1);
const SEQUENCE_LENGTH = 150;

describe('the tables against their reference model', () => {
  for (const use of USES) {
    describe(`in ${use.name}`, () => {
      for (const sequence of SEQUENCES) {
        it(sequence.name, () => {
          const { failure } = runModelOperations(use, sequence.operations(use), tablesSubject);
          expect(failure).toBeNull();
        });
      }

      it('answers as the model in the sequences of the seeds', () => {
        const failed: number[] = [];
        for (const seed of SEEDS) {
          const steps = randomModelSteps(seed, SEQUENCE_LENGTH);
          if (runModelSteps(use, steps, tablesSubject) === null) continue;
          failed.push(seed);
          if (process.env.KASANE_MODEL_REPORT) {
            const short = shrinkModelSteps(
              steps,
              (candidate) => runModelSteps(use, candidate, tablesSubject) !== null,
            );
            const failure = runModelSteps(use, short, tablesSubject);
            process.stdout.write(`${use.name} ${seed}: ${JSON.stringify({ failure, short })}\n`);
          }
        }
        expect(failed).toEqual([]);
      });
    });
  }

  it('reads what a sequence written by hand leaves', () => {
    const use = USES[0];
    const { failure, last } = runModelOperations(use, SEQUENCES[1].operations(use), tablesSubject);
    expect(failure).toBeNull();
    expect(last.tables.t0).toEqual([{ row: 'r0' }]);
    expect(last.tables.t1).toEqual([{ group: 'g0', members: ['r2', 'r1', 'r3'] }]);
    expect(last.rows.r3).toMatchObject({ table: 't1', group: 'g0' });
  });

  it('tells the rows a token let go of kept', () => {
    const use = USES[1];
    const { failure, last } = runModelOperations(use, SEQUENCES[2].operations(use), tablesSubject);
    expect(failure).toBeNull();
    expect(last.released).toEqual(['r1']);
    expect(last.rows.r1).toMatchObject({ table: 't1', type: 'note' });
  });
});
