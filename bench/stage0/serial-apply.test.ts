// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/** The rules of applying batches in the order of their serials, in small scenes */

import { describe, expect, it } from 'vitest';
import { type Batch, Client, Items, type SerialBatch, Serials } from './serial-apply.ts';

/** Two or three clients that have applied the creation of the items `x` and `y` */
function scene(ids: readonly string[] = ['a', 'b']) {
  const serials = new Serials();
  const clients = ids.map((id) => new Client(id));
  const seed = clients[0].write([
    { kind: 'create', item: 'x', fields: { color: 'red', name: 'X' } },
    { kind: 'create', item: 'y', fields: { color: 'blue' } },
  ]);
  const sent = serials.next(seed);
  for (const c of clients) c.receive(sent);
  /** Gives a batch its serial and has every client receive it */
  const deliver = (b: Batch): SerialBatch => {
    const s = serials.next(b);
    for (const c of clients) c.receive(s);
    return s;
  };
  return { serials, clients, deliver };
}

describe('the items of the serials applied', () => {
  it('keep the writes of two clients to different fields of an item', () => {
    const { clients, deliver } = scene();
    const [a, b] = clients;
    const wa = a.write([{ kind: 'set', item: 'x', field: 'color', value: 'green' }]);
    const wb = b.write([{ kind: 'set', item: 'x', field: 'name', value: 'Y' }]);
    deliver(wa);
    deliver(wb);
    for (const c of clients) {
      expect(c.items.get('x', 'color')).toBe('green');
      expect(c.items.get('x', 'name')).toBe('Y');
    }
  });

  it('skip and tell the write of a field another client wrote after the base', () => {
    const { clients, serials } = scene();
    const [a, b] = clients;
    const wa = a.write([{ kind: 'set', item: 'x', field: 'color', value: 'green' }]);
    const wb = b.write([{ kind: 'set', item: 'x', field: 'color', value: 'black' }]);
    const sa = serials.next(wa);
    const sb = serials.next(wb);
    const told = [a, b].map((c) => [c.receive(sa), c.receive(sb)]);
    for (const c of clients) expect(c.items.get('x', 'color')).toBe('green');
    // The client that wrote second is told it was superseded, by the first
    expect(told[1][1].own).toBe(true);
    expect(told[1][1].applied.superseded).toEqual([
      { item: 'x', field: 'color', by: { serial: sa.serial, client: 'a' } },
    ]);
    expect(told[0][1].applied.superseded).toHaveLength(1);
    expect(a.items.snapshot()).toEqual(b.items.snapshot());
  });

  it('apply the writes of one client in a row without waiting for their serials', () => {
    const { clients, deliver } = scene();
    const [a] = clients;
    const w1 = a.write([{ kind: 'set', item: 'x', field: 'color', value: 'green' }]);
    const w2 = a.write([{ kind: 'set', item: 'x', field: 'color', value: 'white' }]);
    expect(w2.base).toBe(w1.base);
    const results = [deliver(w1), deliver(w2)];
    expect(results).toHaveLength(2);
    for (const c of clients) expect(c.items.get('x', 'color')).toBe('white');
  });

  it('apply a write made after seeing the write before it', () => {
    const { clients, deliver } = scene();
    const [a, b] = clients;
    deliver(a.write([{ kind: 'set', item: 'x', field: 'color', value: 'green' }]));
    const wb = b.write([{ kind: 'set', item: 'x', field: 'color', value: 'black' }]);
    deliver(wb);
    for (const c of clients) expect(c.items.get('x', 'color')).toBe('black');
  });

  it('do nothing for a write of the value the field has, without telling it superseded', () => {
    const { clients, serials } = scene();
    const [a, b] = clients;
    const sa = serials.next(a.write([{ kind: 'set', item: 'x', field: 'color', value: 'green' }]));
    const sb = serials.next(b.write([{ kind: 'set', item: 'x', field: 'color', value: 'green' }]));
    a.receive(sa);
    b.receive(sa);
    a.receive(sb);
    expect(b.receive(sb).applied.superseded).toEqual([]);
    expect(b.items.writtenBy('x', 'color')).toEqual({ serial: sa.serial, client: 'a' });
  });

  it('take a field away with a write of undefined', () => {
    const { clients, deliver } = scene();
    deliver(clients[0].write([{ kind: 'set', item: 'x', field: 'name', value: undefined }]));
    for (const c of clients) expect(c.items.snapshot().x.fields).toEqual({ color: 'red' });
  });

  it('skip a whole batch that writes to a deleted item, its other changes too', () => {
    const { clients, serials } = scene();
    const [a, b] = clients;
    const sa = serials.next(a.write([{ kind: 'delete', item: 'x' }]));
    const sb = serials.next(
      b.write([
        { kind: 'set', item: 'y', field: 'color', value: 'pink' },
        { kind: 'set', item: 'x', field: 'color', value: 'pink' },
      ]),
    );
    for (const c of clients) {
      c.receive(sa);
      const r = c.receive(sb);
      expect(r.applied.skipped).toBe('deleted');
      expect(c.items.get('y', 'color')).toBe('blue');
      expect(c.items.isDeleted('x')).toBe(true);
    }
    // The fields of the deleted item are kept
    expect(a.items.get('x', 'color')).toBe('red');
    // The client whose batch was skipped shows the items as applied again
    expect(b.value('y', 'color')).toBe('blue');
    expect(b.exists('x')).toBe(false);
  });

  it('skip a batch that makes an item that exists', () => {
    const { clients, serials } = scene();
    const s = serials.next(clients[1].write([{ kind: 'create', item: 'x', fields: { c: 1 } }]));
    expect(clients[0].receive(s).applied.skipped).toBe('exists');
    expect(clients[1].receive(s).applied.skipped).toBe('exists');
    expect(clients[1].value('x', 'color')).toBe('red');
    expect(clients[1].value('x', 'c')).toBeUndefined();
  });

  it('refuse a batch out of the order of the serials', () => {
    const items = new Items();
    expect(() => items.apply({ client: 'a', batch: 1, base: 0, changes: [], serial: 2 })).toThrow();
  });

  it('skip a batch that writes to an item that does not exist', () => {
    const { clients, deliver } = scene();
    deliver(clients[0].write([{ kind: 'set', item: 'nope', field: 'a', value: 1 }]));
    expect(clients[1].items.has('nope')).toBe(false);
  });
});

describe('a client with batches waiting for their serials', () => {
  it('shows its writes at once, and the value of another client that will win', () => {
    const { clients, serials } = scene();
    const [a, b] = clients;
    const wa = a.write([{ kind: 'set', item: 'x', field: 'color', value: 'green' }]);
    expect(a.value('x', 'color')).toBe('green');
    // The batch of b gets its serial first
    const sb = serials.next(b.write([{ kind: 'set', item: 'x', field: 'color', value: 'black' }]));
    const sa = serials.next(wa);
    const r = a.receive(sb);
    expect(r.overwritten).toBe(1);
    expect(a.value('x', 'color')).toBe('black');
    const own = a.receive(sa);
    expect(own.applied.superseded).toHaveLength(1);
    expect(a.shown.size).toBe(0);
    b.receive(sb);
    b.receive(sa);
    expect(a.items.snapshot()).toEqual(b.items.snapshot());
  });

  it('keeps showing the last of its waiting writes of a field when an earlier one is applied', () => {
    const { clients, deliver } = scene();
    const [a] = clients;
    const w1 = a.write([{ kind: 'set', item: 'x', field: 'color', value: 'green' }]);
    const w2 = a.write([{ kind: 'set', item: 'x', field: 'color', value: 'white' }]);
    deliver(w1);
    expect(a.value('x', 'color')).toBe('white');
    expect(a.items.get('x', 'color')).toBe('green');
    deliver(w2);
    expect(a.shown.size).toBe(0);
    expect(a.value('x', 'color')).toBe('white');
  });

  it('shows the fields of the items of a batch skipped whole from the batches left', () => {
    const { clients, serials } = scene();
    const [a, b] = clients;
    const sb = serials.next(b.write([{ kind: 'delete', item: 'y' }]));
    const w1 = a.write([
      { kind: 'set', item: 'x', field: 'color', value: 'green' },
      { kind: 'set', item: 'y', field: 'color', value: 'green' },
    ]);
    const w2 = a.write([{ kind: 'set', item: 'x', field: 'name', value: 'Z' }]);
    a.receive(sb);
    expect(a.exists('y')).toBe(false);
    const r1 = a.receive(serials.next(w1));
    expect(r1.applied.skipped).toBe('deleted');
    expect(a.value('x', 'color')).toBe('red');
    expect(a.value('x', 'name')).toBe('Z');
    a.receive(serials.next(w2));
    expect(a.value('x', 'name')).toBe('Z');
    expect(a.shown.size).toBe(0);
  });

  it('ends with the same items as the others whatever it showed meanwhile', () => {
    const { clients, serials } = scene(['a', 'b', 'c']);
    const batches: Batch[] = [];
    // Each client writes the same fields, its writes waiting while the others' get their serials
    for (let round = 0; round < 5; round++) {
      for (const c of clients) {
        batches.push(
          c.write([
            { kind: 'set', item: 'x', field: 'color', value: `${c.id}${round}` },
            { kind: 'set', item: round % 2 ? 'y' : 'x', field: c.id, value: round },
          ]),
        );
      }
    }
    const numbered = batches.map((b) => serials.next(b));
    for (const s of numbered) for (const c of clients) c.receive(s);
    const [a, b, c] = clients;
    expect(a.items.snapshot()).toEqual(b.items.snapshot());
    expect(b.items.snapshot()).toEqual(c.items.snapshot());
    for (const client of clients) expect(client.shown.size).toBe(0);
  });
});
