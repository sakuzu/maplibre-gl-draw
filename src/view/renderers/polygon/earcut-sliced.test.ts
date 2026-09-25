// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for SlicedEarcut
 *
 * The value of the ported version lies in exactly one point: "it can produce the same
 * result as upstream earcut while stopping partway through". So what is checked is
 * narrowed down to the following two things.
 *
 * - Identity: for a variety of randomly generated polygons (with holes, with
 *   degeneracies), it returns exactly the same index sequence as upstream earcut
 * - Slicing: it does not run everything in a single step (the iteration limit takes
 *   effect)
 */

import earcut from 'earcut';
import { describe, expect, it } from 'vitest';
import { SlicedEarcut } from './earcut-sliced.js';

/** Deterministic pseudo-random number generator (mulberry32) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A ring whose radius is uniquely determined per angle as seen from the center (a star
 * shape)
 *
 * Because it is built so that self-intersection "cannot happen", a large input can be
 * created without mixing triangulation failures with the genuine load (the same idea as
 * the huge water body in the benchmark).
 */
function starRing(
  count: number,
  rand: () => number,
  center: [number, number] = [0, 0],
  radius = 1,
): number[] {
  const waves = Array.from({ length: 4 }, (_, k) => ({
    frequency: k + 2,
    amplitude: (0.3 / (k + 1)) * (0.5 + rand()),
    phase: rand() * Math.PI * 2,
  }));
  const flat: number[] = new Array(count * 2);
  for (let i = 0; i < count; i++) {
    const theta = (i / count) * Math.PI * 2;
    let noise = 0;
    for (const w of waves) noise += w.amplitude * Math.sin(w.frequency * theta + w.phase);
    const r = radius * Math.min(1.6, Math.max(0.4, 1 + noise));
    flat[i * 2] = center[0] + Math.cos(theta) * r;
    flat[i * 2 + 1] = center[1] + Math.sin(theta) * r;
  }
  return flat;
}

/** Rounds coordinates onto a grid (intentionally creating duplicate-point and collinear
 * degeneracies) */
function quantize(flat: number[], step: number): number[] {
  return flat.map((v) => Math.round(v / step) * step);
}

/** Runs step until completion (returns the number of times it was run) */
function runToEnd(job: SlicedEarcut, iterations?: number): number {
  let steps = 0;
  while (!job.step(iterations)) {
    steps++;
    if (steps > 1_000_000) throw new Error('step does not finish');
  }
  return steps + 1;
}

describe('SlicedEarcut returns the same result as upstream earcut', () => {
  it('star shapes without holes (large and small, with degeneracies)', () => {
    const rand = mulberry32(1);
    for (const count of [3, 4, 10, 64, 81, 500, 3000]) {
      for (const step of [0, 0.05]) {
        const flat = step === 0 ? starRing(count, rand) : quantize(starRing(count, rand), step);
        const job = new SlicedEarcut(flat, []);
        runToEnd(job, 7);
        expect(job.triangles).toEqual(earcut(flat, []));
      }
    }
  });

  it('with holes (1 to 3 inner rings, including a single-vertex hole)', () => {
    const rand = mulberry32(2);
    for (const holeCount of [1, 2, 3]) {
      const outer = starRing(200, rand, [0, 0], 10);
      const flat = [...outer];
      const holeIndices: number[] = [];
      for (let h = 0; h < holeCount; h++) {
        holeIndices.push(flat.length / 2);
        const hole = starRing(h === 2 ? 1 : 24, rand, [h * 3 - 3, 0], 1);
        // wind the inner ring opposite to the outer ring (earcut fixes the winding
        // itself, but this makes it closer to real data)
        for (let i = hole.length / 2 - 1; i >= 0; i--) flat.push(hole[i * 2], hole[i * 2 + 1]);
      }
      const job = new SlicedEarcut(flat, holeIndices);
      runToEnd(job, 5);
      expect(job.triangles).toEqual(earcut(flat, holeIndices));
    }
  });

  it('matches even for self-intersecting inputs and inputs with no area', () => {
    const cases: Array<[number[], number[]]> = [
      // zero area (a straight line)
      [[0, 0, 1, 1, 2, 2], []],
      // bowtie (self-intersecting)
      [[0, 0, 2, 2, 2, 0, 0, 2], []],
      // overlapping duplicate points
      [[0, 0, 1, 0, 1, 0, 1, 1, 0, 1], []],
      // 2 vertices (cannot form a triangle)
      [[0, 0, 1, 1], []],
      // empty
      [[], []],
    ];
    for (const [flat, holes] of cases) {
      const job = new SlicedEarcut(flat, holes);
      runToEnd(job, 3);
      expect(job.triangles).toEqual(earcut(flat, holes));
    }
  });

  it('200 random messy polygons (with holes, degeneracies, self-intersections)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = mulberry32(seed);
      const count = 3 + Math.floor(rand() * 60);
      // vary the coarseness of the rounding to intentionally mix in duplicate points,
      // collinear points and self-intersections
      const grid = [1, 0.5, 0.25, 0.1][Math.floor(rand() * 4)];
      const flat: number[] = [];
      for (let i = 0; i < count; i++) {
        flat.push(Math.round((rand() * 10) / grid) * grid, Math.round((rand() * 10) / grid) * grid);
      }
      const holeIndices: number[] = [];
      if (rand() < 0.5) {
        holeIndices.push(flat.length / 2);
        const holeCount = 1 + Math.floor(rand() * 8);
        for (let i = 0; i < holeCount; i++) {
          flat.push(
            Math.round((rand() * 10) / grid) * grid,
            Math.round((rand() * 10) / grid) * grid,
          );
        }
      }

      const job = new SlicedEarcut(flat, holeIndices);
      runToEnd(job, 1 + Math.floor(rand() * 5));
      // wrap it so that the seed is visible when it fails
      expect({ seed, triangles: job.triangles }).toEqual({
        seed,
        triangles: earcut(flat, holeIndices),
      });
    }
  });

  it('does not change the result when the slice width is changed', () => {
    const flat = starRing(700, mulberry32(3));
    const expected = earcut(flat, []);
    for (const iterations of [1, 2, 17, 128, 100_000]) {
      const job = new SlicedEarcut(flat, []);
      runToEnd(job, iterations);
      expect(job.triangles).toEqual(expected);
    }
  });

  it('does not break the results of one another when separate jobs advance alternately', () => {
    const rand = mulberry32(4);
    const a = starRing(300, rand);
    const b = starRing(400, rand, [10, 10], 2);
    const jobA = new SlicedEarcut(a, []);
    const jobB = new SlicedEarcut(b, []);

    let doneA = false;
    let doneB = false;
    while (!doneA || !doneB) {
      if (!doneA) doneA = jobA.step(3);
      if (!doneB) doneB = jobB.step(5);
    }

    expect(jobA.triangles).toEqual(earcut(a, []));
    expect(jobB.triangles).toEqual(earcut(b, []));
  });
});

describe('Time slicing of SlicedEarcut', () => {
  it('does not finish in a single step, and the partial progress is shorter than the final', () => {
    const flat = starRing(1000, mulberry32(5));
    const job = new SlicedEarcut(flat, []);

    // on the first call, which only does preprocessing, no triangles come out yet
    expect(job.step(0)).toBe(false);
    expect(job.triangles.length).toBe(0);

    expect(job.step(10)).toBe(false);
    const partial = job.triangles.length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(earcut(flat, []).length);
    expect(job.done).toBe(false);

    // resume from where it left off and complete
    runToEnd(job, 128);
    expect(job.done).toBe(true);
    expect(job.triangles).toEqual(earcut(flat, []));
  });

  it('returns true however many times step is called after completion, result unchanged', () => {
    const flat = starRing(50, mulberry32(6));
    const job = new SlicedEarcut(flat, []);
    runToEnd(job, 8);

    const snapshot = [...job.triangles];
    expect(job.step()).toBe(true);
    expect(job.step()).toBe(true);
    expect(job.triangles).toEqual(snapshot);
  });

  it('advances in proportion to the iterations run (one slice does not run it all)', () => {
    const flat = starRing(2000, mulberry32(7));
    const slow = new SlicedEarcut(flat, []);
    const fast = new SlicedEarcut(flat, []);

    slow.step(0); // preprocessing
    fast.step(0);
    slow.step(50);
    fast.step(500);

    expect(fast.triangles.length).toBeGreaterThan(slow.triangles.length);
  });
});
