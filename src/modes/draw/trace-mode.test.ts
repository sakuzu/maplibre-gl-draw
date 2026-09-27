// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the tracing of the drawing modes
 *
 * Synthetic input (draw.input) is fed into a whole engine on a map stub that projects
 * linearly, and through the real InputRouter, SnapService and the line and polygon drawing
 * modes this checks that the sequence of boundary vertices is inserted between clicks snapped
 * to the boundary of an existing feature or of a dataset.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../api/engine.js';
import { createEngine } from '../../api/engine.js';
import type { InputOperations } from '../../api/input-api.js';
import type { Draw } from '../../api/v2/draw.js';
import { createDrawOnEngine } from '../../api/v2/impl/create-draw.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import type { Store } from '../../store/store.js';
import type { Coordinate, Feature } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { ModeManager } from '../manager.js';

const ZOOM = 14;
/** The degrees corresponding to one pixel at zoom 14 (= 360 / (512 * 2^14)) */
const DEG_PER_PIXEL = 360 / (512 * 2 ** ZOOM);

/** The origin of the projection (screen coordinate (0, 0)) */
const ORIGIN = { lng: 139.7, lat: 35.68 };

/** An interval sufficiently larger than the vertex click decision (10px) */
const STEP = 40 * DEG_PER_PIXEL;

/**
 * The ring of the existing polygon that becomes the snap target
 *
 *   P0 ── P1 ── P2      3 vertices on the top edge (screen y = 0)
 *   │            │
 *   P4 ───────── P3     the bottom edge (screen y = 80px)
 *
 * From P0 to P2, going along the top edge (via P1) is short, and going the other way around
 * (via P4 / P3) is long.
 */
const P0: Coordinate = [ORIGIN.lng, ORIGIN.lat];
const P1: Coordinate = [ORIGIN.lng + STEP, ORIGIN.lat];
const P2: Coordinate = [ORIGIN.lng + 2 * STEP, ORIGIN.lat];
const P3: Coordinate = [ORIGIN.lng + 2 * STEP, ORIGIN.lat - 2 * STEP];
const P4: Coordinate = [ORIGIN.lng, ORIGIN.lat - 2 * STEP];
const RING: Coordinate[] = [P0, P1, P2, P3, P4, P0];

/** A point sufficiently far from the ring that does not snap */
const AWAY: Coordinate = [ORIGIN.lng + 5 * STEP, ORIGIN.lat + 3 * STEP];

/**
 * The ring of the existing polygon adjoining on the right (it shares the P2 - P3 edge)
 *
 *   P2 ── N0      the top edge (screen y = 0)
 *   │      │
 *   P3 ── N1      the bottom edge
 */
const N0: Coordinate = [ORIGIN.lng + 3 * STEP, ORIGIN.lat];
const N1: Coordinate = [ORIGIN.lng + 3 * STEP, ORIGIN.lat - 2 * STEP];
const NEIGHBOR_RING: Coordinate[] = [P2, N0, N1, P3, P2];

/**
 * The ring put on a dataset (at a position that does not overlap the rings of
 * the Store)
 */
const D0: Coordinate = [ORIGIN.lng, ORIGIN.lat + 6 * STEP];
const D1: Coordinate = [ORIGIN.lng + STEP, ORIGIN.lat + 6 * STEP];
const D2: Coordinate = [ORIGIN.lng + 2 * STEP, ORIGIN.lat + 6 * STEP];
const D_RING: Coordinate[] = [
  D0,
  D1,
  D2,
  [ORIGIN.lng + 2 * STEP, ORIGIN.lat + 8 * STEP],
  [ORIGIN.lng, ORIGIN.lat + 8 * STEP],
  D0,
];

let engine: Engine;
let draw: Draw;
let store: Store;
let modeManager: ModeManager;
let input: InputOperations;
/** The layer the features are in */
let layerId: string;

/**
 * Builds an engine on a map that projects linearly around ORIGIN at ZOOM, and places one
 * polygon as the snap target
 */
function setup(): void {
  const stub = createMapStub();
  Object.assign(stub.map, {
    getZoom: () => ZOOM,
    project: (coord: Coordinate | { lng: number; lat: number }) => {
      const [lng, lat] = Array.isArray(coord) ? coord : [coord.lng, coord.lat];
      return { x: (lng - ORIGIN.lng) / DEG_PER_PIXEL, y: (ORIGIN.lat - lat) / DEG_PER_PIXEL };
    },
    unproject: (point: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      return { lng: ORIGIN.lng + x * DEG_PER_PIXEL, lat: ORIGIN.lat - y * DEG_PER_PIXEL };
    },
    getBounds: () => ({
      getWest: () => -180,
      getEast: () => 180,
      getSouth: () => -85,
      getNorth: () => 85,
      getSouthWest: () => ({ lng: -180, lat: -85 }),
      getNorthEast: () => ({ lng: 180, lat: 85 }),
    }),
  });
  engine = createEngine(stub.map, {}, { deferDefaultMode: true });
  draw = createDrawOnEngine(engine);
  engine.enterDefaultMode();
  store = engine.context.store;
  modeManager = engine.modeManager;
  input = engine.facade.input;
  layerId = store.listLayers()[0].id;

  store.createFeature({
    id: 'target',
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [RING] },
    layerId,
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  });
}

/** The snap target features placed in advance */
const EXISTING_IDS = new Set(['target', 'neighbor']);

/** The feature produced by the drawing (excluding the snap target polygons) */
function drawnFeature(): Feature {
  const features = store.listFeatures().filter((f) => !EXISTING_IDS.has(f.id));
  expect(features).toHaveLength(1);
  return features[0];
}

/** Places the polygon on the right (it shares the P2 - P3 edge) */
function addNeighbor(): void {
  store.createFeature({
    id: 'neighbor',
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: [NEIGHBOR_RING] },
    layerId,
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  });
}

beforeEach(() => {
  setup();
  return () => engine.destroy();
});

describe('tracing of the line drawing mode', () => {
  it('inserts the vertices in between when snapping to two vertices of the same polygon', () => {
    modeManager.setMode('draw_line');

    input.click(P0);
    input.click(P2);
    input.key('Enter');

    expect(coordinatesOf(drawnFeature())).toEqual([P0, P1, P2]);
  });

  it('continues the trace onto the adjoining feature connected by a shared vertex', () => {
    addNeighbor();
    modeManager.setMode('draw_line');

    // From P0 (target) to N0 (neighbor) it spans the edges of two polygons
    input.click(P0);
    input.click(N0);
    input.key('Enter');

    expect(coordinatesOf(drawnFeature())).toEqual([P0, P1, P2, N0]);
  });

  it('can trace from a click snapped to the middle of an edge as well', () => {
    modeManager.setMode('draw_line');

    // The midpoint of P0-P1 (it is 20px away from the vertices at both ends, so it snaps to
    // the edge)
    const mid: Coordinate = [ORIGIN.lng + STEP / 2, ORIGIN.lat];
    input.click(mid);
    input.click(P2);
    input.key('Enter');

    expect(coordinatesOf(drawnFeature())).toEqual([mid, P1, P2]);
  });

  it('inserts nothing when both points are snapped onto the same edge', () => {
    modeManager.setMode('draw_line');

    const a: Coordinate = [ORIGIN.lng + STEP / 4, ORIGIN.lat];
    const b: Coordinate = [ORIGIN.lng + (STEP * 3) / 4, ORIGIN.lat];
    input.click(a);
    input.click(b);
    input.key('Enter');

    expect(coordinatesOf(drawnFeature())).toEqual([a, b]);
  });

  it('does not trace when a click that does not snap is inserted in between', () => {
    modeManager.setMode('draw_line');

    input.click(P0);
    input.click(AWAY);
    input.click(P2);
    input.key('Enter');

    expect(coordinatesOf(drawnFeature())).toEqual([P0, AWAY, P2]);
  });

  it('previews the trace path on a mouse move', () => {
    modeManager.setMode('draw_line');

    input.click(P0);
    input.move(P2);

    const tentative = store.getTentative();
    expect(tentative?.coordinates).toEqual([P0, P1, P2]);
    // The confirmed part remains a single point (the path and the cursor point are unconfirmed)
    expect(tentative?.confirmedCount).toBe(1);
  });

  it('makes the preview disappear as well when the cursor leaves the snap', () => {
    modeManager.setMode('draw_line');

    input.click(P0);
    input.move(P2);
    input.move(AWAY);

    expect(store.getTentative()?.coordinates).toEqual([P0, AWAY]);
  });

  it('inserts nothing when tracing is disabled', () => {
    draw.options.update({ tracing: { enabled: false } });
    modeManager.setMode('draw_line');

    input.click(P0);
    input.click(P2);
    input.key('Enter');

    expect(coordinatesOf(drawnFeature())).toEqual([P0, P2]);
  });

  it('does not trace on the click right after going back with Backspace', () => {
    modeManager.setMode('draw_line');

    input.click(P0);
    input.click(AWAY);
    input.key('Backspace');
    // The snap target of the previously confirmed click (P0) has been discarded
    input.click(P2);
    input.key('Enter');

    expect(coordinatesOf(drawnFeature())).toEqual([P0, P2]);
  });
});

describe('preference of the trace anchor', () => {
  /** Puts one piece of data on (at a position away from the rings of the Store) */
  function addDataset(): void {
    draw.datasets.add({
      id: 'data',
      rows: [
        {
          type: 'Feature',
          id: 'dpoly',
          geometry: { type: 'Polygon', coordinates: [D_RING] },
          properties: {},
        },
      ],
    });
  }

  /** The preferred feature returned by the current mode */
  function preference(): { featureId: string; datasetId?: string } | null {
    return modeManager.getHandler()?.getSnapPreference?.() ?? null;
  }

  it('returns the snap target of the confirmed click', () => {
    modeManager.setMode('draw_line');
    expect(preference()).toBeNull();

    input.click(P0);

    expect(preference()).toEqual({ featureId: 'target', datasetId: undefined });
  });

  it('also returns datasetId for a snap target originating from data', () => {
    addDataset();
    modeManager.setMode('draw_line');

    input.click(D0);

    expect(preference()).toEqual({ featureId: 'dpoly', datasetId: 'data' });
  });

  it('the trace also holds between boundaries of data', () => {
    addDataset();
    modeManager.setMode('draw_line');

    input.click(D0);
    input.click(D2);
    input.key('Enter');

    expect(coordinatesOf(drawnFeature())).toEqual([D0, D1, D2]);
  });

  it('goes back to null after a click that does not snap', () => {
    modeManager.setMode('draw_line');

    input.click(P0);
    input.click(AWAY);

    expect(preference()).toBeNull();
  });

  it('goes back together with the state of the mode when confirmed (Enter)', () => {
    modeManager.setMode('draw_line');
    const handler = modeManager.getHandler();

    input.click(P0);
    input.click(P2);
    input.key('Enter');

    expect(handler?.getSnapPreference?.()).toBeNull();
  });

  it('goes back on a cancel (Escape) as well', () => {
    modeManager.setMode('draw_line');

    input.click(P0);
    input.key('Escape');

    expect(preference()).toBeNull();
  });

  it('returns nothing when tracing is disabled', () => {
    draw.options.update({ tracing: { enabled: false } });
    modeManager.setMode('draw_line');

    input.click(P0);

    expect(preference()).toBeNull();
  });

  it('returns the same way for draw_polygon as well', () => {
    modeManager.setMode('draw_polygon');

    input.click(P0);

    expect(preference()).toEqual({ featureId: 'target', datasetId: undefined });
  });
});

describe('tracing of the polygon drawing mode', () => {
  it('takes in the vertices by tracing along the boundary', () => {
    modeManager.setMode('draw_polygon');

    input.click(P0);
    input.click(P2);
    input.click(AWAY);
    input.key('Enter');

    const ring = (coordinatesOf(drawnFeature()) as Coordinate[][])[0];
    // P0 -> (takes in P1) -> P2 -> AWAY -> the closing point
    expect(ring).toEqual([P0, P1, P2, AWAY, P0]);
  });

  it('keeps the shape of a closed ring in the preview as well', () => {
    modeManager.setMode('draw_polygon');

    input.click(P0);
    input.move(P2);

    const tentative = store.getTentative();
    expect(tentative?.type).toBe('Polygon');
    expect((tentative!.coordinates as Coordinate[][])[0]).toEqual([P0, P1, P2, P0]);
    expect(tentative?.confirmedCount).toBe(1);
  });
});
