// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.captureImage`: the image of the map is taken in the frame the map draws next, with the
 * state of this client left out of that frame only; the size asked for is covered by the map, cut
 * at its middle (13.7 of the design of the tables: the thumbnail of a large map is taken from the
 * screen). The pixels themselves are checked by the end-to-end test.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { DrawError } from '../errors.js';
import { type CaptureCanvas, captureImage } from './capture.js';

/** A map that draws a frame when asked, telling `render` after it */
function fakeMap(width = 800, height = 600) {
  const listeners = new Set<() => void>();
  const canvas = { width, height } as HTMLCanvasElement;
  let asked = 0;
  const map = {
    on: (type: string, fn: () => void) => {
      if (type === 'render') listeners.add(fn);
    },
    off: (type: string, fn: () => void) => {
      if (type === 'render') listeners.delete(fn);
    },
    getCanvas: () => canvas,
    triggerRepaint: () => {
      asked++;
    },
  };
  return {
    map: map as unknown as MapLibreMap,
    canvas,
    /** Draws the frame asked for */
    frame() {
      for (const fn of [...listeners]) fn();
    },
    asked: () => asked,
    listeners: () => listeners.size,
  };
}

/** A canvas that records what was copied onto it */
function recordingCanvas(blob: Blob | null = new Blob(['x'])) {
  const made: Array<{
    width: number;
    height: number;
    drawn: number[];
    type?: string;
    quality?: number;
  }> = [];
  const make = (width: number, height: number): CaptureCanvas => {
    const entry: (typeof made)[number] = { width, height, drawn: [] };
    made.push(entry);
    return {
      draw: (_source, sx, sy, sw, sh) => {
        entry.drawn = [sx, sy, sw, sh];
      },
      encode: async (type, quality) => {
        entry.type = type;
        entry.quality = quality;
        return blob;
      },
    };
  };
  return { make, made };
}

describe('an image of the map', () => {
  it('is taken in the next frame, with the state of this client left out of it only', async () => {
    const map = fakeMap();
    const hidden: boolean[] = [];
    const canvas = recordingCanvas();
    const image = captureImage(map.map, (h) => hidden.push(h), undefined, canvas.make);
    expect(map.asked()).toBe(1);
    expect(hidden).toEqual([true]);
    expect(canvas.made).toEqual([]);
    map.frame();
    expect(hidden).toEqual([true, false]);
    expect(map.listeners()).toBe(0);
    expect(await image).toBeInstanceOf(Blob);
    expect(canvas.made[0]).toMatchObject({
      width: 800,
      height: 600,
      drawn: [0, 0, 800, 600],
      type: 'image/png',
    });
  });

  it('keeps the shape of the map with one side, and is cut at the middle with both', async () => {
    const map = fakeMap(800, 600);
    const canvas = recordingCanvas();
    const byWidth = captureImage(map.map, () => {}, { width: 400 }, canvas.make);
    map.frame();
    await byWidth;
    expect(canvas.made[0]).toMatchObject({ width: 400, height: 300, drawn: [0, 0, 800, 600] });
    const byHeight = captureImage(map.map, () => {}, { height: 150 }, canvas.make);
    map.frame();
    await byHeight;
    expect(canvas.made[1]).toMatchObject({ width: 200, height: 150 });
    // A square of the middle of the map
    const square = captureImage(
      map.map,
      () => {},
      { width: 300, height: 300, type: 'image/webp', quality: 0.8 },
      canvas.make,
    );
    map.frame();
    await square;
    expect(canvas.made[2]).toMatchObject({
      width: 300,
      height: 300,
      drawn: [100, 0, 600, 600],
      type: 'image/webp',
      quality: 0.8,
    });
  });

  it('rejects options of the wrong type, and a type that cannot be made', async () => {
    const map = fakeMap();
    await expect(captureImage(map.map, () => {}, { width: 0 })).rejects.toBeInstanceOf(DrawError);
    await expect(captureImage(map.map, () => {}, { quality: 2 })).rejects.toBeInstanceOf(DrawError);
    await expect(captureImage(map.map, () => {}, 'x' as never)).rejects.toBeInstanceOf(DrawError);
    expect(map.asked()).toBe(0);
    const hidden: boolean[] = [];
    const image = captureImage(
      map.map,
      (h) => hidden.push(h),
      undefined,
      recordingCanvas(null).make,
    );
    map.frame();
    await expect(image).rejects.toBeInstanceOf(DrawError);
    expect(hidden).toEqual([true, false]);
  });
});
