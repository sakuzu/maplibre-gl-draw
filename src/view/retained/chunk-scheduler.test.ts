// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  advanceChunkBuild,
  advanceChunkBuilds,
  type ChunkSchedulerHost,
  createChunkBuildBudget,
  invalidateChunk,
  type RetainedChunkState,
} from './chunk-scheduler.js';

/** A chunk whose batches are a label of the build */
interface State extends RetainedChunkState<string> {
  name: string;
  builds: number;
}

function state(name: string, minX = 0): State {
  return {
    name,
    builds: 0,
    bounds: { minX, minY: 0, maxX: minX + 1, maxY: 1 },
    batches: null,
    job: null,
    origin: null,
    jobOrigin: null,
    viewOrigin: null,
    stale: false,
  };
}

/** A host whose builds take `steps` steps; it records the draws and the disposals */
function host(steps = 1) {
  const drawn: string[] = [];
  const disposed: string[] = [];
  const h: ChunkSchedulerHost<State, string> = {
    isStale: () => false,
    startJob: (s) => {
      let left = steps;
      const version = `${s.name}#${++s.builds}`;
      return {
        step: () => --left <= 0,
        take: () => version,
        dispose: () => {
          disposed.push(`job ${version}`);
        },
      };
    },
    adoptJob: () => {},
    disposeBatches: (batches) => {
      disposed.push(batches);
    },
    draw: (s) => {
      drawn.push(s.batches as string);
      return true;
    },
  };
  return { h, drawn, disposed };
}

const VIEW = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
const frame = (settled = true, ms = Number.POSITIVE_INFINITY) => ({
  bounds: VIEW,
  zoom: 10,
  settled,
  budget: createChunkBuildBudget(ms),
});

describe('advanceChunkBuilds', () => {
  it('builds the chunks in view and draws them in their order', () => {
    const states = [state('a'), state('b'), state('far', 50)];
    const { h, drawn } = host();
    expect(advanceChunkBuilds(states, frame(), h)).toBe(false);
    expect(drawn).toEqual(['a#1', 'b#1']);
    expect(states[2].batches).toBeNull();
  });

  it('starts and steps nothing while the camera moves, and asks for another frame', () => {
    const states = [state('a')];
    const { h, drawn } = host();
    expect(advanceChunkBuilds(states, frame(false), h)).toBe(true);
    expect(states[0].job).toBeNull();
    expect(drawn).toEqual([]);
  });

  it('steps at least one build per frame with no budget left', () => {
    const states = [state('a'), state('b')];
    const { h, drawn } = host();
    const budget = frame(true, 0);
    expect(advanceChunkBuilds(states, budget, h)).toBe(true);
    expect(drawn).toEqual(['a#1']);
    expect(advanceChunkBuilds(states, frame(true, 0), h)).toBe(false);
    expect(drawn).toEqual(['a#1', 'a#1', 'b#1']);
  });

  it('keeps drawing the batches it has until the new ones are built', () => {
    const states = [state('a')];
    const { h, drawn, disposed } = host(3);
    // Three frames to build
    advanceChunkBuilds(states, frame(true, 0), h);
    advanceChunkBuilds(states, frame(true, 0), h);
    advanceChunkBuilds(states, frame(true, 0), h);
    expect(drawn).toEqual(['a#1']);
    invalidateChunk(states[0], h, true);
    expect(states[0].stale).toBe(true);
    advanceChunkBuilds(states, frame(true, 0), h);
    advanceChunkBuilds(states, frame(true, 0), h);
    expect(drawn).toEqual(['a#1', 'a#1', 'a#1']);
    expect(disposed).toEqual([]);
    advanceChunkBuilds(states, frame(true, 0), h);
    expect(drawn).toEqual(['a#1', 'a#1', 'a#1', 'a#2']);
    expect(disposed).toEqual(['a#1']);
    expect(states[0].stale).toBe(false);
  });

  it('releases the batches at once when it does not keep drawing them', () => {
    const states = [state('a')];
    const { h, disposed } = host(2);
    advanceChunkBuilds(states, frame(), h);
    advanceChunkBuilds(states, frame(), h);
    expect(states[0].batches).toBe('a#1');
    advanceChunkBuilds(states, frame(true, 0), h);
    invalidateChunk(states[0], h, false);
    expect(states[0].batches).toBeNull();
    expect(disposed).toEqual(['a#1']);
  });

  it('discards the build in progress when the chunk is invalidated', () => {
    const states = [state('a')];
    const { h, disposed } = host(5);
    advanceChunkBuilds(states, frame(true, 0), h);
    expect(states[0].job).not.toBeNull();
    invalidateChunk(states[0], h, true);
    expect(states[0].job).toBeNull();
    expect(disposed).toEqual(['job a#1']);
  });

  it('gives the builds their time however long the drawing of the chunks built takes', () => {
    // A clock that the draws and the steps move: every draw takes 50 ms, a step 1 ms
    let clock = 0;
    const now = (): number => clock;
    const states = ['a', 'b', 'c', 'd', 'e'].map((name) => state(name));
    const { h } = host();
    const timed: ChunkSchedulerHost<State, string> = {
      ...h,
      startJob: (s, origin) => {
        const job = h.startJob(s, origin);
        return {
          ...job,
          step: (deadline, n) => {
            clock += 1;
            return job.step(deadline, n);
          },
        };
      },
      draw: (s) => {
        clock += 50;
        return h.draw(s);
      },
    };
    const budget = createChunkBuildBudget(12, now);
    expect(
      advanceChunkBuilds(states, { bounds: VIEW, zoom: 10, settled: true, budget }, timed),
    ).toBe(false);
    expect(states.every((s) => s.batches !== null)).toBe(true);
  });

  it('counts the start of a build in the budget, and starts no build once it is spent', () => {
    let clock = 0;
    const states = [state('a'), state('b')];
    const { h } = host();
    const slow: ChunkSchedulerHost<State, string> = {
      ...h,
      startJob: (s, origin) => {
        clock += 20;
        return h.startJob(s, origin);
      },
    };
    const budget = createChunkBuildBudget(12, () => clock);
    expect(
      advanceChunkBuilds(states, { bounds: VIEW, zoom: 10, settled: true, budget }, slow),
    ).toBe(true);
    expect(states[0].batches).toBe('a#1');
    expect(states[1].job).toBeNull();
    expect(states[1].batches).toBeNull();
  });
});

describe('createChunkBuildBudget', () => {
  it('counts the time of the steps only, and gives a step the time left of the budget', () => {
    let clock = 0;
    const budget = createChunkBuildBudget(10, () => clock);
    clock += 100;
    expect(budget.canStep()).toBe(true);
    const first = budget.step((deadline) => {
      clock += 4;
      return deadline;
    });
    expect(first).toBe(110);
    clock += 100;
    expect(budget.canStep()).toBe(true);
    const second = budget.step((deadline) => {
      clock += 7;
      return deadline;
    });
    expect(second).toBe(210);
    expect(budget.canStep()).toBe(false);
    // A step past the budget is given no time (it does a slice and stops)
    expect(budget.step((deadline) => deadline)).toBe(clock);
  });

  it('always lets the first step of a frame go', () => {
    const budget = createChunkBuildBudget(0, () => 0);
    expect(budget.canStep()).toBe(true);
    budget.step(() => {});
    expect(budget.canStep()).toBe(false);
  });
});

describe('advanceChunkBuild', () => {
  it('builds a chunk out of view only when rows of it moved on the GPU are seen', () => {
    const { h } = host();
    const away = state('away', 100);
    advanceChunkBuild(away, frame(), h);
    expect(away.batches).toBeNull();
    const seenFrom = { minX: 90, minY: 0, maxX: 110, maxY: 1 };
    advanceChunkBuild(away, { ...frame(), movedViews: [seenFrom] }, h);
    expect(away.batches).toBe('away#1');
  });

  it('does for one chunk what advanceChunkBuilds does for each, with one frame for all', () => {
    for (const steps of [1, 3]) {
      for (const ms of [0, Number.POSITIVE_INFINITY]) {
        const together = [state('a'), state('b'), state('far', 50), state('c')];
        const alone = [state('a'), state('b'), state('far', 50), state('c')];
        const a = host(steps);
        const b = host(steps);
        for (let f = 0; f < 4; f++) {
          const pendingTogether = advanceChunkBuilds(together, frame(true, ms), a.h);
          const shared = frame(true, ms);
          let pendingAlone = false;
          for (const chunk of alone) {
            if (advanceChunkBuild(chunk, shared, b.h)) pendingAlone = true;
          }
          expect(pendingAlone).toBe(pendingTogether);
          expect(b.drawn).toEqual(a.drawn);
        }
      }
    }
  });
});
