// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { FeatureStyle } from '../shared/types/model.js';
import { encodeCanonicalValue } from '../table/canonical-value.js';
import { StyleTable } from './style-table.js';

describe('StyleTable', () => {
  it('gives the same number to the same contents, whatever the order of the keys', () => {
    const table = new StyleTable();
    const a = table.intern({ fillColor: '#ff0000', strokeWidth: 2 });
    const b = table.intern({ strokeWidth: 2, fillColor: '#ff0000' });
    const c = table.intern({ fillColor: '#ff0000' });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(table.size).toBe(2);
  });

  it('keeps the keys an extension adds as part of the contents', () => {
    const table = new StyleTable();
    const plain = table.intern({ pointColor: '#000000' });
    const extended = table.intern({ pointColor: '#000000', markerLabel: 'A' } as FeatureStyle);
    expect(extended).not.toBe(plain);
    expect(table.get(extended)).toEqual({ markerLabel: 'A', pointColor: '#000000' });
  });

  it('returns the same frozen style for a number', () => {
    const table = new StyleTable();
    const id = table.intern({ lineStyle: 'dashed' });
    const style = table.get(id);
    expect(style).toBe(table.get(id));
    expect(Object.isFrozen(style)).toBe(true);
    expect(() => table.get(5)).toThrow();
  });

  it('numbers a style given as its canonical bytes like the style itself', () => {
    const table = new StyleTable();
    const bytes = encodeCanonicalValue({ fillOpacity: 0.5 });
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes, 2);
    const fromBytes = table.internBytes(padded, 2, 2 + bytes.length);
    expect(table.intern({ fillOpacity: 0.5 })).toBe(fromBytes);
  });
});

describe('StyleTable counting the rows of each style', () => {
  it('takes back a number no row uses and gives it to the next new style, with a new epoch', () => {
    const table = new StyleTable();
    const red = table.intern({ fillColor: '#ff0000' });
    table.retain(red, 2);
    const blue = table.intern({ fillColor: '#0000ff' });
    table.retain(blue);
    expect(table.size).toBe(2);
    table.release(red);
    expect(table.has(red)).toBe(true);
    table.release(red);
    // No row uses it: taken back, and the style is no longer held
    expect(table.has(red)).toBe(false);
    expect(table.size).toBe(1);
    expect(() => table.get(red)).toThrow();
    const epoch = table.epochOf(red);
    const green = table.intern({ fillColor: '#00ff00' });
    expect(green).toBe(red);
    expect(table.epochOf(green)).toBe(epoch + 1);
    expect(table.get(green)).toEqual({ fillColor: '#00ff00' });
    // The red style is a new number now, and the blue one kept its own
    expect(table.intern({ fillColor: '#0000ff' })).toBe(blue);
    expect(table.intern({ fillColor: '#ff0000' })).not.toBe(green);
  });

  it('keeps the numbers to the styles used, however many colors a row goes through', () => {
    const table = new StyleTable();
    let held = table.intern({ fillColor: '#000000' });
    table.retain(held);
    for (let i = 0; i < 1000; i++) {
      const next = table.intern({ fillColor: `#${i.toString(16).padStart(6, '0')}` });
      table.retain(next);
      table.release(held);
      held = next;
    }
    expect(table.size).toBe(1);
    expect(table.capacity).toBeLessThanOrEqual(2);
  });
});
