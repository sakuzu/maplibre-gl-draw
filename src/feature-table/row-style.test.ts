// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The style of a row read without making its feature (`LayerTableView.getRowStyle`): the object
 * the table of styles shares between the rows of one style, frozen, the one the feature of the
 * row holds, after a write too
 */

import { describe, expect, it } from 'vitest';
import type { FeatureTables } from '../api/tables.js';
import { DrawStore } from '../store/draw-store.js';
import { TableContractStore } from '../store/table-memory.js';
import type { Feature } from '../store/types.js';

function point(id: string, x: number, style: Feature['style']): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [x, 0] },
    layerId: 'l',
    groupId: undefined,
    properties: {},
    style,
    visible: true,
    locked: false,
  };
}

describe('the style of a row', () => {
  it('is the frozen style the rows of one style share, the one of the feature of the row', () => {
    const store = new DrawStore(new TableContractStore());
    store.createLayer({
      id: 'l',
      name: 'l',
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      styleRule: undefined,
      metadata: undefined,
    });
    store.transact(() => {
      store.createFeature(point('a', 0, { pointColor: '#ff0000' }));
      store.createFeature(point('b', 1, { pointColor: '#ff0000' }));
      store.createFeature(point('c', 2, {}));
    });
    const tables = store.tables as FeatureTables;
    const view = tables.get('l');
    const handle = (id: string) => tables.findRow(id) as number;
    const a = view?.getRowStyle(handle('a'));
    expect(a).toEqual({ pointColor: '#ff0000' });
    expect(Object.isFrozen(a)).toBe(true);
    expect(view?.getRowStyle(handle('b'))).toBe(a);
    expect(view?.getRowStyle(handle('c'))).toEqual({});
    expect(view?.getRow(handle('a'))?.style).toEqual(a);
    expect(view?.getRowStyle(-5)).toBeUndefined();
    store.updateFeature('c', { style: { pointColor: '#00ff00' } });
    expect(view?.getRowStyle(handle('c'))).toEqual({ pointColor: '#00ff00' });
  });
});
