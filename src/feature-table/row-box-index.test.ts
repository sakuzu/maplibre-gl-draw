// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The build of the index of the boxes of the rows in slices while the page is idle: a search in
 * the middle of a build answers what the index answers once built, and the rows written while it
 * goes on are read
 */

import { describe, expect, it } from 'vitest';
import { IDLE_BUILD_FROM, RowBoxIndex, type RowBoxSource } from './row-box-index.js';

/** Rows on a grid of a hundred columns, each a box of a fifth of a cell; some rows deleted */
function source(count: number) {
  const boxes = new Float64Array(count * 4);
  const deleted = new Set<number>();
  for (let h = 0; h < count; h++) {
    // The handles go round the grid out of order, so that a run of handles is not a run of cells
    const cell = (h * 7919) % count;
    const x = cell % 100;
    const y = Math.floor(cell / 100);
    boxes.set([x, y, x + 0.2, y + 0.2], h * 4);
  }
  const handles = Int32Array.from({ length: count }, (_, h) => h);
  const rows: RowBoxSource & {
    move(handle: number, x: number, y: number): void;
    remove(handle: number): void;
    brute(minX: number, minY: number, maxX: number, maxY: number): number[];
  } = {
    boxOf(handle, out) {
      if (deleted.has(handle)) return null;
      out.set(boxes.subarray(handle * 4, handle * 4 + 4));
      return 0;
    },
    rowLists: () => [handles],
    countRows: () => count,
    move(handle, x, y) {
      boxes.set([x, y, x + 0.2, y + 0.2], handle * 4);
    },
    remove(handle) {
      deleted.add(handle);
    },
    brute(minX, minY, maxX, maxY) {
      const out: number[] = [];
      for (let h = 0; h < count; h++) {
        if (deleted.has(h)) continue;
        const at = h * 4;
        if (boxes[at] <= maxX && boxes[at + 2] >= minX && boxes[at + 1] <= maxY) {
          if (boxes[at + 3] >= minY) out.push(h);
        }
      }
      return out;
    },
  };
  return rows;
}

/** A scheduler of idle periods run by the test, and a clock that moves a step at every read */
function idle() {
  const tasks: ((deadline: number) => void)[] = [];
  let time = 0;
  return {
    whenIdle: (task: (deadline: number) => void) => {
      tasks.push(task);
      return () => {
        const at = tasks.indexOf(task);
        if (at >= 0) tasks.splice(at, 1);
      };
    },
    now: () => time++,
    /** Runs the next idle period, of 50 ticks of the clock; false when none waits */
    run(): boolean {
      const task = tasks.shift();
      if (!task) return false;
      task(time + 50);
      return true;
    },
    get waiting(): number {
      return tasks.length;
    },
  };
}

const sorted = (rows: number[]) => [...rows].sort((a, b) => a - b);

const BOXES: [number, number, number, number][] = [
  [10, 10, 12.5, 11.5],
  [0, 0, 100, 1],
  [49.9, 49.9, 50.1, 50.1],
  [-5, -5, 0.1, 0.1],
  [200, 200, 300, 300],
];

describe('the build of the index of the boxes of the rows', () => {
  const count = IDLE_BUILD_FROM * 3;

  it('is done in slices while the page is idle, and answers as the rows are', () => {
    const rows = source(count);
    const clock = idle();
    const index = new RowBoxIndex(rows, clock);
    index.mark([0]);
    expect(clock.waiting).toBe(1);
    let slices = 0;
    while (clock.run()) slices++;
    expect(slices).toBeGreaterThan(10);
    expect(index.building).toBe(false);
    expect(index.size).toBe(count);
    for (const box of BOXES) expect(sorted(index.search(0, ...box))).toEqual(rows.brute(...box));
  });

  it('answers a search in the middle of a build as once built', () => {
    for (const slices of [1, 3, 8, 20, 40]) {
      const rows = source(count);
      const clock = idle();
      const index = new RowBoxIndex(rows, clock);
      index.markAll();
      for (let i = 0; i < slices; i++) clock.run();
      for (const box of BOXES) {
        expect(sorted(index.search(0, ...box))).toEqual(rows.brute(...box));
      }
      expect(index.building).toBe(false);
      expect(index.size).toBe(count);
    }
  });

  it('reads the rows written in the middle of a build', () => {
    const rows = source(count);
    const clock = idle();
    const index = new RowBoxIndex(rows, clock);
    index.markAll();
    for (let i = 0; i < 5; i++) clock.run();
    // A row read already and one not read yet move; a row is deleted
    rows.move(0, 300, 300);
    rows.move(count - 1, 300.1, 300.1);
    rows.remove(5);
    index.mark([0, count - 1, 5]);
    while (clock.run());
    expect(sorted(index.search(0, 299, 299, 301, 301))).toEqual([0, count - 1]);
    for (const box of BOXES) expect(sorted(index.search(0, ...box))).toEqual(rows.brute(...box));
    expect(index.size).toBe(count - 1);
  });

  it('starts again when every row is to be read in the middle of a build', () => {
    const rows = source(count);
    const clock = idle();
    const index = new RowBoxIndex(rows, clock);
    index.markAll();
    for (let i = 0; i < 5; i++) clock.run();
    for (let h = 0; h < 10; h++) rows.move(h, 400, 400);
    index.markAll();
    while (clock.run());
    expect(sorted(index.search(0, 399, 399, 401, 401))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(index.size).toBe(count);
  });

  it('leaves a small build to the first search', () => {
    const rows = source(IDLE_BUILD_FROM - 1);
    const clock = idle();
    const index = new RowBoxIndex(rows, clock);
    index.markAll();
    expect(clock.waiting).toBe(0);
    const box: [number, number, number, number] = [10, 10, 12.5, 11.5];
    expect(sorted(index.search(0, ...box))).toEqual(rows.brute(...box));
  });
});
