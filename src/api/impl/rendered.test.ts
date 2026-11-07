// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of `draw.rendered`: the features as they are drawn (the sketches applied), their
 * selection boxes made by the function the selection UI draws and hits them with, and
 * `rendered.changed`, told once the draw that draws a change is done: the features written, those
 * a sketch edits, and the rows a Store of rows writes (it tells them by their handles); not a
 * change of the look (a layer rule, the `style` option), which a draw reads each time
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BULK_MOVE_SET } from '../../feature-table/row-state.js';
import { createCoordinateTransform } from '../../shared/math/index.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import { createMapStub, internalsOf } from '../../test-utils.js';
import { selectionBoxOf } from '../../view/ui/bounds.js';
import type { Draw } from '../draw.js';
import type { Feature } from '../model.js';
import type { FeatureTables } from '../tables.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

let engine: Engine;
let draw: Draw;
/** Draws a frame: the drawing tells the frames drawn by this one signal */
let drawFrame: () => void;

beforeEach(() => {
  const listeners = new Set<() => void>();
  engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
  engine.customLayer.onFrameDrawn = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  drawFrame = () => {
    for (const listener of [...listeners]) listener();
  };
  draw = createDrawOnEngine(engine);
  engine.enterDefaultMode();
});
afterEach(() => {
  draw.destroy();
});

const line = (): Feature =>
  draw.features.create({
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
  }) as Feature;

describe('draw.rendered', () => {
  it('reads the features as they are drawn, with the sketches applied over the document', () => {
    const a = line();
    draw.sketches.add({
      edits: [
        {
          kind: 'vertex-move',
          featureId: a.id,
          vertices: [{ ring: 0, index: 1 }],
          positions: [[2, 2]],
        },
      ],
    });
    const second = (feature: Feature | undefined) =>
      (feature?.geometry as GeoJSON.LineString | undefined)?.coordinates[1];
    expect(second(draw.features.get(a.id))).toEqual([1, 1]);
    expect(second(draw.rendered.get(a.id))).toEqual([2, 2]);
    expect(draw.rendered.getMany([a.id, 'none', a.id]).map((f) => f?.id)).toEqual([
      a.id,
      undefined,
      a.id,
    ]);
    expect(draw.rendered.get('none')).toBeUndefined();
  });

  it('reads a feature a sketch creates by the ID it is drawn with', () => {
    draw.sketches.add({
      edits: [
        {
          kind: 'create',
          feature: {
            type: 'Point',
            geometry: { type: 'Point', coordinates: [3, 4] },
          },
          placedVertexCount: 1,
          below: null,
        },
      ],
    });
    const key = engine.sketches.view.creates()[0]?.key as string;
    expect(draw.rendered.get(key)?.geometry).toEqual({ type: 'Point', coordinates: [3, 4] });
    expect(draw.features.get(key)).toBeUndefined();
  });

  it('gives the selection box the selection UI draws: the footprint with the margin', () => {
    const a = line();
    const point = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
    }) as Feature;
    const { context } = engine;
    const margin = context.selectionStyle.box.margin;
    const extensions = context.selectionScope.extensions;
    const transform = createCoordinateTransform(draw.getMap());
    const expected = selectionBoxOf(
      context.store.getFeature(a.id) as StoredFeature,
      transform,
      margin,
      extensions,
    );
    expect(expected?.kind).toBe('ground');
    const box = draw.rendered.getSelectionBox(a.id);
    if (box?.kind !== 'ground' || expected?.kind !== 'ground') throw new Error('not on the map');
    expect(box.corners).toEqual({
      topLeft: expected.topLeft,
      topRight: expected.topRight,
      bottomRight: expected.bottomRight,
      bottomLeft: expected.bottomLeft,
    });
    // Outside the extent of the line on every side
    expect(box.corners.topLeft[0]).toBeLessThan(0);
    expect(box.corners.bottomRight[1]).toBeLessThan(0);
    // A point is a box of the screen: its marker (a radius of 6 px, an outline of 2 px) and the
    // margin around it
    expect(draw.rendered.getSelectionBox(point.id)).toEqual({
      kind: 'screen',
      position: [1, 1],
      halfWidthPx: 8 + margin,
      halfHeightPx: 8 + margin,
    });
    expect(draw.rendered.getSelectionBox('none')).toBeNull();
  });

  it('gives the footprint as it is drawn: the box the selection box adds the margin to', () => {
    const a = line();
    const point = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
    }) as Feature;
    // An image of 100 by 50 pixels at zoom 1, turned by 30 degrees: its four corners as drawn
    const image = draw.features.create({
      type: 'Image',
      geometry: { type: 'Point', coordinates: [2, 2] },
      properties: {
        'maplibre-gl-draw:imageWidth': 100,
        'maplibre-gl-draw:imageHeight': 50,
        'maplibre-gl-draw:createdZoom': 1,
        'maplibre-gl-draw:rotation': 30,
      },
    }) as Feature;
    const { context } = engine;
    const extensions = context.selectionScope.extensions;
    const transform = createCoordinateTransform(draw.getMap());
    for (const feature of [a, image]) {
      const expected = selectionBoxOf(
        context.store.getFeature(feature.id) as StoredFeature,
        transform,
        0,
        extensions,
      );
      const footprint = draw.rendered.getFootprint(feature.id);
      if (footprint?.kind !== 'ground' || expected?.kind !== 'ground') {
        throw new Error('not on the map');
      }
      expect(footprint.corners).toEqual({
        topLeft: expected.topLeft,
        topRight: expected.topRight,
        bottomRight: expected.bottomRight,
        bottomLeft: expected.bottomLeft,
      });
    }
    // The line: the extent of its positions, without the margin
    const ofLine = draw.rendered.getFootprint(a.id);
    expect(ofLine?.kind === 'ground' && ofLine.corners.topLeft).toEqual([0, 1]);
    // The image is turned: its corners are not those of an upright box
    const ofImage = draw.rendered.getFootprint(image.id);
    if (ofImage?.kind !== 'ground') throw new Error('not on the map');
    expect(ofImage.corners.topLeft[1]).not.toBeCloseTo(ofImage.corners.topRight[1], 6);
    // A point: the box of its marker on the screen, without the margin
    expect(draw.rendered.getFootprint(point.id)).toEqual({
      kind: 'screen',
      position: [1, 1],
      halfWidthPx: 8,
      halfHeightPx: 8,
    });
    expect(draw.rendered.getFootprint('none')).toBeNull();
  });

  it('has no dragged rows over a Store of objects', () => {
    expect(draw.rendered.getDraggedRows()).toBeNull();
  });
});

describe('rendered.changed', () => {
  it('tells the features changed once the frame that draws them is drawn, once a frame', () => {
    const told: (readonly string[])[] = [];
    draw.on('rendered.changed', ({ ids }) => told.push(ids));
    const a = line();
    const b = line();
    draw.features.update(a.id, { style: { strokeWidth: 4 } });
    expect(told).toEqual([]);
    drawFrame();
    expect(told).toEqual([[a.id, b.id]]);
    // Nothing changed since: nothing is told
    drawFrame();
    expect(told).toHaveLength(1);
  });

  it('tells the features a sketch edits, then edits no more, and those deleted', () => {
    const told: (readonly string[])[] = [];
    const a = line();
    const b = line();
    drawFrame();
    draw.on('rendered.changed', ({ ids }) => told.push([...ids].sort()));
    const sketch = draw.sketches.add({
      edits: [{ kind: 'set', featureId: a.id, patch: { style: { strokeWidth: 3 } } }],
    });
    drawFrame();
    // The sketch moves to the other feature: both are drawn otherwise
    draw.sketches.update(sketch?.id as string, {
      edits: [{ kind: 'set', featureId: b.id, patch: { style: { strokeWidth: 3 } } }],
    });
    drawFrame();
    draw.sketches.remove(sketch?.id as string);
    draw.features.delete(a.id);
    drawFrame();
    expect(told).toEqual([[a.id], [a.id, b.id].sort(), [a.id, b.id].sort()]);
  });

  it('tells the features of the rows a Store of rows writes, and no change of the look', () => {
    draw.destroy();
    const { store } = createTableStore();
    store.createLayer({
      id: 'rows',
      name: 'rows',
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      styleRule: undefined,
      metadata: undefined,
    });
    store.transact(() => {
      for (const id of ['r0', 'r1', 'r2']) {
        store.createFeature({
          id,
          type: 'Point',
          geometry: { type: 'Point', coordinates: [0, 0] },
          layerId: 'rows',
          groupId: undefined,
          properties: {},
          style: {},
          visible: true,
          locked: false,
        });
      }
    });
    const listeners = new Set<() => void>();
    engine = createEngine(
      createMapStub().map,
      { store, initDefaultLayer: false },
      { deferDefaultMode: true },
    );
    engine.customLayer.onFrameDrawn = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    drawFrame = () => {
      for (const listener of [...listeners]) listener();
    };
    draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
    engine.enterDefaultMode();
    drawFrame();
    const told: string[][] = [];
    draw.on('rendered.changed', ({ ids }) => told.push([...ids].sort()));
    const notified: boolean[] = [];
    draw.on('document.changed', (change) => {
      notified.push(change.rows !== undefined && (change.features?.updated ?? []).length === 0);
    });
    // Written as rows only: the change names no feature
    draw.features.update('r1', { geometry: { type: 'Point', coordinates: [1, 1] } });
    draw.features.delete('r2');
    expect(notified).toEqual([true, true]);
    drawFrame();
    expect(told).toEqual([['r1', 'r2']]);
    // A change of the look is read by each draw, not told
    draw.layers.update('rows', { styleRule: { kind: 'single', color: '#00ff00' } });
    draw.options.update({ style: { point: { pointRadius: 9 } } });
    drawFrame();
    expect(told).toHaveLength(1);
  });

  it('tells the rows moved by their state: as they start, at each motion, and as they end', () => {
    draw.destroy();
    const { store } = createTableStore();
    store.createLayer({
      id: 'rows',
      name: 'rows',
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      styleRule: undefined,
      metadata: undefined,
    });
    store.transact(() => {
      for (const id of ['r0', 'r1', 'r2']) {
        store.createFeature({
          id,
          type: 'Point',
          geometry: { type: 'Point', coordinates: [0, 0] },
          layerId: 'rows',
          groupId: undefined,
          properties: {},
          style: {},
          visible: true,
          locked: false,
        });
      }
    });
    const listeners = new Set<() => void>();
    engine = createEngine(
      createMapStub().map,
      { store, initDefaultLayer: false },
      { deferDefaultMode: true },
    );
    engine.customLayer.onFrameDrawn = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    drawFrame = () => {
      for (const listener of [...listeners]) listener();
    };
    draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
    engine.enterDefaultMode();
    drawFrame();
    const told: (readonly string[])[] = [];
    draw.on('rendered.changed', ({ ids }) => told.push(ids));
    const tables = store.tables as FeatureTables;
    const states = internalsOf(tables).states;
    const handles = Int32Array.of(tables.findRow('r0') as number, tables.findRow('r1') as number);
    states.setMoving(handles, BULK_MOVE_SET);
    states.setTranslation(BULK_MOVE_SET, 1, 0);
    drawFrame();
    states.setTranslation(BULK_MOVE_SET, 2, 0);
    drawFrame();
    states.setTranslation(BULK_MOVE_SET, 3, 0);
    drawFrame();
    // Nothing moved since
    drawFrame();
    expect(told).toEqual([
      ['r0', 'r1'],
      ['r0', 'r1'],
      ['r0', 'r1'],
    ]);
    // Their IDs are not read again at each motion
    expect(told[2]).toBe(told[1]);
    states.setMoving(handles, 0);
    drawFrame();
    expect(told).toHaveLength(4);
    expect(told[3]).toEqual(['r0', 'r1']);
    drawFrame();
    expect(told).toHaveLength(4);
  });

  it('tells a change of the shape being drawn, which has no ID, with no IDs', () => {
    const told: (readonly string[])[] = [];
    draw.on('rendered.changed', ({ ids }) => told.push(ids));
    engine.context.store.setTentative({
      type: 'LineString',
      coordinates: [[0, 0]],
      layerId: engine.context.getActiveLayerId(),
      confirmedCount: 1,
    });
    drawFrame();
    expect(told).toEqual([[]]);
    drawFrame();
    expect(told).toHaveLength(1);
    engine.context.store.setTentative(null);
    drawFrame();
    expect(told).toEqual([[], []]);
  });

  it('tells a feature a sketch creates, then no longer', () => {
    const told: (readonly string[])[] = [];
    draw.on('rendered.changed', ({ ids }) => told.push(ids));
    const sketch = draw.sketches.add({
      edits: [
        {
          kind: 'create',
          feature: { type: 'Point', geometry: { type: 'Point', coordinates: [3, 4] } },
          placedVertexCount: 1,
          below: null,
        },
      ],
    });
    const key = engine.sketches.view.creates()[0]?.key as string;
    drawFrame();
    draw.sketches.remove(sketch?.id as string);
    drawFrame();
    expect(told).toEqual([[key], [key]]);
  });
});
