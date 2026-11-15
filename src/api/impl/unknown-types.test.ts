// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The features of a type the instance does not know (`store/feature-types.ts`), on both Stores
 *
 * - They are kept with every value they have, and read
 * - They are not hit: neither a click, a pick nor a box finds them, nothing snaps to them, and
 *   they have no selection box
 * - A write of their attributes, their place and their deletion is taken; a write of their
 *   geometry fails with `invalidState` when it names them, and leaves them out when a filter or
 *   every feature names them; a write of this client to the Store leaves their geometry as it is
 * - Once their type is defined (by a plugin, or by the collection of the feature types) they are
 *   hit and framed, and no longer once it is removed; undo gives back a geometry they had
 */

import type { Polygon } from 'geojson';
import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from '../../extend/index.js';
import type { EngineModeContext } from '../../modes/handler.js';
import { queryFeaturesInBox } from '../../modes/select/box-selection.js';
import { queryRowsInBox } from '../../modes/select/bulk.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { BoxSelection } from '../../store/types.js';
import { createMapStub, createSyntheticInput } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine, type Engine } from './engine.js';

const opened: Draw[] = [];
afterEach(() => {
  for (const draw of opened.splice(0)) draw.destroy();
});

/** The type no part of the instance defines */
const MYSTERY = 'acme:mystery';

const square = (x: number, y: number, half: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [x - half, y - half],
      [x + half, y - half],
      [x + half, y + half],
      [x - half, y + half],
      [x - half, y - half],
    ],
  ],
});

/**
 * An instance with a layer `l`: a feature `m` of a type it does not know (a square of 1° around
 * [5, 5], written to its Store as a document that lacks the extension of its type opens), and
 * a polygon `k` (a square of 0.4° around [5, 5]) and a polygon `far` (around [9, 9])
 */
function open(rows: boolean): { draw: Draw; engine: Engine; store: Store } {
  const store = rows ? createTableStore().store : new MemoryStore();
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    ...(store.tables ? { kind: 'table' } : { items: [] }),
    styleRule: undefined,
    metadata: undefined,
  } as never);
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  opened.push(draw);
  const write = engine.context.store;
  for (const [id, type, geometry] of [
    ['m', MYSTERY, square(5, 5, 0.5)],
    ['k', 'Polygon', square(5, 5, 0.2)],
    ['far', 'Polygon', square(9, 9, 0.2)],
  ] as const) {
    write.createFeature({
      id,
      type,
      geometry,
      layerId: 'l',
      groupId: undefined,
      properties: {},
      style: {},
      locked: false,
      visible: true,
    });
  }
  return { draw, engine, store: write };
}

/** The IDs picked at a position */
function pickedAt(draw: Draw, engine: Engine, at: [number, number]): string[] {
  const { x, y } = engine.map.project(at);
  return draw.features.pick([x, y]).map((hit) => hit.feature.id);
}

/** The IDs in a box from [4, 4] to [6, 6], as the select mode finds them on the Store */
function inBox(engine: Engine): string[] {
  const box = { startPoint: [4, 4], endPoint: [6, 6] } as unknown as BoxSelection;
  const context = engine.context as unknown as EngineModeContext;
  const store = engine.context.store;
  const tables = store.tables;
  if (!tables) return queryFeaturesInBox(box, context);
  return [...queryRowsInBox(box, context).handles].map((handle) => tables.getRowId(handle) ?? '');
}

/** The ID of the feature the snapping takes at a position, if any */
function snappedAt(engine: Engine, at: [number, number]): string | undefined {
  const { x, y } = engine.map.project(at);
  const result = engine.context.snapService.resolve(
    { lng: at[0], lat: at[1] },
    { x, y },
    { zoom: 10, modifiers: { shift: false, ctrl: false, alt: false, meta: false } },
  );
  return (result.target as { featureId?: string } | null | undefined)?.featureId;
}

/** The first position of the outer ring of a feature */
function cornerOf(store: Store, id: string): number[] | undefined {
  return (store.getFeature(id)?.geometry as Polygon | undefined)?.coordinates[0]?.[0];
}

/** A plugin that defines the type */
const defining: Plugin = {
  name: 'acme-mystery',
  setup(ctx) {
    ctx.addFeatureType({ name: MYSTERY, footprint: (f) => f.geometry });
  },
};

for (const rows of [false, true]) {
  const kind = rows ? 'a Store of rows' : 'a Store of objects';

  describe(`a feature of a type the instance does not know, on ${kind}`, () => {
    it('is kept with its values and read', () => {
      const { draw } = open(rows);
      const read = draw.features.get('m');
      expect(read?.geometry).toEqual(square(5, 5, 0.5));
      expect(read?.properties['maplibre-gl-draw:featureType']).toBe(MYSTERY);
    });

    it('is neither hit by a click, a pick nor a box, nor snapped to, and has no selection box', () => {
      const { draw, engine, store } = open(rows);
      // Inside m only, then inside k too
      expect(pickedAt(draw, engine, [5.4, 5.4])).toEqual([]);
      expect(pickedAt(draw, engine, [5, 5])).toEqual(['k']);
      expect(inBox(engine)).toEqual(['k']);
      const input = createSyntheticInput(engine);
      input.click([5.4, 5.4]);
      expect(store.getSelection().ids).toEqual([]);
      input.click([5, 5]);
      expect(store.getSelection().ids).toEqual(['k']);
      // Its corner is not snapped to (the corner of k is)
      expect(snappedAt(engine, [5.5, 5.5])).not.toBe('m');
      expect(snappedAt(engine, [5.2, 5.2])).toBe('k');
      // Selected by its ID, it has no box and no handle
      draw.selection.set('feature', ['m']);
      expect(draw.rendered.getSelectionBox('m')).toBeNull();
      expect(draw.rendered.getFootprint('m')).toBeNull();
      expect(engine.context.shapes.handleFeatures(['m', 'k'])).toHaveLength(1);
    });

    it('takes a write of its attributes, its place and its deletion', async () => {
      const { draw, store } = open(rows);
      await draw.write((tx) => tx.features.update('m', { properties: { note: 'kept' } }));
      expect(store.getFeature('m')?.properties.note).toBe('kept');
      expect(store.getFeature('m')?.geometry).toEqual(square(5, 5, 0.5));
      await draw.write((tx) => tx.features.place('m', { above: 'k' }));
      await draw.write((tx) => tx.features.delete('m'));
      expect(store.getFeature('m')).toBeUndefined();
    });

    it('fails a write of its geometry that names it, and leaves it out of one of every feature', async () => {
      const { draw, store } = open(rows);
      const moved = { from: [0, 0], to: [1, 0] };
      await expect(
        draw.write((tx) => tx.features.update('m', { geometry: square(0, 0, 1) })),
      ).rejects.toMatchObject({ code: 'invalidState', ids: ['m'] });
      await expect(
        draw.write((tx) =>
          tx.features.update([
            { id: 'k', patch: { geometry: square(0, 0, 1) } },
            { id: 'm', patch: { geometry: square(0, 0, 1) } },
          ]),
        ),
      ).rejects.toMatchObject({ code: 'invalidState', ids: ['m'] });
      await expect(
        draw.write((tx) => tx.features.translate(['k', 'm'], moved)),
      ).rejects.toMatchObject({ code: 'invalidState', ids: ['m'] });
      await expect(
        draw.write((tx) => tx.features.rotate('m', { center: [5, 5], angleDegrees: 30 })),
      ).rejects.toMatchObject({ code: 'invalidState' });
      await expect(draw.write((tx) => tx.features.union(['m', 'k']))).rejects.toMatchObject({
        code: 'invalidState',
      });
      // Nothing of the failed writes is written
      expect(store.getFeature('m')?.geometry).toEqual(square(5, 5, 0.5));
      expect(store.getFeature('k')?.geometry).toEqual(square(5, 5, 0.2));
      // Every feature: the others move, and it is not counted
      let count = 0;
      await draw.write(async (tx) => {
        count = await tx.features.translate({ all: true }, moved);
      });
      expect(count).toBe(2);
      expect(cornerOf(store, 'k')).not.toEqual([4.8, 4.8]);
      expect(store.getFeature('m')?.geometry).toEqual(square(5, 5, 0.5));
    });

    it('keeps its geometry against a write of this client to the Store', () => {
      const { engine, store } = open(rows);
      const result = store.applyEdits([
        { kind: 'translate', target: { featureIds: ['k', 'm'] }, from: [0, 0], to: [1, 0] },
        { kind: 'set', featureId: 'm', patch: { geometry: square(0, 0, 1) } },
        { kind: 'vertexDelete', featureId: 'm', vertices: [{ ring: 0, index: 0 }] },
      ]);
      // Each feature left out is counted as dropped
      expect(result?.dropped).toBe(3);
      expect(cornerOf(store, 'k')).not.toEqual([4.8, 4.8]);
      expect(store.getFeature('m')?.geometry).toEqual(square(5, 5, 0.5));
      expect(store.updateFeature('m', { geometry: square(0, 0, 1) })).toBe(false);
      expect(engine.context.store.getFeature('m')?.geometry).toEqual(square(5, 5, 0.5));
    });

    it('is hit and framed once a plugin defines its type, and no longer once it is removed', async () => {
      const { draw, engine } = open(rows);
      const controller = new AbortController();
      draw.use(defining, { signal: controller.signal });
      expect(draw.rendered.getSelectionBox('m')).not.toBeNull();
      expect(pickedAt(draw, engine, [5.4, 5.4])).toEqual(['m']);
      expect(inBox(engine).sort()).toEqual(['k', 'm']);
      await draw.write((tx) => tx.features.translate('m', { from: [0, 0], to: [0, 1] }));
      controller.abort();
      expect(draw.rendered.getSelectionBox('m')).toBeNull();
      expect(pickedAt(draw, engine, [5.4, 6.4])).toEqual([]);
      expect(inBox(engine)).toEqual(['k']);
    });

    it('gives back on undo the geometry it had, once its type is no longer defined', async () => {
      const { draw, store } = open(rows);
      draw.extensions.featureTypes.add({ type: MYSTERY, geometry: 'Polygon' });
      await draw.write((tx) => tx.features.translate('m', { from: [0, 0], to: [0, 1] }));
      expect(cornerOf(store, 'm')).not.toEqual([4.5, 4.5]);
      draw.extensions.featureTypes.remove(MYSTERY);
      await draw.undo();
      expect(store.getFeature('m')?.geometry).toEqual(square(5, 5, 0.5));
      await draw.redo();
      expect(cornerOf(store, 'm')).not.toEqual([4.5, 4.5]);
    });
  });
}
