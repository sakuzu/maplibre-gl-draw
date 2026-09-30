// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The builders from packed typed arrays write exactly what the builders from arrays of objects
 * write, so a table and the same features draw the same picture
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../../shared/config/feature-style.js';
import { toPackedPointStyle, toPointInstanceData } from './batch-manager.js';
import {
  buildLineBatchArrays,
  buildPackedLineBatchArrays,
  toLineInstanceColor,
} from './line/line-geometry.js';
import type { LineBatchItem } from './line/line-types.js';
import {
  buildPackedPointInstanceData,
  buildPointInstanceData,
  PACKED_POINT_STYLE_STRIDE,
  type PointInstanceDataFull,
} from './point/point-instance.js';
import type { PointStyle } from './point/point-shape.js';

describe('packed points', () => {
  it('give the same instance array as the objects', () => {
    const base = DEFAULT_FEATURE_STYLE_CONFIG.point.point;
    const styles: PointStyle[] = [
      base,
      { ...base, size: 7.3, fillOpacity: 0.35, strokeOpacity: 0 },
      { ...base, fillColor: [0.2, 0.4, 0.6, 0.9], strokeWidth: 1.7 },
    ];
    const objects: PointInstanceDataFull[] = [];
    const lngLat: number[] = [];
    const style: number[] = [];
    for (let i = 0; i < 30; i++) {
      const coord: [number, number] = [139.123456789 + i * 0.001, 35.987654321 - i * 0.0007];
      const s = styles[i % styles.length];
      objects.push(toPointInstanceData(coord, s));
      lngLat.push(...coord);
      style.push(...toPackedPointStyle(s));
    }
    expect(style.length).toBe(30 * PACKED_POINT_STYLE_STRIDE);
    const origin: [number, number] = [Math.fround(139.1), Math.fround(35.9)];
    for (const ratio of [1, 2, 1.25]) {
      expect(
        buildPackedPointInstanceData(
          { count: 30, lngLat: Float64Array.from(lngLat), style: Float64Array.from(style) },
          origin,
          ratio,
        ),
      ).toEqual(buildPointInstanceData(objects, origin, ratio));
    }
  });
});

describe('packed lines', () => {
  it('give the same texture and instance array as the objects', () => {
    const coords: number[] = [];
    const items: LineBatchItem[] = [];
    const start: number[] = [];
    const end: number[] = [];
    const widths: number[] = [];
    const zooms: number[] = [];
    const colors: number[] = [];
    for (let i = 0; i < 12; i++) {
      const positions: Array<[number, number]> = [];
      for (let k = 0; k < 2 + (i % 5); k++) {
        positions.push([139.5 + i * 0.01 + k * 0.003, 35.6 + Math.sin(i + k) * 0.002]);
      }
      const color: [number, number, number, number] = [0.1 * (i % 10), 0.5, 0.25, 0.8];
      const opacity = i % 2 === 0 ? 1 : 0.6;
      const strokeWidth = i % 3 === 0 ? -2.5 : 1.5 + i * 0.1;
      const createdZoom = i % 3 === 0 ? 0 : 11 + (i % 4);
      items.push({
        coords: positions,
        featureId: `l${i}`,
        closed: false,
        strokeWidth,
        createdZoom,
        color,
        opacity,
      });
      start.push(coords.length / 3);
      // The packed coordinates carry a third value that is skipped
      for (const p of positions) coords.push(p[0], p[1], 123);
      end.push(coords.length / 3);
      widths.push(strokeWidth);
      zooms.push(createdZoom);
      colors.push(...toLineInstanceColor(color, opacity));
    }
    const origin: [number, number] = [Math.fround(139.5), Math.fround(35.6)];
    for (const [zoom, ratio] of [
      [0, 1],
      [13.5, 2],
    ]) {
      const packed = buildPackedLineBatchArrays(
        {
          count: items.length,
          coords: Float64Array.from(coords),
          stride: 3,
          start: Int32Array.from(start),
          end: Int32Array.from(end),
          strokeWidth: Float64Array.from(widths),
          createdZoom: Float64Array.from(zooms),
          color: Float64Array.from(colors),
        },
        zoom,
        origin,
        ratio,
      );
      expect(packed).toEqual(buildLineBatchArrays(items, zoom, origin, ratio));
    }
  });
});
