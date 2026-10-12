// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The building of retained chunks over the frames (`advanceChunkBuilds`)
 *
 * A chunk owns its retained batches (GPU resources). When it is missing them, or when the ones
 * it has no longer match what would be built now (the terrain they were cut for went stale, the
 * way the fills are drawn changed, the view went far from their origin), a build is started and
 * advanced a slice at a time within the budget of the frame. The batches already built keep
 * being drawn until the build is finished, and are replaced in the frame it finishes, so nothing
 * on screen goes missing and no frame pays for a whole chunk.
 *
 * The part every kind of chunk shares is here: the culling by the view, the choice of the
 * origin, the starting and the stepping of the builds while the camera is still, the budget,
 * and the replacement. What is built and how it is drawn belongs to the host: the datasets
 * (`dataset/chunk-set.ts`) and the rows held as columns (`view/layer/table-retained.ts`).
 *
 * The budget is given by the caller, so that one budget can be shared by every chunk built in a
 * frame. It counts the time of the work only (the starts and the steps of the builds): the
 * drawing of the chunks already built, which comes in between in the order of the chunks, does
 * not use it.
 */

import type { BoundingBox } from '../../shared/types/model.js';
import { boundsCenter, rebasedRetainedOrigin } from '../shaders/retained-origin.js';

/**
 * A build in progress, advanced a slice at a time
 *
 * @internal
 */
export interface RetainedChunkJob<B> {
  /**
   * Advances until the deadline (at least one slice is done per call)
   *
   * @returns Whether the build is finished
   */
  step(deadline: number, now: () => number): boolean;
  /** The finished batches (null when unfinished or when the build failed) */
  take(): B | null;
  /** Discards what was built so far */
  dispose(): void;
}

/**
 * A chunk and the state of its retained batches
 *
 * @internal
 */
export interface RetainedChunkState<B> {
  /** The extent of the chunk (the culling and the default origin) */
  readonly bounds: BoundingBox;
  /** The batches drawn (null before the first build, or once discarded) */
  batches: B | null;
  /** The build in progress */
  job: RetainedChunkJob<B> | null;
  /** The origin the batches were built with */
  origin: [number, number] | null;
  /** The origin the build in progress uses */
  jobOrigin: [number, number] | null;
  /** The origin chosen for the view (null = the center of the extent) */
  viewOrigin: [number, number] | null;
  /** Whether the batches must be built again although they keep being drawn until then */
  stale: boolean;
}

/**
 * The time the work done a step at a time may take in a frame
 *
 * Only the time spent in the steps is counted. What the frame does between them (drawing what is
 * built, the other layers, the host) does not use the budget, so a frame that draws much still
 * gives the work its time.
 *
 * @internal
 */
export interface ChunkBuildBudget {
  /** The clock the budget is measured with */
  now(): number;
  /** Whether one more step may be done in this frame (the first step of the frame always may) */
  canStep(): boolean;
  /**
   * Does one step of work, and counts it and the time it takes
   *
   * @param work The step. It is given the time the budget runs out at, counted from when the step
   *   starts (the start itself when nothing is left: a step does at least one slice)
   * @returns What the step returns
   */
  step<T>(work: (deadline: number) => T): T;
}

/**
 * A monotonic clock (it works even where `performance` is missing)
 *
 * @internal
 */
export function chunkClock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * The budget of one frame: `ms` of work, and always at least one step
 *
 * @param ms The time the work may take (Infinity: every build in view finishes in the frame)
 * @internal
 */
export function createChunkBuildBudget(
  ms: number,
  now: () => number = chunkClock,
): ChunkBuildBudget {
  let spent = 0;
  let steps = 0;
  return {
    now,
    canStep: () => steps === 0 || spent < ms,
    step<T>(work: (deadline: number) => T): T {
      const start = now();
      steps++;
      try {
        return work(start + Math.max(0, ms - spent));
      } finally {
        spent += now() - start;
      }
    },
  };
}

/**
 * What the building asks of the kind of chunk
 *
 * @internal
 */
export interface ChunkSchedulerHost<S extends RetainedChunkState<B>, B> {
  /** Whether the batches built no longer match what would be built now */
  isStale(state: S): boolean;
  /** Starts a build with an origin (the host remembers what the build assumes) */
  startJob(state: S, origin: [number, number]): RetainedChunkJob<B>;
  /** Called once the batches of a finished build are in place (the host records what they assume) */
  adoptJob(state: S): void;
  /** Releases batches that are replaced */
  disposeBatches(batches: B): void;
  /**
   * Draws the batches of a chunk
   *
   * @returns false when something of the chunk is left for a later frame
   */
  draw(state: S): boolean;
}

/**
 * The frame the chunks are built and drawn in
 *
 * @internal
 */
export interface ChunkSchedulerFrame {
  /** The view, in longitudes and latitudes (a chunk outside it is skipped) */
  readonly bounds: BoundingBox;
  /** The zoom (for the choice of the origin) */
  readonly zoom: number;
  /**
   * Whether the camera is still. While it moves, nothing is started or stepped (a build of 20 to
   * 50 ms makes a gesture stutter, and the view it would be built for changes anyway)
   */
  readonly settled: boolean;
  /** The time the builds may take */
  readonly budget: ChunkBuildBudget;
}

/**
 * The origin of the batches of a chunk (the one recorded with them, or the center of the
 * extent before the first build)
 *
 * @internal
 */
export function chunkOrigin<B>(state: RetainedChunkState<B>): [number, number] {
  return state.origin ?? boundsCenter(state.bounds);
}

/**
 * Builds and draws the chunks that meet the view, in their order
 *
 * @returns Whether something is left for a later frame (a build not finished or not started)
 * @internal
 */
export function advanceChunkBuilds<S extends RetainedChunkState<B>, B>(
  states: Iterable<S>,
  frame: ChunkSchedulerFrame,
  host: ChunkSchedulerHost<S, B>,
): boolean {
  const { bounds, zoom, settled, budget } = frame;
  let pending = false;

  for (const state of states) {
    if (!intersects(state.bounds, bounds)) continue;

    // A chunk seen far from its origin at high zoom is built again around the view (the batches
    // it has keep being drawn until then)
    const rebased =
      state.batches !== null && !state.job
        ? rebasedRetainedOrigin(chunkOrigin(state), state.bounds, bounds, zoom)
        : null;
    if (rebased) state.viewOrigin = rebased;
    const stale =
      state.batches !== null && (state.stale || host.isStale(state) || rebased !== null);

    const wantsBuild = state.job !== null || !state.batches || stale;
    if (wantsBuild && !settled) pending = true;
    if (wantsBuild && settled) {
      if (budget.canStep()) {
        // A build is started in the step that first advances it, so the time of starting it
        // (what the host walks to size the build) is counted as well
        const done = budget.step((deadline) => {
          if (!state.job) {
            const origin = state.viewOrigin ?? boundsCenter(state.bounds);
            state.jobOrigin = origin;
            state.job = host.startJob(state, origin);
          }
          return state.job.step(deadline, budget.now);
        });
        const job = state.job as RetainedChunkJob<B>;
        if (done) {
          const built = job.take();
          state.job = null;
          if (built) {
            // The old batches are discarded only once the new ones are complete (no flicker)
            if (state.batches) host.disposeBatches(state.batches);
            state.batches = built;
            state.origin = state.jobOrigin;
            state.stale = false;
            host.adoptJob(state);
          }
          // When it could not be built (the shaders are not ready) it is built on a later frame
        } else {
          pending = true;
        }
      } else {
        pending = true;
      }
    }

    if (!state.batches) continue;
    if (!host.draw(state)) pending = true;
  }

  return pending;
}

/**
 * Makes a chunk build its batches again
 *
 * The build in progress is discarded (it was for what changed). With `keepDrawing` the batches
 * keep being drawn until the new ones are built; without it they are released at once and the
 * chunk draws nothing until then.
 *
 * @internal
 */
export function invalidateChunk<S extends RetainedChunkState<B>, B>(
  state: S,
  host: Pick<ChunkSchedulerHost<S, B>, 'disposeBatches'>,
  keepDrawing: boolean,
): void {
  if (state.job) {
    state.job.dispose();
    state.job = null;
  }
  if (!state.batches) return;
  if (keepDrawing) {
    state.stale = true;
    return;
  }
  host.disposeBatches(state.batches);
  state.batches = null;
}

/** Whether two boxes meet (touching edges meet) */
function intersects(a: BoundingBox, b: BoundingBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
