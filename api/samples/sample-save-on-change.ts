// 見本 3。変更を聞いて、変わった地物だけをブラウザーの DB (IndexedDB) に保存する。main の入口だけ
// を使う。
//
// document.changed は、変わった地物の id の集まり (IdSet) と操作の番号 (operationId) を運ぶ。
// 10 万件の移動は、同じ operationId の通知がいくつも来て、最後の通知 (hasMoreParts が false) で
// 終わる。この見本は操作が終わるまで id を集め、終わったら、地物を 500 件ずつ読んで書く。
// 読みは draw.features.getMany なので、10 万件でも一度に作る地物は 500 件である。
//
// DB は地物を id の key で 1 件ずつ持つ。layer と group と並びと metadata は小さいので、変わった
// 時に丸ごと書く (toJSON は地物も全部作るので使わない)。埋め込みのファイルは、通知が運ぶ物を
// id の key で書く。
//
// const keeper = await keepInIndexedDB(draw, 'my-map');

import type { DocumentChange, Draw, Feature, IdSet } from '@sakuzu/maplibre-gl-draw';

/** The features read and written at a time */
const CHUNK = 500;

export async function keepInIndexedDB(draw: Draw, name: string): Promise<{ stop(): void; flushed(): Promise<void> }> {
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore('features');
    open.result.createObjectStore('document');
    open.result.createObjectStore('files');
  };
  const db = await done(open);

  /** The IDs of the operations still being written, gathered until their last change */
  const gathering = new Map<number, Gathered>();
  let queue: Promise<void> = Promise.resolve();

  const unsubscribe = draw.document.subscribe((change) => {
    const entry = gathering.get(change.operationId) ?? { written: [], deleted: [], files: [], document: false };
    entry.written.push(change.features.created, change.features.updated, change.features.moved);
    entry.deleted.push(change.features.deleted);
    if (change.files) entry.files.push(change.files);
    entry.document ||= change.reset || !!(change.layers || change.groups || change.metadata);
    if (change.hasMoreParts) {
      gathering.set(change.operationId, entry);
      return;
    }
    gathering.delete(change.operationId);
    // One operation ended (written whole or stopped): keep what it left, after the ones before
    queue = queue.then(() => keep(db, draw, entry, change.reset));
  });

  return {
    stop: unsubscribe,
    // A button that closes the page waits for the edits under way, then for what they wrote
    async flushed() {
      await draw.waitForWrites();
      await queue;
    },
  };
}

/** What the changes of one operation wrote */
interface Gathered {
  written: IdSet[];
  deleted: IdSet[];
  files: NonNullable<DocumentChange['files']>[];
  document: boolean;
}

async function keep(db: IDBDatabase, draw: Draw, entry: Gathered, reset: boolean): Promise<void> {
  if (reset) {
    await done(db.transaction('features', 'readwrite').objectStore('features').clear());
    await done(db.transaction('files', 'readwrite').objectStore('files').clear());
  }
  if (entry.files.length > 0) {
    const store = db.transaction('files', 'readwrite').objectStore('files');
    for (const files of entry.files) {
      for (const file of files.deleted ?? []) store.delete(file.id);
      for (const file of files.created ?? []) store.put(file, file.id);
    }
    await done(store.transaction);
  }
  for (const ids of entry.deleted) {
    for (const chunk of chunks(ids)) {
      const store = db.transaction('features', 'readwrite').objectStore('features');
      for (const id of chunk) store.delete(id);
      await done(store.transaction);
    }
  }
  for (const ids of entry.written) {
    for (const chunk of chunks(ids)) {
      // The features as they are now: a feature deleted later in the operation reads undefined
      const features = draw.features.getMany(chunk);
      const store = db.transaction('features', 'readwrite').objectStore('features');
      features.forEach((feature: Feature | undefined, i) => {
        if (feature) store.put(feature, chunk[i]);
        else store.delete(chunk[i]);
      });
      await done(store.transaction);
    }
  }
  if (entry.document) {
    // The layers, the groups, the order and the metadata: few, written whole
    const document = {
      layers: draw.layers.list(),
      order: draw.layers.getOrder(),
      groups: [...draw.groups.iterate()],
      metadata: draw.metadata.get(),
    };
    await done(db.transaction('document', 'readwrite').objectStore('document').put(document, 'document'));
  }
}

/** The IDs of a set, `CHUNK` at a time, without an array of every ID */
function* chunks(ids: IdSet): Generator<string[]> {
  let chunk: string[] = [];
  for (const id of ids.iterate()) {
    chunk.push(id);
    if (chunk.length === CHUNK) {
      yield chunk;
      chunk = [];
    }
  }
  if (chunk.length > 0) yield chunk;
}

/** What a request or a transaction of the database gives, once it is done */
function done<T>(request: IDBRequest<T> | IDBTransaction): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    if (request instanceof IDBTransaction) request.oncomplete = () => resolve(undefined as T);
    else request.onsuccess = () => resolve(request.result);
  });
}
