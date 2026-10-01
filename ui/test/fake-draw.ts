// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for a draw instance with only the members the interface uses, and the map's
// container and canvas.

import type {
  Draw,
  Feature,
  FeatureStyleResolved,
  Group,
  Layer,
  Mode,
  MoveTarget,
  SelectionType,
} from '@sakuzu/maplibre-gl-draw';
import { vi } from 'vitest';

type Listener = (payload: unknown) => void;

/** A document for the stand-in: the layers from the back, and their groups and features */
export interface FakeDocument {
  layers: Layer[];
  groups?: Group[];
  features?: Feature[];
  /** The active layer; the front one when left out */
  active?: string;
}

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
  options: { mode?: Mode; ids?: string[]; snapping?: boolean; doc?: FakeDocument } = {},
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
  for (const g of doc.groups ?? []) groups.set(g.id, g);
  for (const f of doc.features ?? []) features.set(f.id, f);
  let active: string | null = doc.active ?? order[order.length - 1] ?? null;
  const hidden = new Set<string>();
  let created = 0;
  let snapping = options.snapping ?? true;
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  container.appendChild(canvas);
  document.body.appendChild(container);

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
      list: () => order.map((id) => layers.get(id) as Layer),
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
      get: () => ({ snapping: { enabled: snapping } }),
      update: vi.fn((patch: { snapping?: { enabled?: boolean } }) => {
        if (patch.snapping?.enabled !== undefined) snapping = patch.snapping.enabled;
      }),
    },
    getMap: () => ({ getContainer: () => container, getCanvas: () => canvas }),
  };

  return {
    draw,
    /** The stand-in as the API types it */
    asDraw: draw as unknown as Draw,
    container,
    canvas,
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
