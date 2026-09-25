// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { drawBillboardsWithoutDepth } from '../renderers/point/billboard-depth.js';
import { isDepthTestEnabled, setDepthTestEnabled, syncDepthTestEnabled } from './depth-state.js';

const DEPTH_TEST = 2929;

/** Minimal GL that counts the enable / disable / isEnabled calls */
function createGL(initiallyEnabled: boolean) {
  let enabled = initiallyEnabled;
  let queries = 0;
  const gl = {
    DEPTH_TEST,
    enable: (cap: number) => {
      if (cap === DEPTH_TEST) enabled = true;
    },
    disable: (cap: number) => {
      if (cap === DEPTH_TEST) enabled = false;
    },
    isEnabled: (cap: number) => {
      queries++;
      return cap === DEPTH_TEST ? enabled : false;
    },
  } as unknown as WebGL2RenderingContext;
  return { gl, queryCount: () => queries, current: () => enabled };
}

describe('recording of the depth test', () => {
  it('syncs to the actual state at the start of a frame', () => {
    const rec = createGL(true);
    syncDepthTestEnabled(rec.gl);
    expect(isDepthTestEnabled(rec.gl)).toBe(true);
    expect(rec.queryCount()).toBe(1);
  });

  it('changes both GL and the record when switched', () => {
    const rec = createGL(true);
    syncDepthTestEnabled(rec.gl);
    setDepthTestEnabled(rec.gl, false);
    expect(rec.current()).toBe(false);
    expect(isDepthTestEnabled(rec.gl)).toBe(false);
    setDepthTestEnabled(rec.gl, true);
    expect(rec.current()).toBe(true);
    expect(isDepthTestEnabled(rec.gl)).toBe(true);
  });

  it('drawing symbols never asks GL for the state', () => {
    // On a map with thousands of labels, a query per glyph becomes a synchronous
    // GPU round-trip and a frame reaches tens of seconds.
    const rec = createGL(true);
    syncDepthTestEnabled(rec.gl);
    const queriesAfterSync = rec.queryCount();

    let depthDuringDraw: boolean | null = null;
    for (let i = 0; i < 100; i++) {
      drawBillboardsWithoutDepth(rec.gl, () => {
        depthDuringDraw = rec.current();
      });
    }

    expect(depthDuringDraw).toBe(false);
    expect(rec.current()).toBe(true);
    expect(rec.queryCount()).toBe(queriesAfterSync);
  });

  it('never touches GL when the depth test was disabled to begin with', () => {
    const rec = createGL(false);
    syncDepthTestEnabled(rec.gl);
    const before = rec.queryCount();
    drawBillboardsWithoutDepth(rec.gl, () => {});
    expect(rec.current()).toBe(false);
    expect(rec.queryCount()).toBe(before);
  });

  it('keeps one record per WebGL context (two maps never read each other)', () => {
    const first = createGL(true);
    const second = createGL(false);
    syncDepthTestEnabled(first.gl);
    syncDepthTestEnabled(second.gl);

    // Drawing symbols on the second map must not re-enable the depth test there because the
    // first map recorded it as enabled
    drawBillboardsWithoutDepth(second.gl, () => {});
    expect(second.current()).toBe(false);
    expect(isDepthTestEnabled(first.gl)).toBe(true);
    expect(isDepthTestEnabled(second.gl)).toBe(false);
  });
});
