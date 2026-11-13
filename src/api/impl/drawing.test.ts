// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the members about the drawing: getLayerStack, hasPendingWork and debug.terrain, the
 * hooks of measurement of the drawing of the rows (`tableDiagnosticsOf`), `draw.drawing`, and
 * `draw.mode` (set, with repeat, and drawing)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFeatureTablesStore } from '../../feature-table/feature-row-tables.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { setViewProjector } from '../../shared/math/index.js';
import { MemoryContractStore } from '../../store/memory.js';
import { FEATURE_TABLE_COLUMNS } from '../../table/tabane/columns.js';
import {
  createMapStub,
  featureRowDataBuilder as createPageDataBuilder,
  createSyntheticInput,
  feature,
  orderKey,
  rowOfFeature,
} from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { Sketch } from '../sketches.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';
import { tableDiagnosticsOf } from './table-diagnostics.js';

let draw: Draw;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

describe('getLayerStack', () => {
  it('gives one frozen entry per run of layers', () => {
    draw = createDraw(createMapStub().map);
    const stack = draw.getLayerStack();
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({ from: 0, to: 1 });
    expect(typeof stack[0].layerId).toBe('string');
    expect(Object.isFrozen(stack)).toBe(true);
    expect(Object.isFrozen(stack[0])).toBe(true);
  });

  it('asks the function of the entries from outside the document', () => {
    draw = createDraw(createMapStub().map, { isExternalEntry: (id) => id.startsWith('base:') });
    expect(draw.getLayerStack()).toHaveLength(1);
  });
});

describe('hasPendingWork and debug.terrain', () => {
  it('has no pending work and reports the terrain as inactive before anything is drawn', () => {
    draw = createDraw(createMapStub().map);
    expect(draw.hasPendingWork()).toBe(false);
    const terrain = draw.debug.terrain();
    expect(terrain.render.active).toBe(false);
    expect(terrain.render.atlasRect).toHaveLength(4);
    expect(terrain.render.atlasSize).toHaveLength(2);
    expect(terrain.drape).toMatchObject({ used: false, reason: 'not-evaluated', featureCount: 0 });
    expect(Object.isFrozen(terrain)).toBe(true);
  });
});

describe('debug.gpu and the hooks of measurement of the rows', () => {
  it('reports no GPU memory before anything is drawn', () => {
    draw = createDraw(createMapStub().map);
    const gpu = draw.debug.gpu();
    expect(gpu).toMatchObject({ bytes: 0, bufferBytes: 0, textureBytes: 0 });
    expect(Object.isFrozen(gpu)).toBe(true);
  });

  it('writes the state of the rows of the tables of the Store', () => {
    const { tables, writer } = createFeatureTablesStore();
    const builder = createPageDataBuilder({ columns: FEATURE_TABLE_COLUMNS });
    ['a', 'b'].forEach((id, i) => {
      builder.addRow(rowOfFeature(feature(id, 'Point', [i, i]), orderKey(i)));
    });
    writer.addPages('rows', builder.finish());
    featureTablesInternals(tables)?.addQueuedPages();
    const contract = new MemoryContractStore();
    Object.defineProperty(contract, 'tables', { value: tables });
    draw = createDraw(createMapStub().map, { store: contract, initDefaultLayer: false });

    const debug = tableDiagnosticsOf(draw);
    const handle = tables.getRowRef('b') as number;
    debug.setRowsMoving([handle], 2);
    debug.setMoveTranslation(2, 0.5, -0.5);
    const internals = featureTablesInternals(tables);
    const group = internals?.rowTable('rows')?.groupAt(0);
    expect(group?.gpuState[1]).toBe(2 << 1);
    expect(internals?.states.translation(2)).toEqual([0.5, -0.5]);
    // Nothing is drawn yet: the recording starts empty
    expect(debug.recordDraws()).toEqual([]);
    debug.stopRecording();
  });
});

describe('drawing', () => {
  it('draws a line from two vertices and finishes it', () => {
    draw = createDraw(createMapStub().map);
    expect(draw.drawing.isActive()).toBe(false);
    expect(draw.drawing.addVertex([0, 0])).toBe(false);
    expect(draw.drawing.finish()).toBe(false);

    draw.setMode('drawLine');
    expect(draw.drawing.isActive()).toBe(true);
    expect(draw.drawing.isDrawing()).toBe(false);
    expect(draw.drawing.addVertex([0, 0])).toBe(true);
    expect(draw.drawing.isDrawing()).toBe(true);
    // One vertex is too few to finish
    expect(draw.drawing.finish()).toBe(false);
    expect(draw.drawing.addVertex([1, 0.5])).toBe(true);
    expect(draw.drawing.finish()).toBe(true);

    const [line] = draw.features.list({ type: 'LineString' });
    expect(line.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 0.5],
      ],
    });
    expect(draw.getMode()).toBe('select');
    expect(draw.drawing.isActive()).toBe(false);
  });

  it('draws an area, with the preview following moveTo and the vertices undone and redone', () => {
    draw = createDraw(createMapStub().map);
    draw.setMode('drawPolygon');
    const previews: unknown[] = [];
    // The shape being drawn is a sketch of this client of an edit create
    const shown = ({ sketch }: { sketch: Sketch }) => {
      const edit = sketch.edits[0];
      if (edit?.kind === 'create') previews.push(edit.feature.geometry);
    };
    draw.sketches.subscribe((sketches) => {
      for (const sketch of sketches) shown({ sketch });
    });
    draw.drawing.addVertex([0, 0]);
    draw.drawing.addVertex([1, 0]);
    draw.drawing.moveTo([1, 1]);
    expect(previews[previews.length - 1]).toMatchObject({ type: 'Polygon' });
    expect(JSON.stringify(previews[previews.length - 1])).toContain('[1,1]');
    draw.drawing.addVertex([1, 1]);
    expect(draw.drawing.undoVertex()).toBe(true);
    expect(draw.drawing.redoVertex()).toBe(true);
    expect(draw.drawing.finish()).toBe(true);

    const [area] = draw.features.list({ type: 'Polygon' });
    expect(area.geometry).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    });
  });

  it('writes the reference zoom while scaleWithZoom is on, and none after it is turned off', () => {
    draw = createDraw(createMapStub().map);
    const drawLine = () => {
      draw.setMode('drawLine');
      draw.drawing.addVertex([0, 0]);
      draw.drawing.addVertex([1, 0.5]);
      draw.drawing.finish();
      const lines = draw.features.list({ type: 'LineString' });
      return lines[lines.length - 1].properties['maplibre-gl-draw:createdZoom'];
    };
    expect(typeof drawLine()).toBe('number');
    // The option changed while the instance runs reaches the drawing modes
    draw.options.update({ scaleWithZoom: false });
    expect(drawLine()).toBeUndefined();
    draw.options.update({ scaleWithZoom: true });
    expect(typeof drawLine()).toBe('number');
  });

  it('places a point with one vertex, and cancels a shape in progress', () => {
    draw = createDraw(createMapStub().map);
    draw.setMode('drawPoint');
    expect(draw.drawing.isActive()).toBe(true);
    expect(draw.drawing.addVertex([0.25, -0.5])).toBe(true);
    expect(draw.features.list({ type: 'Point' })[0].geometry).toEqual({
      type: 'Point',
      coordinates: [0.25, -0.5],
    });

    draw.setMode('drawLine');
    draw.drawing.addVertex([0, 0]);
    expect(draw.drawing.cancel()).toBe(true);
    expect(draw.drawing.isDrawing()).toBe(false);
    expect(draw.drawing.isActive()).toBe(true);
    expect(draw.drawing.cancel()).toBe(false);
  });

  it('goes through the input receivers of the plugins, which can consume it', () => {
    draw = createDraw(createMapStub().map);
    const clicks: unknown[] = [];
    let consume = false;
    let contextDrawing: unknown = null;
    draw.extensions.plugins.add({
      name: 'listener',
      onAdd(ctx) {
        contextDrawing = ctx.draw.drawing;
      },
      input: {
        onClick(event) {
          clicks.push({ lngLat: event.lngLat, snapped: event.snapped, point: event.point });
          return consume;
        },
      },
    });
    expect(contextDrawing).toBe(draw.drawing);

    draw.setMode('drawLine');
    draw.drawing.addVertex([1, 1]);
    expect(clicks).toEqual([{ lngLat: [1, 1], snapped: { lngLat: [1, 1] }, point: [500, 200] }]);
    consume = true;
    expect(draw.drawing.addVertex([2, 2])).toBe(true);
    // The plugin consumed the click: the mode placed no second vertex
    draw.drawing.finish();
    expect(draw.features.list({ type: 'LineString' })).toHaveLength(0);
  });

  it('keeps the positions given as they are, at the point the frame drawn last draws them', () => {
    const stub = createMapStub();
    draw = createDraw(stub.map);
    const clicks: unknown[] = [];
    draw.extensions.plugins.add({
      name: 'listener',
      onAdd() {},
      input: {
        onClick(event) {
          clicks.push({ lngLat: event.lngLat, point: event.point });
          return true;
        },
      },
    });
    // The frame drawn last draws the position elsewhere than the camera of the map now, and
    // unprojects its point elsewhere again: the position stays the one given
    setViewProjector(stub.map as never, {
      project: () => ({ x: 7, y: 9 }),
      unproject: () => ({ lng: 50, lat: 50 }),
    });
    try {
      draw.setMode('drawLine');
      draw.drawing.addVertex([1, 1]);
    } finally {
      setViewProjector(stub.map as never, null);
    }
    expect(clicks).toEqual([{ lngLat: [1, 1], point: [7, 9] }]);
  });

  it('places the exact positions, with no click tolerance, and finishes wherever they are', () => {
    // One degree is 100 px on the stub: the vertices are 3 px apart on the screen
    draw = createDraw(createMapStub().map);
    draw.setMode('drawLine');
    draw.drawing.addVertex([0, 0]);
    draw.drawing.moveTo([0.03, 0]);
    expect(draw.drawing.addVertex([0.03, 0])).toBe(true);
    // The second vertex was placed, not taken as a click on the last one that finishes
    expect(draw.drawing.isDrawing()).toBe(true);
    expect(draw.drawing.finish()).toBe(true);
    expect(draw.features.list({ type: 'LineString' })[0].geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [0.03, 0],
      ],
    });

    // A vertex of an area 3 px from the first one does not close it
    draw.setMode('drawPolygon');
    for (const position of [
      [0, 0],
      [1, 0],
      [1, 1],
    ]) {
      draw.drawing.addVertex(position);
    }
    draw.drawing.moveTo([0.02, 0.02]);
    draw.drawing.addVertex([0.02, 0.02]);
    expect(draw.drawing.isDrawing()).toBe(true);
    expect(draw.drawing.finish()).toBe(true);
    const [area] = draw.features.list({ type: 'Polygon' });
    expect(area.geometry).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0.02, 0.02],
          [0, 0],
        ],
      ],
    });
  });

  it('keeps the click tolerance for the pointer: a click 3 px from the last vertex places none', () => {
    const engine = createEngine(createMapStub().map);
    draw = createDrawOnEngine(engine);
    const input = createSyntheticInput(engine);
    draw.setMode('drawPolygon');
    for (const position of [
      [0, 0],
      [1, 0],
      [1.03, 0],
      [1, 1],
    ] as Array<[number, number]>) {
      input.move(position, { snap: false });
      input.click(position, { snap: false });
    }
    // A click 3 px from the first vertex closes the area
    input.move([0.02, 0.02], { snap: false });
    input.click([0.02, 0.02], { snap: false });
    expect(draw.drawing.isDrawing()).toBe(false);
    expect(draw.features.list({ type: 'Polygon' })[0].geometry).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    });
  });

  it('ignores a vertex at exactly the last position, and closes an area on its first one', () => {
    draw = createDraw(createMapStub().map);
    draw.setMode('drawPolygon');
    for (const position of [
      [0, 0],
      [1, 0],
      [1, 0],
      [1, 1],
    ]) {
      draw.drawing.addVertex(position);
    }
    expect(draw.drawing.isDrawing()).toBe(true);
    draw.drawing.addVertex([0, 0]);
    expect(draw.drawing.isDrawing()).toBe(false);
    expect(draw.features.list({ type: 'Polygon' })[0].geometry).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    });
  });

  it('refuses a position that is not two finite numbers', () => {
    draw = createDraw(createMapStub().map);
    draw.setMode('drawLine');
    expect(() => draw.drawing.addVertex([Number.NaN, 0])).toThrow(DrawError);
    expect(() => draw.drawing.moveTo([0] as unknown as [number, number])).toThrow(DrawError);
  });
});

describe('mode.set', () => {
  it('enters a mode and tells it, as setMode does', () => {
    draw = createDraw(createMapStub().map);
    const told: string[] = [];
    draw.mode.subscribe((mode) => told.push(mode));
    draw.mode.set('drawLine');
    expect(draw.mode.value).toBe('drawLine');
    expect(draw.getMode()).toBe('drawLine');
    draw.mode.set('select');
    expect(told).toEqual(['select', 'drawLine', 'select']);
  });

  it('throws notFound for a mode that is not there, and invalidInput for wrong options', () => {
    draw = createDraw(createMapStub().map);
    expect(() => draw.mode.set('draw_nothing')).toThrow(
      expect.objectContaining({ code: 'notFound' }),
    );
    expect(() => draw.mode.set('drawLine', { repeat: 'yes' as unknown as boolean })).toThrow(
      expect.objectContaining({ code: 'invalidInput' }),
    );
    expect(() => draw.mode.set(1 as unknown as string)).toThrow(
      expect.objectContaining({ code: 'invalidInput' }),
    );
    expect(draw.mode.value).toBe('select');
  });

  it('changes nothing for a drawing mode while the interaction lock is on', () => {
    draw = createDraw(createMapStub().map);
    draw.setInteractionLocked(true);
    draw.mode.set('drawPoint');
    expect(draw.mode.value).toBe('select');
  });

  it('keeps a drawing mode with repeat for the next shape, until Escape', () => {
    const engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
    draw = createDrawOnEngine(engine);
    engine.enterDefaultMode();
    draw.mode.set('drawLine', { repeat: true });
    draw.mode.drawing.add([0, 0]);
    draw.mode.drawing.add([1, 0.5]);
    void draw.mode.drawing.commit();
    expect(draw.mode.value).toBe('drawLine');
    expect(draw.mode.drawing.active).toBe(false);
    draw.mode.drawing.add([2, 0]);
    draw.mode.drawing.add([3, 0.5]);
    void draw.mode.drawing.commit();
    expect(draw.features.list({ type: 'LineString' })).toHaveLength(2);
    // Escape in the middle of a shape drops it; Escape with nothing drawn leaves the mode
    draw.mode.drawing.add([4, 0]);
    createSyntheticInput(engine).key('Escape');
    expect(draw.mode.value).toBe('drawLine');
    createSyntheticInput(engine).key('Escape');
    expect(draw.mode.value).toBe('select');
    expect(draw.features.list({ type: 'LineString' })).toHaveLength(2);
  });

  it('keeps the point mode with repeat, one point for each click', () => {
    draw = createDraw(createMapStub().map);
    draw.mode.set('drawPoint', { repeat: true });
    draw.mode.drawing.add([0.25, -0.5]);
    draw.mode.drawing.add([0.5, -0.25]);
    expect(draw.features.list({ type: 'Point' })).toHaveLength(2);
    expect(draw.mode.value).toBe('drawPoint');
    // Another mode set without repeat does not repeat
    draw.mode.set('drawPoint');
    draw.mode.drawing.add([0.75, 0]);
    expect(draw.mode.value).toBe('select');
  });

  it('leaves a repeated mode for select once no layer can be written', async () => {
    draw = createDraw(createMapStub().map);
    draw.mode.set('drawPoint', { repeat: true });
    const [layer] = draw.layers.list();
    await draw.write((tx) => tx.layers.update(layer.id, { locked: true }));
    draw.mode.drawing.add([0.5, -0.25]);
    expect(draw.mode.value).toBe('select');
    expect(draw.features.list({ type: 'Point' })).toHaveLength(0);
  });

  it('starts the repeated mode again only when the next shape can be written', async () => {
    draw = createDraw(createMapStub().map);
    draw.mode.set('drawLine', { repeat: true });
    draw.mode.drawing.add([0, 0]);
    const [layer] = draw.layers.list();
    // The layer is locked in the middle of the shape: the shape is dropped and the mode is left
    await draw.write((tx) => tx.layers.update(layer.id, { locked: true }));
    draw.mode.drawing.add([1, 0.5]);
    await draw.mode.drawing.commit().catch(() => {});
    expect(draw.mode.value).toBe('select');
    expect(draw.features.list({ type: 'LineString' })).toHaveLength(0);
  });

  it('places one point and goes back to select without repeat', () => {
    draw = createDraw(createMapStub().map);
    draw.mode.set('drawPoint');
    draw.mode.drawing.add([0.25, -0.5]);
    expect(draw.features.list({ type: 'Point' })).toHaveLength(1);
    expect(draw.mode.value).toBe('select');
  });
});

describe('mode.drawing', () => {
  it('throws invalidState outside a drawing mode', async () => {
    draw = createDraw(createMapStub().map);
    const { drawing } = draw.mode;
    expect(drawing.active).toBe(false);
    for (const run of [
      () => drawing.add([0, 0]),
      () => drawing.move([0, 0]),
      () => drawing.undo(),
      () => drawing.redo(),
      () => drawing.cancel(),
    ]) {
      expect(run).toThrow(expect.objectContaining({ code: 'invalidState' }));
    }
    await expect(drawing.commit()).rejects.toMatchObject({ code: 'invalidState' });
  });

  it('refuses a position that is not two finite numbers', () => {
    draw = createDraw(createMapStub().map);
    draw.mode.set('drawLine');
    expect(() => draw.mode.drawing.add([Number.NaN, 0])).toThrow(
      expect.objectContaining({ code: 'invalidInput' }),
    );
    expect(() => draw.mode.drawing.move([0] as unknown as [number, number])).toThrow(
      expect.objectContaining({ code: 'invalidInput' }),
    );
  });

  it('draws an area with move, undo and redo, and commits it as one commit with its label', async () => {
    draw = createDraw(createMapStub().map);
    const changes: Array<{
      commit: string;
      label: string | undefined;
      created: readonly string[];
    }> = [];
    draw.on('change', (change) =>
      changes.push({
        commit: change.commit,
        label: change.label,
        created: change.features.created,
      }),
    );
    draw.mode.set('drawPolygon');
    const { drawing } = draw.mode;
    drawing.add([0, 0]);
    expect(drawing.active).toBe(true);
    drawing.add([1, 0]);
    drawing.move([1, 1]);
    drawing.add([1, 1]);
    drawing.add([2, 2]);
    drawing.undo();
    drawing.redo();
    drawing.undo();
    const write = drawing.commit({ label: 'Area' });
    const area = await write;
    expect(area.geometry).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    });
    expect(await write.result).toEqual({ value: area, skipped: 0 });
    expect(changes).toEqual([{ commit: write.id, label: 'Area', created: [area.id] }]);
    expect(draw.mode.value).toBe('select');
    expect(drawing.active).toBe(false);
    // It is one step of undo
    await draw.undo();
    expect(draw.features.count()).toBe(0);
  });

  it('commits with undo false as no step of undo', async () => {
    draw = createDraw(createMapStub().map);
    draw.mode.set('drawLine');
    draw.mode.drawing.add([0, 0]);
    draw.mode.drawing.add([1, 0.5]);
    await draw.mode.drawing.commit({ undo: false });
    expect(draw.features.count()).toBe(1);
    await expect(draw.undo()).rejects.toMatchObject({ code: 'invalidState' });
  });

  it('rejects a commit of too few vertices and keeps the shape', async () => {
    draw = createDraw(createMapStub().map);
    draw.mode.set('drawLine');
    draw.mode.drawing.add([0, 0]);
    await expect(draw.mode.drawing.commit()).rejects.toMatchObject({ code: 'invalidState' });
    expect(draw.mode.drawing.active).toBe(true);
    expect(draw.features.count()).toBe(0);
  });

  it('rejects a commit stopped by its signal, or with wrong options, and keeps the shape', async () => {
    draw = createDraw(createMapStub().map);
    draw.mode.set('drawLine');
    draw.mode.drawing.add([0, 0]);
    draw.mode.drawing.add([1, 0.5]);
    const controller = new AbortController();
    controller.abort();
    await expect(draw.mode.drawing.commit({ signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    await expect(draw.mode.drawing.commit({ label: 1 as unknown as string })).rejects.toMatchObject(
      { code: 'invalidInput' },
    );
    expect(draw.mode.drawing.active).toBe(true);
    expect(draw.features.count()).toBe(0);
  });

  it('rejects a commit while the document is read-only', async () => {
    draw = createDraw(createMapStub().map);
    draw.mode.set('drawLine');
    draw.mode.drawing.add([0, 0]);
    draw.mode.drawing.add([1, 0.5]);
    draw.setReadOnly(true);
    await expect(draw.mode.drawing.commit()).rejects.toMatchObject({ code: 'notEditable' });
    expect(draw.features.count()).toBe(0);
  });

  it('cancels the shape and stays in the mode', () => {
    draw = createDraw(createMapStub().map);
    draw.mode.set('drawLine');
    draw.mode.drawing.add([0, 0]);
    draw.mode.drawing.cancel();
    expect(draw.mode.drawing.active).toBe(false);
    expect(draw.mode.value).toBe('drawLine');
    // Nothing to cancel is nothing
    draw.mode.drawing.cancel();
    expect(draw.mode.value).toBe('drawLine');
  });

  it('throws invalidState once the instance is destroyed, and commit rejects with it', async () => {
    draw = createDraw(createMapStub().map);
    const { mode } = draw;
    draw.destroy();
    expect(() => mode.set('drawLine')).toThrow(expect.objectContaining({ code: 'invalidState' }));
    expect(() => mode.drawing.add([0, 0])).toThrow(
      expect.objectContaining({ code: 'invalidState' }),
    );
    await expect(mode.drawing.commit()).rejects.toMatchObject({ code: 'invalidState' });
  });
});
