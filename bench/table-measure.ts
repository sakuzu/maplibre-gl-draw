// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The measurements of the page of the layers held as rows: the intervals of the animation frames
 * (their median, 95th percentile and longest), the JS heap, and the GPU memory the drawing holds
 */

import type { Draw } from '@sakuzu/maplibre-gl-draw';
import type * as maplibregl from 'maplibre-gl';

declare global {
  interface Performance {
    memory?: { usedJSHeapSize: number };
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  }
}

export const MB = 1024 * 1024;

/** The statistics of the frames of one phase */
export interface PhaseResult {
  readonly name: string;
  readonly frames: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  /** The JS heap at the end of the phase (MB; null when the browser does not tell) */
  readonly heapMb: number | null;
  /** The GPU memory of the drawing at the end of the phase (MB) */
  readonly gpuMb: number;
}

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
export const nextFrame = (): Promise<number> =>
  new Promise((resolve) => requestAnimationFrame(resolve));

/** The JS heap now (MB; null when the browser does not tell) */
export function heapMb(): number | null {
  const memory = performance.memory;
  return memory ? memory.usedJSHeapSize / MB : null;
}

/** The intervals of the frames while `run` goes, drawing every frame */
export async function recordFrames(
  map: maplibregl.Map,
  run: () => Promise<void>,
): Promise<number[]> {
  const intervals: number[] = [];
  let last = performance.now();
  let alive = true;
  const tick = (now: number): void => {
    intervals.push(now - last);
    last = now;
    map.triggerRepaint();
    if (alive) requestAnimationFrame(tick);
  };
  requestAnimationFrame((now) => {
    last = now;
    requestAnimationFrame(tick);
  });
  await run();
  alive = false;
  return intervals;
}

/** The statistics of the intervals of a phase */
export function phaseOf(draw: Draw, name: string, intervals: number[]): PhaseResult {
  const sorted = [...intervals].sort((a, b) => a - b);
  const pick = (p: number): number =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    name,
    frames: intervals.length,
    medianMs: pick(0.5),
    p95Ms: pick(0.95),
    maxMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    heapMb: heapMb(),
    gpuMb: draw.debug.gpu().bytes / MB,
  };
}

/** The frames of a phase without anything going on (the frames before and after an edit) */
export async function idleFrames(map: maplibregl.Map, frames = 60): Promise<number[]> {
  return recordFrames(map, async () => {
    for (let i = 0; i < frames; i++) await nextFrame();
  });
}
