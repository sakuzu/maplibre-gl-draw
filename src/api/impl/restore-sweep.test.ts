// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.restore` against a model of what its declaration says, over seeded random lists of
 * edits: the edits of this client (one feature, a transaction that writes other fields of other
 * features, the bulk edits, the moves between layers and groups, the groups made, taken apart,
 * renamed and moved, the vertices moved, added and deleted), the edits of a client elsewhere
 * (another source) to the same features, and the writing back of the edits of this client, the
 * making again of what was written back, and the writing back of the edits of the client
 * elsewhere, some of them with `exceptProperties`. After every writing back, every field of every
 * feature and every group is compared with the model, and the order of the features it did not
 * place with the order before.
 *
 * The model follows the declaration: a key is written back feature by feature, the layer or group
 * of a feature and its position there are two keys, a key written with the value it had was not
 * written, a feature the change wrote that is deleted now stays deleted, the features put into a
 * group the change created stay in its layer when it goes, a feature the change deleted comes
 * back unless it is there again, and a vertex the change deleted comes back before the vertex that
 * was after it (at the end for the last one, not at all when that vertex is gone).
 *
 * The seeds run by default keep the test within its time; `DRAW_RESTORE_SEEDS=1-3000` runs all of
 * them (and `DRAW_RESTORE_STEPS` the longest list).
 */

import { describe, expect, it } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DocumentChange } from '../events.js';
import type { Feature, FeatureValues } from '../model.js';
import { createDraw } from './create-draw.js';

const [SEED_FROM, SEED_TO] = (process.env.DRAW_RESTORE_SEEDS ?? '1-300').split('-').map(Number);
const MAX_STEPS = Number(process.env.DRAW_RESTORE_STEPS ?? 30);

// ============================================================================
// The model
// ============================================================================

type Pos = [number, number];

/** A feature as the model holds it */
interface SF {
  id: string;
  type: string;
  coords: Pos[];
  layer: string;
  group: string | null;
  props: Record<string, unknown>;
  style: Record<string, unknown>;
  visible: boolean;
}

/** A group as the model holds it */
interface SG {
  id: string;
  name: string;
  layer: string;
}

/** The document: the features, the groups, and the items of each layer and group in order */
interface Snap {
  f: Map<string, SF>;
  g: Map<string, SG>;
  order: Map<string, string[]>;
}

/** What a change did to a geometry: whole, or vertex by vertex, followed to the geometry now */
type Geo =
  | { kind: 'whole'; before: Pos[] }
  | {
      kind: 'vertex';
      moved: Array<{ idx: number | null; before: Pos }>;
      added: Array<number | null>;
      /** A vertex deleted, before the vertex that was after it (its index now), or at the end */
      deleted: Array<{ anchor: number | null | 'end'; pos: Pos }>;
      last: Pos[];
    };

/** What a change wrote of one feature, with the values before */
interface FP {
  created?: boolean;
  deleted?: SF;
  props?: Map<string, unknown>;
  style?: Map<string, unknown>;
  visible?: boolean;
  /** The layer and group before, or only the position there (`orderOnly`) */
  place?: { layer: string; group: string | null; orderOnly?: boolean };
  geo?: Geo;
}

interface GroupFP {
  created: string[];
  deleted: SG[];
  moved: Array<{ id: string; layer: string }>;
  renamed: Array<{ id: string; name: string }>;
}

/** An edit as the model holds it: what it wrote, and the values its changes carry */
interface Rec {
  label: string;
  values: FeatureValues[];
  fp: Map<string, FP>;
  groups: GroupFP;
  /** The writing back of the record did not follow the model: it is not compared again */
  tainted: boolean;
}

const emptyGroups = (): GroupFP => ({ created: [], deleted: [], moved: [], renamed: [] });

const eqPos = (a: Pos | undefined, b: Pos | undefined): boolean =>
  !!a && !!b && a[0] === b[0] && a[1] === b[1];

const nearPos = (a: Pos, b: Pos): boolean =>
  Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

const copyCoords = (coords: readonly Pos[]): Pos[] => coords.map((q) => [q[0], q[1]] as Pos);

function cloneF(f: SF): SF {
  return { ...f, coords: copyCoords(f.coords), props: { ...f.props }, style: { ...f.style } };
}

function cloneSnap(s: Snap): Snap {
  return {
    f: new Map([...s.f].map(([k, v]) => [k, cloneF(v)])),
    g: new Map([...s.g].map(([k, v]) => [k, { ...v }])),
    order: new Map([...s.order].map(([k, v]) => [k, [...v]])),
  };
}

/** The span that changed between two rings, as `VertexRef` finds it */
function span(a: readonly Pos[], b: readonly Pos[]): { p: number; s: number } {
  const min = Math.min(a.length, b.length);
  let p = 0;
  while (p < min && eqPos(a[p], b[p])) p++;
  let s = 0;
  while (s < min - p && eqPos(a[a.length - 1 - s], b[b.length - 1 - s])) s++;
  return { p, s };
}

/** What a geometry written vertex by vertex did: the span moved, or deleted and added */
function vertexDiff(a: readonly Pos[], b: readonly Pos[]): Geo {
  const { p, s } = span(a, b);
  const moved: Array<{ idx: number | null; before: Pos }> = [];
  const added: Array<number | null> = [];
  const deleted: Array<{ anchor: number | null | 'end'; pos: Pos }> = [];
  if (a.length === b.length) {
    for (let i = p; i < a.length - s; i++) moved.push({ idx: i, before: a[i] });
  } else {
    const anchor = s === 0 ? 'end' : b.length - s;
    for (let i = p; i < a.length - s; i++) deleted.push({ anchor, pos: a[i] });
    for (let i = p; i < b.length - s; i++) added.push(i);
  }
  return { kind: 'vertex', moved, added, deleted, last: copyCoords(b) };
}

/** Where a vertex of `last` is in `now`, as `VertexRef` follows it (null: it cannot be) */
function follow(last: readonly Pos[], now: readonly Pos[], idx: number): number | null {
  const { p, s } = span(last, now);
  if (idx < p) return idx;
  if (idx >= last.length - s) return idx + now.length - last.length;
  if (now.length !== last.length) return null;
  const pos = last[idx];
  const others: number[] = [];
  for (let j = p; j < now.length - s; j++) if (j !== idx && eqPos(now[j], pos)) others.push(j);
  return others.length === 1 ? others[0] : idx;
}

/** Follows the vertices a record keeps to the geometries now */
function followAll(rec: Rec, now: Snap): void {
  for (const [id, fp] of rec.fp) {
    const geo = fp.geo;
    if (geo?.kind !== 'vertex') continue;
    const f = now.f.get(id);
    if (!f) continue;
    const last = geo.last;
    if (f.coords.length === last.length && f.coords.every((q, i) => eqPos(q, last[i]))) continue;
    geo.moved = geo.moved.map((m) => ({
      ...m,
      idx: m.idx === null ? null : follow(last, f.coords, m.idx),
    }));
    geo.added = geo.added.map((i) => (i === null ? null : follow(last, f.coords, i)));
    geo.deleted = geo.deleted.map((d) => ({
      ...d,
      anchor: typeof d.anchor === 'number' ? follow(last, f.coords, d.anchor) : d.anchor,
    }));
    geo.last = copyCoords(f.coords);
  }
}

/**
 * Leaves out of what an edit wrote the keys it wrote with the values they had, and marks a move
 * within the layer or group as a move of the position alone
 */
function settle(fp: Map<string, FP>, before: Snap, after: Snap): void {
  for (const [id, w] of fp) {
    const b = before.f.get(id);
    const a = after.f.get(id);
    if (!b || !a) continue;
    if (w.props)
      for (const k of [...w.props.keys()]) if (b.props[k] === a.props[k]) w.props.delete(k);
    if (w.props?.size === 0) delete w.props;
    if (w.style)
      for (const k of [...w.style.keys()]) if (b.style[k] === a.style[k]) w.style.delete(k);
    if (w.style?.size === 0) delete w.style;
    if (w.visible !== undefined && b.visible === a.visible) delete w.visible;
    if (w.place && b.layer === a.layer && b.group === a.group)
      w.place = { ...w.place, orderOnly: true };
  }
}

/** What writing back the values of `rec` onto the document `now` gives, as the declaration says */
function predict(rec: Rec, now: Snap, except: ReadonlySet<string>): { exp: Snap; rec: Rec } {
  const exp = cloneSnap(now);
  const fp = new Map<string, FP>();
  const groups = emptyGroups();
  // The groups
  for (const id of rec.groups.created) {
    const g = exp.g.get(id);
    if (!g) continue;
    groups.deleted.push({ ...g });
    exp.g.delete(id);
    for (const f of exp.f.values()) {
      if (f.group !== id) continue;
      // The features put into it since stay in its layer, as `groups.delete` leaves them
      if (!rec.fp.get(f.id)?.place) fp.set(f.id, { place: { layer: f.layer, group: id } });
      f.group = null;
      f.layer = g.layer;
    }
  }
  for (const g of rec.groups.deleted) {
    if (exp.g.has(g.id)) continue;
    exp.g.set(g.id, { ...g });
    groups.created.push(g.id);
  }
  for (const m of rec.groups.moved) {
    const g = exp.g.get(m.id);
    if (!g) continue;
    groups.moved.push({ id: m.id, layer: g.layer });
    g.layer = m.layer;
    for (const f of exp.f.values()) if (f.group === m.id) f.layer = m.layer;
  }
  for (const r of rec.groups.renamed) {
    const g = exp.g.get(r.id);
    if (!g) continue;
    groups.renamed.push({ id: r.id, name: g.name });
    g.name = r.name;
  }
  // The features
  for (const [id, change] of rec.fp) {
    const cur = exp.f.get(id);
    if (change.created) {
      if (cur) {
        exp.f.delete(id);
        fp.set(id, { deleted: cloneF(now.f.get(id) as SF) });
      }
      continue;
    }
    if (change.deleted) {
      // One that is there again already is left as it is
      if (cur) continue;
      const back = cloneF(change.deleted);
      if (back.group !== null && !exp.g.has(back.group)) back.group = null;
      if (back.group !== null) back.layer = (exp.g.get(back.group) as SG).layer;
      exp.f.set(id, back);
      fp.set(id, { created: true });
      continue;
    }
    // A feature the change wrote that is deleted now stays deleted
    if (!cur) continue;
    const orig = now.f.get(id) as SF;
    const own: FP = {};
    if (change.props) {
      for (const [k, v] of change.props) {
        if (except.has(k)) continue;
        own.props ??= new Map();
        own.props.set(k, orig.props[k]);
        if (v === undefined) delete cur.props[k];
        else cur.props[k] = v;
      }
    }
    if (change.style) {
      own.style = new Map();
      for (const [k, v] of change.style) {
        own.style.set(k, orig.style[k]);
        if (v === undefined) delete cur.style[k];
        else cur.style[k] = v;
      }
    }
    if (change.visible !== undefined) {
      own.visible = orig.visible;
      cur.visible = change.visible;
    }
    if (change.place?.orderOnly) {
      // Only the position was written: the feature stays in its layer or group
      own.place = { layer: orig.layer, group: orig.group, orderOnly: true };
    } else if (change.place) {
      own.place = { layer: orig.layer, group: orig.group };
      const { layer, group } = change.place;
      if (group !== null && exp.g.has(group)) {
        cur.group = group;
        cur.layer = (exp.g.get(group) as SG).layer;
      } else {
        cur.group = null;
        cur.layer = layer;
      }
    }
    if (change.geo) {
      const before = copyCoords(cur.coords);
      const geo = change.geo;
      if (geo.kind === 'whole') {
        cur.coords = copyCoords(geo.before);
        own.geo = { kind: 'whole', before };
      } else {
        const coords = copyCoords(cur.coords);
        for (const m of geo.moved) {
          if (m.idx !== null && m.idx < coords.length) coords[m.idx] = m.before;
        }
        // The vertices it added go; those it deleted come back before the vertex that was after
        // them (at the end for the last one; not at all when that vertex is gone)
        const items = coords.map((pos, i) => ({ pos, at: i, gone: false }));
        for (const i of geo.added) if (i !== null && items[i]) items[i].gone = true;
        const out = [...items];
        for (const d of geo.deleted) {
          if (d.anchor === null) continue;
          const item = { pos: d.pos, at: -1, gone: false };
          const at = d.anchor === 'end' ? -1 : out.findIndex((x) => x.at === d.anchor);
          if (at < 0) out.push(item);
          else out.splice(at, 0, item);
        }
        cur.coords = out.filter((x) => !x.gone).map((x) => x.pos);
        own.geo = vertexDiff(before, cur.coords);
      }
    }
    fp.set(id, own);
  }
  return { exp, rec: { label: '', values: [], fp, groups, tainted: false } };
}

/** A field of the document that differs from the model */
interface Mismatch {
  id: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

const sortedEntries = (o: Record<string, unknown>): string =>
  JSON.stringify(
    Object.entries(o)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );

/** The fields of the document that differ from the model */
function compare(exp: Snap, act: Snap): Mismatch[] {
  const out: Mismatch[] = [];
  for (const id of new Set([...exp.f.keys(), ...act.f.keys()])) {
    const e = exp.f.get(id);
    const a = act.f.get(id);
    if (!e || !a) {
      if (!!e !== !!a) out.push({ id, field: 'exists', expected: !!e, actual: !!a });
      continue;
    }
    const check = (field: string, ok: boolean, ev: unknown, av: unknown): void => {
      if (!ok) out.push({ id, field, expected: ev, actual: av });
    };
    check('props', sortedEntries(e.props) === sortedEntries(a.props), e.props, a.props);
    check('style', sortedEntries(e.style) === sortedEntries(a.style), e.style, a.style);
    check('visible', e.visible === a.visible, e.visible, a.visible);
    check(
      'place',
      e.layer === a.layer && e.group === a.group,
      [e.layer, e.group],
      [a.layer, a.group],
    );
    check(
      'geometry',
      e.coords.length === a.coords.length && e.coords.every((q, i) => nearPos(q, a.coords[i])),
      e.coords,
      a.coords,
    );
  }
  for (const id of new Set([...exp.g.keys(), ...act.g.keys()])) {
    const e = exp.g.get(id);
    const a = act.g.get(id);
    if (!e || !a) {
      if (!!e !== !!a) out.push({ id, field: 'group exists', expected: !!e, actual: !!a });
    } else if (e.name !== a.name || e.layer !== a.layer) {
      out.push({ id, field: 'group', expected: [e.name, e.layer], actual: [a.name, a.layer] });
    }
  }
  return out;
}

/** The containers whose items of `keep` are in another order after than before */
function orderMoved(before: Snap, after: Snap, keep: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const [container, list] of before.order) {
    const now = after.order.get(container);
    if (!now) continue;
    const a = list.filter((id) => keep.has(id) && now.includes(id));
    const b = now.filter((id) => keep.has(id) && list.includes(id));
    if (a.join(',') !== b.join(',')) out.push(`${container}: ${a.join(',')} -> ${b.join(',')}`);
  }
  return out;
}

// ============================================================================
// The lists of edits
// ============================================================================

const PKEYS = ['k1', 'k2', 'k3'];
const SKEYS = ['pointColor', 'strokeColor', 'strokeWidth'];

/** A seeded random number generator (mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What did not follow the model in one list */
interface Finding {
  seed: number;
  edits: string[];
  kind: string;
  detail: unknown;
}

/** What one list wrote back, compared and found */
interface SweepResult {
  restores: number;
  compared: number;
  findings: Finding[];
}

/** The patches an edit gives (written loosely: the edits are made at random) */
type Patch = {
  properties?: Record<string, unknown>;
  style?: Record<string, unknown>;
  visible?: boolean;
  geometry?: { type: string; coordinates: unknown };
};

/** The model of a feature read from the instance */
function featureOf(x: Feature): SF {
  const g = x.geometry as { type: string; coordinates: number[] | number[][] };
  const coords: Pos[] =
    g.type === 'Point'
      ? [[(g.coordinates as number[])[0], (g.coordinates as number[])[1]]]
      : (g.coordinates as number[][]).map((q) => [q[0], q[1]] as Pos);
  return {
    id: x.id,
    type: g.type,
    coords,
    layer: x.layerId,
    group: x.groupId ?? null,
    props: { ...x.properties },
    style: { ...(x.style as Record<string, unknown>) },
    visible: x.visible,
  };
}

/** Runs one list of edits and writings back, comparing the document with the model */
async function sweep(seed: number): Promise<SweepResult> {
  const r = rng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)];
  const draw: Draw = createDraw(createMapStub().map, { store: createStore() });
  const changes: DocumentChange[] = [];
  draw.document.subscribe((c) => changes.push(c), { previousValues: true });
  const result: SweepResult = { restores: 0, compared: 0, findings: [] };
  const edits: string[] = [];
  const found = (kind: string, detail: unknown): void => {
    result.findings.push({ seed, edits: [...edits], kind, detail });
  };
  let idn = 0;
  const L1 = draw.layers.list()[0].id;
  const L2 = draw.layers.create({ name: 'second' })?.id as string;
  const layers = [L1, L2];
  const coordOf = (): number => Math.round(r() * 1000) / 1000;
  const newFeature = (layer: string) => {
    const id = `f${idn++}`;
    const line = r() < 0.5;
    const n = 3 + Math.floor(r() * 3);
    const coords: Pos[] = line
      ? Array.from({ length: n }, (_, i) => [i + coordOf(), coordOf()] as Pos)
      : [[coordOf(), coordOf()]];
    const properties: Record<string, unknown> = {};
    for (const k of PKEYS) if (r() < 0.6) properties[k] = Math.floor(r() * 100);
    const style: Record<string, unknown> = {};
    if (r() < 0.5) style.pointColor = '#000000';
    return {
      id,
      type: line ? 'LineString' : 'Point',
      geometry: line
        ? { type: 'LineString', coordinates: coords }
        : { type: 'Point', coordinates: coords[0] },
      layerId: layer,
      properties,
      style,
    };
  };
  const count = 4 + Math.floor(r() * 9);
  for (let i = 0; i < count; i++) draw.features.create(newFeature(pick(layers)) as never);

  const snap = (): Snap => {
    const f = new Map<string, SF>();
    for (const x of draw.features.list()) f.set(x.id, featureOf(x));
    const g = new Map<string, SG>();
    for (const x of draw.groups.list()) g.set(x.id, { id: x.id, name: x.name, layer: x.layerId });
    const order = new Map<string, string[]>();
    for (const l of draw.layers.list()) {
      order.set(l.id, draw.layers.listItemIds(l.id, { start: 0, end: 1000 }));
    }
    for (const id of g.keys())
      order.set(id, draw.groups.listFeatureIds(id, { start: 0, end: 1000 }));
    return { f, g, order };
  };

  const valuesSince = (mark: number, source: string): FeatureValues[] =>
    changes
      .slice(mark)
      .filter((c) => c.source === source)
      .flatMap((c) => (c.previousValues ? [c.previousValues] : []));

  /** Runs an edit and records what it wrote: the footprint the model says it writes */
  const run = async (
    label: string,
    source: string,
    body: () => unknown,
    footprint: (before: Snap, after: Snap) => { fp: Map<string, FP>; groups: GroupFP },
  ): Promise<Rec | null> => {
    const before = snap();
    const mark = changes.length;
    try {
      const out = source === 'local' ? body() : draw.transact(body, { source });
      if (out instanceof Promise) await out;
    } catch (error) {
      edits.push(`${label} (threw ${(error as { code?: string }).code ?? error})`);
      return null;
    }
    edits.push(label);
    const after = snap();
    const { fp, groups } = footprint(before, after);
    // The groups the edit deleted or created along (a group left empty goes)
    for (const [id, g] of before.g) {
      if (!after.g.has(id) && !groups.deleted.some((x) => x.id === id))
        groups.deleted.push({ ...g });
    }
    for (const id of after.g.keys()) {
      if (!before.g.has(id) && !groups.created.includes(id)) groups.created.push(id);
    }
    // The fields the model says the edit did not write did not change
    for (const id of new Set([...before.f.keys(), ...after.f.keys()])) {
      const b = before.f.get(id);
      const a = after.f.get(id);
      const w = fp.get(id);
      if (!b || !a) {
        if (!w?.created && !w?.deleted) found('the edit: exists', { id });
        continue;
      }
      const one = (f: SF): Snap => ({ f: new Map([[id, f]]), g: new Map(), order: new Map() });
      for (const d of compare(one(b), one(a))) {
        const inGroups =
          groups.moved.some((m) => m.id === b.group || m.id === a.group) ||
          groups.deleted.some((x) => x.id === b.group) ||
          groups.created.includes(a.group ?? '');
        const written =
          (d.field === 'props' && w?.props) ||
          (d.field === 'style' && w?.style) ||
          (d.field === 'visible' && w?.visible !== undefined) ||
          (d.field === 'place' && (w?.place || inGroups)) ||
          (d.field === 'geometry' && w?.geo);
        if (!written) found(`the edit: ${d.field}`, d);
      }
    }
    settle(fp, before, after);
    return { label, values: valuesSince(mark, source), fp, groups, tainted: false };
  };

  const patchFP = (before: Snap, after: Snap, patches: ReadonlyMap<string, Patch>) => {
    const fp = new Map<string, FP>();
    for (const [id, patch] of patches) {
      const b = before.f.get(id);
      const a = after.f.get(id);
      if (!b || !a) continue;
      const w: FP = {};
      if (patch.properties) {
        w.props = new Map(Object.keys(patch.properties).map((k) => [k, b.props[k]]));
      }
      if (patch.style) w.style = new Map(Object.keys(patch.style).map((k) => [k, b.style[k]]));
      if (patch.visible !== undefined) w.visible = b.visible;
      // The same type, parts and rings: compared vertex by vertex
      if (patch.geometry) w.geo = vertexDiff(b.coords, a.coords);
      fp.set(id, w);
    }
    return { fp, groups: emptyGroups() };
  };
  const wholeFP = (before: Snap, ids: readonly string[]) => {
    const fp = new Map<string, FP>();
    for (const id of ids) {
      const b = before.f.get(id);
      if (b) fp.set(id, { geo: { kind: 'whole', before: b.coords } });
    }
    return { fp, groups: emptyGroups() };
  };
  const deletedFP = (before: Snap, ids: readonly string[]) => {
    const fp = new Map<string, FP>();
    for (const id of ids) {
      const b = before.f.get(id);
      if (b) fp.set(id, { deleted: cloneF(b) });
    }
    return { fp, groups: emptyGroups() };
  };
  const createdFP = (before: Snap, after: Snap) => {
    const fp = new Map<string, FP>();
    for (const id of after.f.keys()) if (!before.f.has(id)) fp.set(id, { created: true });
    return { fp, groups: emptyGroups() };
  };
  const placeFP = (before: Snap, ids: readonly string[]) => {
    const fp = new Map<string, FP>();
    for (const id of ids) {
      const b = before.f.get(id);
      if (b) fp.set(id, { place: { layer: b.layer, group: b.group } });
    }
    return fp;
  };

  const randomGeometry = (f: SF, step: number): Patch['geometry'] => {
    const coords = copyCoords(f.coords);
    const op = f.type === 'Point' ? 'move' : pick(['move', 'move', 'add', 'delete']);
    const i = Math.floor(r() * coords.length);
    if (op === 'move') coords[i] = [coords[i][0] + step + coordOf(), coords[i][1] + 0.25];
    if (op === 'add') coords.splice(i, 0, [coords[i][0] - 0.5, coords[i][1] + 0.5 + coordOf()]);
    if (op === 'delete' && coords.length > 2) coords.splice(i, 1);
    return f.type === 'Point'
      ? { type: 'Point', coordinates: coords[0] }
      : { type: 'LineString', coordinates: coords };
  };
  const randomPatch = (f: SF, allowGeometry: boolean): Patch => {
    const patch: Patch = {};
    const what = Math.floor(r() * 5);
    if (what === 0 || r() < 0.3) {
      const properties: Record<string, unknown> = {};
      properties[pick(PKEYS)] = r() < 0.15 ? undefined : Math.floor(r() * 1000);
      if (r() < 0.3) properties[pick(PKEYS)] = Math.floor(r() * 1000);
      patch.properties = properties;
    }
    if (what === 1 || r() < 0.2) {
      const key = pick(SKEYS);
      const value =
        key === 'strokeWidth'
          ? 2 + Math.floor(r() * 5)
          : `#${Math.floor(r() * 0xffffff)
              .toString(16)
              .padStart(6, '0')}`;
      patch.style = { [key]: r() < 0.1 ? undefined : value };
    }
    if (what === 2) patch.visible = !f.visible;
    if ((what === 3 || what === 4) && allowGeometry) patch.geometry = randomGeometry(f, 0.25);
    if (Object.keys(patch).length === 0)
      patch.properties = { [pick(PKEYS)]: Math.floor(r() * 1000) };
    return patch;
  };

  let lastLocal: Rec | null = null;

  /** An edit of this client or of the client elsewhere */
  const edit = async (source: string, elsewhere: boolean): Promise<Rec | null> => {
    const s = snap();
    const ids = [...s.f.keys()];
    if (ids.length === 0) {
      const input = newFeature(pick(layers));
      return run(
        `${source} create ${input.id}`,
        source,
        () => draw.features.create(input as never),
        createdFP,
      );
    }
    // The client elsewhere mostly edits the features the last edit of this client wrote
    const focus =
      elsewhere && lastLocal ? [...lastLocal.fp.keys()].filter((id) => s.f.has(id)) : [];
    if (focus.length > 0 && r() < 0.7) ids.splice(0, ids.length, ...focus);
    const kinds = elsewhere
      ? ['update', 'update', 'update', 'vertex', 'move', 'delete', 'groupName', 'translate']
      : [
          'update',
          'update',
          'transact',
          'transact',
          'updateAll',
          'translate',
          'rotate',
          'deleteMany',
          'delete',
          'duplicate',
          'move',
          'groupCreate',
          'groupDelete',
          'groupName',
          'groupMove',
          'vertex',
          'create',
        ];
    const kind = pick(kinds);
    const some = (): string[] =>
      ids
        .filter(() => r() < 0.5)
        .slice(0, 4)
        .concat(pick(ids))
        .filter((x, i, a) => a.indexOf(x) === i);
    switch (kind) {
      case 'update':
      case 'vertex': {
        const id = pick(ids);
        const f = s.f.get(id) as SF;
        const patch: Patch =
          kind === 'vertex' ? { geometry: randomGeometry(f, 0.3) } : randomPatch(f, true);
        return run(
          `${source} update ${id} ${JSON.stringify(patch)}`,
          source,
          () => draw.features.update(id, patch as never),
          (b, a) => patchFP(b, a, new Map([[id, patch]])),
        );
      }
      case 'transact': {
        // Writes of several kinds to several features: an update, a deletion or a move each
        const targets = some().slice(0, 3);
        const actions = new Map<string, Patch | { delete: true } | { move: object }>(
          targets.map((id) => {
            const c = r();
            if (c < 0.2 && targets.length > 1) return [id, { delete: true as const }];
            if (c < 0.35)
              return [id, { move: { layerId: pick(layers), index: Math.floor(r() * 4) } }];
            return [id, randomPatch(s.f.get(id) as SF, true)];
          }),
        );
        return run(
          `${source} transact ${JSON.stringify([...actions])}`,
          source,
          () =>
            draw.transact(() => {
              for (const [id, p] of actions) {
                if ('delete' in p) draw.features.delete(id);
                else if ('move' in p) draw.features.move(id, p.move as never);
                else draw.features.update(id, p as never);
              }
            }),
          (b, a) => {
            const patches = new Map<string, Patch>();
            for (const [id, p] of actions)
              if (!('delete' in p) && !('move' in p)) patches.set(id, p);
            const out = patchFP(b, a, patches);
            for (const [id, p] of actions) {
              const f = b.f.get(id) as SF;
              if ('delete' in p) out.fp.set(id, { deleted: cloneF(f) });
              if ('move' in p) out.fp.set(id, { place: { layer: f.layer, group: f.group } });
            }
            return out;
          },
        );
      }
      case 'updateAll': {
        const targets = some();
        const patch = randomPatch(s.f.get(targets[0]) as SF, false);
        delete patch.visible;
        return run(
          `${source} updateAll ${targets} ${JSON.stringify(patch)}`,
          source,
          () => draw.features.updateAll(targets, patch as never),
          (b, a) => patchFP(b, a, new Map(targets.map((id) => [id, patch]))),
        );
      }
      case 'translate': {
        const targets = some();
        const t = { from: [0, 0], to: [0.1 + coordOf(), 0.1] };
        return run(
          `${source} translate ${targets} ${JSON.stringify(t)}`,
          source,
          () => draw.features.translate(targets, t as never),
          (b) => wholeFP(b, targets),
        );
      }
      case 'rotate': {
        const targets = some();
        const rot = {
          center: [coordOf(), coordOf()],
          counterclockwiseDegrees: 10 + Math.floor(r() * 90),
        };
        return run(
          `${source} rotate ${targets} ${JSON.stringify(rot)}`,
          source,
          () => draw.features.rotate(targets, rot as never),
          (b) => wholeFP(b, targets),
        );
      }
      case 'deleteMany': {
        const targets = some();
        return run(
          `${source} deleteMany ${targets}`,
          source,
          () => draw.features.deleteMany(targets),
          (b) => deletedFP(b, targets),
        );
      }
      case 'delete': {
        const id = pick(ids);
        return run(
          `${source} delete ${id}`,
          source,
          () => draw.features.delete(id),
          (b) => deletedFP(b, [id]),
        );
      }
      case 'duplicate': {
        const targets = some();
        return run(
          `${source} duplicate ${targets}`,
          source,
          () => draw.features.duplicate(targets, { offset: { from: [0, 0], to: [0.5, 0] } }),
          createdFP,
        );
      }
      case 'move': {
        const id = pick(ids);
        const f = s.f.get(id) as SF;
        const groupIds = [...s.g.keys()];
        let to: object;
        const c = r();
        if (c < 0.4) {
          to = {
            layerId: pick(layers.filter((l) => l !== f.layer).concat(f.layer)),
            index: Math.floor(r() * 4),
          };
        } else if (c < 0.7 && groupIds.length > 0) {
          to = { groupId: pick(groupIds), index: Math.floor(r() * 3) };
        } else {
          to = { groupId: null };
        }
        return run(
          `${source} move ${id} ${JSON.stringify(to)}`,
          source,
          () => draw.features.move(id, to as never),
          (b) => ({ fp: placeFP(b, [id]), groups: emptyGroups() }),
        );
      }
      case 'groupCreate': {
        const layer = pick(layers);
        const members = ids
          .filter((id) => s.f.get(id)?.layer === layer && s.f.get(id)?.group === null)
          .slice(0, 3);
        if (members.length === 0) return null;
        const gid = `g${idn++}`;
        return run(
          `${source} group ${gid} of ${members}`,
          source,
          () => draw.groups.create({ id: gid, featureIds: members }),
          (b) => ({ fp: placeFP(b, members), groups: { ...emptyGroups(), created: [gid] } }),
        );
      }
      case 'groupDelete': {
        const gid = [...s.g.keys()][0];
        if (!gid) return null;
        const members = ids.filter((id) => s.f.get(id)?.group === gid);
        return run(
          `${source} take apart ${gid}`,
          source,
          () => draw.groups.delete(gid),
          (b) => ({
            fp: placeFP(b, members),
            groups: { ...emptyGroups(), deleted: [{ ...(b.g.get(gid) as SG) }] },
          }),
        );
      }
      case 'groupName': {
        const gid = [...s.g.keys()][0];
        if (!gid) return null;
        const name = `n${Math.floor(r() * 1000)}`;
        return run(
          `${source} rename ${gid} ${name}`,
          source,
          () => draw.groups.update(gid, { name }),
          (b) => ({
            fp: new Map(),
            groups: { ...emptyGroups(), renamed: [{ id: gid, name: (b.g.get(gid) as SG).name }] },
          }),
        );
      }
      case 'groupMove': {
        const gid = [...s.g.keys()][0];
        if (!gid) return null;
        const g = s.g.get(gid) as SG;
        const layer = layers.find((l) => l !== g.layer) as string;
        return run(
          `${source} move group ${gid} to ${layer}`,
          source,
          () => draw.groups.move(gid, { layerId: layer }),
          () => ({
            fp: new Map(),
            groups: { ...emptyGroups(), moved: [{ id: gid, layer: g.layer }] },
          }),
        );
      }
      default: {
        const input = newFeature(pick(layers));
        return run(
          `${source} create ${input.id}`,
          source,
          () => draw.features.create(input as never),
          createdFP,
        );
      }
    }
  };

  /** Writes a record back and compares the document with the model */
  const writeBack = async (rec: Rec, source: string, except?: string[]): Promise<Rec | null> => {
    const before = snap();
    const p = predict(rec, before, new Set(except ?? []));
    const mark = changes.length;
    const label = `${source} restore of [${rec.label}]${except ? ` except ${except}` : ''}`;
    let counts: unknown;
    try {
      counts = await draw.features.restore(rec.values, {
        source,
        ignoreLocks: true,
        ...(except && { exceptProperties: except }),
      });
    } catch (error) {
      edits.push(`${label} (threw ${(error as { code?: string }).code ?? error})`);
      found('threw', String(error));
      return null;
    }
    edits.push(label);
    result.restores += 1;
    const after = snap();
    p.rec.values = valuesSince(mark, source);
    p.rec.label = label;
    settle(p.rec.fp, before, after);
    if (rec.tainted) {
      p.rec.tainted = true;
      return p.rec;
    }
    result.compared += 1;
    const diff = compare(p.exp, after);
    // The order of the features the writing back did not place
    const placed = new Set<string>();
    for (const [id, w] of rec.fp) if (w.place || w.created || w.deleted) placed.add(id);
    for (const g of rec.groups.created) placed.add(g);
    for (const g of [...rec.groups.deleted, ...rec.groups.moved]) placed.add(g.id);
    const keep = new Set([...before.f.keys()].filter((id) => !placed.has(id)));
    const moved = orderMoved(before, after, keep);
    if (counts === null) found('refused', null);
    for (const d of diff) found(d.field, d);
    for (const m of moved) found('order', m);
    if (diff.length > 0 || moved.length > 0) p.rec.tainted = true;
    return p.rec;
  };

  // The edits of this client, those written back, and those of the client elsewhere
  const done: Rec[] = [];
  const back: Rec[] = [];
  const elsewhereDone: Rec[] = [];
  const steps = 4 + Math.floor(r() * (MAX_STEPS - 3));
  for (let step = 0; step < steps; step++) {
    const c = r();
    if (c < 0.38) {
      const rec = await edit('local', false);
      if (rec) {
        lastLocal = rec;
        done.push(rec);
        back.length = 0;
      }
    } else if (c < 0.62) {
      const rec = await edit('elsewhere', true);
      if (rec) elsewhereDone.push(rec);
    } else if (c < 0.8 && done.length > 0) {
      const except = r() < 0.25 ? [pick(PKEYS)] : undefined;
      const rec = await writeBack(done.pop() as Rec, 'back', except);
      if (rec) back.push(rec);
    } else if (c < 0.93 && back.length > 0) {
      const rec = await writeBack(back.pop() as Rec, 'again');
      if (rec) done.push(rec);
    } else if (elsewhereDone.length > 0) {
      await writeBack(elsewhereDone.pop() as Rec, 'elsewhere-back');
    }
    const now = snap();
    for (const x of [...done, ...back, ...elsewhereDone]) followAll(x, now);
  }
  draw.destroy();
  return result;
}

describe('the writing back against the model of its declaration', () => {
  it(`follows the model over the lists of the seeds ${SEED_FROM} to ${SEED_TO}`, async () => {
    const findings: Finding[] = [];
    let restores = 0;
    let compared = 0;
    for (let seed = SEED_FROM; seed <= SEED_TO; seed++) {
      const one = await sweep(seed);
      findings.push(...one.findings);
      restores += one.restores;
      compared += one.compared;
    }
    // Every writing back was compared, and none differs
    expect(compared).toBe(restores);
    expect(restores).toBeGreaterThan(SEED_TO - SEED_FROM);
    expect(findings.slice(0, 3)).toEqual([]);
  }, 600_000);
});
