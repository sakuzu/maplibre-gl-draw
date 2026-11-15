// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A refused commit is as if it was never made, the steps of undo included: random runs of writes,
 * undos and redos, some of them refused while the answers wait, in which every write gives a value
 * no other write gives. A value only a refused commit wrote never comes to the storage (checked
 * after each step), and the instance and the storage settle on the same document
 *
 * The runs make no group: an undo that makes a group again whose members are gone leaves here a
 * group with no member the storage does not show, refused or not
 */

import { afterEach, describe, expect, it } from 'vitest';
import { random, writtenOf } from '../../test-support/random-commits.js';
import {
  drawWith,
  point,
  refusing,
  STORE_KINDS,
  settled,
  shownOf,
} from '../../test-support/refusing-storage.js';
import type { Draw } from '../draw.js';
import type { StoredDocument } from './values.js';

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

/** The values a document holds that writes give: of the features, and the names of the layers */
function valuesOf(document: StoredDocument): string[] {
  const out: string[] = [];
  for (const record of document.features.values()) {
    const value = record.properties.v;
    if (typeof value === 'string') out.push(value);
  }
  for (const layer of document.layers.values()) out.push(layer.name);
  return out;
}

/**
 * One random run
 *
 * @returns How many commits were refused, and how many undos and redos were made
 */
async function run(
  makeStore: Parameters<typeof drawWith>[0],
  rowsReadAtOnce: number | undefined,
  seed: number,
  steps: number,
): Promise<{ refused: number; undos: number }> {
  const next = random(seed);
  const pick = random(seed + 1000);
  const made = new Set<string>();
  const storage = refusing((batch) => made.has(batch.commit) && pick() < 0.2);
  draw = drawWith(makeStore, storage.backend, rowsReadAtOnce);
  const d = draw;
  // The values each commit of this client wrote first (an undo and a redo write none of their own)
  const minted = new Map<string, string[]>();
  let writing: string[] | null = null;
  d.on('change', (change) => {
    if (change.source === 'refused' || change.source === 'remote') return;
    made.add(change.commit);
    if (writing && change.source === 'local') minted.set(change.commit, writing);
  });
  let count = 0;
  const mint = (): string => {
    const value = `w${++count}`;
    writing?.push(value);
    return value;
  };
  const write = async (fn: Parameters<Draw['write']>[0]): Promise<void> => {
    writing = [];
    await d.write(fn).then(
      () => undefined,
      () => undefined,
    );
    writing = null;
  };
  await write(async (tx) => {
    await tx.layers.create({ id: 'a', name: mint() });
    await tx.layers.create({ id: 'b', name: mint() });
  });
  let ids = 0;
  let undos = 0;
  let last: string | undefined;
  const one = async (): Promise<void> => {
    const features = d.features.list({}, { limit: 100000 }).map((feature) => feature.id);
    const layers = d.layers.list().map((layer) => layer.id);
    const of = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)];
    const choice = next();
    if (choice < 0.15 || features.length < 2) {
      const id = `f${++ids}`;
      await write((tx) => tx.features.create([point(id, of(layers), { v: mint() })]));
    } else if (choice < 0.45) {
      // A value written over another, the one most often taken back: half the time over the value
      // the last write gave, so that a refused value is written over before it is answered
      const id =
        last !== undefined && features.includes(last) && next() < 0.5 ? last : of(features);
      last = id;
      await write((tx) => tx.features.update(id, { properties: { v: mint() } }));
    } else if (choice < 0.5) {
      const chosen = features.filter(() => next() < 0.2);
      if (chosen.length > 0) await write((tx) => tx.features.delete(chosen));
    } else if (choice < 0.55) {
      const chosen = features.filter(() => next() < 0.3);
      if (chosen.length > 0) {
        await write((tx) => tx.features.place(chosen, { layerId: of(layers) }));
      }
    } else if (choice < 0.62) {
      await write((tx) => tx.layers.update(of(layers), { name: mint() }));
    } else if (choice < 0.64) {
      const id = `layer${++ids}`;
      await write((tx) => tx.layers.create({ id, name: mint() }));
    } else if (choice < 0.65) {
      if (layers.length > 2) await write((tx) => tx.layers.delete(of(layers)));
    } else if (choice < 0.88) {
      undos++;
      await d.undo().catch(() => undefined);
    } else {
      undos++;
      await d.redo().catch(() => undefined);
    }
  };
  // The values only refused commits wrote
  const refusedValues = (): Set<string> => {
    const out = new Set<string>();
    for (const refusal of d.backend.refusals.value) {
      for (const value of minted.get(refusal.commit) ?? []) out.add(value);
    }
    return out;
  };
  const noRefusedValue = (where: string, values: readonly string[], i: number): void => {
    const refused = refusedValues();
    expect({ seed, i, where, leaked: values.filter((value) => refused.has(value)) }).toEqual({
      seed,
      i,
      where,
      leaked: [],
    });
  };
  for (let i = 0; i < steps; i++) {
    // Two to four at a time, now and then made before the storage answers the first
    if (pick() < 0.4) storage.hold();
    const many = 2 + Math.floor(pick() * 3);
    for (let k = 0; k < many; k++) await one();
    storage.release();
    // Some answers came: what was refused is never in the storage
    await new Promise((resolve) => setTimeout(resolve, 0));
    noRefusedValue('storage', valuesOf(storage.backend.document), i);
    if (i % 10 === 9 || i === steps - 1) {
      await settled(d);
      noRefusedValue('storage', valuesOf(storage.backend.document), i);
      const here = writtenOf(d.document.toJSON());
      noRefusedValue(
        'here',
        [
          ...here.features.map((feature) => feature.properties.v as string),
          ...here.layers.map((layer) => layer.name),
        ],
        i,
      );
      expect({ seed, i, stored: shownOf(storage.backend.document) }).toEqual({
        seed,
        i,
        stored: here,
      });
    }
  }
  const refused = d.backend.refusals.value.length;
  draw.destroy();
  draw = undefined;
  return { refused, undos };
}

describe('a refused commit, with undos and redos', () => {
  for (const [kind, makeStore] of STORE_KINDS) {
    for (const atOnce of kind === 'rows' ? [undefined, 0] : [undefined]) {
      const how = atOnce === 0 ? ', the rows read over several tasks' : '';
      it(`never comes back to the storage (${kind}${how})`, async () => {
        let refused = 0;
        let undos = 0;
        for (let seed = 1; seed <= 40; seed++) {
          const counts = await run(makeStore(), atOnce, seed, 40);
          refused += counts.refused;
          undos += counts.undos;
        }
        expect(refused).toBeGreaterThan(200);
        expect(undos).toBeGreaterThan(500);
      }, 120_000);
    }
  }
});
