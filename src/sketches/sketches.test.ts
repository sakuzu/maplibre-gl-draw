// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sketches (`draw.sketches`) over the Store of objects, the Store of rows and a Store that gives
 * its vertices IDs, with every check of the state on
 *
 * - add: the gates of a sketch of this client (read-only, a lock, a layer that cannot be written, a
 *   feature hidden) give null, an ID of no feature throws, and a sketch with an owner passes no
 *   gate
 * - the events and their order; a commit writes in one transaction with one `applyEdits`, a
 *   removal writes nothing
 * - a second sketch of this client of a feature commits the first one; the sketches with an owner
 *   are applied first and cannot be committed
 * - applied again over what the Store writes: a feature deleted, locked or hidden is left out
 *   (dropped) and the sketch goes on, and ends with the reason once nothing is left; the vertices
 *   found again by their IDs, or by their places while the shape stays
 * - a feature created in its place (`below`), and a sketch ended when its layer cannot be written
 * - the reads of the features as they are drawn, with the sketches (`draw.rendered`)
 * - the checks `sketches` and `sketch-commits` pass, and fail when what they check is broken
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draw } from '../api/draw.js';
import type { Store as PublicStore } from '../api/extension/store.js';
import { createDrawOnEngine } from '../api/impl/create-draw.js';
import type { Engine } from '../api/impl/engine.js';
import { createEngine } from '../api/impl/engine.js';
import type { InstanceSignals } from '../api/impl/events.js';
import { toFeature } from '../api/impl/feature-shape.js';
import type { ConsistencyFailure } from '../api/options.js';
import type { Sketch, SketchEdit } from '../api/sketches.js';
import { draggedRowMotionsOf } from '../feature-table/dragged-rows.js';
import {
  SKETCH_MOVE_SET,
  STATE_HIDDEN_SKETCH,
  STATE_MOVE_MASK,
  STATE_MOVE_SHIFT,
} from '../feature-table/feature-row-states.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { MemoryStore } from '../store/memory.js';
import type { FeatureEdit, Store } from '../store/store.js';
import { createTableStore } from '../store/table-memory.js';
import type { Feature, StoreChange, VertexRef } from '../store/types.js';
import { writesOf } from '../test-support/writes.js';
import { createMapStub } from '../test-utils.js';

type Kind = 'objects' | 'rows' | 'ids';

const KINDS: readonly Kind[] = ['objects', 'rows', 'ids'];

/**
 * A Store of objects that gives its vertices IDs: the ID of a vertex is its position, so a vertex
 * keeps it while vertices are added before it and others are moved
 */
function vertexIdStore(): Store {
  const store = new MemoryStore();
  const placeOf = (featureId: string, id: string): VertexRef | null => {
    const feature = store.getFeature(featureId);
    if (feature?.geometry.type !== 'LineString') return null;
    const index = feature.geometry.coordinates.findIndex((p) => `${p[0]},${p[1]}` === id);
    return index < 0 ? null : { ring: 0, index };
  };
  const resolve = (featureId: string, vertex: unknown): unknown =>
    typeof vertex === 'string' ? placeOf(featureId, vertex) : vertex;
  const reads: Record<string, unknown> = {
    getVertexIds(featureId: string, vertices: readonly VertexRef[]) {
      const feature = store.getFeature(featureId) as Feature;
      const coordinates = (feature.geometry as { coordinates: number[][] }).coordinates;
      return vertices.map((v) => `${coordinates[v.index][0]},${coordinates[v.index][1]}`);
    },
    findVertices(featureId: string, ids: readonly string[]) {
      return ids.map((id) => placeOf(featureId, id));
    },
    applyEdits(edits: readonly FeatureEdit[]) {
      return store.applyEdits(
        edits.map((edit) => {
          if (!('featureId' in edit) || edit.kind === 'set') return edit;
          const id = edit.featureId;
          if (edit.kind === 'vertex-insert') {
            return edit.after !== undefined
              ? { ...edit, after: resolve(id, edit.after) }
              : { ...edit, before: resolve(id, edit.before) };
          }
          return { ...edit, vertices: edit.vertices.map((v) => resolve(id, v)) };
        }) as FeatureEdit[],
      );
    },
  };
  return new Proxy(store, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in reads) return reads[prop];
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as Store;
}

interface Opened {
  readonly engine: Engine;
  readonly draw: Draw;
  readonly store: Store;
  readonly failures: ConsistencyFailure[];
  readonly events: Array<[string, unknown]>;
}

const opened: Draw[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const draw of opened.splice(0)) draw.destroy();
  vi.useRealTimers();
});

function storeOf(kind: Kind): Store {
  if (kind === 'rows') return createTableStore().store;
  if (kind === 'ids') return vertexIdStore();
  return new MemoryStore();
}

/** An instance over a Store of a kind, with every check of the state on */
function open(kind: Kind, allowed: Array<'sketches' | 'sketch-commits'> = []): Opened {
  const store = storeOf(kind);
  const failures: ConsistencyFailure[] = [];
  const options = {
    store: store as unknown as PublicStore,
    debug: {
      checks: { allowed, onFailure: (failure: ConsistencyFailure) => failures.push(failure) },
    },
  };
  const engine = createEngine(createMapStub().map, { store }, { deferDefaultMode: true });
  const draw = createDrawOnEngine(engine, options);
  engine.enterDefaultMode();
  opened.push(draw);
  const events: Array<[string, unknown]> = [];
  for (const event of ['sketch.added', 'sketch.updated', 'sketch.removed', 'change'] as const) {
    engine.events.on(event, (payload) => events.push([event, payload]));
  }
  return { engine, draw, store, failures, events };
}

/** A line of three vertices along the equator, from x */
function line(draw: Draw, x = 0, layerId?: string): Feature {
  return writesOf(draw).features.create({
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [x, 0],
        [x + 1, 0],
        [x + 2, 0],
      ],
    },
    ...(layerId === undefined ? {} : { layerId }),
  }) as Feature;
}

/** The coordinates of a line, of a feature of the Store or of the public shape */
function coordinatesOf(feature: { readonly geometry: unknown } | undefined): number[][] {
  return ((feature as { readonly geometry: unknown }).geometry as { coordinates: number[][] })
    .coordinates;
}

/** The names of the events, in order */
function names(events: Array<[string, unknown]>): string[] {
  return events.map(([name]) => name);
}

const move = (
  featureId: string,
  to: [number, number],
  vertex: VertexRef | string = { ring: 0, index: 1 },
): SketchEdit => ({
  kind: 'vertex-move',
  featureId,
  vertices: [vertex as VertexRef],
  positions: [to],
});

for (const kind of KINDS) {
  describe(`sketches over the Store of ${kind}`, () => {
    it('adds a sketch that is drawn and read with the sketches, and writes nothing', () => {
      const { draw, events, failures } = open(kind);
      const a = line(draw);
      events.length = 0;
      const sketch = draw.sketches.add({ edits: [move(a.id, [1, 1])] }) as Sketch;
      expect(sketch.owner).toBeNull();
      expect(draw.sketches.get(sketch.id)).toBe(sketch);
      expect(draw.sketches.list()).toEqual([sketch]);
      expect(draw.sketches.count()).toBe(1);
      expect(draw.sketches.has(sketch.id)).toBe(true);
      expect(names(events)).toEqual(['sketch.added']);
      expect(coordinatesOf(writesOf(draw).features.get(a.id))[1]).toEqual([1, 0]);
      expect(coordinatesOf(draw.rendered.get(a.id))[1]).toEqual([1, 1]);
      expect(draw.rendered.getMany([a.id, 'none']).map((f) => f && coordinatesOf(f)[1])).toEqual([
        [1, 1],
        undefined,
      ]);
      if (kind === 'ids') {
        // The vertex is kept by its ID
        expect((sketch.edits[0] as unknown as { vertices: unknown[] }).vertices).toEqual(['1,0']);
      }
      expect(failures).toEqual([]);
    });

    it('refuses a sketch of this client of what cannot be written, and throws for no feature', () => {
      const { draw, failures } = open(kind);
      const a = line(draw);
      const b = line(draw, 10);
      expect(() => draw.sketches.add({ edits: [move('none', [0, 0])] })).toThrow(
        expect.objectContaining({ code: 'not-found' }),
      );
      expect(() => draw.sketches.add({ edits: [{ kind: 'nothing' } as never] })).toThrow(
        expect.objectContaining({ code: 'invalid-input' }),
      );
      expect(() =>
        draw.sketches.add({ edits: [move(a.id, [0, 0], { ring: 0, index: 9 })] }),
      ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
      writesOf(draw).features.update(a.id, { locked: true });
      expect(draw.sketches.add({ edits: [move(a.id, [1, 1])] })).toBeNull();
      // A sketch with an owner passes no gate
      expect(draw.sketches.add({ edits: [move(a.id, [1, 1])], owner: 'other' })).not.toBeNull();
      writesOf(draw).features.update(a.id, { locked: false });
      writesOf(draw).layers.update('default-layer', { visible: false });
      expect(draw.sketches.add({ edits: [move(b.id, [11, 1])] })).toBeNull();
      writesOf(draw).layers.update('default-layer', { visible: true });
      draw.setReadOnly(true);
      expect(draw.sketches.add({ edits: [move(b.id, [11, 1])] })).toBeNull();
      draw.setReadOnly(false);
      writesOf(draw).layers.update('default-layer', { locked: true });
      expect(draw.sketches.add({ edits: [move(b.id, [11, 1])] })).toBeNull();
      writesOf(draw).layers.update('default-layer', { locked: false });
      expect(draw.sketches.add({ id: 'd', edits: [move(b.id, [11, 1])] })).not.toBeNull();
      expect(() => draw.sketches.add({ id: 'd', edits: [] })).toThrow(
        expect.objectContaining({ code: 'already-exists' }),
      );
      expect(failures).toEqual([]);
    });

    it('commits in one transaction with one applyEdits, and a removal writes nothing', () => {
      const { draw, store, events, failures } = open(kind);
      const a = line(draw);
      const b = line(draw, 10);
      const applyEdits = vi.spyOn(
        store as unknown as { applyEdits: Store['applyEdits'] },
        'applyEdits',
      );
      const removed = draw.sketches.add({ edits: [move(b.id, [11, 5])] }) as Sketch;
      events.length = 0;
      expect(draw.sketches.remove(removed.id)).toBe(true);
      expect(applyEdits).not.toHaveBeenCalled();
      expect(events).toEqual([
        ['sketch.removed', { sketch: removed, reason: 'cancelled', dropped: 0 }],
      ]);
      expect(coordinatesOf(writesOf(draw).features.get(b.id))[1]).toEqual([11, 0]);

      const sketch = draw.sketches.add({
        edits: [
          move(a.id, [1, 1]),
          { kind: 'translate', target: { featureIds: [b.id] }, from: [0, 0], to: [0, 1] },
        ],
      }) as Sketch;
      const shown = draw.rendered.get(b.id);
      events.length = 0;
      expect(draw.sketches.commit(sketch.id)).toBe(true);
      expect(applyEdits).toHaveBeenCalledTimes(1);
      expect(names(events)).toEqual(['change', 'sketch.removed']);
      expect(events[1][1]).toEqual({ sketch, reason: 'committed', dropped: 0 });
      expect(draw.sketches.count()).toBe(0);
      expect(coordinatesOf(writesOf(draw).features.get(a.id))[1]).toEqual([1, 1]);
      expect(writesOf(draw).features.get(b.id)?.geometry).toEqual(shown?.geometry);
      expect(coordinatesOf(writesOf(draw).features.get(b.id))[0][1]).toBeGreaterThan(0.9);
      expect(() => draw.sketches.commit(sketch.id)).toThrow(
        expect.objectContaining({ code: 'not-found' }),
      );
      expect(failures).toEqual([]);
    });

    it('commits the first sketch of this client of a feature when a second one starts', () => {
      const { draw, events, failures } = open(kind);
      const a = line(draw);
      const first = draw.sketches.add({ edits: [move(a.id, [1, 1])] }) as Sketch;
      events.length = 0;
      const second = draw.sketches.add({
        edits: [{ kind: 'set', featureId: a.id, patch: { properties: { n: 1 } } }],
      }) as Sketch;
      expect(names(events)).toEqual(['change', 'sketch.removed', 'sketch.added']);
      expect(events[1][1]).toEqual({ sketch: first, reason: 'committed', dropped: 0 });
      expect(coordinatesOf(writesOf(draw).features.get(a.id))[1]).toEqual([1, 1]);
      expect(draw.sketches.list()).toEqual([second]);
      expect(failures).toEqual([]);
    });

    it('draws the sketches with an owner first, in their order, and does not commit them', () => {
      const { draw, failures } = open(kind);
      const a = line(draw);
      const mine = draw.sketches.add({
        edits: [{ kind: 'set', featureId: a.id, patch: { properties: { by: 'me' } } }],
      }) as Sketch;
      const theirs = draw.sketches.add({
        owner: 'other',
        edits: [
          { kind: 'set', featureId: a.id, patch: { properties: { by: 'other', other: true } } },
        ],
      }) as Sketch;
      expect(draw.sketches.list()).toEqual([theirs, mine]);
      expect(draw.rendered.get(a.id)?.properties).toMatchObject({
        by: 'me',
        other: true,
      });
      expect(draw.sketches.commit(theirs.id)).toBe(false);
      expect(draw.sketches.commitMany([mine.id, theirs.id])).toBe(false);
      expect(draw.sketches.count()).toBe(2);
      draw.sketches.remove(theirs.id);
      // In the public shape: the attributes, and the layer under the key of the library
      expect(draw.rendered.get(a.id)?.properties).toEqual({
        by: 'me',
        'maplibre-gl-draw:layerId': a.layerId,
      });
      expect(failures).toEqual([]);
    });

    it('leaves out a feature deleted or locked and goes on, and ends once none is left', () => {
      const { draw, events, failures } = open(kind);
      const a = line(draw);
      const b = line(draw, 10);
      const c = line(draw, 20);
      const sketch = draw.sketches.add({
        edits: [
          {
            kind: 'translate',
            target: { featureIds: [a.id, b.id, c.id] },
            from: [0, 0],
            to: [0, 1],
          },
        ],
      }) as Sketch;
      events.length = 0;
      writesOf(draw).transact(() => writesOf(draw).features.delete(a.id), { source: 'remote' });
      expect(names(events)).toEqual(['change', 'sketch.updated']);
      const updated = events[1][1] as InstanceSignals['sketch.updated'];
      expect(updated.dropped).toBe(1);
      expect(updated.sketch.edits[0]).toMatchObject({ target: { featureIds: [b.id, c.id] } });
      expect(draw.sketches.get(sketch.id)).toBe(updated.sketch);
      events.length = 0;
      writesOf(draw).features.update(b.id, { locked: true });
      expect(names(events)).toEqual(['change', 'sketch.updated']);
      expect(draw.sketches.get(sketch.id)?.edits[0]).toMatchObject({
        target: { featureIds: [c.id] },
      });
      events.length = 0;
      writesOf(draw).features.update(c.id, { locked: true });
      expect(names(events)).toEqual(['change', 'sketch.removed']);
      expect(events[1][1]).toMatchObject({ reason: 'locked', dropped: 3 });
      expect(draw.sketches.count()).toBe(0);
      expect(failures).toEqual([]);
    });

    it('ends with the reason the last features left for', () => {
      const { draw, events, failures } = open(kind);
      const a = line(draw);
      const b = line(draw, 10);
      draw.sketches.add({ edits: [move(a.id, [1, 1])] });
      draw.sketches.add({ edits: [move(b.id, [11, 1])] });
      events.length = 0;
      writesOf(draw).features.delete(a.id);
      draw.hidden.add(b.id);
      expect(
        events
          .filter(([name]) => name === 'sketch.removed')
          .map(([, p]) => (p as InstanceSignals['sketch.removed']).reason),
      ).toEqual(['deleted', 'layer-unavailable']);
      expect(failures).toEqual([]);
    });

    it('applies a sketch of a vertex again over another vertex moved, and finds it again', () => {
      const { draw, events, failures } = open(kind);
      const a = line(draw);
      const sketch = draw.sketches.add({ edits: [move(a.id, [1, 1])] }) as Sketch;
      events.length = 0;
      // Another vertex moved: the sketch goes on, over the new position
      writesOf(draw).transact(
        () =>
          writesOf(draw).features.update(a.id, {
            geometry: {
              type: 'LineString',
              coordinates: [
                [0, 2],
                [1, 0],
                [2, 0],
              ],
            },
          }),
        { source: 'remote' },
      );
      expect(draw.sketches.get(sketch.id)).toBe(sketch);
      expect(coordinatesOf(draw.rendered.get(a.id))).toEqual([
        [0, 2],
        [1, 1],
        [2, 0],
      ]);
      // A vertex added before it
      writesOf(draw).transact(
        () =>
          writesOf(draw).features.update(a.id, {
            geometry: {
              type: 'LineString',
              coordinates: [
                [-1, 0],
                [0, 2],
                [1, 0],
                [2, 0],
              ],
            },
          }),
        { source: 'remote' },
      );
      if (kind === 'ids') {
        // Found by its ID: the same vertex, now the third
        expect(draw.sketches.get(sketch.id)).toBe(sketch);
        expect(coordinatesOf(draw.rendered.get(a.id))).toEqual([
          [-1, 0],
          [0, 2],
          [1, 1],
          [2, 0],
        ]);
        // The vertex itself moved by another: its ID is gone
        events.length = 0;
        writesOf(draw).transact(
          () =>
            writesOf(draw).features.update(a.id, {
              geometry: {
                type: 'LineString',
                coordinates: [
                  [-1, 0],
                  [0, 2],
                  [1, 3],
                  [2, 0],
                ],
              },
            }),
          { source: 'remote' },
        );
        expect(events[events.length - 1]?.[1]).toMatchObject({
          reason: 'vertices-removed',
          dropped: 1,
        });
      } else {
        // Taken by its place: the shape changed, the sketch ends
        expect(events[events.length - 1]?.[0]).toBe('sketch.removed');
        expect(events[events.length - 1]?.[1]).toMatchObject({ reason: 'vertices-removed' });
      }
      expect(draw.sketches.count()).toBe(0);
      expect(failures).toEqual([]);
    });

    it('creates a feature in its place, and ends a sketch whose layer cannot be written', () => {
      const { draw, events, failures } = open(kind);
      const a = line(draw);
      const b = line(draw, 10);
      const create = (below: string | null): SketchEdit => ({
        kind: 'create',
        feature: {
          type: 'Point',
          geometry: { type: 'Point', coordinates: [5, 5] },
          id: `new-${below}`,
        },
        placedVertexCount: 1,
        below,
      });
      const first = draw.sketches.add({ edits: [create(a.id)] }) as Sketch;
      expect(draw.sketches.commit(first.id)).toBe(true);
      const items = (): string[] =>
        draw.layers.listItems('default-layer', { offset: 0, limit: 10 });
      expect(items()).toEqual([a.id, `new-${a.id}`, b.id]);
      const second = draw.sketches.add({ edits: [create(null)] }) as Sketch;
      expect(draw.sketches.commit(second.id)).toBe(true);
      expect(items()).toEqual(['new-null', a.id, `new-${a.id}`, b.id]);

      const third = draw.sketches.add({ edits: [create(b.id)] }) as Sketch;
      writesOf(draw).layers.update('default-layer', { locked: true });
      events.length = 0;
      expect(draw.sketches.commit(third.id)).toBe(false);
      expect(events).toEqual([
        ['sketch.removed', { sketch: third, reason: 'layer-unavailable', dropped: 0 }],
      ]);
      expect((third.edits[0] as { feature: { geometry: unknown } }).feature.geometry).toEqual({
        type: 'Point',
        coordinates: [5, 5],
      });
      expect(draw.features.has(`new-${b.id}`)).toBe(false);
      expect(failures).toEqual([]);
    });

    it('creates a feature given alone at the front of its layer, every vertex placed', () => {
      const { draw, engine, failures } = open(kind);
      const a = line(draw);
      const b = line(draw, 10);
      const items = (): string[] =>
        draw.layers.listItems('default-layer', { offset: 0, limit: 10 });
      const sketch = draw.sketches.add({
        edits: [
          {
            kind: 'create',
            feature: { type: 'Point', geometry: { type: 'Point', coordinates: [5, 5] }, id: 'n' },
          },
        ],
      }) as Sketch;
      expect(sketch).not.toBeNull();
      if (kind !== 'rows') {
        // Drawn in front of the features of its layer
        const drawn = engine.context.shapes.drawnFeaturesInOrder().map((f) => f.geometry.type);
        expect(drawn).toEqual(['LineString', 'LineString', 'Point']);
      }
      expect(draw.sketches.commit(sketch.id)).toBe(true);
      expect(items()).toEqual([a.id, b.id, 'n']);
      expect(writesOf(draw).features.get('n')?.geometry).toEqual({
        type: 'Point',
        coordinates: [5, 5],
      });
      expect(failures).toEqual([]);
    });

    it('draws a shape being drawn apart from the features, and writes it once it is a feature', () => {
      const { draw, engine, failures } = open(kind);
      line(draw);
      const shape = (coordinates: number[][]): SketchEdit => ({
        kind: 'create',
        feature: { type: 'LineString', geometry: { type: 'LineString', coordinates }, id: 's' },
        placedVertexCount: 1,
        highlightedVertexIndex: 0,
      });
      // A line of one position is a shape being drawn
      const sketch = draw.sketches.add({ edits: [shape([[5, 5]])] }) as Sketch;
      expect(sketch).not.toBeNull();
      const view = engine.sketches.view;
      expect(view.creates()).toEqual([]);
      expect(view.drawings()).toEqual([
        expect.objectContaining({
          owner: null,
          type: 'LineString',
          coordinates: [[5, 5]],
          layerId: 'default-layer',
          confirmedCount: 1,
          highlightedVertexIndex: 0,
          pendingFeatureId: 's',
        }),
      ]);
      expect(engine.context.shapes.drawing()?.coordinates).toEqual([[5, 5]]);
      // Not yet a feature: committing it throws, and changes nothing
      expect(() => draw.sketches.commit(sketch.id)).toThrow(
        expect.objectContaining({ code: 'invalid-input' }),
      );
      expect(draw.sketches.has(sketch.id)).toBe(true);
      draw.sketches.update(sketch.id, {
        edits: [
          shape([
            [5, 5],
            [6, 6],
          ]),
        ],
      });
      expect(draw.sketches.commit(sketch.id)).toBe(true);
      expect(writesOf(draw).features.get('s')?.geometry).toEqual({
        type: 'LineString',
        coordinates: [
          [5, 5],
          [6, 6],
        ],
      });
      expect(view.drawings()).toEqual([]);
      expect(engine.context.shapes.drawing()).toBeNull();
      expect(failures).toEqual([]);
    });

    it('ends the sketches of this client when the document becomes read-only, and all when it is replaced', () => {
      const { draw, events, failures } = open(kind);
      const a = line(draw);
      const b = line(draw, 10);
      draw.sketches.add({ edits: [move(a.id, [1, 1])] });
      const theirs = draw.sketches.add({ owner: 'other', edits: [move(b.id, [11, 1])] }) as Sketch;
      events.length = 0;
      draw.setReadOnly(true);
      expect(events.map(([, p]) => (p as InstanceSignals['sketch.removed']).reason)).toEqual([
        'read-only',
      ]);
      expect(draw.sketches.list()).toEqual([theirs]);
      draw.setReadOnly(false);
      expect(failures).toEqual([]);
    });

    it('adds, changes, removes and commits many, all of them or none', () => {
      const { draw, store, events, failures } = open(kind);
      const a = line(draw);
      const b = line(draw, 10);
      const c = line(draw, 20);
      writesOf(draw).features.update(c.id, { locked: true });
      expect(
        draw.sketches.addMany([{ edits: [move(a.id, [1, 1])] }, { edits: [move(c.id, [21, 1])] }]),
      ).toBeNull();
      expect(draw.sketches.count()).toBe(0);
      expect(() =>
        draw.sketches.addMany([{ edits: [move(a.id, [1, 1])] }, { edits: [move(a.id, [1, 2])] }]),
      ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
      const [d1, d2] = draw.sketches.addMany([
        { edits: [move(a.id, [1, 1])] },
        { edits: [move(b.id, [11, 1])] },
      ]) as Sketch[];
      expect(() =>
        draw.sketches.updateMany([
          { id: d1.id, patch: { edits: [move(a.id, [1, 3])] } },
          { id: 'none', patch: {} },
        ]),
      ).toThrow(expect.objectContaining({ code: 'not-found' }));
      expect(draw.sketches.get(d1.id)).toBe(d1);
      const [u1] = draw.sketches.updateMany([
        { id: d1.id, patch: { edits: [move(a.id, [1, 3])] } },
      ]) as Sketch[];
      expect(coordinatesOf(draw.rendered.get(a.id))[1]).toEqual([1, 3]);
      expect(() => draw.sketches.removeMany([d2.id, 'none'])).toThrow(
        expect.objectContaining({ code: 'not-found' }),
      );
      expect(draw.sketches.count()).toBe(2);
      const applyEdits = vi.spyOn(
        store as unknown as { applyEdits: Store['applyEdits'] },
        'applyEdits',
      );
      events.length = 0;
      expect(draw.sketches.commitMany([u1.id, d2.id])).toBe(true);
      expect(names(events)).toEqual(['change', 'sketch.removed', 'sketch.removed']);
      expect(applyEdits).toHaveBeenCalledTimes(2);
      expect(coordinatesOf(writesOf(draw).features.get(b.id))[1]).toEqual([11, 1]);
      expect(failures).toEqual([]);
    });

    it('edits the features selected, the locked ones left out, and ends once none is', () => {
      const { draw, events, failures } = open(kind);
      const a = line(draw);
      const b = line(draw, 10);
      draw.selection.set('feature', [a.id, b.id]);
      writesOf(draw).features.update(b.id, { locked: true });
      const sketch = draw.sketches.add({
        edits: [{ kind: 'translate', target: { selection: true }, from: [0, 0], to: [0, 0.5] }],
      }) as Sketch;
      expect(coordinatesOf(draw.rendered.get(a.id))[0][1]).toBeGreaterThan(0.4);
      expect(coordinatesOf(draw.rendered.get(b.id))[0][1]).toBe(0);
      events.length = 0;
      draw.selection.clear();
      expect(events).toEqual([['sketch.removed', { sketch, reason: 'deselected', dropped: 0 }]]);
      draw.selection.set('feature', [b.id]);
      expect(
        draw.sketches.add({
          edits: [{ kind: 'translate', target: { selection: true }, from: [0, 0], to: [0, 1] }],
        }),
      ).toBeNull();
      expect(failures).toEqual([]);
    });

    it('adds and commits in a transaction of the application', () => {
      const { draw, events, failures } = open(kind);
      const a = line(draw);
      events.length = 0;
      writesOf(draw).transact(() => {
        const sketch = draw.sketches.add({ edits: [move(a.id, [1, 1])] }) as Sketch;
        writesOf(draw).features.update(a.id, { properties: { n: 1 } });
        draw.sketches.commit(sketch.id);
      });
      expect(names(events)).toEqual(['sketch.added', 'sketch.removed', 'change']);
      expect(coordinatesOf(writesOf(draw).features.get(a.id))[1]).toEqual([1, 1]);
      expect(writesOf(draw).features.get(a.id)?.properties).toEqual({ n: 1 });
      // A transaction that writes nothing but draws a sketch
      writesOf(draw).transact(() => draw.sketches.add({ edits: [move(a.id, [1, 2])] }));
      writesOf(draw).features.update(a.id, { properties: { n: 2 } });
      expect(failures).toEqual([]);
    });

    it('runs the checks of the sketches, which find what is drawn broken', () => {
      const { engine, draw, failures } = open(kind, ['sketches', 'sketch-commits']);
      const a = line(draw);
      const shape: SketchEdit = {
        kind: 'set',
        featureId: a.id,
        patch: {
          geometry: {
            type: 'LineString',
            coordinates: [
              [0.5, 0.5],
              [1.5, 1.5],
            ],
          },
        },
      };
      const sketch = draw.sketches.add({ edits: [shape] }) as Sketch;
      expect(failures).toEqual([]);
      // The sketch hidden no more, or drawn as something else
      const tables = featureTablesInternals(draw.getStore().tables);
      if (tables) {
        const handle = tables.ids.handleOf(a.id);
        const place = tables.placeOf(handle)!;
        expect(place.group.state[place.row] & STATE_HIDDEN_SKETCH).not.toBe(0);
        tables.states.setSketched(Int32Array.of(handle), false);
      } else {
        engine.sketches.view.set(new Map(), []);
      }
      line(draw, 30);
      expect(failures.map((f) => f.check)).toContain('sketches');
      failures.length = 0;
      // A commit that writes other than what was drawn
      draw.sketches.remove(sketch.id);
      const second = draw.sketches.add({ edits: [shape] }) as Sketch;
      expect(failures).toEqual([]);
      // Drawn otherwise than the sketch leaves it
      const drawn = engine.sketches.view.liveFeatures().get(a.id) as Feature;
      engine.sketches.view.set(
        new Map([
          [
            a.id,
            {
              ...drawn,
              geometry: {
                type: 'LineString',
                coordinates: [
                  [9, 9],
                  [8, 8],
                ],
              },
            },
          ],
        ]),
        [],
      );
      expect(draw.sketches.commit(second.id)).toBe(true);
      expect(failures.map((f) => f.check)).toContain('sketch-commits');
    });
  });
}

describe('a sketch of one edit that moves rows', () => {
  const translate = (ids: string[], by: number): SketchEdit => ({
    kind: 'translate',
    target: { featureIds: ids },
    from: [0, 0],
    to: [by, 0],
  });

  /** The bits of the state of the row of a feature */
  function stateOf(draw: Draw, id: string): number {
    const tables = draw.getStore().tables;
    return featureTablesInternals(tables)?.states.stateOf(tables?.getRowRef(id) ?? -1) ?? 0;
  }

  const setOf = (draw: Draw, id: string): number =>
    (stateOf(draw, id) & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT;

  it('draws them moved by a moving set, their values untouched, and writes them once', () => {
    const { draw, failures } = open('rows');
    const a = line(draw);
    const sketch = draw.sketches.add({ edits: [translate([a.id], 1)] }) as Sketch;
    expect(setOf(draw, a.id)).toBe(SKETCH_MOVE_SET);
    expect(stateOf(draw, a.id) & STATE_HIDDEN_SKETCH).toBe(0);
    expect(coordinatesOf(writesOf(draw).features.get(a.id))[0]).toEqual([0, 0]);
    expect(coordinatesOf(draw.rendered.get(a.id))[0]?.[0]).toBeCloseTo(1, 9);
    draw.sketches.update(sketch.id, { edits: [translate([a.id], 2)] });
    expect(coordinatesOf(draw.rendered.get(a.id))[0]?.[0]).toBeCloseTo(2, 9);
    expect(draw.sketches.commit(sketch.id)).toBe(true);
    expect(setOf(draw, a.id)).toBe(0);
    expect(coordinatesOf(writesOf(draw).features.get(a.id))[0]?.[0]).toBeCloseTo(2, 9);
    expect(failures).toEqual([]);
  });

  it('leaves them where they are once removed', () => {
    const { draw, failures } = open('rows');
    const a = line(draw);
    const sketch = draw.sketches.add({ edits: [translate([a.id], 1)] }) as Sketch;
    draw.sketches.remove(sketch.id);
    expect(setOf(draw, a.id)).toBe(0);
    expect(coordinatesOf(draw.rendered.get(a.id))[0]).toEqual([0, 0]);
    expect(failures).toEqual([]);
  });

  it('draws a row another sketch edits too on the slow path, both applied', () => {
    const { draw, failures } = open('rows');
    const a = line(draw);
    const b = line(draw, 10);
    draw.sketches.add({ edits: [translate([a.id, b.id], 1)] });
    expect(setOf(draw, b.id)).toBe(SKETCH_MOVE_SET);
    const other = draw.sketches.add({ owner: 'other', edits: [translate([b.id], 2)] }) as Sketch;
    expect(setOf(draw, a.id)).toBe(SKETCH_MOVE_SET);
    expect(setOf(draw, b.id)).toBe(0);
    expect(stateOf(draw, b.id) & STATE_HIDDEN_SKETCH).not.toBe(0);
    expect(coordinatesOf(draw.rendered.get(b.id))[0]?.[0]).toBeCloseTo(13, 9);
    draw.sketches.remove(other.id);
    expect(setOf(draw, b.id)).toBe(SKETCH_MOVE_SET);
    expect(stateOf(draw, b.id) & STATE_HIDDEN_SKETCH).toBe(0);
    expect(failures).toEqual([]);
  });

  it('draws the rows of a sketch that finds the moving set taken on the slow path', () => {
    const { draw, failures } = open('rows');
    const a = line(draw);
    const b = line(draw, 10);
    draw.sketches.add({ edits: [translate([a.id], 1)] });
    draw.sketches.add({ edits: [translate([b.id], 1)] });
    expect(setOf(draw, a.id)).toBe(SKETCH_MOVE_SET);
    expect(setOf(draw, b.id)).toBe(0);
    expect(stateOf(draw, b.id) & STATE_HIDDEN_SKETCH).not.toBe(0);
    expect(coordinatesOf(draw.rendered.get(b.id))[0]?.[0]).toBeCloseTo(11, 9);
    expect(failures).toEqual([]);
  });

  it('draws them where they are written in a frame of an image of the map', () => {
    const { draw, engine, failures } = open('rows');
    const a = line(draw);
    draw.sketches.add({ edits: [translate([a.id], 1)] });
    const shapes = engine.context.shapes;
    const tables = featureTablesInternals(draw.getStore().tables)!;
    expect(shapes.rowMotion(tables, SKETCH_MOVE_SET).transform).not.toBeNull();
    shapes.setWritten(true);
    // The row stays in its moving set, which moves it nowhere in that frame
    expect(setOf(draw, a.id)).toBe(SKETCH_MOVE_SET);
    expect(shapes.rowMotion(tables, SKETCH_MOVE_SET)).toEqual({
      translation: [0, 0],
      transform: null,
    });
    // The row is read as dragged, drawn where it is written
    const handle = tables.ids.handleOf(a.id);
    const inPlace = shapes.draggedRows();
    expect(inPlace?.has(handle)).toBe(true);
    expect(inPlace?.position(handle, [0, 0])).toEqual([0, 0]);
    expect(draggedRowMotionsOf(inPlace!)?.translation(SKETCH_MOVE_SET)).toEqual([0, 0]);
    expect(draggedRowMotionsOf(inPlace!)?.transform(SKETCH_MOVE_SET)).toBeNull();
    expect(draggedRowMotionsOf(inPlace!)?.gpuStateOf(handle)).not.toBe(0);
    expect(coordinatesOf(draw.rendered.get(a.id))[0]).toEqual([0, 0]);
    shapes.setWritten(false);
    expect(shapes.rowMotion(tables, SKETCH_MOVE_SET).transform).not.toBeNull();
    expect(coordinatesOf(draw.rendered.get(a.id))[0]?.[0]).toBeCloseTo(1, 9);
    expect(failures).toEqual([]);
  });

  it('runs the checks of the sketches, which find a row out of its moving set', () => {
    const { draw, failures } = open('rows', ['sketches']);
    const a = line(draw);
    draw.sketches.add({ edits: [translate([a.id], 1)] });
    expect(failures).toEqual([]);
    const tables = draw.getStore().tables;
    featureTablesInternals(tables)?.states.setMoving(
      Int32Array.of(tables?.getRowRef(a.id) ?? -1),
      0,
    );
    line(draw, 30);
    expect(failures.map((f) => f.check)).toContain('sketches');
  });
});

for (const kind of KINDS) {
  describe(`a frame of an image of the map over the Store of ${kind}`, () => {
    /** The sketches of this client and of another one: a vertex of each line, and a line drawn */
    function sketched(draw: Draw): { a: Feature; b: Feature } {
      const a = line(draw);
      const b = line(draw, 10);
      draw.sketches.add({ edits: [move(a.id, [1, 1])] });
      draw.sketches.add({ owner: 'other', edits: [move(b.id, [11, 1])] });
      draw.sketches.add({
        owner: 'other',
        edits: [
          {
            kind: 'create',
            feature: {
              type: 'LineString',
              geometry: {
                type: 'LineString',
                coordinates: [
                  [20, 0],
                  [21, 0],
                ],
              },
            },
          },
        ],
      });
      return { a, b };
    }

    /** Whether the row of a feature is hidden by the mark of the sketches */
    function hiddenBySketch(draw: Draw, id: string): boolean {
      const tables = featureTablesInternals(draw.getStore().tables);
      if (!tables) return false;
      const place = tables.placeOf(tables.ids.handleOf(id))!;
      return (place.group.state[place.row] & STATE_HIDDEN_SKETCH) !== 0;
    }

    it('reads the shapes as written, the sketches of every client left out, and as seen again after', () => {
      const { draw, engine, failures } = open(kind);
      const { a, b } = sketched(draw);
      const shapes = engine.context.shapes;
      const [created] = shapes.createdIds();
      expect(created).toBeDefined();
      const changes: StoreChange[] = [];
      engine.sketches.view.onChange((change) => changes.push(change));
      const rows = kind === 'rows';

      shapes.setWritten(true);
      expect(coordinatesOf(draw.rendered.get(a.id))[1]).toEqual([1, 0]);
      expect(coordinatesOf(draw.rendered.get(b.id))[1]).toEqual([11, 0]);
      expect(draw.rendered.get(created as string)).toBeUndefined();
      expect(shapes.sketched).toBe(false);
      expect(shapes.sketchedIds()).toEqual([]);
      expect(shapes.createdIds()).toEqual([]);
      if (rows) {
        // The rows of the delta go, and the rows they hid are drawn
        expect(hiddenBySketch(draw, a.id)).toBe(false);
        expect(hiddenBySketch(draw, b.id)).toBe(false);
        expect(changes).toEqual([]);
      } else {
        expect(shapes.drawnFeaturesInOrder()).toEqual(draw.getStore().listFeaturesInOrder());
        // The drawing is told the features as the Store has them
        const [change] = changes;
        expect(changes).toHaveLength(1);
        expect(change?.features?.updated?.map((u) => [u.id, u.feature]).sort()).toEqual(
          [
            [a.id, draw.getStore().getFeature(a.id)],
            [b.id, draw.getStore().getFeature(b.id)],
          ].sort(),
        );
        expect(change?.features?.deleted?.map((f) => f.id)).toEqual([created]);
      }
      // What hits reads as in every frame, and the snapping finds the shape this client draws
      expect(shapes.hitFeature(a.id)).toBe(draw.getStore().getFeature(a.id));

      shapes.setWritten(false);
      expect(coordinatesOf(draw.rendered.get(a.id))[1]).toEqual([1, 1]);
      expect(coordinatesOf(draw.rendered.get(b.id))[1]).toEqual([11, 1]);
      expect(shapes.createdIds()).toEqual([created]);
      if (rows) {
        expect(hiddenBySketch(draw, a.id)).toBe(true);
        expect(hiddenBySketch(draw, b.id)).toBe(true);
      } else {
        const change = changes[1];
        expect(changes).toHaveLength(2);
        expect(change?.features?.updated?.map((u) => u.id).sort()).toEqual([a.id, b.id].sort());
        expect(change?.features?.created?.map((f) => f.id)).toEqual([created]);
      }
      line(draw, 30);
      expect(failures).toEqual([]);
    });

    it('draws a sketch changed while the shapes are read as written once they are seen again', () => {
      const { draw, engine, failures } = open(kind);
      const a = line(draw);
      const sketch = draw.sketches.add({ edits: [move(a.id, [1, 1])] }) as Sketch;
      const shapes = engine.context.shapes;
      shapes.setWritten(true);
      draw.sketches.update(sketch.id, { edits: [move(a.id, [1, 2])] });
      expect(coordinatesOf(draw.rendered.get(a.id))[1]).toEqual([1, 0]);
      if (kind === 'rows') expect(hiddenBySketch(draw, a.id)).toBe(false);
      shapes.setWritten(false);
      expect(coordinatesOf(draw.rendered.get(a.id))[1]).toEqual([1, 2]);
      if (kind === 'rows') {
        expect(hiddenBySketch(draw, a.id)).toBe(true);
        expect(
          featureTablesInternals(draw.getStore().tables)?.sketchGeometryOf(a.id),
        ).toMatchObject({
          coordinates: [
            [0, 0],
            [1, 2],
            [2, 0],
          ],
        });
      } else {
        // What is drawn is what `draw.rendered` reads, in the public shape
        expect(draw.rendered.get(a.id)).toEqual(
          toFeature(engine.sketches.view.drawnFeature(a.id) as Feature),
        );
      }
      line(draw, 30);
      expect(failures).toEqual([]);
    });
  });
}

describe('the checks of the sketches as a failure', () => {
  it('throws from the operation that found them', () => {
    const { draw, engine } = open('objects');
    const a = line(draw);
    draw.sketches.add({ edits: [move(a.id, [1, 1])] });
    engine.sketches.view.set(new Map(), []);
    expect(() => line(draw, 10)).toThrow(/\(sketches\)/);
  });
});
