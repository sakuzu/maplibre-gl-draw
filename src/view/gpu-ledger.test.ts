// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { GpuLedger, textureBytes } from './gpu-ledger.js';

describe('GpuLedger', () => {
  it('adds what is allocated and takes out what is released, per renderer', () => {
    const ledger = new GpuLedger();
    const a = {};
    const b = {};
    const t = {};
    ledger.record(a, 'points', 'buffer', 100);
    ledger.record(b, 'lines', 'buffer', 40);
    ledger.record(t, 'lines', 'texture', textureBytes(4, 4, 16));
    expect(ledger.snapshot()).toMatchObject({
      bytes: 396,
      bufferBytes: 140,
      textureBytes: 256,
      byOwner: { points: 100, lines: 296 },
    });
    ledger.release(b);
    ledger.release(b);
    expect(ledger.snapshot().byOwner).toEqual({ points: 100, lines: 256 });
  });

  it('replaces the size of a buffer written again, as bufferData replaces its storage', () => {
    const ledger = new GpuLedger();
    const buffer = {};
    ledger.record(buffer, 'polygons', 'buffer', 1000);
    ledger.record(buffer, 'polygons', 'buffer', 300);
    expect(ledger.snapshot().bytes).toBe(300);
    ledger.release(buffer);
    expect(ledger.snapshot()).toMatchObject({
      bytes: 0,
      bufferBytes: 0,
      textureBytes: 0,
      byOwner: {},
    });
  });

  it('ignores a missing object', () => {
    const ledger = new GpuLedger();
    ledger.record(null, 'points', 'buffer', 10);
    ledger.release(null);
    expect(ledger.snapshot().bytes).toBe(0);
  });

  it('tells the most bytes held at once, and the allocations made', () => {
    const ledger = new GpuLedger();
    const a = {};
    const b = {};
    ledger.record(a, 'x', 'buffer', 100);
    ledger.record(b, 'x', 'texture', 50);
    ledger.release(a);
    ledger.record(a, 'x', 'buffer', 10);
    expect(ledger.snapshot()).toMatchObject({ bytes: 60, peakBytes: 150, allocations: 3 });
  });
});
