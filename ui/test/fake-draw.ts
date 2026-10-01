// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for a draw instance with only the members the interface uses, and the map's
// container and canvas.

import type {
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
  SelectionType,
} from '@sakuzu/maplibre-gl-draw';
import { vi } from 'vitest';

type Listener = (payload: unknown) => void;

export function fakeDraw(options: { mode?: Mode; ids?: string[]; snapping?: boolean } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  let mode: Mode = options.mode ?? 'select';
  let ids: string[] = options.ids ?? [];
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
  const select = (next: string[]) => {
    const previous = { type: ids.length ? 'feature' : null, ids };
    ids = next;
    emit('selection.changed', {
      selection: { type: ids.length ? 'feature' : null, ids },
      previous,
    });
  };

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
      get: () => ({ type: ids.length ? 'feature' : null, ids }),
      delete: vi.fn(() => {
        if (ids.length === 0) return false;
        select([]);
        return true;
      }),
      clear: vi.fn(() => select([])),
    },
    options: {
      get: () => ({ snapping: { enabled: snapping } }),
      update: vi.fn((patch: { snapping?: { enabled?: boolean } }) => {
        if (patch.snapping?.enabled !== undefined) snapping = patch.snapping.enabled;
      }),
    },
    getMap: () => ({ getContainer: () => container, getCanvas: () => canvas }),
    // A document without features, for the inspector (fakeDocument has one with features)
    isReadOnly: () => false,
    features: { getMany: (list: readonly string[]) => list.map(() => undefined) },
  };

  return {
    draw,
    /** The stand-in as the API types it */
    asDraw: draw as unknown as Draw,
    container,
    canvas,
    /** Fires an event of the draw instance */
    emit,
    /** Changes the selection from outside the interface, as a click on the map would */
    select,
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
export function feature(input: FeatureInput & { id: string }): Feature {
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
    feature({
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
