// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of following vertices across a change, and of the changes of a geometry vertex by vertex
 *
 * The rule is the one `VertexRef` states: each ring is compared before and after, and the span
 * between the vertices equal from its start and those equal from its end is what changed. A
 * vertex before the span keeps its index, one after it moves by the difference of the lengths,
 * one inside it keeps its index when the length is the same and cannot be followed otherwise,
 * and one whose ring is gone cannot be followed.
 *
 * The properties are checked on geometries changed at random, with a random generator of a fixed
 * seed written here.
 */

import { describe, expect, it } from 'vitest';
import {
  compareRings,
  diffVertices,
  followVertex,
  followVertexDiff,
  followVertexIndex,
  revertVertexDiff,
  type VertexDiff,
  type VertexGeometry,
} from './vertex-changes.js';

type Position = number[];
type Ring = Position[];
type Part = Ring[];

/**
 * Makes a geometry of nested arrays. With `closed`, every ring is given without its closing
 * position, and the closing position is added (a copy of the first).
 */
function make(
  parts: Part[],
  options: { closed?: boolean; values?: number } = {},
): VertexGeometry & { readonly ringStarts: Int32Array } {
  const closed = options.closed ?? false;
  const values = options.values ?? parts[0]?.[0]?.[0]?.length ?? 2;
  const coordinates: number[] = [];
  const ringStarts = [0];
  const positionStarts = [0];
  let positions = 0;
  for (const part of parts) {
    for (const ring of part) {
      const all = closed && ring.length > 0 ? [...ring, ring[0]] : ring;
      for (const p of all) {
        expect(p.length).toBe(values);
        coordinates.push(...p);
        positions++;
      }
      positionStarts.push(positions);
    }
    ringStarts.push(positionStarts.length - 1);
  }
  return {
    coordinates: Float64Array.from(coordinates),
    valuesPerPosition: values,
    ringStarts: Int32Array.from(ringStarts),
    positionStarts: Int32Array.from(positionStarts),
    closedRings: closed,
  };
}

/** Reads a geometry back as nested arrays, every position as it is (the closing one included) */
function read(g: VertexGeometry): Part[] {
  const n = g.valuesPerPosition;
  const parts: Part[] = [];
  for (let p = 0; p + 1 < g.ringStarts.length; p++) {
    const part: Part = [];
    for (let r = g.ringStarts[p]; r < g.ringStarts[p + 1]; r++) {
      const ring: Ring = [];
      for (let i = g.positionStarts[r]; i < g.positionStarts[r + 1]; i++) {
        ring.push(Array.from({ length: n }, (_, k) => g.coordinates[i * n + k]));
      }
      part.push(ring);
    }
    parts.push(part);
  }
  return parts;
}

/** The entries of a diff as plain records, to compare */
function entries(diff: VertexDiff) {
  const list = (e: VertexDiff['moved'], withPositions: boolean) =>
    Array.from(e.indices, (index, k) => ({
      part: e.parts[k],
      ring: e.rings[k],
      index,
      ...(withPositions
        ? {
            position: Array.from(
              e.positions.subarray(k * diff.valuesPerPosition, (k + 1) * diff.valuesPerPosition),
            ),
          }
        : {}),
    }));
  return {
    moved: list(diff.moved, true),
    deleted: list(diff.deleted, true),
    added: list(diff.added, false),
    skippedVertexCount: diff.skippedVertexCount,
  };
}

const line = (positions: Ring): Part[] => [[positions]];

/** A random generator of a fixed seed (mulberry32) */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Positions that are never equal to one another: each is new */
function freshPositions(values: number) {
  let next = 1;
  return (): Position => {
    const p = Array.from({ length: values }, (_, k) => next * 10 + k);
    next++;
    return p;
  };
}

describe('followVertex', () => {
  const a = [0, 0];
  const b = [1, 0];
  const c = [2, 0];
  const d = [3, 0];
  const e = [4, 0];
  const x = [9, 9];
  const y = [8, 8];

  it('keeps the index of a vertex before the span, and of a vertex moved in it', () => {
    const spans = compareRings(make(line([a, b, c, d, e])), make(line([a, b, c, x, e])));
    for (const index of [0, 1, 2, 3, 4]) {
      expect(followVertex(spans, { ring: 0, index })).toEqual({ ring: 0, index });
    }
  });

  it('moves a vertex after the span by the difference of the lengths', () => {
    const added = compareRings(make(line([a, b, c, d, e])), make(line([a, b, x, y, c, d, e])));
    expect([0, 1, 2, 3, 4].map((index) => followVertexIndex(added, 0, 0, index))).toEqual([
      0, 1, 4, 5, 6,
    ]);
    const deleted = compareRings(make(line([a, b, c, d, e])), make(line([a, e])));
    expect([0, 1, 2, 3, 4].map((index) => followVertexIndex(deleted, 0, 0, index))).toEqual([
      0, -1, -1, -1, 1,
    ]);
  });

  it('cannot follow a vertex inside a span whose length changed', () => {
    const spans = compareRings(make(line([a, b, c, d, e])), make(line([a, x, y, x, y, e])));
    expect([0, 1, 2, 3, 4].map((index) => followVertexIndex(spans, 0, 0, index))).toEqual([
      0, -1, -1, -1, 5,
    ]);
  });

  it('reads two places changed at once as one span between them', () => {
    // Vertices 1 and 3 moved: the span is 1 to 3, and vertex 2, inside it, keeps its index
    const moved = compareRings(make(line([a, b, c, d, e])), make(line([a, x, c, y, e])));
    expect([0, 1, 2, 3, 4].map((index) => followVertexIndex(moved, 0, 0, index))).toEqual([
      0, 1, 2, 3, 4,
    ]);
    // Vertex 1 deleted and vertex 3 moved: the span 1 to 3 changed its length
    const both = compareRings(make(line([a, b, c, d, e])), make(line([a, c, y, e])));
    expect([0, 1, 2, 3, 4].map((index) => followVertexIndex(both, 0, 0, index))).toEqual([
      0, -1, -1, -1, 3,
    ]);
  });

  it('cannot follow a vertex whose ring is not there after the change', () => {
    const outer = [a, b, c, d];
    const hole = [x, y, e];
    const spans = compareRings(
      make([[outer, hole]], { closed: true }),
      make([[outer]], { closed: true }),
    );
    expect(followVertex(spans, { ring: 1, index: 0 })).toBeNull();
    expect(followVertex(spans, { ring: 0, index: 2 })).toEqual({ ring: 0, index: 2 });
    expect(spans.sameStructure).toBe(false);
  });

  it('matches the rings of a Multi geometry by their part numbers', () => {
    const p0 = [a, b, c];
    const p1 = [d, e, x];
    const spans = compareRings(make([[p0], [p1]]), make([[p0], [[d, y, e, x]]]));
    expect(followVertex(spans, { part: 0, ring: 0, index: 2 })).toEqual({
      part: 0,
      ring: 0,
      index: 2,
    });
    expect(followVertex(spans, { part: 1, ring: 0, index: 0 })).toEqual({
      part: 1,
      ring: 0,
      index: 0,
    });
    expect(followVertex(spans, { part: 1, ring: 0, index: 1 })).toEqual({
      part: 1,
      ring: 0,
      index: 2,
    });
    // part left out is part 0
    expect(followVertex(spans, { ring: 0, index: 1 })).toEqual({ ring: 0, index: 1 });

    // The first part deleted: the parts are matched by their numbers, so part 1 is gone, and
    // part 0 is compared with what was part 1
    const shifted = compareRings(make([[p0], [p1]]), make([[p1]]));
    expect(followVertex(shifted, { part: 1, ring: 0, index: 0 })).toBeNull();
    expect(followVertex(shifted, { part: 0, ring: 0, index: 0 })).toEqual({
      part: 0,
      ring: 0,
      index: 0,
    });
    expect(shifted.sameStructure).toBe(false);
  });

  it('cannot follow an index that is not a vertex of the geometry before', () => {
    const spans = compareRings(make(line([a, b, c])), make(line([a, b, c])));
    expect(followVertexIndex(spans, 0, 0, -1)).toBe(-1);
    expect(followVertexIndex(spans, 0, 0, 3)).toBe(-1);
    expect(followVertexIndex(spans, 0, 1, 0)).toBe(-1);
    expect(followVertexIndex(spans, 1, 0, 0)).toBe(-1);
  });

  it('does not count as equal two positions that differ in one value, the height or the measure', () => {
    const z = compareRings(
      make(
        line([
          [0, 0, 1],
          [1, 0, 1],
          [2, 0, 1],
        ]),
      ),
      make(
        line([
          [0, 0, 1],
          [1, 0, 2],
          [2, 0, 1],
        ]),
      ),
    );
    expect(Array.from(z.spans.subarray(2, 5))).toEqual([1, 2, 2]);
    const m = compareRings(
      make(
        line([
          [0, 0, 1, 5],
          [1, 0, 1, 5],
          [2, 0, 1, 5],
        ]),
      ),
      make(
        line([
          [0, 0, 1, 5],
          [1, 0, 1, 5],
          [2, 0, 1, 6],
        ]),
      ),
    );
    expect(Array.from(m.spans.subarray(2, 5))).toEqual([2, 3, 3]);
    const diff = diffVertices(
      make(
        line([
          [0, 0, 1, 5],
          [1, 0, 1, 5],
          [2, 0, 1, 5],
        ]),
      ),
      make(
        line([
          [0, 0, 1, 5],
          [1, 0, 1, 5],
          [2, 0, 1, 6],
        ]),
      ),
    );
    expect(entries(diff).moved).toEqual([{ part: 0, ring: 0, index: 2, position: [2, 0, 1, 5] }]);
  });

  it('counts the closing position of a polygon as its first vertex', () => {
    const before = make([[[a, b, c, d]]], { closed: true });
    const after = make([[[x, b, c, d]]], { closed: true });
    const spans = compareRings(before, after);
    expect(Array.from(spans.spans.subarray(0, 5))).toEqual([4, 4, 0, 1, 1]);
    // The closing position follows as the first vertex
    expect(followVertexIndex(spans, 0, 0, 4)).toBe(0);
    expect(entries(diffVertices(before, after))).toEqual({
      moved: [{ part: 0, ring: 0, index: 0, position: a }],
      deleted: [],
      added: [],
      skippedVertexCount: 0,
    });
  });

  it('does not count the last position of a line as its first, even when they are equal', () => {
    const spans = compareRings(make(line([a, b, c, a])), make(line([x, b, c, a])));
    expect(Array.from(spans.spans.subarray(0, 5))).toEqual([4, 4, 0, 1, 1]);
    expect(followVertexIndex(spans, 0, 0, 3)).toBe(3);
  });
});

describe('diffVertices', () => {
  const a = [0, 0];
  const b = [1, 0];
  const c = [2, 0];
  const d = [3, 0];
  const x = [9, 9];
  const y = [8, 8];

  it('reads the vertices moved, with their positions before', () => {
    expect(entries(diffVertices(make(line([a, b, c, d])), make(line([a, x, y, d]))))).toEqual({
      moved: [
        { part: 0, ring: 0, index: 1, position: b },
        { part: 0, ring: 0, index: 2, position: c },
      ],
      deleted: [],
      added: [],
      skippedVertexCount: 0,
    });
  });

  it('reads the vertices deleted, with their positions before, and where they were', () => {
    expect(entries(diffVertices(make(line([a, b, c, d])), make(line([a, d]))))).toEqual({
      moved: [],
      deleted: [
        { part: 0, ring: 0, index: 1, position: b },
        { part: 0, ring: 0, index: 1, position: c },
      ],
      added: [],
      skippedVertexCount: 0,
    });
    // Deleted at the end: they were at the end of the ring
    expect(entries(diffVertices(make(line([a, b, c, d])), make(line([a, b])))).deleted).toEqual([
      { part: 0, ring: 0, index: 2, position: c },
      { part: 0, ring: 0, index: 2, position: d },
    ]);
  });

  it('reads the vertices added', () => {
    expect(entries(diffVertices(make(line([a, b, c])), make(line([a, x, y, b, c]))))).toEqual({
      moved: [],
      deleted: [],
      added: [
        { part: 0, ring: 0, index: 1 },
        { part: 0, ring: 0, index: 2 },
      ],
      skippedVertexCount: 0,
    });
  });

  it('reads a span whose length changed as its vertices deleted and others added', () => {
    expect(entries(diffVertices(make(line([a, b, c, d])), make(line([a, x, d]))))).toEqual({
      moved: [],
      deleted: [
        { part: 0, ring: 0, index: 2, position: b },
        { part: 0, ring: 0, index: 2, position: c },
      ],
      added: [{ part: 0, ring: 0, index: 1 }],
      skippedVertexCount: 0,
    });
  });

  it('reads only the rings matched when the number of rings changes', () => {
    const before = make([[[a, b, c]], [[x, y, d]]]);
    const after = make([[[a, x, c]]]);
    const spans = compareRings(before, after);
    expect(spans.sameStructure).toBe(false);
    expect(entries(diffVertices(before, after, spans)).moved).toEqual([
      { part: 0, ring: 0, index: 1, position: b },
    ]);
  });

  it('reads one of two equal vertices side by side deleted, either way the same geometry', () => {
    const before = make(line([a, b, b, c]));
    const after = make(line([a, b, c]));
    // Whichever of the two was deleted, the geometry after is the same, and so is the reading
    const diff = diffVertices(before, after);
    expect(entries(diff).deleted).toEqual([{ part: 0, ring: 0, index: 2, position: b }]);
    expect(read(revertVertexDiff(after, diff).geometry)).toEqual(read(before));
  });
});

describe('revertVertexDiff', () => {
  const square = [
    [0, 0],
    [1, 0],
    [2, 0],
    [2, 1],
    [2, 2],
    [0, 2],
  ];
  const at = (ring: Ring, index: number, position: Position): Ring =>
    ring.map((p, i) => (i === index ? position : p));

  it('takes back a vertex moved, and leaves a vertex another change moved after it', () => {
    const before = make([[square]], { closed: true });
    // This change moves vertex 2
    const mine = make([[at(square, 2, [3, -1])]], { closed: true });
    const diff = diffVertices(before, mine);
    // Another change moves vertex 4 of the same feature afterwards
    const now = make([[at(at(square, 2, [3, -1]), 4, [3, 3])]], { closed: true });
    const followed = followVertexDiff(diff, compareRings(mine, now));
    const result = revertVertexDiff(now, followed);
    // Vertex 2 goes back, vertex 4 stays where the other change put it
    expect(read(result.geometry)).toEqual(read(make([[at(square, 4, [3, 3])]], { closed: true })));
    expect(result.skippedVertexCount).toBe(0);
  });

  it('follows the vertices of the diff along a change that added vertices before them', () => {
    const before = make(line(square));
    const mine = make(line(at(square, 4, [5, 5])));
    const diff = diffVertices(before, mine);
    const nowRing = [...at(square, 4, [5, 5])];
    nowRing.splice(1, 0, [0.5, -1], [0.7, -1]);
    const now = make(line(nowRing));
    const result = revertVertexDiff(now, followVertexDiff(diff, compareRings(mine, now)));
    const expected = [...square];
    expected.splice(1, 0, [0.5, -1], [0.7, -1]);
    expect(read(result.geometry)).toEqual(read(make(line(expected))));
  });

  it('deletes the vertices added and brings back the vertices deleted', () => {
    const before = make(line(square));
    const added = make(line([square[0], [7, 7], ...square.slice(1)]));
    expect(read(revertVertexDiff(added, diffVertices(before, added)).geometry)).toEqual(
      read(before),
    );
    const deleted = make(line([square[0], square[3], square[4], square[5]]));
    expect(read(revertVertexDiff(deleted, diffVertices(before, deleted)).geometry)).toEqual(
      read(before),
    );
  });

  it('leaves and counts the vertices it cannot follow', () => {
    const before = make(line(square));
    const mine = make(line(at(square, 2, [3, -1])));
    const diff = diffVertices(before, mine);
    // Another change replaces vertices 1 to 3 with one vertex: vertex 2 cannot be followed
    const nowRing = [square[0], [8, 8], square[4], square[5]];
    const now = make(line(nowRing));
    const followed = followVertexDiff(diff, compareRings(mine, now));
    expect(followed.skippedVertexCount).toBe(1);
    expect(followed.moved.indices.length).toBe(0);
    const result = revertVertexDiff(now, followed);
    expect(read(result.geometry)).toEqual(read(now));
    expect(result.skippedVertexCount).toBe(1);
  });

  it('leaves and counts the vertices whose ring is gone', () => {
    const outer = square;
    const hole = [
      [0.5, 0.5],
      [1, 0.5],
      [1, 1],
    ];
    const before = make([[outer, hole]], { closed: true });
    const mine = make([[outer, at(hole, 1, [1.2, 0.4])]], { closed: true });
    const diff = diffVertices(before, mine);
    const now = make([[at(outer, 0, [-1, -1])]], { closed: true });
    const followed = followVertexDiff(diff, compareRings(mine, now));
    expect(followed.skippedVertexCount).toBe(1);
    expect(read(revertVertexDiff(now, followed).geometry)).toEqual(read(now));
  });

  it('counts the entries that are not in the geometry it is given', () => {
    const before = make(line(square));
    const mine = make(line(at(square, 5, [3, 3])));
    const diff = diffVertices(before, mine);
    const shorter = make(line(square.slice(0, 3)));
    const result = revertVertexDiff(shorter, diff);
    expect(read(result.geometry)).toEqual(read(shorter));
    expect(result.skippedVertexCount).toBe(1);
  });

  it('keeps the rings of a polygon closed, also when its first vertex comes back', () => {
    const before = make([[square]], { closed: true });
    const deletedFirst = make([[square.slice(1)]], { closed: true });
    const diff = diffVertices(before, deletedFirst);
    expect(entries(diff).deleted).toEqual([{ part: 0, ring: 0, index: 0, position: [0, 0] }]);
    expect(read(revertVertexDiff(deletedFirst, diff).geometry)).toEqual(read(before));
  });

  it('reads a geometry of a column in place, and gives one whose starts begin at 0', () => {
    // Two rows of a column: the second is read with the entries of its parts
    const column = make([
      [
        [
          [0, 0],
          [1, 1],
        ],
      ],
      [
        [
          [5, 5],
          [6, 6],
          [7, 7],
        ],
      ],
    ]);
    const row: VertexGeometry = { ...column, ringStarts: column.ringStarts.subarray(1, 3) };
    const after = make(
      line([
        [5, 5],
        [9, 9],
        [7, 7],
      ]),
    );
    const diff = diffVertices(row, after);
    expect(entries(diff).moved).toEqual([{ part: 0, ring: 0, index: 1, position: [6, 6] }]);
    expect(read(revertVertexDiff(after, diff).geometry)).toEqual(
      read(
        make(
          line([
            [5, 5],
            [6, 6],
            [7, 7],
          ]),
        ),
      ),
    );
    const back = revertVertexDiff(row, diffVertices(row, row));
    expect(Array.from(back.geometry.ringStarts)).toEqual([0, 1]);
    expect(Array.from(back.geometry.positionStarts)).toEqual([0, 3]);
  });
});

/**
 * One random change of one ring: what it does, and where. `kind` is one of moving `count`
 * vertices, adding `count` vertices, deleting `count` vertices, or putting `count2` vertices in
 * the place of `count` (the two counts differ).
 */
interface Edit {
  kind: 'move' | 'add' | 'delete' | 'replace';
  at: number;
  count: number;
  count2: number;
}

function randomEdit(next: () => number, length: number): Edit {
  const kinds: Edit['kind'][] = length === 0 ? ['add'] : ['move', 'add', 'delete', 'replace'];
  const kind = kinds[Math.floor(next() * kinds.length)];
  // Changes at the start and the end of the ring are drawn more often than others
  const place = (max: number) => {
    const r = next();
    if (r < 0.25) return 0;
    if (r < 0.5) return max;
    return Math.floor(next() * (max + 1));
  };
  if (kind === 'add') {
    return { kind, at: place(length), count: 1 + Math.floor(next() * 3), count2: 0 };
  }
  const at = place(length - 1);
  const count = 1 + Math.floor(next() * Math.min(3, length - at));
  let count2 = 1 + Math.floor(next() * 3);
  if (count2 === count) count2++;
  return { kind, at, count, count2 };
}

function applyEdit(ring: Ring, edit: Edit, fresh: () => Position): Ring {
  const out = ring.slice();
  const news = (n: number) => Array.from({ length: n }, fresh);
  if (edit.kind === 'move') out.splice(edit.at, edit.count, ...news(edit.count));
  else if (edit.kind === 'add') out.splice(edit.at, 0, ...news(edit.count));
  else if (edit.kind === 'delete') out.splice(edit.at, edit.count);
  else out.splice(edit.at, edit.count, ...news(edit.count2));
  return out;
}

/** Where the rule puts vertex `index` after the edit, or -1 */
function expectedIndex(edit: Edit, index: number): number {
  if (index < edit.at) return index;
  const removed = edit.kind === 'add' ? 0 : edit.count;
  const put =
    edit.kind === 'add'
      ? edit.count
      : edit.kind === 'move'
        ? edit.count
        : edit.kind === 'delete'
          ? 0
          : edit.count2;
  if (index >= edit.at + removed) return index + put - removed;
  return edit.kind === 'move' ? index : -1;
}

function randomParts(next: () => number, fresh: () => Position): Part[] {
  const partCount = 1 + Math.floor(next() * 2);
  return Array.from({ length: partCount }, () =>
    Array.from({ length: 1 + Math.floor(next() * 2) }, () =>
      Array.from({ length: 1 + Math.floor(next() * 7) }, fresh),
    ),
  );
}

describe('properties', () => {
  for (const closed of [false, true]) {
    for (const values of [2, 4]) {
      it(`follows every vertex as the rule says (${closed ? 'polygon' : 'line'}, ${values} values)`, () => {
        const next = random(closed ? 7 + values : 11 + values);
        for (let round = 0; round < 300; round++) {
          const fresh = freshPositions(values);
          const parts = randomParts(next, fresh);
          const part = Math.floor(next() * parts.length);
          const ring = Math.floor(next() * parts[part].length);
          const edit = randomEdit(next, parts[part][ring].length);
          const changed = parts.map((rings, p) =>
            rings.map((r, i) => (p === part && i === ring ? applyEdit(r, edit, fresh) : r)),
          );
          const before = make(parts, { closed, values });
          const after = make(changed, { closed, values });
          const spans = compareRings(before, after);
          for (let p = 0; p < parts.length; p++) {
            for (let r = 0; r < parts[p].length; r++) {
              for (let i = 0; i < parts[p][r].length; i++) {
                const want = p === part && r === ring ? expectedIndex(edit, i) : i;
                const got = followVertexIndex(spans, p, r, i);
                expect(got, JSON.stringify({ round, edit, p, r, i })).toBe(want);
                if (got >= 0 && !(p === part && r === ring && edit.kind === 'move')) {
                  expect(changed[p][r][got]).toEqual(parts[p][r][i]);
                }
              }
            }
          }
          // Taken back at once, the change gives the geometry before
          const diff = diffVertices(before, after, spans);
          const back = revertVertexDiff(after, diff);
          expect(read(back.geometry), JSON.stringify({ round, edit })).toEqual(read(before));
          expect(back.skippedVertexCount).toBe(0);
        }
      });

      it(`takes back one change and leaves a later change elsewhere in the ring (${closed ? 'polygon' : 'line'}, ${values} values)`, () => {
        const next = random(closed ? 101 + values : 211 + values);
        for (let round = 0; round < 300; round++) {
          const fresh = freshPositions(values);
          const segment = (min: number) =>
            Array.from({ length: min + Math.floor(next() * 3) }, fresh);
          // The ring is L, X, M, Y, T: one change replaces X and the other Y, with M (at least
          // one vertex) between them
          const pieces = {
            l: segment(0),
            x: segment(0),
            m: segment(1),
            y: segment(0),
            t: segment(0),
          };
          const changeOf = (piece: Ring): Ring => {
            const r = next();
            if (r < 0.3) return piece.map(fresh);
            if (r < 0.5) return [];
            if (r < 0.7) return [...piece, ...segment(1)];
            return segment(0);
          };
          const xChanged = changeOf(pieces.x);
          const yChanged = changeOf(pieces.y);
          const firstIsX = next() < 0.5;
          const ring = (x: Ring, y: Ring) => [...pieces.l, ...x, ...pieces.m, ...y, ...pieces.t];
          const before = make([[ring(pieces.x, pieces.y)]], { closed, values });
          const mine = firstIsX
            ? make([[ring(xChanged, pieces.y)]], { closed, values })
            : make([[ring(pieces.x, yChanged)]], { closed, values });
          const now = make([[ring(xChanged, yChanged)]], { closed, values });
          const expected = firstIsX
            ? make([[ring(pieces.x, yChanged)]], { closed, values })
            : make([[ring(xChanged, pieces.y)]], { closed, values });

          const diff = diffVertices(before, mine);
          const followed = followVertexDiff(diff, compareRings(mine, now));
          const result = revertVertexDiff(now, followed);
          const label = JSON.stringify({ round, pieces, xChanged, yChanged, firstIsX });
          expect(read(result.geometry), label).toEqual(read(expected));
          expect(result.skippedVertexCount, label).toBe(0);
        }
      });
    }
  }

  it('reads a deletion of one of two equal vertices side by side as the same geometry either way', () => {
    const next = random(5);
    for (let round = 0; round < 200; round++) {
      const fresh = freshPositions(2);
      const ring = Array.from({ length: 2 + Math.floor(next() * 6) }, fresh);
      const at = Math.floor(next() * ring.length);
      // Vertex `at` is doubled, and one of the two is deleted
      const doubled = [...ring.slice(0, at + 1), ring[at], ...ring.slice(at + 1)];
      const deleteFirst = doubled.filter((_, i) => i !== at);
      const deleteSecond = doubled.filter((_, i) => i !== at + 1);
      expect(deleteFirst).toEqual(deleteSecond);
      const before = make(line(doubled));
      const after = make(line(deleteFirst));
      const diff = diffVertices(before, after);
      expect(diff.deleted.indices.length).toBe(1);
      expect(read(revertVertexDiff(after, diff).geometry)).toEqual(read(before));
    }
  });
});
