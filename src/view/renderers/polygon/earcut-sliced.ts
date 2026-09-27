// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only AND ISC

/**
 * Time-sliceable triangulation (a port of earcut 3.2.3)
 *
 * Triangulating a huge polygon (such as a water body on the order of a million
 * vertices) takes more than ten seconds in a single synchronous call as long as the
 * earcut dependency is called. Because the call cannot be stopped partway through, the
 * main thread freezes for that entire time.
 *
 * Here the main loop of earcut's ear clipping is ported into a form that "can break out
 * partway through and later resume from where it left off". The preprocessing (turning
 * the rings into a linked list, bridging the holes, z-order indexing) takes only tens of
 * milliseconds even at a million vertices, so it is not sliced and is done in one go;
 * only the time-consuming ear clipping loop is sliced.
 *
 * The algorithm is identical to upstream (the triangulation result also matches upstream
 * earcut; earcut-sliced.test.ts guarantees this by cross-checking with random inputs).
 * The only reason for the port is to "be able to break out partway through", and neither
 * the geometry nor the way triangles come out is touched. The upstream English comments
 * are left as they are as an explanation of the algorithm.
 *
 * Upstream: https://github.com/mapbox/earcut (ISC License)
 * See THIRD_PARTY_NOTICES.md for the license text.
 *
 * This is used only for polygons whose vertex count exceeds the threshold (ordinary
 * polygons call the earcut dependency directly as before; dataset/triangulation.ts).
 */

/**
 * A vertex of the circular doubly linked list that represents a ring of the polygon
 */
interface EarcutNode {
  /** The vertex number within the coordinate array */
  i: number;
  x: number;
  y: number;
  prev: EarcutNode;
  next: EarcutNode;
  /** The z-order curve value (reused as the block index while holes are bridged) */
  z: number;
  prevZ: EarcutNode | null;
  nextZ: EarcutNode | null;
}

/**
 * The number of ear clipping loop iterations run in a single step
 *
 * The caller checks the clock at this granularity, so this determines "how far the
 * budget can be overrun". The measurements on a million-vertex water body are as
 * follows.
 *
 * | slice | average per step | p99 | max | total CPU of the triangulation |
 * | --- | --- | --- | --- | --- |
 * | 16 | 0.14ms | 5.1ms | 23ms | 15.0s |
 * | 32 | 0.28ms | 10.3ms | 35ms | 15.3s |
 * | 64 | 0.52ms | 19.5ms | 55ms | 14.2s |
 *
 * Since the total hardly changes even when the slice is made finer (the cost of slicing
 * is negligible), 16 is adopted because it keeps within the budget. A long step appears
 * rarely because the recovery performed when no more ears can be found (the full sweep
 * of filterPoints) runs within a single iteration.
 */
export const EARCUT_SLICE_ITERATIONS = 16;

// === The following is upstream's mutable scratch state (alive only within one step) ===

/**
 * The "single-vertex holes" (steiner points) that filterPoints stores
 *
 * Because the triangulation stops partway through, this set has to be swapped per job
 * (it is swapped to the one of the job in question at the entrance of step).
 */
let steiners: Set<EarcutNode> = new Set();

/** The empty set steiners points at while no job is running (avoids allocating each time) */
const EMPTY_STEINERS: Set<EarcutNode> = new Set();

// set by filterPoints whenever it removes at least one node; read by the ear clipping
// loop's stall handler to decide whether another clip pass is worth attempting
let filteredOut = false;

// true only while eliminateHoles merges holes, so removeNode keeps the block index live
let indexActive = false;

/**
 * How far the triangulation has progressed
 *
 * setup = preprocessing not done yet, clip = in the middle of ear clipping,
 * done = finished.
 */
type SlicePhase = 'setup' | 'clip' | 'done';

/**
 * Time-sliceable earcut
 *
 * If `step()` is called repeatedly until completion (true), `triangles` ends up holding
 * the same index sequence as the `earcut(data, holeIndices, dim)` dependency.
 */
export class SlicedEarcut {
  private readonly data: ArrayLike<number>;
  private readonly holeIndices: ArrayLike<number> | null;
  private readonly dim: number;

  /** The triangulation result (partial progress until it finishes) */
  readonly triangles: number[] = [];

  private phase: SlicePhase = 'setup';

  // State of the ear clipping loop (carried over across steps)
  private ear: EarcutNode | null = null;
  private stop: EarcutNode | null = null;
  private cured = false;
  private minX = 0;
  private minY = 0;
  private invSize = 0;

  /** The steiner points of this job (swapped into the module variable at step's entrance) */
  private readonly ownSteiners = new Set<EarcutNode>();
  /** The filteredOut of this job (same as above) */
  private ownFilteredOut = false;

  constructor(data: ArrayLike<number>, holeIndices?: ArrayLike<number> | null, dim = 2) {
    this.data = data;
    this.holeIndices = holeIndices ?? null;
    this.dim = dim;
  }

  /** Whether it has finished */
  get done(): boolean {
    return this.phase === 'done';
  }

  /**
   * Advances the triangulation a little
   *
   * @param iterations The upper bound on ear clipping loop iterations (the default slice
   *   when omitted)
   * @returns true once it has finished
   */
  step(iterations: number = EARCUT_SLICE_ITERATIONS): boolean {
    if (this.done) return true;

    // Swap the module scratch state to this job's (so that even if another job runs
    // while this triangulation is partway through, they do not break each other's state)
    steiners = this.ownSteiners;
    filteredOut = this.ownFilteredOut;

    try {
      if (this.phase === 'setup') {
        this.runSetup();
      }
      if (this.phase === 'clip') {
        this.runClip(iterations);
      }
    } finally {
      this.ownFilteredOut = filteredOut;
      steiners = EMPTY_STEINERS;
    }

    return this.done;
  }

  /**
   * Preprocessing (building the linked list, bridging the holes, bbox, z-order indexing)
   *
   * This part is not sliced. It takes only tens of milliseconds even at a million
   * vertices, so fidelity to the port is preferred over the value of slicing it.
   */
  private runSetup(): void {
    const data = this.data;
    const holeIndices = this.holeIndices;
    const dim = this.dim;
    const hasHoles = holeIndices !== null && holeIndices.length > 0;
    const outerLen = hasHoles ? holeIndices[0] * dim : data.length;
    if (steiners.size) steiners.clear();

    let outerNode = linkedList(data, 0, outerLen, dim, true);

    if (!outerNode || outerNode.next === outerNode.prev) {
      this.phase = 'done';
      return;
    }

    if (hasHoles) outerNode = eliminateHoles(data, holeIndices, outerNode, dim);

    // if the shape is not too simple, we'll use z-order curve hash later; calculate polygon bbox
    if (data.length > 80 * dim) {
      let minX = data[0];
      let minY = data[1];
      let maxX = minX;
      let maxY = minY;

      for (let i = dim; i < outerLen; i += dim) {
        const x = data[i];
        const y = data[i + 1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }

      // minX, minY and invSize are later used to transform coords into integers for z-order
      let invSize = Math.max(maxX - minX, maxY - minY);
      invSize = invSize !== 0 ? 32767 / invSize : 0;
      this.minX = minX;
      this.minY = minY;
      this.invSize = invSize;
    }

    // interlink polygon nodes in z-order
    if (this.invSize) indexCurve(outerNode, this.minX, this.minY, this.invSize);

    this.ear = outerNode;
    this.stop = outerNode;
    this.cured = false;
    this.phase = 'clip';
  }

  /**
   * The main ear clipping loop (identical to upstream's earcutLinked; breaks out on the
   * iteration count)
   *
   * splitEarcut, the last resort, is recursive, so it is not sliced (it is a path that
   * runs only once against the remaining polygon and is not taken for ordinary inputs).
   */
  private runClip(iterations: number): void {
    const { triangles, minX, minY, invSize } = this;
    let ear = this.ear as EarcutNode;
    let stop = this.stop as EarcutNode;
    let cured = this.cured;
    let remaining = iterations;

    // iterate through ears, slicing them one by one
    while (ear.prev !== ear.next) {
      if (remaining-- <= 0) {
        this.ear = ear;
        this.stop = stop;
        this.cured = cured;
        return;
      }

      const prev = ear.prev;
      const next = ear.next;

      if (
        area(prev, ear, next) < 0 &&
        (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear))
      ) {
        triangles.push(prev.i, ear.i, next.i); // cut off the triangle

        removeNode(ear);
        ear = next;
        stop = next;
        continue;
      }

      ear = next;

      // if we looped through the whole remaining polygon and can't find any more ears
      if (ear === stop) {
        // try filtering collinear/coincident points and slicing again — repeat as long as
        // filtering actually removes nodes, since each removal can expose new ears
        filteredOut = false;
        ear = filterPoints(ear);
        if (filteredOut) {
          stop = ear;
          continue;
        }

        // filtering is exhausted: cure small local self-intersections once, then retry
        if (!cured) {
          ear = cureLocalIntersections(ear, triangles);
          stop = ear;
          cured = true;
          continue;
        }

        // as a last resort, try splitting the remaining polygon into two
        splitEarcut(ear, triangles, minX, minY, invSize);
        break;
      }
    }

    this.ear = ear;
    this.stop = stop;
    this.cured = cured;
    this.phase = 'done';
  }
}

// === The following is the port of upstream earcut (the algorithm is unmodified) ===

// create a circular doubly linked list from polygon points in the specified winding order
function linkedList(
  data: ArrayLike<number>,
  start: number,
  end: number,
  dim: number,
  clockwise: boolean,
): EarcutNode | null {
  let last: EarcutNode | null = null;

  if (clockwise === signedArea(data, start, end, dim) > 0) {
    for (let i = start; i < end; i += dim)
      last = insertNode((i / dim) | 0, data[i], data[i + 1], last);
  } else {
    for (let i = end - dim; i >= start; i -= dim)
      last = insertNode((i / dim) | 0, data[i], data[i + 1], last);
  }

  if (last && equals(last, last.next)) {
    removeNode(last);
    last = last.next;
  }

  return last;
}

// Remove collinear or coincident points; removability depends only on a node's immediate
// neighbors, so we sweep forward and re-check the predecessor after each removal. With no `end`
// we sweep the whole ring, lapping until nothing is removable (the fixpoint the clipper needs).
// With an explicit `end` we heal only the dirty window around a bridge/diagonal cut, stopping at
// `end` rather than lapping — O(window) instead of O(ring).
function filterPoints(start: EarcutNode, end: EarcutNode = start): EarcutNode {
  const full = end === start;

  let p = start;
  let again: boolean;
  do {
    again = false;
    if (
      p !== p.next &&
      (steiners.size === 0 || !steiners.has(p)) &&
      (equals(p, p.next) || area(p.prev, p, p.next) === 0)
    ) {
      if (full || p === end) end = p.prev; // pull the stop bound back past the removal
      filteredOut = true;
      removeNode(p);
      p = p.prev; // re-check the predecessor
      again = true;
    } else if (full || p !== end) {
      p = p.next;
      again = !full; // local heal: keep looping until the sweep reaches end
    }
  } while (again || p !== end);

  return end;
}

// main ear slicing loop which triangulates a polygon (given as a linked list)
//
// This has the same content as SlicedEarcut.runClip. It is left as upstream for the path
// that runs through in one go without slicing (the recursion of splitEarcut).
function earcutLinked(
  ear: EarcutNode,
  triangles: number[],
  minX: number,
  minY: number,
  invSize: number,
): void {
  // interlink polygon nodes in z-order
  if (invSize) indexCurve(ear, minX, minY, invSize);

  let stop = ear;
  let cured = false;

  // iterate through ears, slicing them one by one
  while (ear.prev !== ear.next) {
    const prev = ear.prev;
    const next = ear.next;

    if (
      area(prev, ear, next) < 0 &&
      (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear))
    ) {
      triangles.push(prev.i, ear.i, next.i); // cut off the triangle

      removeNode(ear);
      ear = next;
      stop = next;
      continue;
    }

    ear = next;

    // if we looped through the whole remaining polygon and can't find any more ears
    if (ear === stop) {
      filteredOut = false;
      ear = filterPoints(ear);
      if (filteredOut) {
        stop = ear;
        continue;
      }

      if (!cured) {
        ear = cureLocalIntersections(ear, triangles);
        stop = ear;
        cured = true;
        continue;
      }

      splitEarcut(ear, triangles, minX, minY, invSize);
      break;
    }
  }
}

// check whether a polygon node forms a valid ear with adjacent nodes
function isEar(ear: EarcutNode): boolean {
  // reflex check (area(a, b, c) >= 0) is hoisted into the caller
  const a = ear.prev;
  const b = ear;
  const c = ear.next;
  const ax = a.x;
  const bx = b.x;
  const cx = c.x;
  const ay = a.y;
  const by = b.y;
  const cy = c.y;
  const x0 = Math.min(ax, bx, cx); // triangle bbox
  const y0 = Math.min(ay, by, cy);
  const x1 = Math.max(ax, bx, cx);
  const y1 = Math.max(ay, by, cy);

  // make sure we don't have other points inside the potential ear
  let p = c.next;
  while (p !== a) {
    if (
      p.x >= x0 &&
      p.x <= x1 &&
      p.y >= y0 &&
      p.y <= y1 &&
      !(ax === p.x && ay === p.y) &&
      pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) &&
      area(p.prev, p, p.next) >= 0
    )
      return false;
    p = p.next;
  }
  return true;
}

function isEarHashed(ear: EarcutNode, minX: number, minY: number, invSize: number): boolean {
  // reflex check is hoisted into the caller (see isEar)
  const a = ear.prev;
  const b = ear;
  const c = ear.next;
  const ax = a.x;
  const bx = b.x;
  const cx = c.x;
  const ay = a.y;
  const by = b.y;
  const cy = c.y;
  const x0 = Math.min(ax, bx, cx); // triangle bbox
  const y0 = Math.min(ay, by, cy);
  const x1 = Math.max(ax, bx, cx);
  const y1 = Math.max(ay, by, cy);
  // z-order range for the current triangle bbox
  const minZ = zOrder(x0, y0, minX, minY, invSize);
  const maxZ = zOrder(x1, y1, minX, minY, invSize);

  let p = ear.prevZ;
  while (p && p.z >= minZ) {
    // look for points inside the triangle in decreasing z-order
    if (
      p.x >= x0 &&
      p.x <= x1 &&
      p.y >= y0 &&
      p.y <= y1 &&
      p !== c &&
      !(ax === p.x && ay === p.y) &&
      pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) &&
      area(p.prev, p, p.next) >= 0
    )
      return false;
    p = p.prevZ;
  }
  let n = ear.nextZ;
  while (n && n.z <= maxZ) {
    // look for points in increasing z-order
    if (
      n.x >= x0 &&
      n.x <= x1 &&
      n.y >= y0 &&
      n.y <= y1 &&
      n !== c &&
      !(ax === n.x && ay === n.y) &&
      pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) &&
      area(n.prev, n, n.next) >= 0
    )
      return false;
    n = n.nextZ;
  }
  return true;
}

// go through all polygon nodes and cure small local self-intersections
function cureLocalIntersections(start: EarcutNode, triangles: number[]): EarcutNode {
  let p = start;
  let cured = false;
  do {
    const a = p.prev;
    const b = p.next.next;

    if (intersects(a, p, p.next, b, false) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i, p.i, b.i);

      // remove two nodes involved
      removeNode(p);
      removeNode(p.next);

      p = b;
      start = b;
      cured = true;
    }
    p = p.next;
  } while (p !== start);

  return cured ? filterPoints(p) : p;
}

// try splitting polygon into two and triangulate them independently
function splitEarcut(
  start: EarcutNode,
  triangles: number[],
  minX: number,
  minY: number,
  invSize: number,
): void {
  // look for a valid diagonal that divides the polygon into two
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        // split the polygon in two by the diagonal
        let c = splitPolygon(a, b);

        // filter colinear points around the cuts
        a = filterPoints(a, a.next);
        c = filterPoints(c, c.next);

        // run earcut on each half
        earcutLinked(a, triangles, minX, minY, invSize);
        earcutLinked(c, triangles, minX, minY, invSize);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

// link every hole into the outer loop, producing a single-ring polygon without holes
function eliminateHoles(
  data: ArrayLike<number>,
  holeIndices: ArrayLike<number>,
  outerNode: EarcutNode,
  dim: number,
): EarcutNode {
  const queue: EarcutNode[] = [];

  for (let i = 0, len = holeIndices.length; i < len; i++) {
    const start = holeIndices[i] * dim;
    const end = i < len - 1 ? holeIndices[i + 1] * dim : data.length;
    const list = linkedList(data, start, end, dim, false) as EarcutNode;
    if (list === list.next) steiners.add(list);
    queue.push(getLeftmost(list));
  }

  queue.sort(compareXYSlope);

  // block-bbox index for findHoleBridge, grown append-only as holes merge
  buildBlockIndex(data.length / dim, holeIndices.length);
  indexSegment(outerNode, outerNode);

  // process holes from left to right
  indexActive = true;
  for (let i = 0; i < queue.length; i++) {
    outerNode = eliminateHole(queue[i], outerNode);
  }
  indexActive = false;

  // collapse collinear/coincident points across the whole merged ring once before clipping
  return filterPoints(outerNode);
}

function compareXYSlope(a: EarcutNode, b: EarcutNode): number {
  // when the left-most point of 2 holes meet at a vertex, sort the holes counterclockwise so that
  // when we find the bridge to the outer shell it is always the point that they meet at.
  return (
    a.x - b.x ||
    a.y - b.y ||
    (a.next.y - a.y) / (a.next.x - a.x) - (b.next.y - b.y) / (b.next.x - b.x)
  );
}

// find a bridge between vertices that connects hole with an outer ring and link it
function eliminateHole(hole: EarcutNode, outerNode: EarcutNode): EarcutNode {
  const bridge = findHoleBridge(hole, outerNode);
  if (!bridge) {
    return outerNode;
  }

  const bridgeReverse = splitPolygon(bridge, hole);

  // index the merged-in segment before filtering
  const bridge2 = bridgeReverse.next;
  indexSegment(bridge, bridge2.next);

  // heal collinear/coincident points around the two new slit edges
  filterPoints(bridgeReverse, bridgeReverse.next);
  return filterPoints(bridge, bridge.next);
}

// Block-bbox index for findHoleBridge: one [minX,minY,maxX,maxY] bbox per K consecutive ring
// edges, in a flat Float64Array, so the leftward-ray scan can skip whole blocks in O(1).
const K = 16; // edges per block

let blockBBox = new Float64Array(0); // [minX,minY,maxX,maxY] per block
let numBlocks = 0;
const blockHead: EarcutNode[] = []; // first node of each block's segment
const blockStop: EarcutNode[] = []; // node just past each block's segment

function buildBlockIndex(maxNodes: number, numHoles: number): void {
  // upper bound: every input node indexed once, +2 bridge nodes per hole, plus a partial
  // trailing block per appended segment (outer ring + one per hole)
  const maxBlocks = Math.ceil((maxNodes + 2 * numHoles) / K) + numHoles + 2;
  if (blockBBox.length < maxBlocks * 4) blockBBox = new Float64Array(maxBlocks * 4);
  numBlocks = 0;
}

// index the ring run head..stop (exclusive) as ceil(len / K) blocks; head === stop means
// the whole ring. each block's bbox covers both endpoints of every edge it owns.
function indexSegment(head: EarcutNode, stop: EarcutNode): void {
  let p = head;
  do {
    const b = numBlocks++;
    blockHead[b] = p;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let k = 0;
    do {
      const c = p.next; // edge p->c; bbox must bound both endpoints
      p.z = b; // reuse z as the owning block during eliminateHoles (see growBlock)
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
      p = c;
    } while (++k < K && p !== stop);
    blockStop[b] = p;
    const g = b * 4;
    blockBBox[g] = minX;
    blockBBox[g + 1] = minY;
    blockBBox[g + 2] = maxX;
    blockBBox[g + 3] = maxY;
  } while (p !== stop);
}

// when filterPoints heals an edge head->tail, grow head's block bbox to cover tail so the
// leftward-ray prune can't false-skip it.
function growBlock(head: EarcutNode, tail: EarcutNode): void {
  const g = head.z * 4;
  if (tail.x < blockBBox[g]) blockBBox[g] = tail.x;
  if (tail.y < blockBBox[g + 1]) blockBBox[g + 1] = tail.y;
  if (tail.x > blockBBox[g + 2]) blockBBox[g + 2] = tail.x;
  if (tail.y > blockBBox[g + 3]) blockBBox[g + 3] = tail.y;
}

function liveBlockStop(b: number): EarcutNode {
  let stop = blockStop[b];
  while (stop.prev.next !== stop) stop = stop.next;
  blockStop[b] = stop;
  return stop;
}

// the block's head node can be removed by filterPoints during merges; advance it to the next
// live node so the walk doesn't start on (and immediately terminate at) a dead node.
function liveBlockHead(b: number): EarcutNode {
  let head = blockHead[b];
  while (head.prev.next !== head) head = head.next;
  blockHead[b] = head;
  return head;
}

// David Eberly's algorithm for finding a bridge between hole and outer polygon
function findHoleBridge(hole: EarcutNode, outerNode: EarcutNode): EarcutNode | null {
  let p = outerNode;
  const hx = hole.x;
  const hy = hole.y;
  let qx = Number.NEGATIVE_INFINITY;
  let m: EarcutNode | undefined;

  // find a segment intersected by a ray from the hole's leftmost point to the left;
  // segment's endpoint with lesser x will be potential connection point
  // unless they intersect at a vertex, then choose the vertex
  if (equals(hole, p)) return p;

  // scan blocks; skip any whose bbox can't hold a crossing that beats qx and lies left of hx
  for (let b = 0, g = 0; b < numBlocks; b++, g += 4) {
    if (
      hy < blockBBox[g + 1] ||
      hy > blockBBox[g + 3] ||
      blockBBox[g] > hx ||
      blockBBox[g + 2] <= qx
    )
      continue;

    // ensure the walk's exclusive bound is live so we don't overrun into other blocks
    const stop = liveBlockStop(b);

    p = liveBlockHead(b);
    do {
      if (p.prev.next === p) {
        // skip nodes removed by filterPoints (stale in the index)
        if (equals(hole, p.next)) return p.next;
        if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
          const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y);
          if (x <= hx && x > qx) {
            qx = x;
            m = p.x < p.next.x ? p : p.next;
            if (x === hx) return m; // hole touches outer segment; pick leftmost endpoint
          }
        }
      }
      p = p.next;
    } while (p !== stop);
  }

  if (!m) return null;

  // look for points inside the triangle of hole point, segment intersection and endpoint;
  // if there are no points found, we have a valid connection;
  // otherwise choose the point of the minimum angle with the ray as connection point

  const mx = m.x;
  const my = m.y;
  const tminY = Math.min(hy, my); // the triangle's y span; x span is [mx, hx]
  const tmaxY = Math.max(hy, my);
  let tanMin = Number.POSITIVE_INFINITY;

  // scan the same blocks; skip any whose bbox can't overlap the triangle's box
  for (let b = 0, g = 0; b < numBlocks; b++, g += 4) {
    if (
      blockBBox[g + 2] < mx ||
      blockBBox[g] > hx ||
      blockBBox[g + 3] < tminY ||
      blockBBox[g + 1] > tmaxY
    )
      continue;

    const stop = liveBlockStop(b);

    p = liveBlockHead(b);
    do {
      if (
        p.prev.next === p &&
        hx >= p.x &&
        p.x >= mx &&
        hx !== p.x && // skip dead nodes
        pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)
      ) {
        const tan = Math.abs(hy - p.y) / (hx - p.x); // tangential

        // if hole point sits on p's horizontal edge (T-junction touch): the bridge runs
        // along that edge — locallyInside rejects it as collinear, but it's valid
        if (
          (locallyInside(p, hole) || (p.y === hy && p.next.y === hy && p.next.x > hx)) &&
          (tan < tanMin ||
            (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))
        ) {
          m = p;
          tanMin = tan;
        }
      }

      p = p.next;
    } while (p !== stop);
  }

  return m;
}

// whether sector in vertex m contains sector in vertex p in the same coordinates
function sectorContainsSector(m: EarcutNode, p: EarcutNode): boolean {
  return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;
}

// scratch buffers reused across calls and grown on demand
const sortArr: EarcutNode[] = [];
let sortBuf: EarcutNode[] = [];
let zArr = new Uint32Array(0);
let zBuf = new Uint32Array(0);
const counts = new Uint32Array(256);

// interlink polygon nodes in z-order: collect into an array, sort by z, relink
function indexCurve(start: EarcutNode, minX: number, minY: number, invSize: number): void {
  let p = start;
  let n = 0;
  do {
    // always (re)compute: z may still hold a block index left over from eliminateHoles
    p.z = zOrder(p.x, p.y, minX, minY, invSize);
    sortArr[n++] = p;
    p = p.next;
  } while (p !== start);

  sortNodes(n);

  let prev: EarcutNode | null = null;
  for (let i = 0; i < n; i++) {
    const node = sortArr[i];
    node.prevZ = prev;
    if (prev) prev.nextZ = node;
    prev = node;
  }
  (prev as EarcutNode).nextZ = null;
}

// sort the first n nodes of sortArr by z, in place: insertion sort for small n, else LSD radix
function sortNodes(n: number): void {
  if (n <= 32) {
    for (let i = 1; i < n; i++) {
      const node = sortArr[i];
      const z = node.z;
      let j = i - 1;
      while (j >= 0 && sortArr[j].z > z) {
        sortArr[j + 1] = sortArr[j];
        j--;
      }
      sortArr[j + 1] = node;
    }
    return;
  }

  if (zArr.length < n) {
    zArr = new Uint32Array(n);
    zBuf = new Uint32Array(n);
    sortBuf = new Array(n);
  }
  for (let i = 0; i < n; i++) zArr[i] = sortArr[i].z;

  // even pass count lands the sorted result back in sortArr
  radixPass(n, sortArr, zArr, sortBuf, zBuf, 0);
  radixPass(n, sortBuf, zBuf, sortArr, zArr, 8);
  radixPass(n, sortArr, zArr, sortBuf, zBuf, 16);
  radixPass(n, sortBuf, zBuf, sortArr, zArr, 24);
}

// one LSD radix pass: stably scatter the first n nodes (and their z) from src to dst
function radixPass(
  n: number,
  src: EarcutNode[],
  srcZ: Uint32Array,
  dst: EarcutNode[],
  dstZ: Uint32Array,
  shift: number,
): void {
  counts.fill(0);
  for (let i = 0; i < n; i++) counts[(srcZ[i] >>> shift) & 0xff]++;
  // turn per-bucket counts into start offsets (prefix sum)
  let sum = 0;
  for (let b = 0; b < 256; b++) {
    const c = counts[b];
    counts[b] = sum;
    sum += c;
  }
  for (let i = 0; i < n; i++) {
    const z = srcZ[i];
    const pos = counts[(z >>> shift) & 0xff]++;
    dst[pos] = src[i];
    dstZ[pos] = z;
  }
}

// z-order of a point given coords and inverse of the longer side of data bbox
function zOrder(x: number, y: number, minX: number, minY: number, invSize: number): number {
  // coords are transformed into non-negative 15-bit integer range
  x = ((x - minX) * invSize) | 0;
  y = ((y - minY) * invSize) | 0;

  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;

  y = (y | (y << 8)) & 0x00ff00ff;
  y = (y | (y << 4)) & 0x0f0f0f0f;
  y = (y | (y << 2)) & 0x33333333;
  y = (y | (y << 1)) & 0x55555555;

  return x | (y << 1);
}

// find the leftmost node of a polygon ring
function getLeftmost(start: EarcutNode): EarcutNode {
  let p = start;
  let leftmost = start;
  do {
    if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p;
    p = p.next;
  } while (p !== start);

  return leftmost;
}

// check if a point lies within a convex triangle
function pointInTriangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
): boolean {
  return (
    (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
    (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
    (bx - px) * (cy - py) >= (cx - px) * (by - py)
  );
}

// check if a diagonal between two polygon nodes is valid (lies in polygon interior)
function isValidDiagonal(a: EarcutNode, b: EarcutNode): boolean {
  // degenerate case
  const zeroLength = equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0;
  return (
    a.next.i !== b.i &&
    (zeroLength ||
      (locallyInside(a, b) && // locally visible
        locallyInside(b, a) &&
        (area(a.prev, a, b.prev) !== 0 || area(a, b.prev, b) !== 0))) && // no opposite-facing sectors
    !intersectsPolygon(a, b) &&
    (zeroLength || middleInside(a, b))
  );
}

// signed area of a triangle
function area(p: EarcutNode, q: EarcutNode, r: EarcutNode): number {
  return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

// check if two points are equal
function equals(p1: EarcutNode, p2: EarcutNode): boolean {
  return p1.x === p2.x && p1.y === p2.y;
}

// check if two segments intersect; by default includes collinear boundary touches
function intersects(
  p1: EarcutNode,
  q1: EarcutNode,
  p2: EarcutNode,
  q2: EarcutNode,
  includeBoundary = true,
): boolean {
  const o1 = area(p1, q1, p2);
  const o2 = area(p1, q1, q2);
  const o3 = area(p2, q2, p1);
  const o4 = area(p2, q2, q1);

  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)))
    return true;

  if (!includeBoundary) return false;

  if (o1 === 0 && onSegment(p1, p2, q1)) return true; // p1, q1 and p2 are collinear and p2 lies on p1q1
  if (o2 === 0 && onSegment(p1, q2, q1)) return true; // p1, q1 and q2 are collinear and q2 lies on p1q1
  if (o3 === 0 && onSegment(p2, p1, q2)) return true; // p2, q2 and p1 are collinear and p1 lies on p2q2
  if (o4 === 0 && onSegment(p2, q1, q2)) return true; // p2, q2 and q1 are collinear and q1 lies on p2q2

  return false;
}

// for collinear points p, q, r, check if point q lies on segment pr
function onSegment(p: EarcutNode, q: EarcutNode, r: EarcutNode): boolean {
  return (
    q.x <= Math.max(p.x, r.x) &&
    q.x >= Math.min(p.x, r.x) &&
    q.y <= Math.max(p.y, r.y) &&
    q.y >= Math.min(p.y, r.y)
  );
}

// check if a polygon diagonal intersects any polygon segments
function intersectsPolygon(a: EarcutNode, b: EarcutNode): boolean {
  // diagonal bbox; an edge whose bbox can't overlap it can't intersect it
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);

  let p = a;
  do {
    const n = p.next;
    if (
      (p.x > maxX && n.x > maxX) ||
      (p.x < minX && n.x < minX) ||
      (p.y > maxY && n.y > maxY) ||
      (p.y < minY && n.y < minY)
    ) {
      p = n;
      continue;
    }
    if (p.i !== a.i && n.i !== a.i && p.i !== b.i && n.i !== b.i && intersects(p, n, a, b))
      return true;
    p = n;
  } while (p !== a);

  return false;
}

// check if a polygon diagonal is locally inside the polygon
function locallyInside(a: EarcutNode, b: EarcutNode): boolean {
  return area(a.prev, a, a.next) < 0
    ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
    : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}

// check if the middle point of a polygon diagonal is inside the polygon
function middleInside(a: EarcutNode, b: EarcutNode): boolean {
  let p = a;
  let inside = false;
  const px = (a.x + b.x) / 2;
  const py = (a.y + b.y) / 2;
  do {
    const n = p.next;
    if (p.y > py !== n.y > py && px < ((n.x - p.x) * (py - p.y)) / (n.y - p.y) + p.x)
      inside = !inside;
    p = n;
  } while (p !== a);

  return inside;
}

// link two polygon vertices with a bridge; if the vertices belong to the same ring, it splits
// polygon into two; if one belongs to the outer ring and another to a hole, it merges it
function splitPolygon(a: EarcutNode, b: EarcutNode): EarcutNode {
  const a2 = createNode(a.i, a.x, a.y);
  const b2 = createNode(b.i, b.x, b.y);
  const an = a.next;
  const bp = b.prev;

  a.next = b;
  b.prev = a;

  a2.next = an;
  an.prev = a2;

  b2.next = a2;
  a2.prev = b2;

  bp.next = b2;
  b2.prev = bp;

  return b2;
}

// create a node and optionally link it with previous one (in a circular doubly linked list)
function insertNode(i: number, x: number, y: number, last: EarcutNode | null): EarcutNode {
  const p = createNode(i, x, y);

  if (!last) {
    p.prev = p;
    p.next = p;
  } else {
    p.next = last.next;
    p.prev = last;
    last.next.prev = p;
    last.next = p;
  }
  return p;
}

function removeNode(p: EarcutNode): void {
  p.next.prev = p.prev;
  p.prev.next = p.next;

  if (p.prevZ) p.prevZ.nextZ = p.nextZ;
  if (p.nextZ) p.nextZ.prevZ = p.prevZ;

  // keep the hole-bridge index's block bboxes covering the healed prev->next edge
  if (indexActive) growBlock(p.prev, p.next);
}

function createNode(i: number, x: number, y: number): EarcutNode {
  // prev/next are assigned by the caller before any read
  return {
    i, // vertex index in coordinates array
    x,
    y, // vertex coordinates
    prev: null as unknown as EarcutNode, // previous and next vertex nodes in a polygon ring
    next: null as unknown as EarcutNode,
    z: 0, // z-order curve value; doubles as owning block in the hole-bridge index
    prevZ: null, // previous and next nodes in z-order
    nextZ: null,
  };
}

function signedArea(data: ArrayLike<number>, start: number, end: number, dim: number): number {
  let sum = 0;
  for (let i = start, j = end - dim; i < end; i += dim) {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
    j = i;
  }
  return sum;
}
