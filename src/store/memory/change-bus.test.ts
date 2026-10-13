// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows held as columns in the notifications of a transaction: one entry per row, a row
 * created and deleted within the transaction dropped, the fields and the keys of the styles
 * gathered
 */

import { describe, expect, it } from 'vitest';
import type { LayerRowsChange, RowField, RowsChange } from '../../api/tables.js';
import type { StoreChange } from '../types.js';
import { ChangeBus } from './change-bus.js';

function rows(
  layerId: string,
  change: Partial<Record<'created' | 'updated' | 'deleted', number[]>> & {
    fields?: RowField[];
    styleKeys?: string[];
  },
): RowsChange {
  const entry: LayerRowsChange = {
    created: Int32Array.from(change.created ?? []),
    updated: Int32Array.from(change.updated ?? []),
    deleted: Int32Array.from(change.deleted ?? []),
    fields: new Set(change.fields ?? []),
    styleKeys: new Set(change.styleKeys ?? []),
  };
  return { layers: new Map([[layerId, entry]]) };
}

describe('the rows in the notifications of a transaction', () => {
  it('are one entry per row, a row created and deleted within it dropped', () => {
    const bus = new ChangeBus();
    const seen: StoreChange[] = [];
    bus.subscribe((change) => seen.push(change));
    bus.transact(() => {
      bus.merge({ rows: rows('a', { created: [1, 2], fields: ['geometry'] }) });
      bus.merge({
        rows: rows('a', { updated: [2, 3], fields: ['style'], styleKeys: ['fillColor'] }),
      });
      bus.merge({ rows: rows('a', { deleted: [1, 4] }) });
      bus.merge({ rows: rows('b', { updated: [9] }) });
    });
    expect(seen).toHaveLength(1);
    const a = seen[0].rows?.layers.get('a');
    expect(Array.from(a?.created ?? [])).toEqual([2]);
    expect(Array.from(a?.updated ?? [])).toEqual([3]);
    expect(Array.from(a?.deleted ?? [])).toEqual([4]);
    expect([...(a?.fields ?? [])]).toEqual(['geometry', 'style']);
    expect([...(a?.styleKeys ?? [])]).toEqual(['fillColor']);
    expect(Array.from(seen[0].rows?.layers.get('b')?.updated ?? [])).toEqual([9]);
  });
});
