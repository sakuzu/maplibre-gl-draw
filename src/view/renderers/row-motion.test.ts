// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The motion of a moving set on the GPU, through its float32 copy in JavaScript
 *
 * - What is drawn moved is within a pixel of what is written once let go (the computation of the
 *   library in float64), at zoom 18 and 22, for the points seen on the screen: over 0.2 degrees
 *   around Tokyo (moves to the east and to the north, a rotation, scalings) and over the south
 *   and the north of Japan (a move from Tokyo to Sapporo, a rotation, a scaling), with the origin
 *   of the batch taken near where the center of the camera is moved from
 * - The same, at the zoom where the selection fits a screen of 1,000 pixels, the origin left at
 *   the center of the selection
 * - A row that keeps its shape is scaled by `sizeFactor`
 * - An edit that moves nothing has no motion
 */

import { describe, expect, it } from 'vitest';
import { applyEnuEdit, type EnuEdit } from '../../geometry/enu-transforms.js';
import { MotionUniformValues, motionFrameOf, moveOffsetFloat32 } from './row-motion.js';

const DEG = Math.PI / 180;
const TILE = 512;

/** A random number generator of a fixed seed (mulberry32) */
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

function scatter(seed: number, west: number, south: number, east: number, north: number) {
  const next = random(seed);
  const out: Array<[number, number]> = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
  ];
  for (let i = 0; i < 1500; i++) {
    out.push([west + (east - west) * next(), south + (north - south) * next()]);
  }
  return out;
}

/** Web Mercator world coordinates (0 to 1) */
function world([lng, lat]: readonly number[]): [number, number] {
  const s = Math.sin((lat as number) * DEG);
  return [((lng as number) + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

function fromWorld([x, y]: readonly [number, number]): [number, number] {
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
}

function pixels(a: readonly number[], b: readonly number[], zoom: number): number {
  const wa = world(a);
  const wb = world(b);
  return Math.hypot(wa[0] - wb[0], wa[1] - wb[1]) * TILE * 2 ** zoom;
}

/** The largest gap in pixels between what is drawn and what is written */
function worstGap(
  points: ReadonlyArray<[number, number]>,
  edit: EnuEdit,
  zoom: number | 'fit',
  uniformScale = false,
): number {
  const next = random(99);
  const values = new MotionUniformValues();
  let worst = 0;
  let fitZoom = 0;
  let boxCenter: [number, number] = [0, 0];
  let fitCenter: [number, number] = [0, 0];
  const written = points.map(
    (p) =>
      applyEnuEdit(edit, { geometry: { type: 'Point', coordinates: p }, uniformScale }).geometry
        .coordinates as number[],
  );
  if (zoom === 'fit') {
    // The selection fits the screen; the camera is at the center of where it is moved to, and the
    // origin of the batch is the center of where it was
    const boxOf = (list: ReadonlyArray<readonly number[]>) => {
      const w = list.map(world);
      const xs = w.map((v) => v[0]);
      const ys = w.map((v) => v[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
    };
    const before = boxOf(points);
    const after = boxOf(written);
    fitZoom = Math.log2(1000 / (TILE * Math.max(before[2] - before[0], before[3] - before[1])));
    boxCenter = fromWorld([(before[0] + before[2]) / 2, (before[1] + before[3]) / 2]).map(
      Math.fround,
    ) as [number, number];
    fitCenter = fromWorld([(after[0] + after[2]) / 2, (after[1] + after[3]) / 2]).map(
      Math.fround,
    ) as [number, number];
  }
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as [number, number];
    const done = written[i] as number[];
    let K: [number, number];
    let z: number;
    if (zoom === 'fit') {
      z = fitZoom;
      K = fitCenter;
    } else {
      z = zoom;
      const w = world(done);
      const span = 450 / (TILE * 2 ** zoom);
      K = fromWorld([w[0] + (2 * next() - 1) * span, w[1] + (2 * next() - 1) * span]).map(
        Math.fround,
      ) as [number, number];
    }
    const frame = motionFrameOf(edit, uniformScale, K);
    if (!frame) throw new Error('no motion');
    // The origin of the batch: near where K is moved from, or the center of the selection
    const origin: [number, number] =
      zoom === 'fit' ? boxCenter : [Math.fround(frame.fromLon), Math.fround(frame.fromLat)];
    values.write(0, frame, origin);
    const offset: [number, number] = [Math.fround(p[0] - origin[0]), Math.fround(p[1] - origin[1])];
    const moved = moveOffsetFloat32(values, 0, offset);
    const shown = [K[0] + moved[0], K[1] + moved[1]];
    worst = Math.max(worst, pixels(shown, done, z));
  }
  return worst;
}

const TOKYO_CENTER: [number, number] = [139.7, 35.68];
const JAPAN_CENTER: [number, number] = [137, 38];
const TOKYO: [number, number] = [139.6917, 35.6895];
const SAPPORO: [number, number] = [141.3544, 43.0621];

const SCENES: Array<[string, ReadonlyArray<[number, number]>, EnuEdit]> = (() => {
  const tokyo = scatter(1, 139.6, 35.58, 139.8, 35.78);
  const japan = scatter(2, 129, 31, 145, 45);
  return [
    ['Tokyo, east', tokyo, { kind: 'translate', from: TOKYO_CENTER, to: [139.75, 35.68] }],
    ['Tokyo, north', tokyo, { kind: 'translate', from: TOKYO_CENTER, to: [139.7, 35.73] }],
    ['Tokyo, 30 degrees', tokyo, { kind: 'rotate', center: TOKYO_CENTER, angleDegrees: 30 }],
    [
      'Tokyo, 1.5 times',
      tokyo,
      { kind: 'scale', center: TOKYO_CENTER, eastFactor: 1.5, northFactor: 1.5, sizeFactor: 1.5 },
    ],
    [
      'Tokyo, 2 times east',
      tokyo,
      { kind: 'scale', center: TOKYO_CENTER, eastFactor: 2, northFactor: 1, sizeFactor: 1 },
    ],
    ['Japan, Tokyo to Sapporo', japan, { kind: 'translate', from: TOKYO, to: SAPPORO }],
    ['Japan, 30 degrees', japan, { kind: 'rotate', center: JAPAN_CENTER, angleDegrees: 30 }],
    [
      'Japan, 1.5 times',
      japan,
      { kind: 'scale', center: JAPAN_CENTER, eastFactor: 1.5, northFactor: 1.5, sizeFactor: 1.5 },
    ],
  ];
})();

describe('the motion of a moving set on the GPU', () => {
  for (const [name, points, edit] of SCENES) {
    it(`draws within a pixel of what is written: ${name}`, () => {
      expect(worstGap(points, edit, 18)).toBeLessThan(1);
      expect(worstGap(points, edit, 22)).toBeLessThan(1);
      expect(worstGap(points, edit, 'fit')).toBeLessThan(1);
    });
  }

  it('scales a row that keeps its shape by the factor of the size', () => {
    const points = scatter(3, 139.6, 35.58, 139.8, 35.78);
    const edit: EnuEdit = {
      kind: 'scale',
      center: TOKYO_CENTER,
      eastFactor: 2,
      northFactor: 0.5,
      sizeFactor: 1.25,
    };
    expect(worstGap(points, edit, 22, true)).toBeLessThan(1);
  });

  it('has no motion for an edit that moves nothing', () => {
    expect(
      motionFrameOf({ kind: 'rotate', center: TOKYO_CENTER, angleDegrees: 0 }, false, TOKYO),
    ).toBe(null);
    expect(
      motionFrameOf({ kind: 'translate', from: TOKYO, to: [TOKYO[0], TOKYO[1]] }, false, TOKYO),
    ).toBe(null);
  });
});
