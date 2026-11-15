// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The commits a storage of the first shape refused, taken out of the document here, so that every
 * client settles on the document the storage has (the last write to arrive at the storage stays)
 *
 * - A value a refused commit wrote is put back only where it still is the value of that commit:
 *   when a later commit of this client wrote it again (or created or deleted its thing), the later
 *   value stays, and that commit is told to take it back to the value before the refused commit,
 *   not to the refused value, should it be refused too
 * - What a refused commit created is deleted, and what it deleted is created again where it was
 * - A later commit not sent that names what a refused commit created (its own creations too) is
 *   refused with it (`dependsOnRefused`); one that only wrote the same values does not depend on it
 * - The refused commits are taken out from the newest
 *
 * A value is one key of what a commit writes: the geometry of a feature, one key of its
 * properties, one key of its style, the place of an item (its parent and key), one field of a layer
 * or a group, the title or the description.
 *
 * @internal
 */

import type { Store } from '../../store/store.js';
import type { JsonObject, JsonValue } from '../model.js';
import type { CommitValues, ItemPlace } from './commit-values.js';
import { writeOperations } from './store-writes.js';
import type { ValueOperation } from './values.js';

const STYLE_KEY = 'maplibre-gl-draw:style';
const LAYER_KEY = 'maplibre-gl-draw:layerId';
const GROUP_KEY = 'maplibre-gl-draw:groupId';

/** A key taken off */
const UNSET: unique symbol = Symbol('unset');

type SlotValue = JsonValue | ItemPlace | typeof UNSET;

/** What kind of thing a value is of */
type SlotKind = 'feature' | 'layer' | 'group' | 'document';

/** The values of a commit, by thing and by key (see the description of the module) */
type Slots = Map<string, Map<string, SlotValue>>;

/**
 * A commit of this client as operations: what it did, and what takes it back (rewritten when a
 * refused commit before it keeps a value both wrote)
 *
 * @internal
 */
export interface CommitOperations {
  readonly operations: readonly ValueOperation[];
  inverse: ValueOperation[];
}

/**
 * Which of the later commits depend on a refused one: those that name what it created, or what a
 * commit that depends on it created
 *
 * @param later - The later commits not sent, in their order
 * @returns The indexes of `later` that depend on it
 * @internal
 */
export function dependentsOf(
  refused: CommitOperations,
  later: readonly CommitOperations[],
): number[] {
  const made = new Set<string>();
  createdIds(refused.operations, made);
  const out: number[] = [];
  later.forEach((commit, i) => {
    if (!names(commit.operations, made)) return;
    out.push(i);
    createdIds(commit.operations, made);
  });
  return out;
}

/**
 * Takes refused commits out of the document, from the newest, in a transaction of the caller
 *
 * @param commits - The commits not sent, in their order (the first refused among them)
 * @param refused - Which of them are refused
 * @returns What the Store refused to write (the rest is written)
 * @internal
 */
export function takeOut(
  store: Store,
  values: CommitValues,
  commits: readonly CommitOperations[],
  refused: ReadonlySet<CommitOperations>,
): TakeOutResult {
  const failed: unknown[] = [];
  const unplaced: Array<{ kind: 'feature' | 'group'; id: string }> = [];
  const uncreated: Array<{ kind: 'feature' | 'group'; id: string }> = [];
  for (let i = commits.length - 1; i >= 0; i--) {
    if (!refused.has(commits[i])) continue;
    // The commits after it that stay: their inverse is rewritten
    const later = commits.slice(i + 1).filter((commit) => !refused.has(commit));
    const result = takeOutOne(store, values, commits[i], later);
    failed.push(...result.failed);
    unplaced.push(...result.unplaced);
    uncreated.push(...result.uncreated);
  }
  return { failed, unplaced, uncreated };
}

/**
 * What a take-out could not write: what the Store refused, and the items the storage is told
 * where they are: those it did not put back because a later commit deleted their parent (they
 * stay where they are), and those it put back in a group a later commit put in another layer
 *
 * @internal
 */
export interface TakeOutResult {
  readonly failed: readonly unknown[];
  readonly unplaced: ReadonlyArray<{ readonly kind: 'feature' | 'group'; readonly id: string }>;
  /** What it did not create again because a later commit deleted its layer: the storage deletes it */
  readonly uncreated: ReadonlyArray<{ readonly kind: 'feature' | 'group'; readonly id: string }>;
}

function takeOutOne(
  store: Store,
  values: CommitValues,
  commit: CommitOperations,
  later: readonly CommitOperations[],
): TakeOutResult {
  const made = new Set<string>();
  createdIds(commit.operations, made);
  const back = slotsOf(commit.inverse);
  // What each later commit wrote, created and deleted
  const written = later.map((other) => slotsOf(other.operations));
  const created = later.map((other) => createdThings(other.operations));
  const deleted = later.map((other) => deletedThings(other.operations));
  const inverses: Array<Slots | null> = later.map(() => null);
  const records: Array<Map<string, Map<string, SlotValue>> | null> = later.map(() => null);
  const kept: Slots = new Map();
  const told: Array<{ kind: 'feature' | 'group'; id: string }> = [];
  for (const [thing, slots] of slotsOf(commit.operations)) {
    const { kind, id } = thingOf(thing);
    // What it created is deleted with it
    if (made.has(id)) continue;
    const now = currentOf(store, values, kind, id);
    for (const [key, value] of slots) {
      const before = back.get(thing)?.get(key);
      if (before === undefined) continue;
      // The first later commit that wrote the value, or created or deleted its thing
      const at = later.findIndex(
        (_, i) =>
          written[i].get(thing)?.has(key) === true ||
          created[i].has(thing) ||
          deleted[i].has(thing),
      );
      if (at < 0) {
        // Still the value of this commit: put back (a value from elsewhere stays)
        if (now && sameValue(now(key), value)) {
          let entry = kept.get(thing);
          if (!entry) {
            entry = new Map();
            kept.set(thing, entry);
          }
          entry.set(key, before);
          // A feature put back in a group a later commit put in another layer: the storage, which
          // moved the group with the members that commit named, is told where it is
          const parent = key === 'place' ? (before as ItemPlace).parentId : null;
          if (kind === 'feature' && parent !== null) {
            const group = thingKey('group', parent);
            if (written.some((slots) => slots.get(group)?.has('place'))) {
              told.push({ kind: 'feature', id });
            }
          }
        }
        continue;
      }
      // The later value stays; that commit takes it back to the value before this one (those
      // after it take it back to the value of the one before them)
      if (written[at].get(thing)?.has(key)) {
        inverses[at] ??= slotsOf(later[at].inverse);
        (inverses[at] as Slots).get(thing)?.set(key, before);
      }
      if (deleted[at].has(thing)) {
        const list = records[at] ?? new Map<string, Map<string, SlotValue>>();
        records[at] = list;
        const entry = list.get(thing) ?? new Map<string, SlotValue>();
        entry.set(key, before);
        list.set(thing, entry);
      }
    }
  }
  later.forEach((other, i) => {
    const inverse = inverses[i];
    if (inverse) other.inverse = withSlots(other.inverse, inverse);
    const remade = records[i];
    if (remade) other.inverse = withRecords(store, other.inverse, remade);
  });
  // What it deleted comes back, unless a later commit created it again (or deleted it once more):
  // the later one stays, and taking that one back no longer deletes it
  const creates = commit.inverse.filter((operation) => {
    if (operation.type !== 'create') return false;
    if (operation.kind === 'file') return true;
    const thing = thingKey(operation.kind, operation.id);
    const at = later.findIndex((_, i) => created[i].has(thing) || deleted[i].has(thing));
    if (at < 0) return true;
    if (created[at].has(thing)) {
      const other = later[at];
      other.inverse = withoutDeletion(other.inverse, operation.kind, operation.id);
    }
    return false;
  });
  const operations = [
    ...creates,
    ...operationsOf(kept),
    ...commit.inverse.filter((operation) => operation.type === 'delete'),
  ];
  const result = writeOperations(store, values, operations);
  return { ...result, unplaced: [...result.unplaced, ...told] };
}

// ============================================================================
// What a commit names
// ============================================================================

/** Operations without the deletion of one thing */
function withoutDeletion(
  operations: readonly ValueOperation[],
  kind: string,
  id: string,
): ValueOperation[] {
  return operations.flatMap((operation) => {
    if (operation.type !== 'delete' || operation.kind !== kind || !operation.ids.includes(id)) {
      return [operation];
    }
    const ids = operation.ids.filter((one) => one !== id);
    return ids.length > 0 ? [{ ...operation, ids }] : [];
  });
}

/** The things operations create */
function createdThings(operations: readonly ValueOperation[]): Set<string> {
  const out = new Set<string>();
  for (const operation of operations) {
    if (operation.type === 'create' && operation.kind !== 'file') {
      out.add(thingKey(operation.kind, operation.id));
    }
  }
  return out;
}

/** The things operations delete */
function deletedThings(operations: readonly ValueOperation[]): Set<string> {
  const out = new Set<string>();
  for (const operation of operations) {
    if (operation.type !== 'delete' || operation.kind === 'file') continue;
    for (const id of operation.ids) out.add(thingKey(operation.kind, id));
  }
  return out;
}

/**
 * Operations whose creations hold the values given instead of theirs: what a commit that deleted
 * a thing brings back
 */
function withRecords(
  store: Store,
  operations: readonly ValueOperation[],
  records: ReadonlyMap<string, ReadonlyMap<string, SlotValue>>,
): ValueOperation[] {
  // The layers of the groups the operations create again
  const groupLayers = new Map<string, string>();
  for (const operation of operations) {
    if (operation.type === 'create' && operation.kind === 'group') {
      groupLayers.set(operation.id, operation.record.layerId);
    }
  }
  const layerOfGroup = (id: string): string | undefined =>
    store.getLayer(id) ? undefined : (store.getGroup(id)?.layerId ?? groupLayers.get(id));
  return operations.map((operation) => {
    if (operation.type !== 'create' || operation.kind === 'file') return operation;
    const slots = records.get(thingKey(operation.kind, operation.id));
    if (!slots) return operation;
    switch (operation.kind) {
      case 'feature': {
        const properties: Record<string, JsonValue> = { ...operation.record.properties };
        let style: Record<string, JsonValue> = isObject(properties[STYLE_KEY])
          ? { ...(properties[STYLE_KEY] as JsonObject) }
          : {};
        let geometry = operation.record.geometry;
        let key = operation.record.key;
        for (const [slot, value] of slots) {
          if (slot === 'geometry') geometry = value as never;
          else if (slot === 'place') {
            const place = value as ItemPlace;
            key = place.key;
            const groupLayer = place.parentId === null ? undefined : layerOfGroup(place.parentId);
            if (groupLayer !== undefined && place.parentId !== null) {
              properties[LAYER_KEY] = groupLayer;
              properties[GROUP_KEY] = place.parentId;
            } else if (place.parentId !== null) {
              properties[LAYER_KEY] = place.parentId;
              delete properties[GROUP_KEY];
            }
          } else if (slot.startsWith('s:')) {
            if (value === UNSET) delete style[slot.slice(2)];
            else style = { ...style, [slot.slice(2)]: value as JsonValue };
          } else if (slot.startsWith('p:')) {
            if (value === UNSET) delete properties[slot.slice(2)];
            else properties[slot.slice(2)] = value as JsonValue;
          }
        }
        if (Object.keys(style).length > 0) properties[STYLE_KEY] = style;
        else delete properties[STYLE_KEY];
        return { ...operation, record: { geometry, properties, key } };
      }
      case 'group': {
        const record = { ...operation.record } as Record<string, unknown>;
        for (const [slot, value] of slots) {
          if (slot === 'place') {
            const place = value as ItemPlace;
            record.key = place.key;
            if (place.parentId !== null) record.layerId = place.parentId;
          } else if (value !== UNSET) {
            record[slot] = value;
          }
        }
        return { ...operation, record: record as never };
      }
      default: {
        const record = { ...operation.record } as Record<string, unknown>;
        let style = { ...(operation.record.style as JsonObject) } as Record<string, unknown>;
        for (const [slot, value] of slots) {
          if (slot === 'place') record.key = (value as ItemPlace).key;
          else if (slot.startsWith('s:')) {
            if (value === UNSET) delete style[slot.slice(2)];
            else style = { ...style, [slot.slice(2)]: value };
          } else if (value !== UNSET) {
            record[slot] = value;
          }
        }
        record.style = style;
        return { ...operation, record: record as never };
      }
    }
  });
}

/** Adds the IDs of what operations create */
function createdIds(operations: readonly ValueOperation[], out: Set<string>): void {
  for (const operation of operations) if (operation.type === 'create') out.add(operation.id);
}

/** Whether operations name one of the IDs given (as what they write, or as a parent) */
function names(operations: readonly ValueOperation[], ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  for (const operation of operations) {
    switch (operation.type) {
      case 'create': {
        if (ids.has(operation.id)) return true;
        if (operation.kind === 'feature') {
          const properties = operation.record.properties;
          const layer = properties[LAYER_KEY];
          const group = properties[GROUP_KEY];
          if (typeof layer === 'string' && ids.has(layer)) return true;
          if (typeof group === 'string' && ids.has(group)) return true;
        } else if (operation.kind === 'group' && ids.has(operation.record.layerId)) {
          return true;
        }
        break;
      }
      case 'set':
        if (operation.kind !== 'document' && operation.ids.some((id) => ids.has(id))) return true;
        break;
      case 'place':
        if (operation.parentId !== null && ids.has(operation.parentId)) return true;
        if (operation.ids.some((id) => ids.has(id))) return true;
        break;
      case 'delete':
        if (operation.ids.some((id) => ids.has(id))) return true;
        break;
    }
  }
  return false;
}

// ============================================================================
// Values
// ============================================================================

function thingKey(kind: SlotKind, id: string): string {
  return `${kind}\u0000${id}`;
}

function thingOf(thing: string): { kind: SlotKind; id: string } {
  const at = thing.indexOf('\u0000');
  return { kind: thing.slice(0, at) as SlotKind, id: thing.slice(at + 1) };
}

/** The values the sets and the places of operations write, by thing and key (the last kept) */
function slotsOf(operations: readonly ValueOperation[]): Slots {
  const out: Slots = new Map();
  const slot = (kind: SlotKind, id: string): Map<string, SlotValue> => {
    const thing = thingKey(kind, id);
    let entry = out.get(thing);
    if (!entry) {
      entry = new Map();
      out.set(thing, entry);
    }
    return entry;
  };
  for (const operation of operations) {
    if (operation.type === 'place') {
      operation.ids.forEach((id, i) => {
        const key = operation.keys[i];
        if (key !== undefined)
          slot(operation.kind, id).set('place', { parentId: operation.parentId, key });
      });
      continue;
    }
    if (operation.type !== 'set') continue;
    switch (operation.kind) {
      case 'document': {
        const entry = slot('document', '');
        if (operation.set.title !== undefined) entry.set('title', operation.set.title);
        if (operation.set.description !== undefined) {
          entry.set('description', operation.set.description);
        }
        break;
      }
      case 'feature':
        for (const id of operation.ids) {
          const entry = slot('feature', id);
          if (operation.set.geometry) entry.set('geometry', operation.set.geometry as never);
          for (const [key, value] of Object.entries(operation.set.properties ?? {})) {
            if (key === STYLE_KEY && isObject(value)) {
              for (const [name, one] of Object.entries(value as JsonObject)) {
                entry.set(`s:${name}`, one);
              }
            } else {
              entry.set(`p:${key}`, value);
            }
          }
          for (const key of operation.unset?.properties ?? []) entry.set(`p:${key}`, UNSET);
          for (const key of operation.unset?.style ?? []) entry.set(`s:${key}`, UNSET);
        }
        break;
      case 'layer':
        for (const id of operation.ids) {
          const entry = slot('layer', id);
          for (const [key, value] of Object.entries(operation.set)) {
            if (key === 'style' && isObject(value)) {
              for (const [name, one] of Object.entries(value as JsonObject)) {
                entry.set(`s:${name}`, one);
              }
            } else if (value !== undefined) {
              entry.set(key, value as JsonValue);
            }
          }
          for (const key of operation.unset?.style ?? []) entry.set(`s:${key}`, UNSET);
        }
        break;
      case 'group':
        for (const id of operation.ids) {
          const entry = slot('group', id);
          for (const [key, value] of Object.entries(operation.set)) {
            if (value !== undefined) entry.set(key, value as JsonValue);
          }
        }
        break;
    }
  }
  return out;
}

/** The sets and the places of values, in the order of the operations of a commit */
function operationsOf(slots: Slots): ValueOperation[] {
  const sets: ValueOperation[] = [];
  const places = new Map<
    string,
    { kind: 'feature' | 'layer' | 'group'; parentId: string | null; ids: string[]; keys: string[] }
  >();
  for (const [thing, entry] of slots) {
    const { kind, id } = thingOf(thing);
    const set: Record<string, unknown> = {};
    const properties: Record<string, unknown> = {};
    const style: Record<string, unknown> = {};
    const unsetProperties: string[] = [];
    const unsetStyle: string[] = [];
    for (const [key, value] of entry) {
      if (key === 'place') {
        const place = value as ItemPlace;
        const group = `${kind}\u0000${place.parentId ?? ''}`;
        let list = places.get(group);
        if (!list) {
          list = {
            kind: kind as 'feature' | 'layer' | 'group',
            parentId: place.parentId,
            ids: [],
            keys: [],
          };
          places.set(group, list);
        }
        list.ids.push(id);
        list.keys.push(place.key);
      } else if (key.startsWith('s:')) {
        if (value === UNSET) unsetStyle.push(key.slice(2));
        else style[key.slice(2)] = value;
      } else if (key.startsWith('p:')) {
        if (value === UNSET) unsetProperties.push(key.slice(2));
        else properties[key.slice(2)] = value;
      } else if (value !== UNSET) {
        set[key] = value;
      }
    }
    const hasStyle = Object.keys(style).length > 0;
    switch (kind) {
      case 'document':
        if (Object.keys(set).length > 0) sets.push({ type: 'set', kind: 'document', set });
        break;
      case 'feature': {
        if (hasStyle) properties[STYLE_KEY] = style;
        if (Object.keys(properties).length > 0) set.properties = properties;
        const unset = {
          ...(unsetProperties.length > 0 && { properties: unsetProperties }),
          ...(unsetStyle.length > 0 && { style: unsetStyle }),
        };
        if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) break;
        sets.push({
          type: 'set',
          kind: 'feature',
          ids: [id],
          set,
          ...(Object.keys(unset).length > 0 && { unset }),
        } as ValueOperation);
        break;
      }
      case 'layer': {
        if (hasStyle) set.style = style;
        const unset = unsetStyle.length > 0 ? { unset: { style: unsetStyle } } : {};
        if (Object.keys(set).length === 0 && unsetStyle.length === 0) break;
        sets.push({ type: 'set', kind: 'layer', ids: [id], set, ...unset } as ValueOperation);
        break;
      }
      case 'group':
        if (Object.keys(set).length > 0) {
          sets.push({ type: 'set', kind: 'group', ids: [id], set } as ValueOperation);
        }
        break;
    }
  }
  const placed: ValueOperation[] = [];
  // The layers first, then the groups, then the features, as a commit gives them
  for (const kind of ['layer', 'group', 'feature'] as const) {
    for (const list of places.values()) {
      if (list.kind !== kind) continue;
      placed.push({ type: 'place', kind, ids: list.ids, parentId: list.parentId, keys: list.keys });
    }
  }
  return [...sets, ...placed];
}

/** Operations with the values of their sets and places replaced by those given */
function withSlots(operations: readonly ValueOperation[], slots: Slots): ValueOperation[] {
  return [
    ...operations.filter((operation) => operation.type === 'create'),
    ...operationsOf(slots),
    ...operations.filter((operation) => operation.type === 'delete'),
  ];
}

/** What reads the value of a key of a thing as it is now (null for a thing not there) */
function currentOf(
  store: Store,
  values: CommitValues,
  kind: SlotKind,
  id: string,
): ((key: string) => SlotValue) | null {
  switch (kind) {
    case 'document': {
      const metadata = store.getMetadata();
      return (key) => {
        const value = (metadata as Record<string, unknown>)[key];
        return typeof value === 'string' ? value : '';
      };
    }
    case 'feature': {
      const record = values.recordOf('feature', id);
      if (!record) return null;
      const properties = record.properties;
      const style = isObject(properties[STYLE_KEY]) ? (properties[STYLE_KEY] as JsonObject) : {};
      return (key) => {
        if (key === 'place') return values.placeOf('feature', id) ?? UNSET;
        if (key === 'geometry') return record.geometry as never;
        if (key.startsWith('s:')) return own(style, key.slice(2));
        return own(properties, key.slice(2));
      };
    }
    case 'layer': {
      const record = values.recordOf('layer', id);
      if (!record) return null;
      return (key) => {
        if (key === 'place') return values.placeOf('layer', id) ?? UNSET;
        if (key.startsWith('s:')) return own(record.style as JsonObject, key.slice(2));
        return own(record as unknown as JsonObject, key);
      };
    }
    case 'group': {
      const record = values.recordOf('group', id);
      if (!record) return null;
      return (key) => {
        if (key === 'place') return values.placeOf('group', id) ?? UNSET;
        return own(record as unknown as JsonObject, key);
      };
    }
  }
}

function own(object: JsonObject, key: string): SlotValue {
  return Object.getOwnPropertyDescriptor(object, key) ? (object[key] as JsonValue) : UNSET;
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether two values are the same (JSON values, places, or both taken off) */
function sameValue(a: SlotValue | undefined, b: SlotValue | undefined): boolean {
  if (a === b) return true;
  if (a === UNSET || b === UNSET || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => sameValue(value, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      Object.getOwnPropertyDescriptor(right, key) !== undefined &&
      sameValue(left[key] as SlotValue, right[key] as SlotValue),
  );
}
