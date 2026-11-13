// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for a draw instance with only the members the interface uses, and the map's
// container and canvas.
//
// It writes as core does: `draw.write(fn)` gives `fn` a transaction whose writes are checked when
// they are called and kept, and commits them at once after `fn` ends, in a later microtask, then
// tells `change`. A write that fails fails the whole transaction (nothing is committed), and a
// write core refuses rejects with `DrawError` (`notEditable` while read-only, `locked` for a
// locked feature). The writes of the transaction are mocks (`fake.tx`) to assert on, and
// `fake.settle()` waits for the commits and what the interface does after them.

import type {
  DatasetOrder,
  Draw,
  Feature,
  FeatureGeometry,
  FeatureStyle,
  FeatureStyleResolved,
  FeatureType,
  Layer,
  Mode,
  ObjectGroup,
  ObjectLayer,
  Placement,
  RuntimeOptions,
  SelectionType,
  SelectionValue,
  StyleRule,
} from '@sakuzu/maplibre-gl-draw';
import { DrawError } from '@sakuzu/maplibre-gl-draw';
import { flushSync } from 'svelte';
import { vi } from 'vitest';

/** The value of a selection as `draw.selection.value` gives it (no layers nor extent here) */
export function selectionValue(type: SelectionType | null, ids: readonly string[]): SelectionValue {
  return { type: type ?? 'feature', count: ids.length, ids: [...ids], layerIds: [], bbox: null };
}

type Listener = (payload: unknown) => void;

/** The options with a patch merged in: plain objects key by key, other values replaced */
function mergeOptions<T extends object>(base: T, patch: Partial<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    const before = out[key];
    const nested = (v: unknown): v is object =>
      typeof v === 'object' && v !== null && !Array.isArray(v);
    out[key] = nested(value) && nested(before) ? mergeOptions(before, value) : value;
  }
  return out as T;
}

// ============================================================================
// Features
// ============================================================================

const KEY = {
  layerId: 'maplibre-gl-draw:layerId',
  groupId: 'maplibre-gl-draw:groupId',
  featureType: 'maplibre-gl-draw:featureType',
  style: 'maplibre-gl-draw:style',
  visible: 'maplibre-gl-draw:visible',
  locked: 'maplibre-gl-draw:locked',
} as const;

/** The keys of the place of a feature, which a patch does not change */
const PLACE_KEYS: ReadonlySet<string> = new Set([KEY.layerId, KEY.groupId, KEY.featureType]);

/**
 * A feature of the stand-in by the short names of `readFeature`: what goes under the keys of the
 * library, a default left out
 */
export interface FakeFeatureSpec {
  id: string;
  /** The type it is drawn as */
  type: FeatureType;
  /** The geometry; one of the type when left out */
  geometry?: FeatureGeometry;
  /** `l1` when left out */
  layerId?: string;
  groupId?: string;
  /** The attributes of the user and the other values of the library */
  properties?: Record<string, unknown>;
  style?: FeatureStyle;
  /** True when left out */
  visible?: boolean;
  /** False when left out */
  locked?: boolean;
}

/** A geometry of the type: a point, a line or an area at the origin */
function geometryOf(type: FeatureType): FeatureGeometry {
  const ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ];
  switch (type) {
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: [[0, 0]] };
    case 'LineString':
    case 'Freehand':
      return {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 0],
        ],
      };
    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 0],
          ],
        ],
      };
    case 'Polygon':
      return { type: 'Polygon', coordinates: [ring] };
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: [[ring]] };
    default:
      return { type: 'Point', coordinates: [0, 0] };
  }
}

/**
 * A feature of the stand-in, in the one shape of core: a GeoJSON Feature, with the values of the
 * library under their keys and no key for a default (core always gives the layer)
 */
export function makeFeature(spec: FakeFeatureSpec): Feature {
  const geometry = spec.geometry ?? geometryOf(spec.type);
  const properties: Record<string, unknown> = { ...(spec.properties ?? {}) };
  properties[KEY.layerId] = spec.layerId ?? 'l1';
  if (spec.groupId !== undefined) properties[KEY.groupId] = spec.groupId;
  if (spec.type !== geometry.type) properties[KEY.featureType] = spec.type;
  if (spec.style && Object.keys(spec.style).length > 0) properties[KEY.style] = { ...spec.style };
  if (spec.visible === false) properties[KEY.visible] = false;
  if (spec.locked === true) properties[KEY.locked] = true;
  return { type: 'Feature', id: spec.id, geometry, properties } as Feature;
}

/** A feature of a fake document */
export function feature(
  id: string,
  layerId: string,
  type: FeatureType = 'Point',
  extra: Omit<Partial<FakeFeatureSpec>, 'id' | 'layerId' | 'type'> = {},
): Feature {
  return makeFeature({ ...extra, id, layerId, type });
}

/** The layer, the group and the lock of a feature, read from its keys */
function fieldsOf(f: Feature) {
  const p = f.properties as Record<string, unknown>;
  return {
    layerId: p[KEY.layerId] as string,
    groupId: p[KEY.groupId] as string | undefined,
    locked: p[KEY.locked] === true,
    style: (p[KEY.style] ?? {}) as FeatureStyle,
  };
}

/** A feature with the keys of its place set to another layer and group */
function placedFeature(f: Feature, layerId: string, groupId: string | undefined): Feature {
  const properties: Record<string, unknown> = { ...f.properties, [KEY.layerId]: layerId };
  if (groupId === undefined) delete properties[KEY.groupId];
  else properties[KEY.groupId] = groupId;
  return { ...f, properties } as Feature;
}

const invalid = (message: string) => new DrawError('invalidInput', message);

/**
 * A feature with a patch of core applied: `properties` merged key by key (the style under its key
 * too), then the keys of `unset` removed, and the keys of the defaults dropped as core reads them
 *
 * @throws DrawError `invalidInput` for an empty patch, a key given `undefined` or a key of the place
 */
function patched(f: Feature, patch: unknown): Feature {
  const p = patch as {
    geometry?: FeatureGeometry;
    properties?: Record<string, unknown>;
    unset?: { properties?: readonly string[]; style?: readonly string[] };
  };
  if (typeof p !== 'object' || p === null || Object.keys(p).length === 0) {
    throw invalid('An empty patch');
  }
  for (const [key, value] of Object.entries(p)) {
    if (value === undefined) throw invalid(`${key} is given undefined`);
  }
  const properties: Record<string, unknown> = { ...f.properties };
  for (const [key, value] of Object.entries(p.properties ?? {})) {
    if (value === undefined) throw invalid(`${key} is given undefined: name it in unset`);
    if (PLACE_KEYS.has(key)) throw invalid(`${key} is changed with place`);
    if (key === KEY.style) {
      const style = { ...((properties[KEY.style] as object | undefined) ?? {}) } as Record<
        string,
        unknown
      >;
      for (const [k, v] of Object.entries(value as object)) {
        if (v === undefined) throw invalid(`style.${k} is given undefined: name it in unset`);
        style[k] = v;
      }
      properties[KEY.style] = style;
    } else properties[key] = value;
  }
  for (const key of p.unset?.properties ?? []) delete properties[key];
  if (p.unset?.style && properties[KEY.style]) {
    const style = { ...(properties[KEY.style] as Record<string, unknown>) };
    for (const key of p.unset.style) delete style[key];
    properties[KEY.style] = style;
  }
  if (properties[KEY.style] && Object.keys(properties[KEY.style] as object).length === 0) {
    delete properties[KEY.style];
  }
  if (properties[KEY.visible] === true) delete properties[KEY.visible];
  if (properties[KEY.locked] === false) delete properties[KEY.locked];
  return { ...f, geometry: p.geometry ?? f.geometry, properties } as Feature;
}

/** Whether a patch only shows, hides, locks or unlocks: what a locked feature takes */
function onlyLockOrVisibility(patch: unknown): boolean {
  const p = patch as { properties?: object; geometry?: unknown; unset?: unknown };
  if (p.geometry !== undefined || p.unset !== undefined) return false;
  return Object.keys(p.properties ?? {}).every((k) => k === KEY.visible || k === KEY.locked);
}

// ============================================================================
// The document and its datasets
// ============================================================================

/** A document for the stand-in: the layers from the back, and their groups and features */
export interface FakeDocument {
  layers: ObjectLayer[];
  groups?: ObjectGroup[];
  features?: Feature[];
  /** The active layer; the front one when left out */
  active?: string;
  /** The datasets on the map, from the back */
  datasets?: FakeDatasetSpec[];
  /**
   * The stacking order from the back, with the IDs of the `layerOrder` datasets placed among the
   * layers; the layers in their order when left out
   */
  order?: string[];
}

/** A dataset of the stand-in */
export interface FakeDatasetSpec {
  id: string;
  /** `layerOrder` when left out */
  order?: DatasetOrder;
  /** The number of its rows; 0 when left out */
  rows?: number;
  /** True when left out */
  visible?: boolean;
  /** Its style rule; none when left out */
  styleRule?: StyleRule;
  /** The type of every row; `Polygon` when left out */
  rowType?: string;
}

/** A dataset of the stand-in: the members the interface reads, and its events */
function fakeDataset(spec: FakeDatasetSpec) {
  let visible = spec.visible ?? true;
  let rows = spec.rows ?? 0;
  let styleRule = spec.styleRule;
  const rowType = spec.rowType ?? 'Polygon';
  const listeners = new Set<(payload: { reason: string }) => void>();
  const emit = (reason: string) => {
    for (const listener of [...listeners]) listener({ reason });
  };
  return {
    id: spec.id,
    order: spec.order ?? ('layerOrder' as DatasetOrder),
    interactive: true,
    get visible() {
      return visible;
    },
    setVisible: vi.fn((next: boolean) => {
      if (next === visible) return;
      visible = next;
      emit('visibility');
    }),
    getThinningStats: () => ({
      enabled: false,
      active: false,
      total: rows,
      visible: rows,
      band: null,
    }),
    listRows: () => Array.from({ length: rows }, () => ({}) as never),
    getRowType: vi.fn((index: number) => (index >= 0 && index < rows ? rowType : null)),
    getStyleRule: () => styleRule,
    setStyleRule: vi.fn((rule: StyleRule | undefined) => {
      styleRule = rule;
      emit('style');
    }),
    /** Changes the number of its rows, as `setRows` would */
    setRowCount(next: number) {
      rows = next;
      emit('rows');
    },
    on: vi.fn((event: string, listener: (payload: { reason: string }) => void) => {
      if (event !== 'changed') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    off: vi.fn((_event: string, listener: (payload: { reason: string }) => void) => {
      listeners.delete(listener);
    }),
    /** The number of listeners of its events */
    listening: () => listeners.size,
  };
}

/** A dataset of the stand-in, as `fakeDraw(...).datasets` holds them */
export type FakeDataset = ReturnType<typeof fakeDataset>;

/** A layer of a fake document */
export function layer(
  id: string,
  items: string[] = [],
  extra: Partial<ObjectLayer> = {},
): ObjectLayer {
  return {
    id,
    name: `Layer ${id}`,
    visible: true,
    locked: false,
    opacity: 1,
    items,
    styleRule: undefined,
    metadata: undefined,
    ...extra,
  };
}

/** A group of a fake document */
export function group(id: string, layerId: string, featureIds: string[]): ObjectGroup {
  return { id, layerId, name: `Group ${id}`, featureIds, visible: true, locked: false };
}

/** The document the stand-in holds: what the reads read and a commit changes */
interface Doc {
  layers: Map<string, ObjectLayer>;
  groups: Map<string, ObjectGroup>;
  features: Map<string, Feature>;
  /** The stacking order from the back, datasets of `layerOrder` among the layers */
  order: string[];
}

const cloneDoc = (d: Doc): Doc => ({
  layers: new Map(d.layers),
  groups: new Map(d.groups),
  features: new Map(d.features),
  order: [...d.order],
});

/** Takes an item out of every layer and group */
function takeOut(d: Doc, id: string) {
  for (const l of d.layers.values()) {
    if (l.items.includes(id)) d.layers.set(l.id, { ...l, items: l.items.filter((x) => x !== id) });
  }
  for (const g of d.groups.values()) {
    if (g.featureIds.includes(id)) {
      d.groups.set(g.id, { ...g, featureIds: g.featureIds.filter((x) => x !== id) });
    }
  }
}

/** A list with an item put next to its neighbor, or at the front (the end) without one */
function insertAt(list: readonly string[], id: string, to: { below?: string; above?: string }) {
  const out = list.filter((x) => x !== id);
  if (to.below !== undefined) {
    const at = out.indexOf(to.below);
    if (at === -1) throw new DrawError('notFound', `no item ${to.below} there`);
    out.splice(at + 1, 0, id);
  } else if (to.above !== undefined) {
    const at = out.indexOf(to.above);
    if (at === -1) throw new DrawError('notFound', `no item ${to.above} there`);
    out.splice(at, 0, id);
  } else out.push(id);
  return out;
}

/** The layer and the group of a placement: of the neighbor when it names neither */
function placeOf(d: Doc, to: Placement): { layerId: string; groupId: string | undefined } {
  const p = to as { layerId?: string; groupId?: string; below?: string; above?: string };
  if (p.groupId !== undefined) {
    const g = d.groups.get(p.groupId);
    if (!g) throw new DrawError('notFound', `no group ${p.groupId}`);
    return { layerId: g.layerId, groupId: g.id };
  }
  if (p.layerId !== undefined) return { layerId: p.layerId, groupId: undefined };
  const neighbor = (p.below ?? p.above) as string;
  const f = d.features.get(neighbor);
  if (f) return fieldsOf(f);
  const g = d.groups.get(neighbor);
  if (g) return { layerId: g.layerId, groupId: undefined };
  throw new DrawError('notFound', `no item ${neighbor}`);
}

// ============================================================================
// The stand-in
// ============================================================================

export function fakeDraw(
  options: {
    mode?: Mode;
    ids?: string[];
    snapping?: boolean;
    doc?: FakeDocument;
    /** The URL of the map's style */
    styleUrl?: string;
    /** The `name` of the map's style */
    styleName?: string;
    /** Whether the document is read-only; false when left out */
    readOnly?: boolean;
  } = {},
) {
  const listeners = new Map<string, Set<Listener>>();
  let mode: Mode = options.mode ?? 'select';
  let ids: string[] = options.ids ?? [];
  let selType: SelectionType | null = ids.length ? 'feature' : null;
  const given = options.doc ?? { layers: [layer('l1')] };
  let doc: Doc = {
    layers: new Map(given.layers.map((l) => [l.id, l])),
    groups: new Map((given.groups ?? []).map((g) => [g.id, g])),
    features: new Map((given.features ?? []).map((f) => [f.id, f])),
    order: given.order ? [...given.order] : given.layers.map((l) => l.id),
  };
  const datasets: FakeDataset[] = (given.datasets ?? []).map(fakeDataset);
  let active: string | null =
    given.active ?? [...doc.order].reverse().find((id) => doc.layers.has(id)) ?? null;
  const hidden = new Set<string>();
  let readOnly = options.readOnly ?? false;
  let created = 0;
  let commits = 0;
  // The writes not committed yet, and what the interface does after them
  const pending = new Set<Promise<unknown>>();
  // The options: nested as core gives them, every value filled in
  let runtime: RuntimeOptions = {
    snapping: {
      enabled: options.snapping ?? true,
      disableKey: 'alt',
      kinds: { vertex: true, edge: true, intersection: true, guide: true },
      datasets: true,
    },
    tracing: { enabled: true },
    topology: { sharedVertexDrag: false },
  };
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  container.appendChild(canvas);
  document.body.appendChild(container);
  // The map: its container, its canvas, its padding, its controls and its style
  let padding = { top: 10, bottom: 20, left: 30, right: 40 };
  let styleUrl: string | null = options.styleUrl ?? null;
  let styleName: string | undefined = options.styleName;
  const mapListeners = new Map<string, Set<() => void>>();
  const map = {
    getContainer: () => container,
    getCanvas: () => canvas,
    getPadding: () => ({ ...padding }),
    setPadding: vi.fn((next: typeof padding) => {
      padding = { ...next };
    }),
    addControl: vi.fn((_control: unknown, _position?: string) => map),
    removeControl: vi.fn((_control: unknown) => map),
    getStyleUrl: () => styleUrl,
    getStyle: () => ({ name: styleName }),
    getCenter: () => ({ lng: 139.767, lat: 35.681 }),
    on: vi.fn((type: string, listener: () => void) => {
      if (!mapListeners.has(type)) mapListeners.set(type, new Set());
      mapListeners.get(type)?.add(listener);
      return map;
    }),
    off: vi.fn((type: string, listener: () => void) => {
      mapListeners.get(type)?.delete(listener);
      return map;
    }),
    setStyle: vi.fn((style: unknown, _options?: unknown) => {
      styleUrl = typeof style === 'string' ? style : null;
      return map;
    }),
  };

  const emit = (event: string, payload: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
  };
  const off = (event: string, listener: Listener) => {
    listeners.get(event)?.delete(listener);
  };
  const setSelection = (type: SelectionType | null, next: string[]) => {
    const previous = selectionValue(selType, ids);
    ids = next;
    selType = next.length ? type : null;
    emit('selection.changed', { selection: selectionValue(selType, ids), previous });
  };
  const select = (next: string[]) => setSelection('feature', next);
  const changed = () => emit('change', {});
  /**
   * An observable of the stand-in: read again at once and after each of the signals it follows,
   * which the stand-in fires by the names core tells them by inside
   */
  const observable = <T>(signals: readonly string[], read: () => T) => ({
    get value() {
      return read();
    },
    subscribe(run: (value: T) => void) {
      const listener = () => run(read());
      for (const signal of signals) {
        let set = listeners.get(signal);
        if (!set) {
          set = new Set();
          listeners.set(signal, set);
        }
        set.add(listener);
      }
      run(read());
      return () => {
        for (const signal of signals) off(signal, listener);
      };
    },
  });

  /** Whether a feature can be changed: not read-only, nor locked with its layer or group */
  const editable = (d: Doc, f: Feature) => {
    const { layerId, groupId, locked } = fieldsOf(f);
    return (
      !readOnly &&
      !locked &&
      !d.layers.get(layerId)?.locked &&
      !(groupId && d.groups.get(groupId)?.locked)
    );
  };
  const appliedStyle = (f: Feature): FeatureStyleResolved =>
    ({ ...DEFAULT_STYLE, ...fieldsOf(f).style }) as FeatureStyleResolved;

  // ---------------------------------------------------------------------------
  // The writes of a transaction, on the document they are given: the one the transaction reads
  // (its draft), then the committed one at the commit

  /** The selection as a target of a write */
  const SELECTION = 'selection';
  /** The IDs of the features a target names */
  const namedFeatures = (d: Doc, target: unknown): string[] => {
    if (typeof target === 'string') return [target];
    if (Array.isArray(target)) return target as string[];
    if ((target as { type?: unknown }).type === SELECTION) {
      if (selType === 'feature') return [...ids];
      if (selType === 'group') {
        return ids.flatMap((id) => d.groups.get(id)?.featureIds ?? []);
      }
      if (selType === 'layer') {
        return [...d.features.values()]
          .filter((f) => ids.includes(fieldsOf(f).layerId))
          .map((f) => f.id);
      }
      return [];
    }
    if ((target as { all?: unknown }).all === true) return [...d.features.keys()];
    const where = target as { layerId?: string };
    return [...d.features.values()]
      .filter((f) => where.layerId === undefined || fieldsOf(f).layerId === where.layerId)
      .map((f) => f.id);
  };
  const featureIn = (d: Doc, id: string) => {
    const f = d.features.get(id);
    if (!f) throw new DrawError('notFound', `no feature ${id}`);
    return f;
  };
  const requireEditable = () => {
    if (readOnly) throw new DrawError('notEditable', 'The document is read-only');
  };
  const updateOne = (d: Doc, id: string, patch: unknown) => {
    const f = featureIn(d, id);
    if (!editable(d, f) && !onlyLockOrVisibility(patch)) {
      throw new DrawError('locked', `${id} is locked`, { ids: [id] });
    }
    const next = patched(f, patch);
    d.features.set(id, next);
    return next;
  };
  const deleteFeatures = (d: Doc, list: readonly string[]) => {
    for (const id of list) {
      takeOut(d, id);
      d.features.delete(id);
    }
  };
  const addFeature = (d: Doc, f: Feature) => {
    d.features.set(f.id, f);
    const { layerId } = fieldsOf(f);
    const l = d.layers.get(layerId);
    if (l) d.layers.set(layerId, { ...l, items: [...l.items.filter((x) => x !== f.id), f.id] });
    return f;
  };
  /** A feature an operation makes, in the layer of the first feature it takes */
  const made = (d: Doc, id: string, from: string) =>
    addFeature(
      d,
      makeFeature({ id, type: 'Polygon', layerId: fieldsOf(featureIn(d, from)).layerId }),
    );

  const ops = {
    features: {
      update: (d: Doc, target: unknown, patch?: unknown) => {
        if (Array.isArray(target) && typeof target[0] === 'object') {
          for (const entry of target as { id: string; patch: unknown }[]) {
            updateOne(d, entry.id, entry.patch);
          }
          return target.length;
        }
        if (typeof target === 'string') return updateOne(d, target, patch);
        const list = namedFeatures(d, target);
        for (const id of list) updateOne(d, id, patch);
        return list.length;
      },
      delete: (d: Doc, target: unknown) => {
        const list = namedFeatures(d, target);
        for (const id of list) {
          if (!editable(d, featureIn(d, id))) {
            throw new DrawError('locked', `${id} is locked`, { ids: [id] });
          }
        }
        deleteFeatures(d, list);
        return list.length;
      },
      place: (d: Doc, target: unknown, to: Placement) => {
        const list = namedFeatures(d, target);
        const { layerId, groupId } = placeOf(d, to);
        for (const id of list) {
          const f = featureIn(d, id);
          takeOut(d, id);
          d.features.set(id, placedFeature(f, layerId, groupId));
          if (groupId !== undefined) {
            const g = d.groups.get(groupId) as ObjectGroup;
            d.groups.set(groupId, { ...g, featureIds: insertAt(g.featureIds, id, to) });
          } else {
            const l = d.layers.get(layerId);
            if (!l) throw new DrawError('notFound', `no layer ${layerId}`);
            d.layers.set(layerId, { ...l, items: insertAt(l.items, id, to) });
          }
        }
        return list.length;
      },
      union: (d: Doc, list: readonly string[]) => {
        const out = made(d, 'union', list[0]);
        deleteFeatures(d, list);
        return out;
      },
      intersection: (d: Doc, list: readonly string[]) => made(d, 'intersection', list[0]),
      difference: (d: Doc, id: string, _subtract: readonly string[]) => made(d, 'difference', id),
      split: (d: Doc, id: string, _lineId: string) => [made(d, 'part1', id), made(d, 'part2', id)],
      buffer: (d: Doc, id: string, distanceMeters: number) => {
        if (!Number.isFinite(distanceMeters)) throw invalid('The distance must be finite');
        return made(d, 'buffer', id);
      },
    },
    layers: {
      create: (d: Doc, input: { name?: string } = {}) => {
        const id = `new${++created}`;
        d.layers.set(id, layer(id, [], input.name ? { name: input.name } : {}));
        d.order.push(id);
        return d.layers.get(id) as ObjectLayer;
      },
      update: (d: Doc, id: string, patch: Partial<ObjectLayer>) => {
        const l = d.layers.get(id);
        if (!l) throw new DrawError('notFound', `no layer ${id}`);
        d.layers.set(id, { ...l, ...patch });
        return d.layers.get(id) as ObjectLayer;
      },
      place: (d: Doc, id: string, to: { below?: string; above?: string }) => {
        if (!d.layers.has(id)) throw new DrawError('notFound', `no layer ${id}`);
        d.order = insertAt(d.order, id, to);
      },
      /** Deletes layers with their features and groups */
      delete: (d: Doc, target: string | readonly string[] | { all: true }) => {
        const list =
          typeof target === 'string'
            ? [target]
            : Array.isArray(target)
              ? (target as readonly string[])
              : [...d.layers.keys()];
        for (const id of list) {
          if (!d.layers.has(id)) throw new DrawError('notFound', `no layer ${id}`);
          for (const f of [...d.features.values()]) {
            if (fieldsOf(f).layerId === id) d.features.delete(f.id);
          }
          for (const g of [...d.groups.values()]) if (g.layerId === id) d.groups.delete(g.id);
          d.layers.delete(id);
          d.order = d.order.filter((x) => x !== id);
        }
        return list.length;
      },
    },
    groups: {
      create: (d: Doc, input: { featureIds: readonly string[]; name?: string }) => {
        const id = `group${++created}`;
        const first = featureIn(d, input.featureIds[0]);
        const { layerId } = fieldsOf(first);
        const l = d.layers.get(layerId) as ObjectLayer;
        const at = Math.max(...input.featureIds.map((f) => l.items.indexOf(f)));
        for (const fid of input.featureIds) {
          takeOut(d, fid);
          d.features.set(fid, placedFeature(featureIn(d, fid), layerId, id));
        }
        const items = (d.layers.get(layerId) as ObjectLayer).items;
        const next = [...items];
        next.splice(Math.min(at, next.length), 0, id);
        d.layers.set(layerId, { ...l, items: next });
        d.groups.set(id, {
          ...group(id, layerId, [...input.featureIds]),
          ...(input.name !== undefined && { name: input.name }),
        });
        return d.groups.get(id) as ObjectGroup;
      },
      update: (d: Doc, id: string, patch: Partial<ObjectGroup>) => {
        const g = d.groups.get(id);
        if (!g) throw new DrawError('notFound', `no group ${id}`);
        d.groups.set(id, { ...g, ...patch });
        return d.groups.get(id) as ObjectGroup;
      },
      delete: (
        d: Doc,
        target: string | readonly string[],
        options: { members: 'keep' | 'delete' },
      ) => {
        const list = typeof target === 'string' ? [target] : target;
        for (const id of list) {
          const g = d.groups.get(id);
          if (!g) throw new DrawError('notFound', `no group ${id}`);
          const l = d.layers.get(g.layerId) as ObjectLayer;
          const at = l.items.indexOf(id);
          if (options.members === 'delete') deleteFeatures(d, g.featureIds);
          else {
            const items = l.items.filter((x) => x !== id);
            items.splice(at, 0, ...g.featureIds);
            d.layers.set(l.id, { ...l, items });
            for (const fid of g.featureIds) {
              d.features.set(fid, placedFeature(featureIn(d, fid), g.layerId, undefined));
            }
          }
          takeOut(d, id);
          d.groups.delete(id);
        }
        return list.length;
      },
      place: (d: Doc, id: string, to: Placement) => {
        const g = d.groups.get(id);
        if (!g) throw new DrawError('notFound', `no group ${id}`);
        const { layerId } = placeOf(d, to);
        takeOut(d, id);
        d.groups.set(id, { ...g, layerId });
        for (const fid of g.featureIds) {
          d.features.set(fid, placedFeature(featureIn(d, fid), layerId, id));
        }
        const l = d.layers.get(layerId);
        if (!l) throw new DrawError('notFound', `no layer ${layerId}`);
        d.layers.set(layerId, { ...l, items: insertAt(l.items, id, to) });
      },
    },
  };

  // The transaction: each write is a mock, run on the draft of the write it belongs to and kept to
  // be run again on the document at the commit
  interface Open {
    draft: Doc;
    kept: ((d: Doc) => unknown)[];
    failed: unknown;
    closed: boolean;
  }
  /** The write the mock called now belongs to */
  let current: Open | null = null;
  const writeOf =
    <A extends unknown[]>(run: (d: Doc, ...args: A) => unknown) =>
    (...args: A) => {
      const open = current;
      if (!open || open.closed) {
        return Promise.reject(new DrawError('transactionClosed', 'The write has ended'));
      }
      try {
        requireEditable();
        // The selection names the features it names when the write is called
        const named = args.map((arg) =>
          typeof arg === 'object' && arg !== null && (arg as { type?: unknown }).type === SELECTION
            ? namedFeatures(open.draft, arg)
            : arg,
        ) as A;
        const value = run(open.draft, ...named);
        open.kept.push((d) => run(d, ...named));
        return Promise.resolve(value);
      } catch (error) {
        open.failed ??= error;
        return Promise.reject(error);
      }
    };
  const tx = {
    features: {
      update: vi.fn(writeOf(ops.features.update)),
      delete: vi.fn(writeOf(ops.features.delete)),
      place: vi.fn(writeOf(ops.features.place)),
      union: vi.fn(writeOf(ops.features.union)),
      intersection: vi.fn(writeOf(ops.features.intersection)),
      difference: vi.fn(writeOf(ops.features.difference)),
      split: vi.fn(writeOf(ops.features.split)),
      buffer: vi.fn(writeOf(ops.features.buffer)),
    },
    layers: {
      create: vi.fn(writeOf(ops.layers.create)),
      update: vi.fn(writeOf(ops.layers.update)),
      place: vi.fn(writeOf(ops.layers.place)),
      delete: vi.fn(writeOf(ops.layers.delete)),
    },
    groups: {
      create: vi.fn(writeOf(ops.groups.create)),
      update: vi.fn(writeOf(ops.groups.update)),
      delete: vi.fn(writeOf(ops.groups.delete)),
      place: vi.fn(writeOf(ops.groups.place)),
    },
  };
  /** The transaction of one write: the mocks of `tx`, called as writes of it */
  const transactionOf = (open: Open) => {
    const bind = <T extends Record<string, (...args: never[]) => unknown>>(group: T) =>
      Object.fromEntries(
        Object.entries(group).map(([name, mock]) => [
          name,
          (...args: never[]) => {
            const before = current;
            current = open;
            try {
              return mock(...args);
            } finally {
              current = before;
            }
          },
        ]),
      ) as T;
    return { features: bind(tx.features), layers: bind(tx.layers), groups: bind(tx.groups) };
  };

  /** Commits what a transaction kept, then drops from the selection what is gone */
  const commit = (kept: readonly ((d: Doc) => unknown)[]) => {
    const next = cloneDoc(doc);
    for (const run of kept) run(next);
    doc = next;
    changed();
    const left = ids.filter((id) =>
      selType === 'feature'
        ? doc.features.has(id)
        : selType === 'group'
          ? doc.groups.has(id)
          : doc.layers.has(id),
    );
    if (left.length !== ids.length) setSelection(selType, left);
  };

  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    const done = () => pending.delete(promise);
    promise.then(done, done);
    return promise;
  };

  const write = vi.fn(<T>(fn: (t: typeof tx) => T | Promise<T>) => {
    const open: Open = { draft: cloneDoc(doc), kept: [], failed: undefined, closed: false };
    const id = `commit${++commits}`;
    const run = (async () => {
      try {
        // The function runs at once; its writes are taken until it ends
        return await fn(transactionOf(open));
      } finally {
        open.closed = true;
      }
    })().then(async (value) => {
      if (open.failed !== undefined) throw open.failed;
      // The commit, in a later microtask
      await Promise.resolve();
      commit(open.kept);
      return value;
    });
    const promise = track(run);
    const result = promise.then((value) => ({ value, skipped: 0 }));
    for (const p of [promise, result]) p.catch(() => {});
    return Object.assign(promise, { id, result });
  });

  const enterMode = (next: Mode): void => {
    const previous = mode;
    mode = next;
    emit('mode.changed', { mode: next, previous });
  };
  const draw = {
    mode: Object.assign(
      observable(['mode.changed'], () => mode),
      {
        set: vi.fn((next: Mode) => enterMode(next)),
        drawing: { add: vi.fn((_at: readonly number[]) => {}) },
      },
    ),
    getMode: () => mode,
    setMode: vi.fn((next: Mode) => {
      enterMode(next);
      return true;
    }),
    on: vi.fn((event: string, listener: Listener) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return () => off(event, listener);
    }),
    off: vi.fn(off),
    write,
    isReadOnly: () => readOnly,
    selection: {
      get value() {
        return selectionValue(selType, ids);
      },
      /** The selection as a target of a write, as core gives it */
      get target() {
        return { type: 'selection' as const, count: ids.length };
      },
      subscribe: (run: (value: unknown) => void) =>
        observable(['selection.changed'], () => draw.selection.value).subscribe(run),
      set: vi.fn((type: SelectionType, next: readonly string[]) => {
        setSelection(type, [...next]);
        return true;
      }),
      clear: vi.fn(() => select([])),
    },
    layers: {
      get: (id: string) => doc.layers.get(id),
      list: () => doc.order.flatMap((id) => doc.layers.get(id) ?? []),
      count: () => doc.layers.size,
      listItems: (id: string, range?: { offset?: number; limit?: number }) =>
        inRange((doc.layers.get(id) as ObjectLayer).items, range),
      countItems: (id: string) => (doc.layers.get(id) as ObjectLayer).items.length,
      getOrder: () => [...doc.order],
      getActive: () => (active ? (doc.layers.get(active) ?? null) : null),
      setActive: vi.fn((id: string) => {
        active = id;
        return true;
      }),
    },
    groups: {
      get: (id: string) => doc.groups.get(id),
      listMembers: (id: string, range?: { offset?: number; limit?: number }) =>
        inRange((doc.groups.get(id) as ObjectGroup).featureIds, range),
    },
    features: {
      get: (id: string) => doc.features.get(id),
      getMany: (list: readonly string[]) => list.map((id) => doc.features.get(id)),
      list: (filter: { layerId?: string } = {}, page?: { limit: number }) =>
        [...doc.features.values()]
          .filter((f) => !filter.layerId || fieldsOf(f).layerId === filter.layerId)
          .slice(0, page?.limit),
      count: (filter: { layerId?: string } = {}) =>
        [...doc.features.values()].filter(
          (f) => !filter.layerId || fieldsOf(f).layerId === filter.layerId,
        ).length,
      isEditable: (id: string) => editable(doc, featureIn(doc, id)),
      getAppliedStyle: (id: string) => {
        const f = doc.features.get(id);
        return f ? appliedStyle(f) : undefined;
      },
    },
    hidden: {
      hiddenIds: observable(['hidden.changed'], () => new Set(hidden)),
      has: (id: string) => hidden.has(id),
      add: vi.fn((id: string) => {
        hidden.add(id);
        emit('hidden.changed', { ids: [...hidden] });
      }),
      remove: vi.fn((id: string) => {
        const had = hidden.delete(id);
        if (had) emit('hidden.changed', { ids: [...hidden] });
        return had;
      }),
    },
    options: {
      get value() {
        return structuredClone(runtime);
      },
      subscribe: (run: (value: RuntimeOptions) => void) =>
        observable(['options.changed'], () => structuredClone(runtime)).subscribe(run),
      get: () => structuredClone(runtime),
      // Merges the patch key by key and fires options.changed, as core does
      update: vi.fn((patch: Partial<RuntimeOptions>) => {
        const previous = runtime;
        runtime = mergeOptions(runtime, patch);
        emit('options.changed', { options: runtime, previous });
      }),
    },
    datasets: {
      get value() {
        return draw.datasets.list();
      },
      subscribe: (run: (value: unknown) => void) =>
        observable(['dataset.added', 'dataset.removed', 'dataset.reordered'], () =>
          draw.datasets.list(),
        ).subscribe(run),
      get: (id: string) => datasets.find((d) => d.id === id),
      // From the back: below the layers, among them, above them
      list: () =>
        (['belowStore', 'layerOrder', 'aboveStore'] as const).flatMap((o) =>
          datasets.filter((d) => d.order === o),
        ),
      // Its order only, as core: a dataset that leaves `layerOrder` leaves the stacking order,
      // and one that joins it goes to the front of it
      move: vi.fn((id: string, placement: { order?: DatasetOrder; index?: number }) => {
        const dataset = datasets.find((d) => d.id === id);
        if (!dataset) throw new Error(`no dataset ${id}`);
        const next = placement.order ?? dataset.order;
        if (dataset.order === 'layerOrder' && next !== 'layerOrder') {
          doc.order = doc.order.filter((x) => x !== id);
        } else if (dataset.order !== 'layerOrder' && next === 'layerOrder') {
          doc.order = [...doc.order, id];
        }
        dataset.order = next;
        emit('dataset.reordered', { ids: datasets.map((d) => d.id) });
        return true;
      }),
    },
    getMap: () => map,
    // The channel a style rule colors for a type, as core judges it for the built-in types
    extensions: {
      featureTypes: { getStyleRuleChannel: (type: string) => builtInRuleChannel(type) },
    },
  };

  return {
    draw,
    /** The stand-in as the API types it */
    asDraw: draw as unknown as Draw,
    /** The writes of the transactions, as mocks to assert on */
    tx,
    container,
    canvas,
    map,
    /**
     * Waits until the writes are committed and the interface has done what it does after them,
     * then draws it
     */
    async settle() {
      do {
        await Promise.allSettled([...pending]);
        await new Promise((resolve) => setTimeout(resolve, 0));
      } while (pending.size > 0);
      flushSync();
    },
    /** Loads a style with this name on the map: it fires the map's `style.load` */
    loadStyle(name: string | undefined) {
      styleName = name;
      for (const listener of mapListeners.get('style.load') ?? []) listener();
    },
    /** The number of listeners of an event of the map */
    mapListening: (type: string) => mapListeners.get(type)?.size ?? 0,
    /** Fires an event of the draw instance, or a signal an observable follows */
    emit,
    /** An observable of the stand-in, read again after the signals it follows */
    observable,
    /** Changes the selection from outside the interface, as a click on the map would */
    select,
    /** Changes the selection of any type from outside the interface */
    setSelection,
    /** Hides an item in this client, from outside the interface */
    hide(id: string) {
      hidden.add(id);
      emit('hidden.changed', { ids: [...hidden] });
    },
    /** Changes the document from outside the interface, and tells it */
    change(fn: (d: { layers: Map<string, Layer>; features: Map<string, Feature> }) => void) {
      // The layers of the stand-in are layers of objects
      fn(doc as unknown as { layers: Map<string, Layer>; features: Map<string, Feature> });
      changed();
    },
    /** Changes a feature from outside the interface with a patch of core, and tells it */
    changeFeature(id: string, patch: unknown) {
      doc.features.set(id, patched(featureIn(doc, id), patch));
      changed();
    },
    /** Turns read-only on or off from outside the interface */
    setReadOnly(value: boolean) {
      readOnly = value;
      emit('readOnly.changed', { readOnly: value });
    },
    /** The datasets of the stand-in, from the order they were given */
    datasets,
    /** Adds a dataset, as `draw.datasets.add` would */
    addDataset(spec: FakeDatasetSpec) {
      const dataset = fakeDataset(spec);
      datasets.push(dataset);
      emit('dataset.added', { dataset });
      return dataset;
    },
    /** Removes a dataset, as `draw.datasets.remove` would */
    removeDataset(id: string) {
      const at = datasets.findIndex((d) => d.id === id);
      if (at !== -1) datasets.splice(at, 1);
      emit('dataset.removed', { datasetId: id });
    },
    /** Changes the mode from outside the interface */
    setModeFromOutside(next: Mode) {
      const previous = mode;
      mode = next;
      emit('mode.changed', { mode: next, previous });
    },
    /** How many listeners are attached now */
    listenerCount() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

/** The look of a feature with nothing set: the defaults of the stand-in */
export const DEFAULT_STYLE: FeatureStyleResolved = Object.freeze({
  fillColor: '#3388ff',
  fillOpacity: 0.2,
  strokeColor: '#3388ff',
  strokeWidth: 2,
  strokeOpacity: 1,
  lineStyle: 'solid',
  pointColor: '#3388ff',
  pointRadius: 6,
  pointShape: 'circle',
  pointOpacity: 1,
  pointStrokeColor: '#ffffff',
  pointStrokeWidth: 2,
  imageOpacity: 1,
});

/** The part of a list of core in a range of positions, as `layers.listItems` reads it */
function inRange(list: readonly string[], range: { offset?: number; limit?: number } = {}) {
  const offset = range.offset ?? 0;
  return list.slice(offset, range.limit === undefined ? undefined : offset + range.limit);
}

/**
 * A stand-in with a document of features, layers and groups, as the inspector reads it: the
 * features in the layer `l1` unless they name another, listed in their layers and groups
 */
export function fakeDocument(
  options: {
    features?: Feature[];
    layers?: Partial<ObjectLayer>[];
    groups?: ObjectGroup[];
    selection?: { type: SelectionType; ids: string[] };
    readOnly?: boolean;
  } = {},
) {
  const features = options.features ?? [];
  const groups = options.groups ?? [];
  const grouped = new Set(groups.flatMap((g) => g.featureIds));
  const layers = (options.layers ?? [{ id: 'l1', name: 'Layer 1' }]).map((l) => {
    const id = l.id as string;
    const items = l.items ?? [
      ...features.filter((f) => fieldsOf(f).layerId === id && !grouped.has(f.id)).map((f) => f.id),
      ...groups.filter((g) => g.layerId === id).map((g) => g.id),
    ];
    return layer(id, [...items], {
      name: l.name ?? 'Layer',
      ...(l.visible !== undefined && { visible: l.visible }),
      ...(l.locked !== undefined && { locked: l.locked }),
      ...(l.opacity !== undefined && { opacity: l.opacity }),
      styleRule: l.styleRule,
    });
  });
  const fake = fakeDraw({
    doc: { layers, groups, features },
    ...(options.readOnly !== undefined && { readOnly: options.readOnly }),
  });
  if (options.selection) fake.setSelection(options.selection.type, [...options.selection.ids]);
  return {
    ...fake,
    /** Changes the selection from outside the interface */
    selectItems: fake.setSelection,
  };
}

/** The channel a style rule colors for a built-in type, as core judges it */
export function builtInRuleChannel(type: string): 'point' | 'stroke' | 'fill' {
  if (type === 'Point' || type === 'MultiPoint') return 'point';
  if (type === 'LineString' || type === 'MultiLineString' || type === 'Freehand') return 'stroke';
  return 'fill';
}
