// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Operations from elsewhere, written to a Store (`writeOperations`) and applied to the document of
 * a storage (`applyOperations`, read by the rules of `kept.ts`), give the same document, and keep
 * the same aside: random runs of what other clients send that name part of what they touch (a
 * group moved with some of its members, a layer deleted with some of what it holds, a feature
 * made in a container gone, a move under a container gone, an undo that makes a record again)
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../store/store.js';
import { random, storedOf, writtenOf } from '../../test-support/random-commits.js';
import { STORE_KINDS } from '../../test-support/refusing-storage.js';
import { createMapStub } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import { CommitValues } from './commit-values.js';
import { readStoredDocument } from './kept.js';
import { writeOperations } from './store-writes.js';
import {
  applyOperations,
  createStoredDocument,
  type FeatureRecord,
  type GroupRecord,
  type LayerRecord,
  type StoredDocument,
  type ValueOperation,
} from './values.js';

const LAYER = 'maplibre-gl-draw:layerId';
const GROUP = 'maplibre-gl-draw:groupId';

const draws: Draw[] = [];

afterEach(() => {
  for (const d of draws.splice(0)) d.destroy();
});

/** Keys of the order, some of them the same for several records */
const KEYS = ['V', 'W', 'X', 'Y', 'VV', 'WW'];

/** What the runs deleted, made again by an undo elsewhere */
interface Deleted {
  readonly layers: Map<string, LayerRecord>;
  readonly groups: Map<string, GroupRecord>;
  readonly features: Map<string, FeatureRecord>;
}

function layerRecord(id: string, key: string): LayerRecord {
  return { name: id, visible: true, locked: false, opacity: 1, style: {}, styleRule: null, key };
}

/** The operations of one random commit of another client, from what the storage holds */
function commitOf(
  next: () => number,
  document: StoredDocument,
  ids: { n: number },
  deleted: Deleted,
): ValueOperation[] {
  const pick = <T>(list: readonly T[]): T | undefined =>
    list.length === 0 ? undefined : list[Math.floor(next() * list.length)];
  const key = (): string => pick(KEYS) as string;
  const layers = [...document.layers.keys()];
  const groups = [...document.groups.keys()];
  const features = [...document.features.keys()];
  const record = (id: string): FeatureRecord => document.features.get(id) as FeatureRecord;
  const choice = next();
  if (choice < 0.2 || features.length < 2) {
    // A feature in a layer or in a group, now and then in a container gone (a view not up to date)
    const id = `f${++ids.n}`;
    const stale = next() < 0.3;
    const groupId =
      next() < 0.4
        ? stale
          ? pick([...deleted.groups.keys(), ...groups])
          : pick(groups)
        : undefined;
    const group =
      groupId === undefined
        ? undefined
        : (document.groups.get(groupId) ?? deleted.groups.get(groupId));
    const layerId =
      group && !(stale && next() < 0.5)
        ? group.layerId
        : ((stale ? pick([...deleted.layers.keys(), ...layers]) : pick(layers)) ?? 'a');
    return [
      {
        type: 'create',
        kind: 'feature',
        id,
        record: {
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: { [LAYER]: layerId, ...(groupId !== undefined && { [GROUP]: groupId }) },
          key: key(),
        },
      },
    ];
  }
  if (choice < 0.3) {
    const id = pick(features) as string;
    return [
      {
        type: 'set',
        kind: 'feature',
        ids: [id],
        set: { properties: { n: Math.floor(next() * 9) } },
      },
    ];
  }
  if (choice < 0.4) {
    // A move into a layer or a group, now and then one gone
    const id = pick(features) as string;
    const parent =
      next() < 0.5
        ? pick(layers)
        : next() < 0.8
          ? pick(groups)
          : pick([...deleted.groups.keys(), ...deleted.layers.keys()]);
    if (parent === undefined) return [];
    return [{ type: 'place', kind: 'feature', ids: [id], parentId: parent, keys: [key()] }];
  }
  if (choice < 0.47) {
    const chosen = features.filter(() => next() < 0.2);
    if (chosen.length === 0) return [];
    for (const id of chosen) deleted.features.set(id, record(id));
    return [{ type: 'delete', kind: 'feature', ids: chosen }];
  }
  if (choice < 0.53) {
    // A group of features of one layer, as a client makes it: the group, then the places
    const layerId = pick(layers);
    if (layerId === undefined) return [];
    const members = features.filter((id) => {
      const properties = record(id).properties;
      return properties[LAYER] === layerId && properties[GROUP] === undefined && next() < 0.5;
    });
    if (members.length === 0) return [];
    const id = `g${++ids.n}`;
    return [
      {
        type: 'create',
        kind: 'group',
        id,
        record: { name: id, layerId, parentId: null, visible: true, locked: false, key: key() },
      },
      { type: 'place', kind: 'feature', ids: members, parentId: id, keys: members.map(key) },
    ];
  }
  if (choice < 0.6) {
    // A group moved to a layer, with some of its members named only
    const id = pick(groups);
    const to = pick(layers);
    if (id === undefined || to === undefined) return [];
    const members = features.filter((one) => record(one).properties[GROUP] === id && next() < 0.6);
    const out: ValueOperation[] = [
      { type: 'place', kind: 'group', ids: [id], parentId: to, keys: [key()] },
    ];
    if (members.length > 0) {
      out.push({
        type: 'place',
        kind: 'feature',
        ids: members,
        parentId: id,
        keys: members.map((one) => record(one).key),
      });
    }
    return out;
  }
  if (choice < 0.66) {
    // A group deleted, with some of its members or none
    const id = pick(groups);
    if (id === undefined) return [];
    const members =
      next() < 0.4
        ? features.filter((one) => record(one).properties[GROUP] === id && next() < 0.6)
        : [];
    deleted.groups.set(id, document.groups.get(id) as GroupRecord);
    for (const one of members) deleted.features.set(one, record(one));
    const out: ValueOperation[] = [];
    if (members.length > 0) out.push({ type: 'delete', kind: 'feature', ids: members });
    out.push({ type: 'delete', kind: 'group', ids: [id] });
    return out;
  }
  if (choice < 0.72) {
    // A layer deleted, with some of what it holds named
    if (layers.length < 2) return [];
    const id = pick(layers) as string;
    const named = features.filter((one) => record(one).properties[LAYER] === id && next() < 0.6);
    const namedGroups = groups.filter(
      (one) => document.groups.get(one)?.layerId === id && next() < 0.6,
    );
    deleted.layers.set(id, document.layers.get(id) as LayerRecord);
    for (const one of named) deleted.features.set(one, record(one));
    for (const one of namedGroups) deleted.groups.set(one, document.groups.get(one) as GroupRecord);
    const out: ValueOperation[] = [];
    if (named.length > 0) out.push({ type: 'delete', kind: 'feature', ids: named });
    if (namedGroups.length > 0) out.push({ type: 'delete', kind: 'group', ids: namedGroups });
    out.push({ type: 'delete', kind: 'layer', ids: [id] });
    return out;
  }
  if (choice < 0.8) {
    // An undo elsewhere: something deleted made again as it was
    const made: ValueOperation[] = [];
    for (const [id, one] of deleted.layers) {
      if (!document.layers.has(id)) made.push({ type: 'create', kind: 'layer', id, record: one });
    }
    for (const [id, one] of deleted.groups) {
      if (!document.groups.has(id)) made.push({ type: 'create', kind: 'group', id, record: one });
    }
    for (const [id, one] of deleted.features) {
      if (!document.features.has(id)) {
        made.push({ type: 'create', kind: 'feature', id, record: one });
      }
    }
    const one = pick(made);
    return one ? [one] : [];
  }
  if (choice < 0.85) {
    const id = `L${++ids.n}`;
    return [{ type: 'create', kind: 'layer', id, record: layerRecord(id, key()) }];
  }
  if (choice < 0.9) {
    const id = pick(layers);
    if (id === undefined) return [];
    return [{ type: 'place', kind: 'layer', ids: [id], parentId: null, keys: [key()] }];
  }
  if (choice < 0.95) {
    const id = pick(groups);
    if (id === undefined) return [];
    return [{ type: 'set', kind: 'group', ids: [id], set: { name: `n${Math.floor(next() * 5)}` } }];
  }
  return [{ type: 'set', kind: 'document', set: { title: `t${Math.floor(next() * 5)}` } }];
}

/** A map by its keys in order, to compare */
function sorted<T>(map: ReadonlyMap<string, T>): [string, T][] {
  return [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * A random run of commits from elsewhere, written to a Store and applied to a storage
 *
 * @returns How many steps kept something aside
 */
async function run(makeStore: () => Store, seed: number, steps: number): Promise<number> {
  const store = makeStore();
  const d = createDraw(createMapStub().map, { store, initDefaultLayer: false });
  draws.push(d);
  const values = new CommitValues(store);
  store.subscribe((changes) => {
    const reading = values.readChange(changes, Number.POSITIVE_INFINITY, false);
    if (!reading) return;
    reading.step(Number.POSITIVE_INFINITY);
    reading.release();
  });
  const storage = createStoredDocument();
  const next = random(seed);
  const ids = { n: 0 };
  const deleted: Deleted = { layers: new Map(), groups: new Map(), features: new Map() };
  let keeping = 0;
  for (let i = 0; i < steps; i++) {
    const operations =
      i === 0
        ? ([
            { type: 'create', kind: 'layer', id: 'a', record: layerRecord('a', 'V') },
            { type: 'create', kind: 'layer', id: 'b', record: layerRecord('b', 'W') },
          ] satisfies ValueOperation[])
        : commitOf(next, storage, ids, deleted);
    if (operations.length === 0) continue;
    applyOperations(storage, operations);
    const { failed } = store.transact(() => writeOperations(store, values, operations), 'remote');
    expect({ seed, i, failed }).toEqual({ seed, i, failed: [] });
    const read = readStoredDocument(storage);
    if (!read.kept.empty) keeping++;
    expect({ seed, i, shown: writtenOf(d.document.toJSON()) }).toEqual({
      seed,
      i,
      shown: storedOf(read.shown),
    });
    expect({
      seed,
      i,
      features: sorted(values.kept.features),
      groups: sorted(values.kept.groups),
      placements: sorted(values.kept.placements),
    }).toEqual({
      seed,
      i,
      features: sorted(read.kept.features),
      groups: sorted(read.kept.groups),
      placements: sorted(read.kept.placements),
    });
  }
  return keeping;
}

describe('the operations from elsewhere written to a Store', () => {
  for (const [kind, makeStore] of STORE_KINDS) {
    it(`give the document of the storage read by the rules, and keep the same aside (${kind})`, async () => {
      let keeping = 0;
      for (let seed = 1; seed <= 60; seed++) keeping += await run(makeStore, seed, 60);
      // Many of the steps keep something aside
      expect(keeping).toBeGreaterThan(300);
    }, 60_000);
  }
});
