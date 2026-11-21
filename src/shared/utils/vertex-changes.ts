// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Following vertices across a change of their feature, and the changes of a geometry vertex by
 * vertex
 *
 * The rule is the one `VertexRef` states. A vertex is kept by its index. When the geometry of its
 * feature changes, each ring is compared before and after, the rings matched by their part and
 * ring numbers: the vertices equal from the start of the ring and those equal from its end are
 * found, and what lies between them is the span that changed.
 *
 * - A vertex before the span keeps its index.
 * - A vertex after the span moves its index by the difference of the lengths of the ring.
 * - A vertex inside the span cannot be followed when the length changed. When the ring keeps its
 *   length, it goes to the index where its position is now, when the span holds that position at
 *   one other index only (vertices taken out and put in at once, a ring turned around);
 *   otherwise it keeps its index (the vertex was moved).
 * - The rings are matched only while there are as many as before: when the geometry has another
 *   type or another number of parts, no vertex can be followed, and when a part has another
 *   number of rings, no vertex of that part can be.
 *
 * Two vertices are equal when every value of their positions is equal (the height and the
 * measure included). The closing position of a ring of a polygon (the last one, equal to the
 * first) counts as the first vertex, so moving the first vertex is one vertex moved.
 *
 * The same comparison reads what a change did, vertex by vertex: in a span that kept its length,
 * the vertices whose positions changed were moved (with their positions before); a vertex of the
 * span whose position is the one it had is not moved. In a span whose length changed, the
 * vertices before were deleted (with their positions) and those after were added. Of two equal
 * vertices side by side, deleting one is read as deleting the second: the geometry is the same
 * either way.
 *
 * The geometries are flat arrays, the shape of `GeometryColumn` for one geometry, so that the
 * comparison makes no object per vertex. A geometry of a column is read in place: its
 * `ringStarts` are the entries of the parts of its row (`subarray`), and its `positionStarts` and
 * `coordinates` the arrays of the column.
 *
 * These functions are internal, and no entry exports them.
 */

import type { VertexRef } from '../types/model.js';

/**
 * One geometry as flat arrays: parts made of rings made of positions, as `GeometryColumn` holds
 * them (a Point is one part of one ring of one position, a LineString one part of one ring, a
 * Polygon one part of its rings, a Multi geometry one part per member).
 */
export interface VertexGeometry {
  /** The positions, `valuesPerPosition` numbers each */
  readonly coordinates: ArrayLike<number>;
  /** The number of values of a position: 2, 3 or 4 */
  readonly valuesPerPosition: number;
  /**
   * Where the rings of each part start, as indices into `positionStarts` (one more entry than
   * there are parts)
   */
  readonly ringStarts: ArrayLike<number>;
  /**
   * Where the positions of each ring start, as indices of positions into `coordinates` (one more
   * entry than the last ring `ringStarts` reaches)
   */
  readonly positionStarts: ArrayLike<number>;
  /**
   * Whether the rings are those of a polygon: a ring whose last position is equal to its first
   * is closed, and its last position counts as the first vertex
   */
  readonly closedRings: boolean;
  /**
   * The type of the geometry, when it is known: two geometries of different types have no ring
   * matched (left out, the types are not compared)
   */
  readonly type?: string | number;
}

/**
 * How two geometries compare ring by ring: the spans that changed. Each change of the geometry
 * of a feature makes one, and every vertex kept across the change is followed with it
 * ({@link followVertexIndex}, {@link followVertexDiff}).
 */
export interface RingSpans {
  /** The number of parts before */
  readonly partCountBefore: number;
  /** The number of parts after */
  readonly partCountAfter: number;
  /** The number of rings of each part before */
  readonly ringCountsBefore: Int32Array;
  /** The number of rings of each part after */
  readonly ringCountsAfter: Int32Array;
  /**
   * Where the matched rings of each part start, in matched rings (one more entry than there are
   * parts in both). A ring is matched when its part and its ring number are there before and
   * after.
   */
  readonly matchedRingStarts: Int32Array;
  /**
   * {@link SPAN_FIELDS} numbers per matched ring: the number of vertices before and after (the
   * closing position not counted), where the span starts, where it ends before and where it ends
   * after (the ends not included), the flags ({@link CLOSED_BEFORE}, {@link CLOSED_AFTER}), and
   * where its entries start in {@link RingSpans.remap} (-1 for none)
   */
  readonly spans: Int32Array;
  /**
   * For a span that kept its length, the index each of its vertices goes to, one entry per
   * vertex of the span from its start
   */
  readonly remap: Int32Array;
  /**
   * Whether the two have the same number of parts, the same number of rings in each part and the
   * same number of values per position. When they do not, the spans are those of the matched
   * rings only, and the change is one of the whole geometry for the caller.
   */
  readonly sameStructure: boolean;
}

/** The numbers of a matched ring in {@link RingSpans.spans}. */
export const SPAN_FIELDS = 7;
/** The flag of a ring closed before the change. */
export const CLOSED_BEFORE = 1;
/** The flag of a ring closed after the change. */
export const CLOSED_AFTER = 2;

/**
 * Vertices of a geometry, one entry per vertex in flat arrays: the part, the ring and the index
 * (or the place) of each, and their positions when they are kept.
 */
export interface VertexEntries {
  /** The part of each vertex */
  readonly parts: Int32Array;
  /** The ring of each vertex */
  readonly rings: Int32Array;
  /** The index of each vertex, or where it goes (see {@link VertexDiff.deleted}) */
  readonly indices: Int32Array;
  /**
   * The positions of the vertices, `valuesPerPosition` numbers each (empty for the vertices of
   * {@link VertexDiff.added}, whose positions are not needed)
   */
  readonly positions: Float64Array;
}

/**
 * What a change did to a geometry, vertex by vertex. The entries are in the order of their parts,
 * their rings and their indices, and their indices are those of the geometry as it is now: after
 * the change, then moved along every later change ({@link followVertexDiff}).
 */
export interface VertexDiff {
  /** The number of values of the positions kept */
  readonly valuesPerPosition: number;
  /** The vertices moved, with their positions before the change */
  readonly moved: VertexEntries;
  /**
   * The vertices deleted, with their positions before the change. The index of an entry is the
   * vertex the deleted vertex was before: the vertex that followed the span the change deleted
   * it from, or the number of vertices of the ring when the span reached its end
   */
  readonly deleted: VertexEntries;
  /** The vertices added */
  readonly added: VertexEntries;
  /** The vertices that could not be followed along the later changes, and were left out */
  readonly skippedVertexCount: number;
}

/** The result of {@link revertVertexDiff}. */
export interface RevertedGeometry {
  /** The geometry with the change taken back (its starts begin at 0) */
  readonly geometry: VertexGeometry;
  /**
   * The vertices left as they are: those the diff could not follow along the later changes,
   * and those that are not in the geometry
   */
  readonly skippedVertexCount: number;
}

function partCountOf(g: VertexGeometry): number {
  return g.ringStarts.length > 0 ? g.ringStarts.length - 1 : 0;
}

function ringCountOf(g: VertexGeometry, part: number): number {
  return g.ringStarts[part + 1] - g.ringStarts[part];
}

/** Whether position `a` of `ga` and position `b` of `gb` have every value equal */
function samePosition(ga: VertexGeometry, a: number, gb: VertexGeometry, b: number): boolean {
  const n = ga.valuesPerPosition;
  if (n !== gb.valuesPerPosition) return false;
  const ca = ga.coordinates;
  const cb = gb.coordinates;
  const oa = a * n;
  const ob = b * n;
  for (let k = 0; k < n; k++) {
    if (ca[oa + k] !== cb[ob + k]) return false;
  }
  return true;
}

/** Whether a ring (its positions from `first` to `end`, the end not included) is closed */
function isClosed(g: VertexGeometry, first: number, end: number): boolean {
  return g.closedRings && end - first >= 2 && samePosition(g, first, g, end - 1);
}

/**
 * Compares two geometries ring by ring.
 *
 * @param before - The geometry before the change
 * @param after - The geometry after it
 * @returns The spans that changed
 */
export function compareRings(before: VertexGeometry, after: VertexGeometry): RingSpans {
  const partCountBefore = partCountOf(before);
  const partCountAfter = partCountOf(after);
  const ringCountsBefore = new Int32Array(partCountBefore);
  const ringCountsAfter = new Int32Array(partCountAfter);
  for (let p = 0; p < partCountBefore; p++) ringCountsBefore[p] = ringCountOf(before, p);
  for (let p = 0; p < partCountAfter; p++) ringCountsAfter[p] = ringCountOf(after, p);

  const sameType =
    before.type === undefined || after.type === undefined || before.type === after.type;
  // Another type or another number of parts: no ring is matched
  const sameParts = sameType && partCountBefore === partCountAfter;
  const matchedParts = sameParts ? partCountBefore : 0;
  const matchedRingStarts = new Int32Array(matchedParts + 1);
  let sameStructure = sameParts && before.valuesPerPosition === after.valuesPerPosition;
  for (let p = 0; p < matchedParts; p++) {
    // A part with another number of rings: none of its rings is matched
    const sameRings = ringCountsBefore[p] === ringCountsAfter[p];
    if (!sameRings) sameStructure = false;
    matchedRingStarts[p + 1] = matchedRingStarts[p] + (sameRings ? ringCountsBefore[p] : 0);
  }

  const spans = new Int32Array(matchedRingStarts[matchedParts] * SPAN_FIELDS);
  const remap: number[] = [];
  for (let p = 0; p < matchedParts; p++) {
    const count = matchedRingStarts[p + 1] - matchedRingStarts[p];
    for (let r = 0; r < count; r++) {
      const rb = before.ringStarts[p] + r;
      const ra = after.ringStarts[p] + r;
      const firstB = before.positionStarts[rb];
      const endB = before.positionStarts[rb + 1];
      const firstA = after.positionStarts[ra];
      const endA = after.positionStarts[ra + 1];
      const closedB = isClosed(before, firstB, endB);
      const closedA = isClosed(after, firstA, endA);
      const lengthB = endB - firstB - (closedB ? 1 : 0);
      const lengthA = endA - firstA - (closedA ? 1 : 0);
      const shorter = Math.min(lengthB, lengthA);

      let start = 0;
      while (start < shorter && samePosition(before, firstB + start, after, firstA + start)) {
        start++;
      }
      let tail = 0;
      while (
        tail < shorter - start &&
        samePosition(before, firstB + lengthB - 1 - tail, after, firstA + lengthA - 1 - tail)
      ) {
        tail++;
      }

      const o = (matchedRingStarts[p] + r) * SPAN_FIELDS;
      spans[o] = lengthB;
      spans[o + 1] = lengthA;
      spans[o + 2] = start;
      spans[o + 3] = lengthB - tail;
      spans[o + 4] = lengthA - tail;
      spans[o + 5] = (closedB ? CLOSED_BEFORE : 0) | (closedA ? CLOSED_AFTER : 0);
      spans[o + 6] =
        lengthB === lengthA
          ? remapSpan(before, firstB, after, firstA, start, lengthB - tail, remap)
          : -1;
    }
  }

  return {
    partCountBefore,
    partCountAfter,
    ringCountsBefore,
    ringCountsAfter,
    matchedRingStarts,
    spans,
    remap: Int32Array.from(remap),
    sameStructure,
  };
}

/** The key of a position, every value of it */
function keyOf(g: VertexGeometry, at: number): string {
  const n = g.valuesPerPosition;
  let key = '';
  for (let k = 0; k < n; k++) key += `${g.coordinates[at * n + k]},`;
  return key;
}

/**
 * Where the vertices of a span that kept its length go: a vertex whose position changed goes to
 * the index of the span where its position is now, when the span holds it at one other index
 * only; any other keeps its index
 *
 * @returns Where the entries of the span start in `remap`, or -1 when every vertex keeps its index
 */
function remapSpan(
  before: VertexGeometry,
  firstB: number,
  after: VertexGeometry,
  firstA: number,
  start: number,
  end: number,
  remap: number[],
): number {
  if (end - start < 2) return -1;
  // The indices of the span after the change, by position (-1 for a position held twice or more)
  const where = new Map<string, number>();
  for (let i = start; i < end; i++) {
    const key = keyOf(after, firstA + i);
    where.set(key, where.has(key) ? -1 : i);
  }
  const at = remap.length;
  let changed = false;
  for (let i = start; i < end; i++) {
    let to = i;
    if (!samePosition(before, firstB + i, after, firstA + i)) {
      const j = where.get(keyOf(before, firstB + i));
      if (j !== undefined && j >= 0 && j !== i) to = j;
    }
    if (to !== i) changed = true;
    remap.push(to);
  }
  if (!changed) {
    remap.length = at;
    return -1;
  }
  return at;
}

/** Where the numbers of a matched ring start in `spans`, or -1 when the ring is not matched */
function spanOffset(spans: RingSpans, part: number, ring: number): number {
  if (part < 0 || ring < 0 || part >= spans.matchedRingStarts.length - 1) return -1;
  const first = spans.matchedRingStarts[part];
  if (ring >= spans.matchedRingStarts[part + 1] - first) return -1;
  return (first + ring) * SPAN_FIELDS;
}

/** Follows an index of a vertex in the matched ring at `o` of `spans`; -1 when it cannot be */
function followAt(spans: RingSpans, o: number, index: number): number {
  const s = spans.spans;
  const lengthB = s[o];
  const lengthA = s[o + 1];
  const start = s[o + 2];
  const endB = s[o + 3];
  if (index < start) return index;
  if (index >= endB) return index + (lengthA - lengthB);
  if (lengthA !== lengthB) return -1;
  const remapAt = s[o + 6];
  return remapAt < 0 ? index : spans.remap[remapAt + index - start];
}

/**
 * Follows a vertex across a change: its index after the change.
 *
 * @param spans - The spans of the change ({@link compareRings})
 * @param part - The part of the vertex (0 for a geometry that is not Multi)
 * @param ring - The ring of the vertex
 * @param index - The index of the vertex before the change; the closing position of a closed
 *   ring is the first vertex
 * @returns The index after the change, or -1 when the vertex cannot be followed (it is not in
 *   the geometry before, it is in a span whose length changed, or its ring is not there after)
 */
export function followVertexIndex(
  spans: RingSpans,
  part: number,
  ring: number,
  index: number,
): number {
  const o = spanOffset(spans, part, ring);
  if (o < 0) return -1;
  const s = spans.spans;
  let i = index;
  if (i === s[o] && (s[o + 5] & CLOSED_BEFORE) !== 0) i = 0;
  if (i < 0 || i >= s[o]) return -1;
  return followAt(spans, o, i);
}

/**
 * Follows a vertex reference across a change ({@link followVertexIndex}).
 *
 * @param spans - The spans of the change ({@link compareRings})
 * @param ref - The vertex before the change
 * @returns The vertex after the change (its `part` left out when `ref` leaves it out), or `null`
 *   when it cannot be followed
 */
export function followVertex(spans: RingSpans, ref: VertexRef): VertexRef | null {
  const index = followVertexIndex(spans, ref.part ?? 0, ref.ring, ref.index);
  if (index < 0) return null;
  return ref.part === undefined
    ? { ring: ref.ring, index }
    : { part: ref.part, ring: ref.ring, index };
}

/** Follows where deleted vertices go: before a vertex, or at the end of the ring */
function followPlace(spans: RingSpans, o: number, place: number): number {
  const s = spans.spans;
  if (place === s[o]) return s[o + 1];
  if (place < 0 || place > s[o]) return -1;
  return followAt(spans, o, place);
}

/** Entries being made, grown as needed */
class EntryBuilder {
  parts = new Int32Array(8);
  rings = new Int32Array(8);
  indices = new Int32Array(8);
  positions: Float64Array;
  count = 0;

  constructor(
    private readonly valuesPerPosition: number,
    private readonly keepsPositions: boolean,
  ) {
    this.positions = new Float64Array(keepsPositions ? 8 * valuesPerPosition : 0);
  }

  push(part: number, ring: number, index: number, from: ArrayLike<number>, at: number): void {
    if (this.count === this.parts.length) this.grow();
    const c = this.count++;
    this.parts[c] = part;
    this.rings[c] = ring;
    this.indices[c] = index;
    if (this.keepsPositions) {
      const n = this.valuesPerPosition;
      for (let k = 0; k < n; k++) this.positions[c * n + k] = from[at * n + k];
    }
  }

  private grow(): void {
    const size = this.parts.length * 2;
    const parts = new Int32Array(size);
    parts.set(this.parts);
    this.parts = parts;
    const rings = new Int32Array(size);
    rings.set(this.rings);
    this.rings = rings;
    const indices = new Int32Array(size);
    indices.set(this.indices);
    this.indices = indices;
    if (this.keepsPositions) {
      const positions = new Float64Array(size * this.valuesPerPosition);
      positions.set(this.positions);
      this.positions = positions;
    }
  }

  build(): VertexEntries {
    const n = this.count;
    return {
      parts: this.parts.slice(0, n),
      rings: this.rings.slice(0, n),
      indices: this.indices.slice(0, n),
      positions: this.keepsPositions
        ? this.positions.slice(0, n * this.valuesPerPosition)
        : new Float64Array(0),
    };
  }
}

/**
 * Reads what a change did to a geometry, vertex by vertex, from the geometries before and after.
 * Only the matched rings are read: whether the change is one of the whole geometry (a move, a
 * rotation, a scaling, a geometry given whole, a change of the number of rings) is for the
 * caller to say ({@link RingSpans.sameStructure} tells the number of rings).
 *
 * @param before - The geometry before the change
 * @param after - The geometry after it
 * @param spans - The spans of the change, when they were compared already
 * @returns The vertices moved, deleted and added, as indices of the geometry after the change
 */
export function diffVertices(
  before: VertexGeometry,
  after: VertexGeometry,
  spans: RingSpans = compareRings(before, after),
): VertexDiff {
  const n = before.valuesPerPosition;
  const moved = new EntryBuilder(n, true);
  const deleted = new EntryBuilder(n, true);
  const added = new EntryBuilder(n, false);
  const s = spans.spans;
  const matchedParts = spans.matchedRingStarts.length - 1;
  for (let p = 0; p < matchedParts; p++) {
    const count = spans.matchedRingStarts[p + 1] - spans.matchedRingStarts[p];
    for (let r = 0; r < count; r++) {
      const o = (spans.matchedRingStarts[p] + r) * SPAN_FIELDS;
      const first = before.positionStarts[before.ringStarts[p] + r];
      const firstA = after.positionStarts[after.ringStarts[p] + r];
      const start = s[o + 2];
      const endB = s[o + 3];
      const endA = s[o + 4];
      if (s[o] === s[o + 1]) {
        for (let i = start; i < endB; i++) {
          // A vertex whose position is the one it had is not moved
          if (samePosition(before, first + i, after, firstA + i)) continue;
          moved.push(p, r, i, before.coordinates, first + i);
        }
      } else {
        for (let i = start; i < endB; i++) {
          deleted.push(p, r, endA, before.coordinates, first + i);
        }
        for (let i = start; i < endA; i++) {
          added.push(p, r, i, before.coordinates, 0);
        }
      }
    }
  }
  return {
    valuesPerPosition: n,
    moved: moved.build(),
    deleted: deleted.build(),
    added: added.build(),
    skippedVertexCount: 0,
  };
}

/** Follows entries across a change; those that cannot be followed are left out and counted */
function followEntries(
  entries: VertexEntries,
  spans: RingSpans,
  valuesPerPosition: number,
  keepsPositions: boolean,
  places: boolean,
): { entries: VertexEntries; skipped: number } {
  const out = new EntryBuilder(valuesPerPosition, keepsPositions);
  const s = spans.spans;
  let skipped = 0;
  let sorted = true;
  for (let e = 0; e < entries.indices.length; e++) {
    const part = entries.parts[e];
    const ring = entries.rings[e];
    const o = spanOffset(spans, part, ring);
    const index =
      o < 0
        ? -1
        : places
          ? followPlace(spans, o, entries.indices[e])
          : entries.indices[e] >= 0 && entries.indices[e] < s[o]
            ? followAt(spans, o, entries.indices[e])
            : -1;
    if (index < 0) {
      skipped++;
      continue;
    }
    const c = out.count;
    if (
      c > 0 &&
      out.parts[c - 1] === part &&
      out.rings[c - 1] === ring &&
      out.indices[c - 1] > index
    ) {
      sorted = false;
    }
    out.push(part, ring, index, entries.positions, e);
  }
  const built = out.build();
  // Vertices that went to other indices of their ring are put back in the order of their indices
  return { entries: sorted ? built : sortEntries(built, valuesPerPosition), skipped };
}

/**
 * Follows a diff across a later change of the same geometry: its vertices as the geometry is
 * after that change. A vertex that cannot be followed is left out and counted.
 *
 * @param diff - The diff, as the geometry was before the later change
 * @param spans - The spans of the later change ({@link compareRings})
 * @returns The diff as the geometry is after the later change
 */
export function followVertexDiff(diff: VertexDiff, spans: RingSpans): VertexDiff {
  const n = diff.valuesPerPosition;
  const moved = followEntries(diff.moved, spans, n, true, false);
  const deleted = followEntries(diff.deleted, spans, n, true, true);
  const added = followEntries(diff.added, spans, n, false, false);
  return {
    valuesPerPosition: n,
    moved: moved.entries,
    deleted: deleted.entries,
    added: added.entries,
    skippedVertexCount: diff.skippedVertexCount + moved.skipped + deleted.skipped + added.skipped,
  };
}

/** Entries in the order of their parts, rings and indices */
function sortEntries(entries: VertexEntries, valuesPerPosition: number): VertexEntries {
  const count = entries.indices.length;
  const order = Array.from({ length: count }, (_, i) => i);
  order.sort(
    (a, b) =>
      entries.parts[a] - entries.parts[b] ||
      entries.rings[a] - entries.rings[b] ||
      entries.indices[a] - entries.indices[b],
  );
  const n = valuesPerPosition;
  const keeps = entries.positions.length > 0;
  const positions = new Float64Array(keeps ? count * n : 0);
  if (keeps) {
    order.forEach((from, to) => {
      for (let k = 0; k < n; k++) positions[to * n + k] = entries.positions[from * n + k];
    });
  }
  return {
    parts: Int32Array.from(order, (i) => entries.parts[i]),
    rings: Int32Array.from(order, (i) => entries.rings[i]),
    indices: Int32Array.from(order, (i) => entries.indices[i]),
    positions,
  };
}

/** A cursor over entries in the order of their parts, rings and indices */
interface Cursor {
  readonly entries: VertexEntries;
  at: number;
}

/** Moves a cursor past the entries before a ring, counting them */
function skipBefore(c: Cursor, part: number, ring: number): number {
  let skipped = 0;
  const { parts, rings } = c.entries;
  while (
    c.at < parts.length &&
    (parts[c.at] < part || (parts[c.at] === part && rings[c.at] < ring))
  ) {
    c.at++;
    skipped++;
  }
  return skipped;
}

/** Whether the entry at the cursor is in the ring */
function inRing(c: Cursor, part: number, ring: number): boolean {
  return (
    c.at < c.entries.parts.length &&
    c.entries.parts[c.at] === part &&
    c.entries.rings[c.at] === ring
  );
}

/**
 * Takes a change back on the geometry as it is now: the vertices moved go back to their
 * positions before, the vertices added are deleted and the vertices deleted come back where they
 * were. Every other vertex is left as it is.
 *
 * The diff is the one of the change, followed along every change since ({@link followVertexDiff}),
 * so that its indices are those of `current`.
 *
 * @param current - The geometry now
 * @param diff - The diff of the change, as the geometry is now
 * @returns The geometry with the change taken back, and the number of vertices left as they are
 */
export function revertVertexDiff(current: VertexGeometry, diff: VertexDiff): RevertedGeometry {
  const total = diff.moved.indices.length + diff.deleted.indices.length + diff.added.indices.length;
  const n = current.valuesPerPosition;
  if (n !== diff.valuesPerPosition) {
    return { geometry: current, skippedVertexCount: diff.skippedVertexCount + total };
  }

  const partCount = partCountOf(current);
  const firstRing = partCount > 0 ? current.ringStarts[0] : 0;
  const ringCount = partCount > 0 ? current.ringStarts[partCount] - firstRing : 0;
  const firstPosition = ringCount > 0 ? current.positionStarts[firstRing] : 0;
  const positionCount =
    ringCount > 0 ? current.positionStarts[firstRing + ringCount] - firstPosition : 0;

  const coordinates = new Float64Array(
    (positionCount + diff.deleted.indices.length + ringCount) * n,
  );
  const ringStarts = new Int32Array(partCount + 1);
  for (let p = 0; p <= partCount; p++) ringStarts[p] = current.ringStarts[p] - firstRing;
  const positionStarts = new Int32Array(ringCount + 1);

  const moved: Cursor = { entries: diff.moved, at: 0 };
  const deleted: Cursor = { entries: diff.deleted, at: 0 };
  const added: Cursor = { entries: diff.added, at: 0 };
  const src = current.coordinates;
  let skipped = diff.skippedVertexCount;
  let written = 0;

  const put = (from: ArrayLike<number>, at: number): void => {
    for (let k = 0; k < n; k++) coordinates[written * n + k] = from[at * n + k];
    written++;
  };

  for (let p = 0; p < partCount; p++) {
    const rings = ringCountOf(current, p);
    for (let r = 0; r < rings; r++) {
      skipped += skipBefore(moved, p, r) + skipBefore(deleted, p, r) + skipBefore(added, p, r);
      const ringIndex = current.ringStarts[p] + r;
      const first = current.positionStarts[ringIndex];
      const end = current.positionStarts[ringIndex + 1];
      const closed = isClosed(current, first, end);
      const length = end - first - (closed ? 1 : 0);
      const ringFirstWritten = written;

      for (let i = 0; i <= length; i++) {
        while (inRing(deleted, p, r) && diff.deleted.indices[deleted.at] <= i) {
          if (diff.deleted.indices[deleted.at] === i) put(diff.deleted.positions, deleted.at);
          else skipped++;
          deleted.at++;
        }
        if (i === length) break;
        let isAdded = false;
        while (inRing(added, p, r) && diff.added.indices[added.at] <= i) {
          if (diff.added.indices[added.at] === i) isAdded = true;
          else skipped++;
          added.at++;
        }
        let movedAt = -1;
        while (inRing(moved, p, r) && diff.moved.indices[moved.at] <= i) {
          if (diff.moved.indices[moved.at] === i) movedAt = moved.at;
          else skipped++;
          moved.at++;
        }
        if (isAdded) {
          if (movedAt >= 0) skipped++;
          continue;
        }
        if (movedAt >= 0) put(diff.moved.positions, movedAt);
        else put(src, first + i);
      }
      // Entries past the end of the ring are not in the geometry
      while (inRing(deleted, p, r)) {
        skipped++;
        deleted.at++;
      }
      while (inRing(added, p, r)) {
        skipped++;
        added.at++;
      }
      while (inRing(moved, p, r)) {
        skipped++;
        moved.at++;
      }

      const closes = current.closedRings && (closed || end === first);
      if (closes && written > ringFirstWritten) {
        for (let k = 0; k < n; k++)
          coordinates[written * n + k] = coordinates[ringFirstWritten * n + k];
        written++;
      }
      positionStarts[ringIndex - firstRing + 1] = written;
    }
  }
  skipped +=
    diff.moved.indices.length -
    moved.at +
    (diff.deleted.indices.length - deleted.at) +
    (diff.added.indices.length - added.at);

  return {
    geometry: {
      coordinates: coordinates.slice(0, written * n),
      valuesPerPosition: n,
      ringStarts,
      positionStarts,
      closedRings: current.closedRings,
    },
    skippedVertexCount: skipped,
  };
}
