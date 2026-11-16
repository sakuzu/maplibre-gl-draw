// 見本 4。標準の Store を包み、document をブラウザーの DB (IndexedDB) に持つ Store。Store の入口を
// 使う (document を自分の所に持つ人の例)。
//
// const store = await openKeptStore('my-map', (error) => showError(error));
// const draw = createDraw(map, { store });
//
// DB は 1 つの object store に、配列の key で持つ。行は欄ごとに ['row', id, 欄]、ほかは
// ['layer', id]、['layerRows', id] (layer の位置の値の数と 3 つ目の値の意味)、['group', id]、
// ['file', id]、['order']、['metadata']。
//
// - 開く時は、DB の cursor で行を 5,000 件ずつ読み、1 つの操作 (operationId) の部分として書く。
//   10 万件でも 1 回の書き込みは 5,000 行で、部分の間に地図が描かれる。instance に付く Store に
//   直に書くのは外で起きた変更 ('remote') だけで、ページからの読み込みも 'remote' で書く ('load' は
//   draw.document.load だけの物)。最後の部分は finally で必ず
//   書き、途中で失敗しても操作を閉じる
// - 行は layer ごとに作る (1 回の createRows は 1 つの layer の行)。layer は位置の値の数を
//   保存して作り直すので、高さや測りのある layer も、開き直して値を失わない
// - 変更は Store の通知を聞いて書く。保存は非同期なので、失敗が分かる前の書き込みも描かれる。
//   失敗はアプリに知らせる (この見本は書き込みを止めない)
// - 行の型、値、形の列は、Store の入口の宣言 (RowValues、GeometryColumn) にある

import type { FileData, Layer, Metadata } from '@sakuzu/maplibre-gl-draw';
import {
  createStore,
  GEOMETRY_TYPES,
  type FeatureRowField,
  type GeometryColumn,
  type Store,
  type StoreChange,
  type StoreGroup,
} from '@sakuzu/maplibre-gl-draw/store';
import type { Geometry, Position } from 'geojson';

/** The rows written at a time while the document is opened */
const ROWS_PER_PART = 5_000;

/** The fields of a row kept besides its attributes and its geometry */
const FIELDS: FeatureRowField[] = ['type', 'visible', 'locked', 'style', 'parent', 'orderKey'];

/**
 * Opens a Store that keeps its document in IndexedDB under `name`: what it kept is read first, a
 * part at a time, and every change after it is kept. A change that could not be kept is told to
 * `onError`.
 */
export async function openKeptStore(name: string, onError: (error: unknown) => void): Promise<Store> {
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => open.result.createObjectStore('doc');
  const db = await done(open);
  const store = createStore();
  await load(db, store);
  store.subscribe((change) => keep(db, store, change).catch(onError));
  // The built-in Store, as it is: this one only keeps what it writes
  return store;
}

/** Writes what the database kept: the layers and groups first, then the rows a part at a time */
async function load(db: IDBDatabase, store: Store): Promise<void> {
  const doc = db.transaction('doc').objectStore('doc');
  const [layers, layerRows, groups, files, order, metadata] = await Promise.all([
    done(doc.getAll(IDBKeyRange.bound(['layer'], ['layer', []]))) as Promise<Layer[]>,
    done(doc.getAll(IDBKeyRange.bound(['layerRows'], ['layerRows', []]))) as Promise<LayerRows[]>,
    done(doc.getAll(IDBKeyRange.bound(['group'], ['group', []]))) as Promise<StoreGroup[]>,
    done(doc.getAll(IDBKeyRange.bound(['file'], ['file', []]))) as Promise<FileData[]>,
    done(doc.get(['order'])) as Promise<string[] | undefined>,
    done(doc.get(['metadata'])) as Promise<Metadata | undefined>,
  ]);
  const dims = new Map(layerRows.map((entry) => [entry.layerId, entry]));
  /** The layer of a parent: the layer itself, or the layer of a group */
  const layerOfParent = new Map<string, string>([
    ...layers.map((layer) => [layer.id, layer.id] as const),
    ...groups.map((group) => [group.id, group.layerId] as const),
  ]);
  const operationId = store.newOperationId();
  let ended = false;
  try {
    store.transact(() => {
      for (const layer of layers) {
        const entry = dims.get(layer.id);
        store.createLayer(layer, entry && { valuesPerPosition: entry.valuesPerPosition, thirdValue: entry.thirdValue });
      }
      for (const group of groups) store.createGroup(group);
      for (const file of files) store.createFile(file);
      if (order) store.setLayerOrder(order);
      if (metadata) store.setMetadata(metadata);
    }, 'remote', { operationId, hasMoreParts: true });
    // The rows, read in the order of their keys: the fields of a row follow each other. They are
    // gathered by layer, and a part writes the rows of each layer with its own call
    let byLayer = new Map<string, { ids: string[]; rows: Map<string, unknown>[] }>();
    let count = 0;
    let row: { id: string; values: Map<string, unknown> } | null = null;
    const take = () => {
      if (!row) return;
      const layerId = layerOfParent.get(row.values.get('parent') as string) ?? '';
      const part = byLayer.get(layerId) ?? { ids: [], rows: [] };
      part.ids.push(row.id);
      part.rows.push(row.values);
      byLayer.set(layerId, part);
      count += 1;
      row = null;
    };
    const flush = (last: boolean) => {
      const parts = byLayer;
      byLayer = new Map();
      count = 0;
      // The last part ends the operation, also when it throws
      ended = last;
      store.transact(() => {
        for (const [layerId, part] of parts) {
          store.createRows(newRowsOf(part.ids, part.rows, dims.get(layerId)?.valuesPerPosition ?? 2));
        }
      }, 'remote', { operationId, hasMoreParts: !last });
    };
    const cursor = db.transaction('doc').objectStore('doc').openCursor(IDBKeyRange.bound(['row'], ['row', []]));
    await new Promise<void>((resolve, reject) => {
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) {
          take();
          resolve();
          return;
        }
        const [, id, field] = at.key as [string, string, string];
        if (row?.id !== id) {
          take();
          if (count === ROWS_PER_PART) flush(false);
          row = { id, values: new Map() };
        }
        row?.values.set(field, at.value);
        at.continue();
      };
    });
    // The last part, also when the database held no row
    flush(true);
  } finally {
    // A part that threw before the last leaves the operation open: end it with nothing written
    if (!ended) store.transact(() => {}, 'remote', { operationId, stopped: true });
  }
}

/** The number of values of the positions of a layer, as kept */
interface LayerRows {
  layerId: string;
  valuesPerPosition: 2 | 3 | 4;
  thirdValue?: 'height' | 'measure';
}

/** The new rows of a part: the values of each field, and the geometries as one column */
function newRowsOf(ids: string[], rows: Map<string, unknown>[], valuesPerPosition: 2 | 3 | 4) {
  const fields = new Map<FeatureRowField, unknown[]>();
  rows.forEach((row, i) => {
    for (const [field, value] of row) {
      if (field === 'geometry') continue;
      const column = fields.get(field as FeatureRowField) ?? new Array<unknown>(ids.length).fill(undefined);
      column[i] = value;
      fields.set(field as FeatureRowField, column);
    }
  });
  const geometry = geometryColumnOf(
    rows.map((row) => (row.get('geometry') as Geometry | undefined) ?? null),
    valuesPerPosition,
  );
  return { ids, fields, geometry };
}

/** Keeps one change, in one transaction of the database */
function keep(db: IDBDatabase, store: Store, change: StoreChange): Promise<unknown> {
  const tx = db.transaction('doc', 'readwrite');
  const doc = tx.objectStore('doc');
  if (change.reset) doc.clear();
  const { tables } = store;
  for (const rows of change.rows?.layers.values() ?? []) {
    // The id of a deleted row is still read while the change is delivered
    for (const row of rows.deleted) {
      const id = tables.getRowId(row) as string;
      doc.delete(IDBKeyRange.bound(['row', id], ['row', id, []]));
    }
    const written = Int32Array.from([...rows.created, ...rows.updated]);
    if (written.length === 0) continue;
    // Every field of a row created, and the fields a row updated changed (the whole style once)
    const fields = new Set<FeatureRowField>(rows.created.length > 0 ? [...FIELDS, 'geometry'] : []);
    for (const field of rows.fields) fields.add(field.startsWith('style:') ? 'style' : field);
    for (const key of rows.created.length > 0 ? store.listPropertyKeys(rows.created) : []) {
      fields.add(`properties:${key}`);
    }
    const values = tables.readValues(written, [...fields]);
    values.rows.forEach((row, i) => {
      const id = tables.getRowId(row) as string;
      for (const [field, column] of values.fields) {
        if (column[i] === undefined) doc.delete(['row', id, field]);
        else doc.put(column[i], ['row', id, field]);
      }
      if (values.geometry) doc.put(geometryOf(values.geometry, i), ['row', id, 'geometry']);
    });
  }
  const { layers, groups, files } = change;
  for (const layer of [...(layers?.created ?? []), ...(layers?.updated ?? []).map((u) => u.layer)]) doc.put(layer, ['layer', layer.id]);
  for (const layer of layers?.created ?? []) {
    const entry: LayerRows = { layerId: layer.id, valuesPerPosition: tables.getValuesPerPosition(layer.id) ?? 2 };
    const thirdValue = tables.getThirdValue(layer.id);
    doc.put(thirdValue ? { ...entry, thirdValue } : entry, ['layerRows', layer.id]);
  }
  for (const group of [...(groups?.created ?? []), ...(groups?.updated ?? []).map((u) => u.group)]) doc.put(group, ['group', group.id]);
  for (const layer of layers?.deleted ?? []) {
    doc.delete(['layer', layer.id]);
    doc.delete(['layerRows', layer.id]);
  }
  for (const group of groups?.deleted ?? []) doc.delete(['group', group.id]);
  for (const file of files?.created ?? []) doc.put(file, ['file', file.id]);
  for (const file of files?.deleted ?? []) doc.delete(['file', file.id]);
  if (layers?.orderChanged || change.reset) doc.put(store.getLayerOrder(), ['order']);
  if (change.metadata || change.reset) doc.put(store.getMetadata(), ['metadata']);
  return done(tx);
}

/** The geometry of row `i` of a column, as GeoJSON */
function geometryOf(column: GeometryColumn, i: number): Geometry | null {
  const type = GEOMETRY_TYPES[column.types[i]];
  if (!type) return null;
  const { coordinates, valuesPerPosition: n, partStarts, ringStarts, positionStarts } = column;
  const ring = (r: number): Position[] => {
    const out: Position[] = [];
    for (let p = positionStarts[r]; p < positionStarts[r + 1]; p += 1) {
      out.push(Array.from(coordinates.subarray(p * n, p * n + n)));
    }
    return out;
  };
  const rings = (part: number) => {
    const out: Position[][] = [];
    for (let r = ringStarts[part]; r < ringStarts[part + 1]; r += 1) out.push(ring(r));
    return out;
  };
  const parts: Position[][][] = [];
  for (let part = partStarts[i]; part < partStarts[i + 1]; part += 1) parts.push(rings(part));
  switch (type) {
    case 'Point':
      return { type, coordinates: parts[0][0][0] };
    case 'LineString':
      return { type, coordinates: parts[0][0] };
    case 'Polygon':
      return { type, coordinates: parts[0] };
    case 'MultiPoint':
      return { type, coordinates: parts.map((p) => p[0][0]) };
    case 'MultiLineString':
      return { type, coordinates: parts.map((p) => p[0]) };
    case 'MultiPolygon':
      return { type, coordinates: parts };
  }
}

/**
 * The geometries of rows, as one column (`null` for a row without one), with the number of
 * values of a position of their layer: a height and a measure are kept
 */
function geometryColumnOf(geometries: (Geometry | null)[], valuesPerPosition: 2 | 3 | 4): GeometryColumn {
  const types = new Uint8Array(geometries.length).fill(255);
  const values: number[] = [];
  const partStarts = [0];
  const ringStarts = [0];
  const positionStarts = [0];
  const addRing = (positions: Position[]) => {
    // The positions kept have the values of their layer (geometryOf writes them whole)
    for (const position of positions) values.push(...position.slice(0, valuesPerPosition));
    positionStarts.push(positionStarts[positionStarts.length - 1] + positions.length);
  };
  const addPart = (rings: Position[][]) => {
    rings.forEach(addRing);
    ringStarts.push(ringStarts[ringStarts.length - 1] + rings.length);
  };
  geometries.forEach((geometry, i) => {
    const index = geometry ? (GEOMETRY_TYPES as readonly string[]).indexOf(geometry.type) : -1;
    if (geometry && index >= 0) {
      types[i] = index;
      if (geometry.type === 'Point') addPart([[geometry.coordinates]]);
      else if (geometry.type === 'LineString') addPart([geometry.coordinates]);
      else if (geometry.type === 'Polygon') addPart(geometry.coordinates);
      else if (geometry.type === 'MultiPoint') geometry.coordinates.forEach((p) => addPart([[p]]));
      else if (geometry.type === 'MultiLineString') geometry.coordinates.forEach((l) => addPart([l]));
      else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(addPart);
    }
    partStarts.push(ringStarts.length - 1);
  });
  return {
    types,
    coordinates: Float64Array.from(values),
    valuesPerPosition,
    partStarts: Int32Array.from(partStarts),
    ringStarts: Int32Array.from(ringStarts),
    positionStarts: Int32Array.from(positionStarts),
  };
}

/** What a request or a transaction of the database gives, once it is done */
function done<T>(request: IDBRequest<T> | IDBTransaction): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    if (request instanceof IDBTransaction) request.oncomplete = () => resolve(undefined as T);
    else request.onsuccess = () => resolve(request.result);
  });
}
