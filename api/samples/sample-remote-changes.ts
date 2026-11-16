// 見本 5。自分のサーバーから届いた変更 (値) を、見るだけの画面 (read-only) にも出す plugin。Store の
// 入口を使う (外で起きた変更を書く人の例)。
//
// 届いた変更は Store に直に書く (出どころ 'remote')。Store は read-only を確かめないので、
// read-only の画面にも出る。自分の編集は Store の通知を聞いて送る。届いた変更は出どころが
// 'remote' なので、送り返さない。1 つの操作 (operationId) の通知は、最後の通知
// (hasMoreParts が false) が来てからまとめて送る。
//
// 届いた 1 つの変更は、1 つの操作として部分に分けて書く (Store.newOperationId)。10 万行の変更でも
// 1 回の書き込みは 5,000 行で、部分の間に地図が描かれる。最後の部分は finally で必ず書き、途中で
// 失敗しても操作を閉じる。届いた変更は、前の変更を書き終えてから書く。
//
// 行の読み書きは layer ごとに分ける (1 回の readValues、writeRows、createRows は 1 つの layer の
// 行)。layer ごとに位置の値の数が違ってもよい。こちらで消された行を名指す値は、飛ばして書く。
//
// サーバーとの取り決めは、この見本が決めた物である (行を id で名指し、値を欄ごとに、形を
// GeometryColumn の配列のまま運ぶ)。ほかの端末で消された行が戻る時は、消した行を id で
// 引き (findRow)、取っておかれた行なら deleted を 0 で書いて戻す。

import type { Layer, Plugin } from '@sakuzu/maplibre-gl-draw';
import type { FeatureRowField, GeometryColumn, RowValues, Store, StoreChange, StoreGroup } from '@sakuzu/maplibre-gl-draw/store';

/** A geometry column as JSON: its typed arrays as arrays of numbers */
type GeometryJSON = { [K in keyof GeometryColumn]: GeometryColumn[K] extends number ? number : number[] };

/** A message of the server of this application: values, never operations */
type Message =
  | {
      kind: 'rows';
      /** The layer the rows are in */
      layerId: string;
      /** The rows, by id */
      ids: string[];
      /** True for rows that are new (they have every field), false for rows written */
      created: boolean;
      /** The values of each field written, one per id */
      fields: Record<string, unknown[]>;
      /** Their geometries, when they were written */
      geometry?: GeometryJSON;
    }
  | { kind: 'deleted'; layerId: string; ids: string[] }
  | { kind: 'layer'; layer: Layer; valuesPerPosition: 2 | 3 | 4; thirdValue?: 'height' | 'measure' }
  | { kind: 'layerDeleted'; id: string }
  | { kind: 'group'; group: StoreGroup }
  | { kind: 'groupDeleted'; id: string }
  | { kind: 'order'; order: string[] }
  | { kind: 'metadata'; metadata: Record<string, unknown> };

/** A part of a message: the rows from `start` up to `end` and without it, for the rows */
interface Piece {
  readonly message: Message;
  readonly start: number;
  readonly end: number;
}

/** The rows written in one part of an operation */
const ROWS_PER_PART = 5_000;

export function remoteChangesPlugin(url: string, onError: (error: unknown) => void): Plugin {
  let socket: WebSocket | undefined;
  let unsubscribe = () => {};
  return {
    name: 'remoteChanges',
    onAdd(ctx) {
      const store = ctx.store;
      socket = new WebSocket(url);
      /** The changes from the server are written one after another, in the order they came */
      let writing = Promise.resolve();
      socket.onmessage = (event) => {
        const messages = JSON.parse(String(event.data)) as Message[];
        writing = writing.then(() => writeChange(store, messages)).catch(onError);
      };
      /** The edits under way, by operation, sent once their last change arrived */
      const edits = new Map<number, Edit>();
      unsubscribe = store.subscribe((change) => {
        if (change.source === 'remote') return; // a change from elsewhere: not sent back
        const edit = edits.get(change.operationId) ?? newEdit();
        collect(store, change, edit);
        if (change.hasMoreParts) {
          edits.set(change.operationId, edit);
          return;
        }
        edits.delete(change.operationId);
        socket?.send(JSON.stringify([...messagesOf(store, edit)]));
      });
    },
    onRemove() {
      unsubscribe();
      socket?.close();
    },
  };
}

/** Writes one change of the server as one operation, a part at a time */
async function writeChange(store: Store, messages: Message[]): Promise<void> {
  const parts = [...partsOf(messages)];
  if (parts.length === 0) parts.push([]);
  const operationId = store.newOperationId();
  let ended = false;
  try {
    for (let i = 0; i < parts.length; i += 1) {
      const hasMoreParts = i < parts.length - 1;
      // The last part ends the operation, also when it throws: what it wrote is told all the same
      ended = !hasMoreParts;
      store.transact(() => parts[i].forEach((piece) => apply(store, piece)), 'remote', { operationId, hasMoreParts });
      if (hasMoreParts) await new Promise(requestAnimationFrame);
    }
  } finally {
    // A part that threw before the last leaves the operation open: a transaction that writes
    // nothing ends it, and its change is told all the same
    if (!ended) store.transact(() => {}, 'remote', { operationId, stopped: true });
  }
}

/** The messages cut into parts of at most `ROWS_PER_PART` rows, in their order */
function* partsOf(messages: Message[]): Generator<Piece[]> {
  let part: Piece[] = [];
  let rows = 0;
  for (const message of messages) {
    const length = message.kind === 'rows' || message.kind === 'deleted' ? message.ids.length : 1;
    for (let start = 0; start < length; start += ROWS_PER_PART) {
      const end = Math.min(length, start + ROWS_PER_PART);
      if (rows + end - start > ROWS_PER_PART && part.length > 0) {
        yield part;
        part = [];
        rows = 0;
      }
      part.push({ message, start, end });
      rows += end - start;
    }
  }
  if (part.length > 0) yield part;
}

/** Writes one piece of a message to the Store, in the transaction of the caller */
function apply(store: Store, { message, start, end }: Piece): void {
  const { tables } = store;
  const at = Array.from({ length: end - start }, (_, i) => start + i);
  switch (message.kind) {
    case 'rows': {
      const fields = new Map(Object.entries(message.fields)) as Map<FeatureRowField, unknown[]>;
      const geometry = message.geometry && columnOf(message.geometry);
      if (!message.created) {
        for (const rows of byLayer(store, message.layerId, message.ids, at)) {
          const values = pick(fields, geometry, rows);
          store.writeRows(valuesOf(rows.map((i) => tables.getRowRef(message.ids[i]) as number), values.fields, values.geometry));
        }
        return;
      }
      // A new row whose id a deletion still keeps comes back where it was, with the values sent
      const back: number[] = [];
      const fresh: number[] = [];
      for (const i of at) (tables.findRow(message.ids[i])?.deleted ? back : fresh).push(i);
      if (back.length > 0) {
        const values = pick(fields, geometry, back);
        store.writeRows({
          ...valuesOf(back.map((i) => tables.findRow(message.ids[i])?.ref as number), values.fields, values.geometry),
          deleted: new Uint8Array(back.length),
        });
      }
      if (fresh.length > 0 && geometry) {
        const values = pick(fields, geometry, fresh);
        store.createRows({ ids: fresh.map((i) => message.ids[i]), fields: values.fields, geometry: values.geometry as GeometryColumn });
      }
      return;
    }
    case 'deleted': {
      for (const rows of byLayer(store, message.layerId, message.ids, at)) {
        const refs = Int32Array.from(rows, (i) => tables.getRowRef(message.ids[i]) as number);
        store.writeRows({ rows: refs, fields: new Map(), deleted: new Uint8Array(refs.length).fill(1) });
      }
      return;
    }
    case 'layer':
      if (!store.getLayer(message.layer.id)) {
        // The number of values of its positions, so that heights and measures are kept
        store.createLayer(message.layer, {
          valuesPerPosition: message.valuesPerPosition,
          ...(message.thirdValue && { thirdValue: message.thirdValue }),
        });
      } else store.updateLayer(message.layer.id, message.layer);
      return;
    case 'layerDeleted':
      store.deleteLayer(message.id);
      return;
    case 'group':
      if (!store.getGroup(message.group.id)) store.createGroup(message.group);
      else store.updateGroup(message.group.id, message.group);
      return;
    case 'groupDeleted':
      store.deleteGroup(message.id);
      return;
    case 'order':
      store.setLayerOrder(message.order);
      return;
    case 'metadata':
      store.setMetadata(message.metadata);
  }
}

/**
 * The rows of a message that this client has, by the indexes given, in groups that one call can
 * write: those in the layer of the message, then each row this client has in another layer
 * alone. A row deleted here meanwhile names nothing, and is left out so that no write is refused.
 */
function byLayer(store: Store, layerId: string, ids: readonly string[], at: readonly number[]): number[][] {
  const { tables } = store;
  const found = at.filter((i) => tables.getRowRef(ids[i]) !== undefined);
  const table = tables.get(layerId);
  const inLayer = found.filter((i) => table?.getRowType(tables.getRowRef(ids[i]) as number) != null);
  const elsewhere = found.filter((i) => !inLayer.includes(i)).map((i) => [i]);
  return [inLayer, ...elsewhere].filter((rows) => rows.length > 0);
}

/** What an edit wrote, collected over its changes */
interface Edit {
  /** The messages that go before the rows (layers and groups created or changed) */
  before: Message[];
  /** The rows created, and the rows written with the fields written */
  created: Set<number>;
  written: Map<number, Set<FeatureRowField>>;
  /** The layer each row created or written is in, as the last change listed it */
  layerOf: Map<number, string>;
  /** The ids of the rows deleted, read while the change is delivered, by layer */
  deleted: Map<string, Set<string>>;
  /** The messages that go after the rows (deletions, the order, the metadata) */
  after: Message[];
}

function newEdit(): Edit {
  return { before: [], created: new Set(), written: new Map(), layerOf: new Map(), deleted: new Map(), after: [] };
}

/** Adds what one change wrote to the edit */
function collect(store: Store, change: StoreChange, edit: Edit): void {
  const { tables } = store;
  for (const layer of change.layers?.created ?? []) {
    const valuesPerPosition = tables.getValuesPerPosition(layer.id) ?? 2;
    const thirdValue = tables.getThirdValue(layer.id);
    edit.before.push({ kind: 'layer', layer, valuesPerPosition, ...(thirdValue && { thirdValue }) });
  }
  for (const { layer } of change.layers?.updated ?? []) {
    edit.before.push({ kind: 'layer', layer, valuesPerPosition: tables.getValuesPerPosition(layer.id) ?? 2 });
  }
  for (const group of change.groups?.created ?? []) edit.before.push({ kind: 'group', group });
  for (const { group } of change.groups?.updated ?? []) edit.before.push({ kind: 'group', group });
  for (const [layerId, rows] of change.rows?.layers ?? []) {
    for (const row of rows.deleted) {
      const ids = edit.deleted.get(layerId) ?? new Set<string>();
      ids.add(tables.getRowId(row) as string);
      edit.deleted.set(layerId, ids);
      edit.created.delete(row);
      edit.written.delete(row);
      edit.layerOf.delete(row);
    }
    for (const row of rows.created) {
      edit.created.add(row);
      edit.layerOf.set(row, layerId);
    }
    for (const row of rows.updated) {
      const fields = edit.written.get(row) ?? new Set<FeatureRowField>();
      for (const field of rows.fields) fields.add(field);
      edit.written.set(row, fields);
      // A row moved to another layer is listed in the layer it is in now
      edit.layerOf.set(row, layerId);
    }
  }
  for (const group of change.groups?.deleted ?? []) edit.after.push({ kind: 'groupDeleted', id: group.id });
  for (const layer of change.layers?.deleted ?? []) edit.after.push({ kind: 'layerDeleted', id: layer.id });
  if (change.layers?.orderChanged) edit.after.push({ kind: 'order', order: change.layers.orderChanged.order });
  if (change.metadata) edit.after.push({ kind: 'metadata', metadata: { ...change.metadata.metadata } });
}

/** The messages of an edit that ended, with the values its rows have now, one layer at a time */
function* messagesOf(store: Store, edit: Edit): Generator<Message> {
  const { tables } = store;
  yield* edit.before;
  const groupByLayer = (rows: Iterable<number>) => {
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      const layerId = edit.layerOf.get(row) as string;
      groups.set(layerId, [...(groups.get(layerId) ?? []), row]);
    }
    return groups;
  };
  for (const [layerId, created] of groupByLayer(edit.created)) {
    const rows = Int32Array.from(created);
    const keys = store.listPropertyKeys(rows).map((key) => `properties:${key}` as const);
    const fields: FeatureRowField[] = ['type', 'visible', 'locked', 'style', 'parent', 'orderKey', 'geometry', ...keys];
    yield rowsMessage(store, layerId, tables.readValues(rows, fields), true);
  }
  const written = [...edit.written.keys()].filter((row) => !edit.created.has(row));
  for (const [layerId, rows] of groupByLayer(written)) {
    const fields = new Set(rows.flatMap((row) => [...(edit.written.get(row) ?? [])]));
    yield rowsMessage(store, layerId, tables.readValues(Int32Array.from(rows), [...fields]), false);
  }
  for (const [layerId, ids] of edit.deleted) yield { kind: 'deleted', layerId, ids: [...ids] };
  yield* edit.after;
}

function rowsMessage(store: Store, layerId: string, values: RowValues, created: boolean): Message {
  return {
    kind: 'rows',
    layerId,
    created,
    ids: Array.from(values.rows, (row) => store.tables.getRowId(row) as string),
    fields: Object.fromEntries([...values.fields].map(([field, column]) => [field, [...column]])),
    ...(values.geometry && { geometry: jsonOf(values.geometry) }),
  };
}

function valuesOf(rows: number[], fields: Map<FeatureRowField, unknown[]>, geometry?: GeometryColumn): RowValues {
  return { rows: Int32Array.from(rows), fields, ...(geometry && { geometry }) };
}

/** The values of some rows of a message, by their indexes */
function pick(fields: Map<FeatureRowField, unknown[]>, geometry: GeometryColumn | undefined, at: number[]) {
  const picked = new Map([...fields].map(([field, column]) => [field, at.map((i) => column[i])] as const));
  if (!geometry) return { fields: picked, geometry };
  const { types, coordinates, valuesPerPosition: n, partStarts, ringStarts, positionStarts } = geometry;
  const values: number[] = [];
  const parts = [0];
  const rings = [0];
  const positions = [0];
  for (const i of at) {
    for (let part = partStarts[i]; part < partStarts[i + 1]; part += 1) {
      for (let ring = ringStarts[part]; ring < ringStarts[part + 1]; ring += 1) {
        values.push(...coordinates.subarray(positionStarts[ring] * n, positionStarts[ring + 1] * n));
        positions.push(positions[positions.length - 1] + positionStarts[ring + 1] - positionStarts[ring]);
      }
      rings.push(positions.length - 1);
    }
    parts.push(rings.length - 1);
  }
  return {
    fields: picked,
    geometry: {
      types: Uint8Array.from(at, (i) => types[i]),
      coordinates: Float64Array.from(values),
      valuesPerPosition: n,
      partStarts: Int32Array.from(parts),
      ringStarts: Int32Array.from(rings),
      positionStarts: Int32Array.from(positions),
    },
  };
}

function jsonOf(column: GeometryColumn): GeometryJSON {
  return {
    types: [...column.types],
    coordinates: [...column.coordinates],
    valuesPerPosition: column.valuesPerPosition,
    partStarts: [...column.partStarts],
    ringStarts: [...column.ringStarts],
    positionStarts: [...column.positionStarts],
  };
}

function columnOf(json: GeometryJSON): GeometryColumn {
  return {
    types: Uint8Array.from(json.types),
    coordinates: Float64Array.from(json.coordinates),
    valuesPerPosition: json.valuesPerPosition,
    partStarts: Int32Array.from(json.partStarts),
    ringStarts: Int32Array.from(json.ringStarts),
    positionStarts: Int32Array.from(json.positionStarts),
  };
}
