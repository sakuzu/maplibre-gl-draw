// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A small trial of applying batches of changes in the order of the serials a sequencer gives
 * them, to measure what it costs a client: the time to apply a batch of another client while a
 * thousand batches of its own wait for their serials, and the memory it adds.
 *
 * The rules:
 *
 * - Every batch gets one serial, and every client applies the batches in the order of their
 *   serials (`Items.apply` refuses another order)
 * - A batch is checked first: one that creates an item that exists, or changes or deletes an
 *   item that does not exist or is deleted, is skipped whole
 * - A batch carries the serial it had seen (`base`). A change of a field that another client
 *   wrote after that serial is skipped and told (`superseded`): the client did not see what it
 *   overwrote. A change of a field the same client wrote, or one written at or before the base,
 *   is applied. A change to the value the field has is nothing, and is not told
 * - The serial and the client that last wrote each field are kept only for the fields written
 *   after their item was made (a sparse table); the others are those of the creation
 *
 * A client applies its own batches at once over the items it was told of (`Client`): what it
 * shows is the items of the serials applied, with the fields its waiting batches wrote over them
 * (one entry per field, the last batch to write it). A batch of another client that writes a
 * field one of its waiting batches wrote means the own one will be superseded: the field shows
 * the value of the other client at once, and the own batch is told superseded when its serial
 * comes. Nothing is applied again but the items of an own batch skipped whole.
 *
 * It depends on neither the tables nor the page: the items are maps of fields.
 */

/** The values of fields of a new item */
export type Fields = Readonly<Record<string, unknown>>;

/** A change of a batch */
export type Change =
  /** Makes an item with its fields */
  | { readonly kind: 'create'; readonly item: string; readonly fields: Fields }
  /** Writes a field (`value` undefined takes the field away) */
  | { readonly kind: 'set'; readonly item: string; readonly field: string; readonly value: unknown }
  /** Deletes an item (its fields are kept) */
  | { readonly kind: 'delete'; readonly item: string };

/** A batch of changes, as a client sends it */
export interface Batch {
  /** The client that made it */
  readonly client: string;
  /** Its number among the batches of the client */
  readonly batch: number;
  /** The last serial the client had applied when it made it */
  readonly base: number;
  readonly changes: readonly Change[];
}

/** A batch with its serial, as every client receives it */
export interface SerialBatch extends Batch {
  readonly serial: number;
}

/** Who wrote a field last */
export interface Writer {
  readonly serial: number;
  readonly client: string;
}

/** A change of a field skipped because another client wrote it after the base */
export interface Superseded {
  readonly item: string;
  readonly field: string;
  readonly by: Writer;
}

/** What applying a batch did */
export interface Applied {
  readonly serial: number;
  /** Why the batch was skipped whole (undefined when it was applied) */
  readonly skipped?: 'exists' | 'missing' | 'deleted';
  readonly superseded: Superseded[];
}

interface Item {
  readonly fields: Map<string, unknown>;
  readonly created: Writer;
  deleted: boolean;
}

/** The key of a field of an item in the tables */
function fieldKey(item: string, field: string): string {
  return `${item}\u0000${field}`;
}

/** Whether two values are the same */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The items of the serials applied */
export class Items {
  readonly #items = new Map<string, Item>();
  /** The last writer of the fields written after their item was made */
  readonly lastWrites = new Map<string, Writer>();
  /** The last serial applied */
  serial = 0;

  get size(): number {
    return this.#items.size;
  }

  has(item: string): boolean {
    return this.#items.has(item);
  }

  isDeleted(item: string): boolean {
    return this.#items.get(item)?.deleted ?? false;
  }

  /** The value of a field (undefined when the item or the field is not there) */
  get(item: string, field: string): unknown {
    return this.#items.get(item)?.fields.get(field);
  }

  /** Who wrote a field last */
  writerOf(item: string, field: string): Writer | undefined {
    return this.lastWrites.get(fieldKey(item, field)) ?? this.#items.get(item)?.created;
  }

  /** Applies the next batch */
  apply(b: SerialBatch): Applied {
    if (b.serial !== this.serial + 1) {
      throw new Error(`the serial ${b.serial} after ${this.serial}`);
    }
    this.serial = b.serial;
    const skipped = this.#check(b);
    if (skipped) return { serial: b.serial, skipped, superseded: [] };
    const writer: Writer = { serial: b.serial, client: b.client };
    const superseded: Superseded[] = [];
    for (const change of b.changes) {
      switch (change.kind) {
        case 'create':
          this.#items.set(change.item, {
            fields: new Map(Object.entries(change.fields)),
            created: writer,
            deleted: false,
          });
          break;
        case 'delete':
          (this.#items.get(change.item) as Item).deleted = true;
          break;
        case 'set': {
          const item = this.#items.get(change.item) as Item;
          const key = fieldKey(change.item, change.field);
          const last = this.lastWrites.get(key) ?? item.created;
          if (sameValue(item.fields.get(change.field), change.value)) break;
          if (last.serial > b.base && last.client !== b.client) {
            superseded.push({ item: change.item, field: change.field, by: last });
            break;
          }
          if (change.value === undefined) item.fields.delete(change.field);
          else item.fields.set(change.field, change.value);
          this.lastWrites.set(key, writer);
          break;
        }
      }
    }
    return { serial: b.serial, superseded };
  }

  /** Why a batch cannot be applied (undefined when it can) */
  #check(b: Batch): Applied['skipped'] {
    const made = new Set<string>();
    const gone = new Set<string>();
    for (const change of b.changes) {
      const exists =
        (this.#items.has(change.item) || made.has(change.item)) && !gone.has(change.item);
      const deleted = this.#items.get(change.item)?.deleted ?? false;
      if (change.kind === 'create') {
        if (this.#items.has(change.item) || made.has(change.item)) return 'exists';
        made.add(change.item);
        continue;
      }
      if (!exists) return gone.has(change.item) ? 'deleted' : 'missing';
      if (deleted && !made.has(change.item)) return 'deleted';
      if (change.kind === 'delete') gone.add(change.item);
    }
    return undefined;
  }

  /** The items and their fields, for comparing two clients */
  snapshot(): Record<string, { deleted: boolean; fields: Record<string, unknown> }> {
    const out: Record<string, { deleted: boolean; fields: Record<string, unknown> }> = {};
    for (const [id, item] of [...this.#items].sort(([a], [b]) => (a < b ? -1 : 1))) {
      out[id] = { deleted: item.deleted, fields: Object.fromEntries(item.fields) };
    }
    return out;
  }
}

/** A field written by a batch waiting for its serial */
interface Shown {
  readonly item: string;
  readonly field: string;
  readonly value: unknown;
  /** The last batch that wrote it */
  readonly batch: number;
}

/** What a client was told when a batch came */
export interface Received {
  readonly applied: Applied;
  /** Whether the batch was one of the client's own */
  readonly own: boolean;
  /** The fields of the waiting batches the batch overwrote (shown with its value from now on) */
  readonly overwritten: number;
}

/** A client: the items of the serials applied, and its batches waiting for their serials */
export class Client {
  readonly id: string;
  readonly items = new Items();
  /** The batches sent and not received back with their serials, in their order */
  readonly waiting: Batch[] = [];
  /** The fields the waiting batches wrote, shown over the items */
  readonly shown = new Map<string, Shown>();
  /** The items the waiting batches made or deleted, with the last batch that did */
  readonly shownItems = new Map<string, { readonly deleted: boolean; readonly batch: number }>();
  #nextBatch = 1;

  constructor(id: string) {
    this.id = id;
  }

  /** Makes a batch of changes, shows it at once and returns it to send */
  write(changes: readonly Change[]): Batch {
    const b: Batch = {
      client: this.id,
      batch: this.#nextBatch++,
      base: this.items.serial,
      changes,
    };
    this.#show(b);
    this.waiting.push(b);
    return b;
  }

  /** Whether an item is shown */
  exists(item: string): boolean {
    const own = this.shownItems.get(item);
    if (own) return !own.deleted;
    return this.items.has(item) && !this.items.isDeleted(item);
  }

  /** The value of a field as it is shown */
  value(item: string, field: string): unknown {
    const own = this.shown.get(fieldKey(item, field));
    return own ? own.value : this.items.get(item, field);
  }

  /** Applies a batch received with its serial */
  receive(b: SerialBatch): Received {
    if (b.client === this.id) return this.#receiveOwn(b);
    const applied = this.items.apply(b);
    let overwritten = 0;
    if (!applied.skipped) {
      for (const change of b.changes) {
        if (change.kind !== 'set') continue;
        // A write applied (not superseded, not the value the field had): every waiting batch saw
        // a serial before this one, so its write of the field will be superseded, and the field
        // shows the value of the other client
        if (this.items.writerOf(change.item, change.field)?.serial !== b.serial) continue;
        if (this.shown.delete(fieldKey(change.item, change.field))) overwritten++;
      }
    }
    return { applied, own: false, overwritten };
  }

  #receiveOwn(b: SerialBatch): Received {
    const next = this.waiting[0];
    if (!next || next.batch !== b.batch) throw new Error(`the own batch ${b.batch} out of order`);
    this.waiting.shift();
    const applied = this.items.apply(b);
    const items = new Set<string>();
    for (const change of b.changes) {
      items.add(change.item);
      const fields =
        change.kind === 'set'
          ? [change.field]
          : change.kind === 'create'
            ? Object.keys(change.fields)
            : [];
      for (const field of fields) {
        const key = fieldKey(change.item, field);
        if (this.shown.get(key)?.batch === b.batch) this.shown.delete(key);
      }
      if (change.kind !== 'set' && this.shownItems.get(change.item)?.batch === b.batch) {
        this.shownItems.delete(change.item);
      }
    }
    // A batch skipped whole: the fields of its items are shown again from the batches left
    if (applied.skipped) this.#showAgain(items);
    return { applied, own: true, overwritten: 0 };
  }

  #show(b: Batch): void {
    for (const change of b.changes) {
      if (change.kind === 'set') {
        const key = fieldKey(change.item, change.field);
        this.shown.set(key, {
          item: change.item,
          field: change.field,
          value: change.value,
          batch: b.batch,
        });
      } else if (change.kind === 'create') {
        this.shownItems.set(change.item, { deleted: false, batch: b.batch });
        for (const [field, value] of Object.entries(change.fields)) {
          this.shown.set(fieldKey(change.item, field), {
            item: change.item,
            field,
            value,
            batch: b.batch,
          });
        }
      } else {
        this.shownItems.set(change.item, { deleted: true, batch: b.batch });
      }
    }
  }

  #showAgain(items: ReadonlySet<string>): void {
    for (const [key, shown] of this.shown) if (items.has(shown.item)) this.shown.delete(key);
    for (const item of items) this.shownItems.delete(item);
    for (const b of this.waiting) {
      this.#show({ ...b, changes: b.changes.filter((c) => items.has(c.item)) });
    }
  }
}

/** Gives batches their serials, in the order they come */
export class Sequencer {
  serial = 0;

  next(b: Batch): SerialBatch {
    return { ...b, serial: ++this.serial };
  }
}
