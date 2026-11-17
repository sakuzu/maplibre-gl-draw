// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The measurements of the editing benchmark (`edit.html`): the frames, each one drawn on
 * request, and the long tasks of the main thread while a scene runs
 *
 * While a recording runs, every animation frame asks the map for another frame
 * (`triggerRepaint`), so a frame is drawn whether or not the scene changed anything. Each
 * frame gives two times: the interval from the frame before (the time the page shows a
 * frame; it does not go below the refresh of the display), and the time the map took to draw
 * it, read until the GPU has finished it (one pixel is read back after the drawing), which
 * shows the differences below the refresh. The recording stops with `stop`: nothing keeps
 * running after it.
 */

import type * as maplibregl from 'maplibre-gl';

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
export const nextFrame = (): Promise<number> =>
  new Promise((resolve) => requestAnimationFrame(resolve));

/** What a recording collected */
export interface Recorded {
  /** The intervals of the animation frames (ms) */
  readonly intervals: readonly number[];
  /** The time the map took to draw each frame, until the GPU had finished it (ms) */
  readonly draws: readonly number[];
  /** The durations of the long tasks the browser reported (ms; null when it reports none) */
  readonly longTasks: readonly number[] | null;
}

/** A recording that runs until it is stopped */
export interface Recording {
  stop(): Recorded;
}

/** Whether the browser reports the long tasks of the main thread */
export function longTasksObserved(): boolean {
  return (
    typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes.includes('longtask')
  );
}

/**
 * Starts recording the frames, drawing every frame, and the long tasks
 *
 * The drawing of the map is wrapped while it records, and given back by `stop`.
 */
export function startRecording(map: maplibregl.Map): Recording {
  const intervals: number[] = [];
  const draws: number[] = [];
  const longTasks: number[] | null = longTasksObserved() ? [] : null;

  const observer =
    longTasks === null
      ? null
      : new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
  observer?.observe({ type: 'longtask' });

  const gl = map.getCanvas().getContext('webgl2');
  const pixel = new Uint8Array(4);
  const render = map._render;
  map._render = function (this: maplibregl.Map, paintStartTimeStamp: number) {
    const started = performance.now();
    const out = render.call(this, paintStartTimeStamp);
    gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    draws.push(performance.now() - started);
    return out;
  };

  let last = 0;
  let alive = true;
  const tick = (now: number): void => {
    if (!alive) return;
    intervals.push(now - last);
    last = now;
    map.triggerRepaint();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame((now) => {
    if (!alive) return;
    last = now;
    map.triggerRepaint();
    requestAnimationFrame(tick);
  });

  return {
    stop(): Recorded {
      alive = false;
      map._render = render;
      if (observer) {
        for (const entry of observer.takeRecords()) longTasks?.push(entry.duration);
        observer.disconnect();
      }
      return { intervals, draws, longTasks };
    },
  };
}

/** The median and the worst of some times (the median by the nearest rank) */
export interface Spread {
  readonly count: number;
  readonly medianMs: number;
  readonly worstMs: number;
}

/** The median and the worst of `values` (zeros when there are none) */
export function spreadOf(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, medianMs: 0, worstMs: 0 };
  return {
    count: sorted.length,
    medianMs: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))],
    worstMs: sorted[sorted.length - 1],
  };
}
