// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for a draw instance with only the members the interface uses, and the map's
// container and canvas.

import type {
  DatasetOrder,
  Draw,
  Feature,
  FeatureInput,
  FeaturePatch,
  FeatureStyleResolved,
  Group,
  GroupPatch,
  Layer,
  LayerPatch,
  Mode,
  MoveTarget,
  RuntimeOptions,
  SelectionType,
  StyleRule,
} from '@sakuzu/maplibre-gl-draw';
import { vi } from 'vitest';

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

/** A document for the stand-in: the layers from the back, and their groups and features */
export interface FakeDocument {
  layers: Layer[];
  groups?: Group[];
  features?: Feature[];
  /** The active layer; the front one when left out */
  active?: string;
  /** The datasets on the map, from the back */
  datasets?: FakeDatasetSpec[];
  /**
   * The stacking order from the back, with the IDs of the `layer-order` datasets placed among the
   * layers; the layers in their order when left out
   */
  order?: string[];
}

/** A dataset of the stand-in */
export interface FakeDatasetSpec {
  id: string;
  /** `layer-order` when left out */
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
    order: spec.order ?? ('layer-order' as DatasetOrder),
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
export function layer(id: string, items: string[] = [], extra: Partial<Layer> = {}): Layer {
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
export function group(id: string, layerId: string, featureIds: string[]): Group {
  return { id, layerId, name: `Group ${id}`, featureIds, visible: true, locked: false };
}

/** A feature of a fake document */
export function feature(
  id: string,
  layerId: string,
  type = 'Point',
  extra: Partial<Feature> = {},
): Feature {
  return {
    id,
    type,
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId,
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
    ...extra,
  };
}

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
  } = {},
) {
  const listeners = new Map<string, Set<Listener>>();
  let mode: Mode = options.mode ?? 'select';
  let ids: string[] = options.ids ?? [];
  let selType: SelectionType | null = ids.length ? 'feature' : null;
  const layers = new Map<string, Layer>();
  const groups = new Map<string, Group>();
  const features = new Map<string, Feature>();
  let order: string[] = [];
  const doc = options.doc ?? { layers: [layer('l1')] };
  for (const l of doc.layers) {
    layers.set(l.id, l);
    order.push(l.id);
  }
  if (doc.order) order = [...doc.order];
  const datasets: FakeDataset[] = (doc.datasets ?? []).map(fakeDataset);
  for (const g of doc.groups ?? []) groups.set(g.id, g);
  for (const f of doc.features ?? []) features.set(f.id, f);
  let active: string | null =
    doc.active ?? [...order].reverse().find((id) => layers.has(id)) ?? null;
  const hidden = new Set<string>();
  let created = 0;
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
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  const off = (event: string, listener: Listener) => {
    listeners.get(event)?.delete(listener);
  };
  const setSelection = (type: SelectionType | null, next: string[]) => {
    const previous = { type: selType, ids };
    ids = next;
    selType = next.length ? type : null;
    emit('selection.changed', { selection: { type: selType, ids }, previous });
  };
  const select = (next: string[]) => setSelection('feature', next);
  const changed = () => emit('document.changed', {});

  const putLayer = (id: string, patch: Partial<Layer>) => {
    const now = layers.get(id);
    if (!now) throw new Error(`no layer ${id}`);
    layers.set(id, { ...now, ...patch });
  };
  const putGroup = (id: string, patch: Partial<Group>) => {
    const now = groups.get(id);
    if (!now) throw new Error(`no group ${id}`);
    groups.set(id, { ...now, ...patch });
  };
  const putFeature = (id: string, patch: Partial<Feature>) => {
    const now = features.get(id);
    if (!now) throw new Error(`no feature ${id}`);
    features.set(id, { ...now, ...patch });
  };
  /** Takes an item out of every layer and group */
  const takeOut = (id: string) => {
    for (const l of layers.values()) {
      if (l.items.includes(id)) putLayer(l.id, { items: l.items.filter((x) => x !== id) });
    }
    for (const g of groups.values()) {
      if (g.featureIds.includes(id)) {
        putGroup(g.id, { featureIds: g.featureIds.filter((x) => x !== id) });
      }
    }
  };
  const insert = (list: readonly string[], id: string, index: number | undefined) => {
    const out = [...list];
    out.splice(index === undefined ? out.length : Math.min(index, out.length), 0, id);
    return out;
  };
  const appliedStyle = (f: Feature): FeatureStyleResolved =>
    ({
      fillColor: '#3388ff',
      strokeColor: '#3388ff',
      pointColor: '#3388ff',
      ...f.style,
    }) as FeatureStyleResolved;

  const draw = {
    getMode: () => mode,
    setMode: vi.fn((next: Mode) => {
      const previous = mode;
      mode = next;
      emit('mode.changed', { mode: next, previous });
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
    selection: {
      get: () => ({ type: selType, ids }),
      set: vi.fn((type: SelectionType, next: readonly string[]) => {
        setSelection(type, [...next]);
        return true;
      }),
      delete: vi.fn(() => {
        if (ids.length === 0) return false;
        select([]);
        return true;
      }),
      clear: vi.fn(() => select([])),
      group: vi.fn(() => null),
    },
    layers: {
      get: (id: string) => layers.get(id),
      list: () => order.flatMap((id) => layers.get(id) ?? []),
      getOrder: () => [...order],
      reorder: vi.fn((next: readonly string[]) => {
        order = [...next];
        changed();
        return true;
      }),
      create: vi.fn((input: { name?: string }) => {
        const id = `new${++created}`;
        layers.set(id, layer(id, [], input.name ? { name: input.name } : {}));
        order.push(id);
        changed();
        return layers.get(id) as Layer;
      }),
      update: vi.fn((id: string, patch: Partial<Layer>) => {
        putLayer(id, patch);
        changed();
        return layers.get(id) as Layer;
      }),
      getActive: () => (active ? (layers.get(active) ?? null) : null),
      setActive: vi.fn((id: string) => {
        active = id;
        return true;
      }),
    },
    groups: {
      get: (id: string) => groups.get(id),
      update: vi.fn((id: string, patch: Partial<Group>) => {
        putGroup(id, patch);
        changed();
        return groups.get(id) as Group;
      }),
      move: vi.fn((id: string, to: MoveTarget) => {
        if (!('layerId' in to)) throw new Error('a group goes into a layer');
        const g = groups.get(id) as Group;
        takeOut(id);
        putGroup(id, { layerId: to.layerId });
        for (const fid of g.featureIds) putFeature(fid, { layerId: to.layerId });
        const target = layers.get(to.layerId) as Layer;
        putLayer(to.layerId, { items: insert(target.items, id, to.index) });
        changed();
        return true;
      }),
    },
    features: {
      get: (id: string) => features.get(id),
      list: (filter: { layerId?: string } = {}) =>
        [...features.values()].filter((f) => !filter.layerId || f.layerId === filter.layerId),
      update: vi.fn((id: string, patch: Partial<Feature>) => {
        const now = features.get(id) as Feature;
        const properties = { ...now.properties, ...(patch.properties ?? {}) };
        for (const [k, v] of Object.entries(properties)) if (v === undefined) delete properties[k];
        putFeature(id, { ...patch, properties });
        changed();
        return features.get(id) as Feature;
      }),
      move: vi.fn((id: string, to: MoveTarget) => {
        takeOut(id);
        if ('layerId' in to) {
          putFeature(id, { layerId: to.layerId, groupId: undefined });
          const target = layers.get(to.layerId) as Layer;
          putLayer(to.layerId, { items: insert(target.items, id, to.index) });
        } else if (to.groupId) {
          const g = groups.get(to.groupId) as Group;
          putFeature(id, { layerId: g.layerId, groupId: g.id });
          putGroup(g.id, { featureIds: insert(g.featureIds, id, to.index) });
        }
        changed();
        return true;
      }),
      getAppliedStyle: (id: string) => {
        const f = features.get(id);
        return f ? appliedStyle(f) : undefined;
      },
    },
    hidden: {
      has: (id: string) => hidden.has(id),
      remove: vi.fn((id: string) => {
        const had = hidden.delete(id);
        if (had) emit('hidden.changed', { ids: [...hidden] });
        return had;
      }),
    },
    options: {
      get: () => structuredClone(runtime),
      // Merges the patch key by key and fires options.changed, as core does
      update: vi.fn((patch: Partial<RuntimeOptions>) => {
        const previous = runtime;
        runtime = mergeOptions(runtime, patch);
        emit('options.changed', { options: runtime, previous });
      }),
    },
    datasets: {
      get: (id: string) => datasets.find((d) => d.id === id),
      // From the back: below the layers, among them, above them
      list: () =>
        (['below-store', 'layer-order', 'above-store'] as const).flatMap((o) =>
          datasets.filter((d) => d.order === o),
        ),
      // Its order only, as core: a dataset that leaves `layer-order` leaves the stacking order,
      // and one that joins it is put on the order by the caller (`layers.reorder`)
      move: vi.fn((id: string, placement: { order?: DatasetOrder; index?: number }) => {
        const dataset = datasets.find((d) => d.id === id);
        if (!dataset) throw new Error(`no dataset ${id}`);
        const next = placement.order ?? dataset.order;
        if (dataset.order === 'layer-order' && next !== 'layer-order') {
          order = order.filter((x) => x !== id);
        }
        dataset.order = next;
        emit('dataset.reordered', { ids: datasets.map((d) => d.id) });
        return true;
      }),
    },
    getMap: () => map,
    // What the inspector reads besides (fakeDocument has a stand-in with every member it uses)
    isReadOnly: () => false,
    transact: <T>(fn: () => T) => fn(),
  };
  Object.assign(draw.features, {
    getMany: (list: readonly string[]) => list.map((id) => features.get(id)),
    isEditable: (id: string) => !features.get(id)?.locked,
  });
  Object.assign(draw.layers, { count: () => layers.size });

  return {
    draw,
    /** The stand-in as the API types it */
    asDraw: draw as unknown as Draw,
    container,
    canvas,
    map,
    /** Loads a style with this name on the map: it fires the map's `style.load` */
    loadStyle(name: string | undefined) {
      styleName = name;
      for (const listener of mapListeners.get('style.load') ?? []) listener();
    },
    /** The number of listeners of an event of the map */
    mapListening: (type: string) => mapListeners.get(type)?.size ?? 0,
    /** Fires an event of the draw instance */
    emit,
    /** Changes the selection from outside the interface, as a click on the map would */
    select,
    /** Changes the selection of any type from outside the interface */
    setSelection,
    /** Hides an item in this client, from outside the interface */
    hide(id: string) {
      hidden.add(id);
      emit('hidden.changed', { ids: [...hidden] });
    },
    /** Changes the document from outside the interface */
    change(fn: (doc: { layers: Map<string, Layer>; features: Map<string, Feature> }) => void) {
      fn({ layers, features });
      changed();
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

/** A feature of the stand-in from an input, in the layer `l1` unless it names another */
export function makeFeature(input: FeatureInput & { id: string }): Feature {
  return {
    id: input.id,
    type: input.type,
    geometry: input.geometry,
    layerId: input.layerId ?? 'l1',
    groupId: input.groupId,
    properties: { ...(input.properties ?? {}) },
    style: { ...(input.style ?? {}) },
    visible: input.visible ?? true,
    locked: input.locked ?? false,
  };
}

/** Merges the keys of a patch of properties or style; a key given as undefined is removed */
function merge<T extends object>(base: T, patch: object | undefined): T {
  if (!patch) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out as unknown as T;
}

/**
 * A stand-in with a document: features, layers and groups held in maps, the members of the
 * inspector, and the events they fire. A change fires document.changed; a change of the
 * selection fires selection.changed.
 */
export function fakeDocument(
  options: {
    features?: Feature[];
    layers?: Partial<Layer>[];
    groups?: Group[];
    selection?: { type: SelectionType; ids: string[] };
    readOnly?: boolean;
  } = {},
) {
  const fake = fakeDraw();
  const features = new Map((options.features ?? []).map((f) => [f.id, f]));
  const layers = new Map<string, Layer>(
    (options.layers ?? [{ id: 'l1', name: 'Layer 1' }]).map((l) => [
      l.id as string,
      {
        id: l.id as string,
        name: l.name ?? 'Layer',
        visible: l.visible ?? true,
        locked: l.locked ?? false,
        opacity: l.opacity ?? 1,
        items: l.items ?? [],
        styleRule: l.styleRule,
        metadata: undefined,
      },
    ]),
  );
  const groups = new Map((options.groups ?? []).map((g) => [g.id, g]));
  const hidden = new Set<string>();
  let selection: { type: SelectionType | null; ids: string[] } = options.selection ?? {
    type: null,
    ids: [],
  };
  let readOnly = options.readOnly ?? false;

  const changed = () => fake.emit('document.changed', {});
  const setSelection = (type: SelectionType | null, ids: string[]) => {
    const previous = selection;
    selection = { type: ids.length ? type : null, ids };
    fake.emit('selection.changed', { selection, previous });
  };
  const editable = (f: Feature) =>
    !readOnly &&
    !f.locked &&
    !layers.get(f.layerId)?.locked &&
    !(f.groupId && groups.get(f.groupId)?.locked);
  const applyPatch = (id: string, patch: FeaturePatch): Feature => {
    const f = features.get(id);
    if (!f) throw new Error(`no feature ${id}`);
    const next: Feature = {
      ...f,
      geometry: patch.geometry ?? f.geometry,
      properties: merge(f.properties, patch.properties),
      style: merge(f.style, patch.style),
      visible: patch.visible ?? f.visible,
      locked: patch.locked ?? f.locked,
    };
    features.set(id, next);
    return next;
  };
  const made = (type: string, id: string): Feature =>
    makeFeature({
      id,
      type,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    });
  const add = (f: Feature) => {
    features.set(f.id, f);
    return f;
  };

  Object.assign(fake.draw, {
    isReadOnly: () => readOnly,
    transact: vi.fn(<T>(fn: () => T) => fn()),
  });
  Object.assign(fake.draw.selection, {
    get: () => selection,
    set: vi.fn((type: SelectionType, ids: readonly string[]) => {
      setSelection(type, [...ids]);
      return true;
    }),
    clear: vi.fn(() => setSelection(null, [])),
    delete: vi.fn(() => {
      if (selection.ids.length === 0) return false;
      for (const id of selection.ids) features.delete(id);
      setSelection(null, []);
      changed();
      return true;
    }),
    group: vi.fn(() => null),
    ungroup: vi.fn(() => true),
  });
  Object.assign(fake.draw, {
    features: {
      get: (id: string) => features.get(id),
      getMany: (ids: readonly string[]) => ids.map((id) => features.get(id)),
      getAppliedStyle: (id: string) => {
        const f = features.get(id);
        return f ? { ...DEFAULT_STYLE, ...f.style } : undefined;
      },
      isEditable: (id: string) => {
        const f = features.get(id);
        if (!f) throw new Error(`no feature ${id}`);
        return editable(f);
      },
      update: vi.fn((id: string, patch: FeaturePatch) => {
        const next = applyPatch(id, patch);
        changed();
        return next;
      }),
      updateMany: vi.fn((patches: readonly { id: string; patch: FeaturePatch }[]) => {
        const out = patches.map(({ id, patch }) => applyPatch(id, patch));
        changed();
        return out;
      }),
      union: vi.fn((ids: readonly string[]) => {
        for (const id of ids) features.delete(id);
        changed();
        return add(made('Polygon', 'union'));
      }),
      intersection: vi.fn(() => add(made('Polygon', 'intersection'))),
      difference: vi.fn(() => add(made('Polygon', 'difference'))),
      split: vi.fn(() => [add(made('Polygon', 'part1')), add(made('Polygon', 'part2'))]),
      buffer: vi.fn(() => [add(made('Polygon', 'buffer'))]),
    },
    hidden: {
      has: (id: string) => hidden.has(id),
      add: vi.fn((id: string) => {
        hidden.add(id);
        fake.emit('hidden.changed', { ids: [...hidden] });
      }),
      remove: vi.fn((id: string) => {
        const had = hidden.delete(id);
        fake.emit('hidden.changed', { ids: [...hidden] });
        return had;
      }),
    },
    layers: {
      get: (id: string) => layers.get(id),
      count: () => layers.size,
      update: vi.fn((id: string, patch: LayerPatch) => {
        const l = layers.get(id);
        if (!l) throw new Error(`no layer ${id}`);
        const next = { ...l, ...patch };
        layers.set(id, next);
        changed();
        return next;
      }),
    },
    groups: {
      get: (id: string) => groups.get(id),
      update: vi.fn((id: string, patch: GroupPatch) => {
        const g = groups.get(id);
        if (!g) throw new Error(`no group ${id}`);
        const next = { ...g, ...patch };
        groups.set(id, next);
        changed();
        return next;
      }),
    },
  });

  type Members = {
    features: Record<string, ReturnType<typeof vi.fn>>;
    layers: Record<string, ReturnType<typeof vi.fn>>;
    groups: Record<string, ReturnType<typeof vi.fn>>;
    hidden: Record<string, ReturnType<typeof vi.fn>>;
    selection: Record<string, ReturnType<typeof vi.fn>>;
    transact: ReturnType<typeof vi.fn>;
  };

  return {
    ...fake,
    /** The members of the stand-in, as mocks to assert on */
    mocks: fake.draw as unknown as Members,
    /** Changes the selection from outside the interface */
    selectItems: setSelection,
    /** Changes a feature from outside the interface */
    change(id: string, patch: FeaturePatch) {
      applyPatch(id, patch);
      changed();
    },
    /** Turns read-only on or off from outside the interface */
    setReadOnly(value: boolean) {
      readOnly = value;
      fake.emit('readOnly.changed', { readOnly: value });
    },
  };
}
