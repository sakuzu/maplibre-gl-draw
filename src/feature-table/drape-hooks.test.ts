// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a side that draws the rows in tiles (a draped drawing) reads of the deltas and the
 * versions, seen by a fake drape that keeps one element per copy of
 * a row
 *
 * - A version goes through built, uploaded and swapped; a side that does not wait for part of
 *   its GPU side says so, and the version is swapped marked so
 * - In every swap, partial or not, every row is one element of the fake drape: its copy in its
 *   group, or its copy of the delta
 * - Every row of a delta has a copy number, kept while it is there whatever the rows are made
 *   again around it, and given again once it leaves
 * - The extent of the rows whose drawing changed is told: rows coming into the delta, written
 *   in place, groups replaced
 * - A row of a delta moved far is found where it is now
 */

import type {
  GroupVersion,
  GroupVersionReceiver,
  RowGroup,
  TableWorkBudget,
} from '@sakuzu/kasane/render';
import { describe, expect, it } from 'vitest';
import type { BBox } from '../geometry/types.js';
import {
  referenceKey as key,
  randomReference,
  randomRowWrites,
  rowPatch,
  seededRandom,
  tablesOfReference,
} from '../test-utils.js';
import { STATE_HIDDEN_MASK } from './feature-row-states.js';
import type { FeatureTablesInternals } from './feature-tables.js';

const ONE_STEP: TableWorkBudget = { canStep: () => true, step: (work) => work(Infinity) };

/**
 * A fake draped drawing: one element per copy of a row (its copy in its group, its copy of the
 * delta by its copy number), made again for the groups of a version swapped in and for the
 * delta when it changes. It does not wait for part of the GPU side when told
 */
function fakeDrape(internals: FeatureTablesInternals, layerIds: readonly string[]) {
  let answer: boolean | 'partial' = 'partial';
  const statuses: string[] = [];
  const problems: string[] = [];
  /** The handle of each element: the copies in the groups, and the copies of the deltas */
  const elements = (): Map<string, number> => {
    const out = new Map<string, number>();
    for (const layerId of layerIds) {
      const table = internals.rowTable(layerId);
      if (!table) continue;
      const add = (group: RowGroup, row: number, name: string): void => {
        if ((group.state[row] & STATE_HIDDEN_MASK) !== 0) return;
        out.set(name, group.data.handles[row]);
      };
      for (let g = 0; g < table.groupCount; g++) {
        const group = table.groupAt(g);
        for (let r = 0; r < group.data.length; r++)
          add(group, r, `${layerId}:m${group.data.handles[r]}`);
      }
      const delta = table.delta.group;
      for (let k = 0; k < (delta?.data.length ?? 0); k++) {
        const copy = table.delta.copyOf((delta as RowGroup).data.handles[k]);
        add(delta as RowGroup, k, `${layerId}:d${copy}`);
      }
    }
    return out;
  };
  const check = (when: string): void => {
    const seen = new Map<number, number>();
    for (const handle of elements().values()) seen.set(handle, (seen.get(handle) ?? 0) + 1);
    for (const [handle, count] of seen) {
      if (count !== 1) problems.push(`${when}: ${handle} drawn ${count} times`);
    }
  };
  const receiver: GroupVersionReceiver = {
    uploaded: (version: GroupVersion) => {
      statuses.push(version.status);
      return answer;
    },
    swapped: (version: GroupVersion) => {
      statuses.push(`${version.status}${version.partial ? ' partial' : ''}`);
      check(`swap ${version.id}`);
    },
    dropped: () => {},
  };
  internals.attachReceiver(receiver);
  return {
    statuses,
    problems,
    check,
    elements,
    answer(next: boolean | 'partial'): void {
      answer = next;
    },
  };
}

describe('what a draped drawing reads of the deltas and the versions', () => {
  it('sees a version built, uploaded and swapped, marked when it did not wait for part of it', () => {
    const reference = randomReference(seededRandom(1), 40, ['a']);
    const { tables, writer, internals } = tablesOfReference(reference, ['a'], 8);
    const drape = fakeDrape(internals, ['a']);
    writer.writeRows(rowPatch([tables.getRowRef('r3') as number], { key: [key(999_000)] }));
    drape.answer(false);
    internals.flushVersions();
    expect(drape.statuses.every((status) => status === 'built')).toBe(true);
    expect(internals.builtVersions('a').length).toBeGreaterThan(0);
    drape.answer('partial');
    internals.swap();
    expect(drape.statuses.filter((status) => status.startsWith('swapped'))).toEqual(
      drape.statuses.filter((status) => status === 'swapped partial'),
    );
    expect(drape.statuses).toContain('swapped partial');
    drape.answer(true);
    writer.writeRows(rowPatch([tables.getRowRef('r4') as number], { key: [key(998_000)] }));
    internals.flushVersions();
    expect(drape.statuses[drape.statuses.length - 1]).toBe('swapped');
    expect(drape.problems).toEqual([]);
  });

  it('has every row as one element in every swap, whatever is written at random', () => {
    for (const seed of [61, 62, 63]) {
      const random = seededRandom(seed);
      const layerIds = ['a', 'b'];
      const reference = randomReference(random, 100, layerIds);
      const setup = tablesOfReference(reference, layerIds, 8);
      const { internals } = setup;
      const drape = fakeDrape(internals, layerIds);
      const writes = randomRowWrites(random, { ...setup, reference, layerIds });
      for (let step = 0; step < 150; step++) {
        const pick = random();
        if (pick < 0.6) writes.step(step);
        else if (pick < 0.8) internals.rebuild(ONE_STEP);
        else {
          drape.answer(random() < 0.3 ? false : random() < 0.5 ? 'partial' : true);
          internals.swap();
        }
        drape.check(`step ${step}`);
      }
      expect(drape.statuses.some((status) => status === 'swapped partial')).toBe(true);
      expect(drape.problems).toEqual([]);
    }
  });

  it('gives every row of a delta a copy number kept while it is there, and again once freed', () => {
    const reference = randomReference(seededRandom(2), 40, ['a']);
    const { tables, writer, internals } = tablesOfReference(reference, ['a'], 8);
    const delta = internals.rowTable('a')?.delta;
    const at = (id: string) => tables.getRowRef(id) as number;
    writer.writeRows(
      rowPatch([at('r1'), at('r2'), at('r3')], { key: [key(10), key(20), key(30)] }),
    );
    const before = ['r1', 'r2', 'r3'].map((id) => delta?.copyOf(at(id)));
    expect(new Set(before).size).toBe(3);
    // Made again around them: the numbers stay
    writer.writeRows(rowPatch([at('r4')], { key: [key(15)] }));
    expect(['r1', 'r2', 'r3'].map((id) => delta?.copyOf(at(id)))).toEqual(before);
    internals.flushVersions();
    expect(internals.deltaRowCount()).toBe(0);
    // Freed: given again, the range does not grow
    const range = delta?.copyRange;
    writer.writeRows(rowPatch([at('r5'), at('r6')], { key: [key(40), key(50)] }));
    expect(delta?.copyRange).toBe(range);
  });

  it('tells the extent of the rows whose drawing changed', () => {
    const reference = randomReference(seededRandom(3), 40, ['a']);
    const { tables, writer, internals } = tablesOfReference(reference, ['a'], 8);
    const told: Array<[string, BBox]> = [];
    internals.onTouched((layerId, bounds) => told.push([layerId, bounds]));
    const at = (id: string) => tables.getRowRef(id) as number;
    const contains = (b: BBox, x: number, y: number) =>
      b[0] <= x && x <= b[2] && b[1] <= y && y <= b[3];
    writer.writeRows(
      rowPatch([at('r1')], {
        geometry: [{ type: 'Point', coordinates: [50, 50] }],
        key: [key(5)],
      }),
    );
    expect(told.some(([layer, b]) => layer === 'a' && contains(b, 50, 50))).toBe(true);
    told.length = 0;
    writer.writeRows(
      rowPatch([at('r1')], { geometry: [{ type: 'Point', coordinates: [60, 60] }] }),
    );
    expect(told.some(([, b]) => contains(b, 60, 60))).toBe(true);
    told.length = 0;
    internals.flushVersions();
    expect(told.some(([, b]) => contains(b, 60, 60))).toBe(true);
  });

  it('finds a row of a delta moved far where it is now', () => {
    const reference = randomReference(seededRandom(4), 40, ['a']);
    const { tables, writer } = tablesOfReference(reference, ['a'], 8);
    const handle = tables.getRowRef('r7') as number;
    writer.writeRows(rowPatch([handle], { key: [key(5)] }));
    writer.writeRows(rowPatch([handle], { geometry: [{ type: 'Point', coordinates: [80, 80] }] }));
    expect(Array.from(tables.get('a')?.listDrawnRows([79, 79, 81, 81]) ?? [])).toEqual([handle]);
    expect(Array.from(tables.get('a')?.listDrawnRows([-1, -1, 11, 11]) ?? [])).not.toContain(
      handle,
    );
  });
});
