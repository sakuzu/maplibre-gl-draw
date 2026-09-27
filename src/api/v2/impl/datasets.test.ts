// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.datasets and the Dataset of the API: the collection, the members in the
 * language of rows, the events of a dataset and the events of the instance about datasets
 */

import type { BBox } from 'geojson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tableFromFeatures } from '../../../table/index.js';
import { createMapStub } from '../../../test-utils.js';
import type { Engine } from '../../engine.js';
import { createEngine } from '../../engine.js';
import type { DatasetEvents, DatasetRow, DatasetsCollection } from '../datasets.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { DrawEvents } from '../events.js';
import { createDatasets } from './datasets.js';

const point = (id: string, lng: number, lat: number, properties = {}): DatasetRow => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties,
});

const line: DatasetRow = {
  type: 'Feature',
  id: 'l',
  geometry: {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [0.5, 0.25],
    ],
  },
  properties: { name: 'road' },
};

const ROWS = [point('a', 0.1, 0.1, { name: 'A' }), point('b', 0.2, 0.2), line];

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof DrawError ? error.code : 'other';
  }
  return undefined;
}

let draw: Draw;
let datasets: DatasetsCollection;

beforeEach(() => {
  vi.useFakeTimers();
  draw = createDraw(createMapStub().map);
  datasets = draw.datasets;
});

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

describe('the collection', () => {
  it('adds, gets, lists, counts and removes datasets', () => {
    expect(datasets.count()).toBe(0);
    const dataset = datasets.add({ id: 'shops', rows: ROWS });
    expect(dataset.id).toBe('shops');
    expect(datasets.get('shops')).toBe(dataset);
    expect(datasets.has('shops')).toBe(true);
    expect(datasets.get('none')).toBeUndefined();
    expect(datasets.list()).toEqual([dataset]);
    expect(datasets.count()).toBe(1);
    expect(datasets.remove('shops')).toBe(true);
    expect(datasets.has('shops')).toBe(false);
  });

  it('throws already-exists for a taken ID and invalid-input for wrong options', () => {
    datasets.add({ id: 'a', rows: [] });
    expect(codeOf(() => datasets.add({ id: 'a', rows: [] }))).toBe('already-exists');
    expect(codeOf(() => datasets.add({ id: 'b' } as never))).toBe('invalid-input');
    expect(
      codeOf(() => datasets.add({ id: 'b', rows: [], provider: async () => [] } as never)),
    ).toBe('invalid-input');
    expect(codeOf(() => datasets.add({ id: '', rows: [] }))).toBe('invalid-input');
    expect(codeOf(() => datasets.add({ id: 'b', rows: [], order: 'top' as never }))).toBe(
      'invalid-input',
    );
    expect(
      codeOf(() => datasets.add({ id: 'b', rows: [], baseStyle: { fill: { fillColor: 'nope' } } })),
    ).toBe('invalid-input');
    expect(codeOf(() => datasets.add({ id: 'b', rows: [], colour: 'red' } as never))).toBe(
      'invalid-input',
    );
  });

  it('adds several datasets, all of them or none', () => {
    const added = datasets.addMany([
      { id: 'a', rows: [] },
      { id: 'b', rows: [] },
    ]);
    expect(added.map((d) => d.id)).toEqual(['a', 'b']);
    expect(
      codeOf(() =>
        datasets.addMany([
          { id: 'c', rows: [] },
          { id: 'c', rows: [] },
        ]),
      ),
    ).toBe('already-exists');
    expect(codeOf(() => datasets.addMany([{ id: 'd', rows: [] }, { id: 'e' } as never]))).toBe(
      'invalid-input',
    );
    expect(datasets.list().map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('removes several datasets, all of them or none, and throws not-found for an unknown ID', () => {
    datasets.addMany([
      { id: 'a', rows: [] },
      { id: 'b', rows: [] },
    ]);
    expect(codeOf(() => datasets.remove('none'))).toBe('not-found');
    expect(codeOf(() => datasets.removeMany(['a', 'none']))).toBe('not-found');
    expect(datasets.count()).toBe(2);
    expect(datasets.removeMany(['a', 'b'])).toBe(true);
    expect(datasets.count()).toBe(0);
  });

  it('moves a dataset and throws not-found for an unknown ID', () => {
    datasets.addMany([
      { id: 'a', rows: [] },
      { id: 'b', rows: [] },
    ]);
    expect(datasets.move('b', { index: 0 })).toBe(true);
    expect(datasets.list().map((d) => d.id)).toEqual(['b', 'a']);
    expect(datasets.move('a', { order: 'above-store' })).toBe(true);
    expect(datasets.get('a')?.order).toBe('above-store');
    expect(codeOf(() => datasets.move('none', {}))).toBe('not-found');
    expect(codeOf(() => datasets.move('a', { index: -1 }))).toBe('invalid-input');
  });
});

describe('the events of the instance about datasets', () => {
  it('announces the datasets added, removed and reordered', () => {
    const added: DrawEvents['dataset.added'][] = [];
    const removed: DrawEvents['dataset.removed'][] = [];
    const reordered: DrawEvents['dataset.reordered'][] = [];
    draw.on('dataset.added', (payload) => added.push(payload));
    draw.on('dataset.removed', (payload) => removed.push(payload));
    draw.on('dataset.reordered', (payload) => reordered.push(payload));

    const a = datasets.add({ id: 'a', rows: [] });
    datasets.add({ id: 'b', rows: [] });
    expect(added.map(({ dataset }) => dataset)).toEqual([a, datasets.get('b')]);
    expect(added[0].dataset).toBe(a);

    datasets.move('b', { index: 0 });
    expect(reordered).toEqual([{ order: ['b', 'a'], previous: ['a', 'b'] }]);

    datasets.remove('a');
    expect(removed).toEqual([{ datasetId: 'a' }]);
  });
});

describe('a dataset', () => {
  it('reads its rows as GeoJSON features', () => {
    const dataset = datasets.add({ id: 'd', rows: ROWS });
    expect(dataset.listRows()).toEqual(ROWS);
    expect(dataset.getRow(0)).toEqual(ROWS[0]);
    expect(dataset.getRow(9)).toBeUndefined();
    expect(dataset.getRowId(1)).toBe('b');
    expect(dataset.getRowType(2)).toBe('LineString');
    expect(dataset.getRowType(9)).toBeNull();
    expect(dataset.getRowBounds(2)).toEqual([0, 0, 0.5, 0.25]);
    expect(dataset.getRowPoint(0)).toEqual([0.1, 0.1]);
    expect(dataset.getRowPoint(2)).toBeNull();
    expect(dataset.findRow('l')).toBe(2);
    expect(dataset.findRow('none')).toBeNull();
  });

  it('lists the rows of a range, with and without their drawn look', () => {
    const dataset = datasets.add({
      id: 'd',
      rows: ROWS,
      baseStyle: { point: { pointColor: 'teal' } },
    });
    const bbox: BBox = [0.15, 0.15, 1, 1];
    const visible = dataset.listVisibleRows(bbox);
    expect(visible.map((row) => row.id)).toEqual(['b', 'l']);
    expect((visible[0] as DatasetRow & { style?: object }).style).toMatchObject({
      pointColor: 'teal',
    });
    expect(dataset.listVisibleRows([0.15, 0.15, 0, 1, 1, 0]).map((row) => row.id)).toEqual([
      'b',
      'l',
    ]);
    expect(dataset.listDrawnRows(bbox)).toBeInstanceOf(Int32Array);
    expect(typeof dataset.getDrawnRowsRevision()).toBe('number');
  });

  it('replaces its rows and its table, and tells it with changed and the reason rows', () => {
    const dataset = datasets.add({ id: 'd', rows: ROWS });
    const changes: DatasetEvents['changed'][] = [];
    const listener = (payload: DatasetEvents['changed']) => changes.push(payload);
    dataset.on('changed', listener);
    dataset.setRows([point('z', 1, 1)]);
    expect(dataset.listRows().map((row) => row.id)).toEqual(['z']);
    dataset.setTable(tableFromFeatures(ROWS));
    expect(dataset.listRows().map((row) => row.id)).toEqual(['a', 'b', 'l']);
    expect(changes.filter((c) => c.reason === 'rows').length).toBeGreaterThanOrEqual(2);

    dataset.off('changed', listener);
    const count = changes.length;
    dataset.setRows([]);
    expect(changes).toHaveLength(count);
  });

  it('takes a table at creation', () => {
    const dataset = datasets.add({ id: 't', table: tableFromFeatures(ROWS) });
    expect(dataset.getRowId(2)).toBe('l');
  });

  it('keeps the visibility, the look, the zoom scale and the selection', () => {
    const dataset = datasets.add({ id: 'd', rows: ROWS, interactive: true });
    expect(dataset.visible).toBe(true);
    expect(dataset.interactive).toBe(true);
    dataset.setVisible(false);
    expect(dataset.visible).toBe(false);

    dataset.setBaseStyle({ stroke: { strokeColor: 'rgb(0 0 0 / 50%)' } });
    expect(dataset.getBaseStyle()).toEqual({ stroke: { strokeColor: 'rgb(0 0 0 / 50%)' } });
    expect(() => dataset.setBaseStyle({ stroke: { strokeWidth: -1 } })).toThrow(DrawError);

    const scale = (zoom: number) => ({ scale: zoom / 10, opacity: 1 });
    dataset.setZoomScale(scale);
    expect(dataset.getZoomScale()).toBe(scale);
    dataset.setZoomScale(null);
    expect(dataset.getZoomScale()).toBeNull();

    dataset.setStyleRule({ kind: 'single', color: 'orange' });
    dataset.setSelectedRowIds(['a', 'b', 'a']);
    expect(dataset.getSelectedRowIds()).toEqual(['a', 'b']);
  });

  it('thins out overlapping points', () => {
    const dataset = datasets.add({ id: 'd', rows: ROWS });
    expect(dataset.getCollisionThinning()).toBeNull();
    expect(dataset.listVisibleRowIds()).toBeNull();
    dataset.setCollisionThinning({ enabled: true });
    expect(dataset.getCollisionThinning()).toEqual({
      enabled: true,
      fullDisplayZoom: 17,
      marginPx: 2,
    });
    expect(dataset.getThinningStats().enabled).toBe(true);
    expect(() => dataset.setCollisionThinning({ marginPx: 'wide' } as never)).toThrow(DrawError);
  });

  it('asks the predicate of the external renderer with rows', () => {
    const seen: DatasetRow[] = [];
    const dataset = datasets.add({
      id: 'd',
      rows: ROWS,
      externalPointRender: (row) => {
        seen.push(row);
        return false;
      },
    });
    dataset.listVisibleRows([-1, -1, 1, 1]);
    dataset.setExternalPointRender((row) => row.id === 'a');
    expect(() => dataset.setExternalPointRender('a' as never)).toThrow(DrawError);
    for (const row of seen) expect(row.type).toBe('Feature');
  });

  it('asks its provider with a BBox and fetches again after refresh', async () => {
    const provider = vi.fn(async (_bbox: BBox, _zoom: number) => [point('p', 0, 0)]);
    const dataset = datasets.add({ id: 'p', provider });
    await vi.advanceTimersByTimeAsync(1000);
    expect(provider).toHaveBeenCalled();
    const [bbox, zoom] = provider.mock.calls[0];
    expect(Array.isArray(bbox)).toBe(true);
    expect(bbox).toHaveLength(4);
    expect(zoom).toBe(10);
    expect(dataset.listRows().map((row) => row.id)).toEqual(['p']);
    expect(() => dataset.refresh()).not.toThrow();
  });

  it('has no remove of its own', () => {
    const dataset = datasets.add({ id: 'd', rows: [] });
    expect('remove' in dataset).toBe(false);
  });
});

describe('the clicks and the hovers', () => {
  let engine: Engine;

  beforeEach(() => {
    engine = createEngine(createMapStub().map);
  });

  afterEach(() => engine.destroy());

  it('passes the clicks and the hovers of a dataset on in rows, with the screen point', () => {
    const collection = createDatasets(engine.datasets, engine.events, engine.context.eventEmitter);
    const dataset = collection.add({ id: 'd', rows: ROWS, interactive: true });
    const clicked: DatasetEvents['clicked'][] = [];
    const hovered: DatasetEvents['hovered'][] = [];
    dataset.on('clicked', (payload) => clicked.push(payload));
    const stop = dataset.on('hovered', (payload) => hovered.push(payload));

    const internal = engine.datasets.getInternal('d');
    const feature = internal?.getRow(0);
    if (!internal || !feature) throw new Error('no row');
    internal.emit('click', {
      datasetId: 'd',
      feature,
      row: 0,
      lngLat: [0.1, 0.1],
      point: { x: 410, y: 290 },
    });
    internal.emit('hover', { datasetId: 'd', feature: null, row: null, lngLat: [1, 2] });
    stop();
    internal.emit('hover', { datasetId: 'd', feature, row: 0, lngLat: [1, 2] });

    expect(clicked).toEqual([
      { datasetId: 'd', rowIndex: 0, row: ROWS[0], lngLat: [0.1, 0.1], point: [410, 290] },
    ]);
    expect(hovered).toHaveLength(1);
    expect(hovered[0]).toMatchObject({ datasetId: 'd', rowIndex: null, row: null, lngLat: [1, 2] });
  });

  it('announces a click on a row of a dataset as dataset.clicked', () => {
    createDatasets(engine.datasets, engine.events, engine.context.eventEmitter).add({
      id: 'd',
      rows: ROWS,
    });
    const clicked: DrawEvents['dataset.clicked'][] = [];
    engine.events.on('dataset.clicked', (payload) => clicked.push(payload));
    const feature = engine.datasets.getInternal('d')?.getRow(1);
    if (!feature) throw new Error('no row');
    engine.context.eventEmitter.emit('dataset.click', {
      datasetId: null,
      feature: null,
      row: null,
      lngLat: [0, 0],
    });
    engine.context.eventEmitter.emit('dataset.click', {
      datasetId: 'd',
      feature,
      row: 1,
      lngLat: [0.2, 0.2],
      point: { x: 420, y: 280 },
    });
    expect(clicked).toEqual([
      { datasetId: 'd', rowIndex: 1, row: ROWS[1], lngLat: [0.2, 0.2], point: [420, 280] },
    ]);
  });
});
