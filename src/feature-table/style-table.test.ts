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
