// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import type { FeatureRow, SelectionValue } from '@sakuzu/maplibre-gl-draw';
import { describe, expect, it } from 'vitest';
import { groupSelection, ungroupSelection, type WriteDraw } from '../src/writes.js';

/** A draw whose selection lists no IDs (selected in bulk), with the writes it is given */
function bulkDraw(rows: Array<{ id: string; groupId: string | null; layerId?: string }>) {
  const calls: unknown[] = [];
  const value: SelectionValue = {
    type: 'feature',
    count: rows.length,
    ids: null,
  } as unknown as SelectionValue;
  const tx = {
    groups: {
      create: async (input: unknown) => calls.push(['create', input]),
    },
    features: {
      place: async (ids: unknown, to: unknown) => calls.push(['place', ids, to]),
    },
  };
  const draw = {
    write: async (fn: (t: typeof tx) => unknown) => fn(tx),
    selection: {
      value,
      target: { type: 'selection', count: rows.length },
      scan: async (visit: (row: FeatureRow) => void) => {
        for (const row of rows) visit({ layerId: 'l', ...row } as unknown as FeatureRow);
      },
    },
  } as unknown as WriteDraw;
  return { draw, calls };
}

describe('the group writes over features selected in bulk', () => {
  it('make a group of every feature the selection scans', async () => {
    const { draw, calls } = bulkDraw([
      { id: 'a', groupId: null },
      { id: 'b', groupId: null },
    ]);
    expect(await groupSelection(draw)).toBe(true);
    expect(calls).toEqual([['create', { members: ['a', 'b'] }]]);
  });

  it('take the features the selection scans out of their groups, in front of each, in order', async () => {
    const { draw, calls } = bulkDraw([
      { id: 'a', groupId: 'g1' },
      { id: 'b', groupId: 'g1' },
      { id: 'c', groupId: null },
      { id: 'd', groupId: 'g2' },
    ]);
    expect(await ungroupSelection(draw)).toBe(true);
    expect(calls).toEqual([
      ['place', ['a', 'b'], { layerId: 'l', below: 'g1' }],
      ['place', ['d'], { layerId: 'l', below: 'g2' }],
    ]);
  });
  it('take the features selected in bulk all in one group out of it through the target, as rows', async () => {
    const { draw, calls } = bulkDraw([
      { id: 'a', groupId: 'g1' },
      { id: 'b', groupId: 'g1' },
    ]);
    expect(await ungroupSelection(draw)).toBe(true);
    expect(calls).toEqual([['place', draw.selection.target, { layerId: 'l', below: 'g1' }]]);
  });
});
