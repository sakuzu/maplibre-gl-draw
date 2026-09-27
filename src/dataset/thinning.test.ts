// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the collision thinning
 *
 * The selection itself is checked by calling the pure function (selectCollisionWinners)
 * directly, and its application (what is drawn, the hit testing, the pinned entries, the triggers
 * of a recomputation) is checked through a dataset. The drawing goes to a stub batch without
 * GL and is judged by "what goes onto the batch" (the same style as dataset.test.ts). A frame
 * is drawn as the render loop draws it: the manager starts it with the zoom of the frame, then
 * draws.
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { BoundingBox, Coordinate, Feature } from '../store/types.js';
import { toRow } from '../test-utils.js';
import type { DisplayBatchTarget } from './dataset.js';
import { createDatasetManager, type DatasetManager } from './manager.js';
import { FeatureArraySource } from './source.js';
import type { CollisionThinningHost, ThinningCamera } from './thinning.js';
import {
  CollisionSelection,
  CollisionThinningState,
  effectiveZoomForCamera,
  effectiveZoomForPitch,
  MAX_PITCH_ZOOM_DROP,
  SELECTION_SLICE_ROWS,
  selectCollisionWinnerRows,
  selectCollisionWinners,
  worldUnitsPerPixel,
  zoomBandFor,
} from './thinning.js';
import type { DatasetOptions, DatasetRow } from './types.js';
import { normalizeDisplayFeature } from './types.js';

/** Viewport covering the whole globe */
const WORLD: BoundingBox = { minX: -180, minY: -85, maxX: 180, maxY: 85 };

/** The longitude that corresponds to one screen pixel in band b (the same for latitude at the
 * equator) */
function pxDeg(band: number): number {
  return 360 / (512 * 2 ** band);
}

/** The footprint radius of the default style (radius 6 + outline 2 + margin 2 = 10px) */
const FOOTPRINT_PX = 10;

function point(id: string, coord: Coordinate, style?: Feature['style']): DatasetRow {
  return toRow({ id, type: 'Point', coordinates: coord, style });
}

function line(id: string, coords: Coordinate[]): DatasetRow {
  return toRow({ id, type: 'LineString', coordinates: coords });
}

/** Points laid out along the longitude in units of px (latitude 0) */
function pointAtPx(id: string, px: number, band = 10, northPx = 0): DatasetRow {
  return point(id, [px * pxDeg(band), northPx * pxDeg(band)]);
}

/** A stub that records the features pushed onto the batch per frame */
function createBatchTarget(): { target: DisplayBatchTarget; frames: Feature[][] } {
  const frames: Feature[][] = [];
  let current: Feature[] = [];

  const target: DisplayBatchTarget = {
    beginFrame: (): void => {
      current = [];
    },
    processFeature: (feature: Feature): boolean => {
      current.push(feature);
      return false;
    },
    endFrame: (): void => {
      frames.push(current);
      current = [];
    },
  };

  return { target, frames };
}

function createManager(zoom = 10): {
  manager: DatasetManager;
  /** Replaces the zoom of the map (not of a frame: a frame is drawn with `drawnIds`) */
  setZoom: (next: number) => void;
  /** Replaces the shallowest effective zoom on screen (the pitch correction) */
  setEffectiveZoom: (next: number | null) => void;
  setBounds: (next: BoundingBox) => void;
  /** Raises the equivalent of moveend */
  moveEnd: () => void;
} {
  let currentZoom = zoom;
  let currentEffectiveZoom: number | null = null;
  let currentBounds = WORLD;
  const handlers = new Set<() => void>();

  const manager = createDatasetManager({
    getViewportBounds: () => currentBounds,
    getZoom: () => currentZoom,
    // Without a pitch it is the same value as the zoom of the camera
    getEffectiveZoom: () => currentEffectiveZoom ?? currentZoom,
    onViewportChange: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    requestRepaint: () => {},
  });

  return {
    manager,
    setZoom: (next: number) => {
      currentZoom = next;
    },
    setEffectiveZoom: (next: number | null) => {
      currentEffectiveZoom = next;
    },
    setBounds: (next: BoundingBox) => {
      currentBounds = next;
    },
    moveEnd: () => {
      for (const handler of [...handlers]) handler();
    },
  };
}

/** Draws a frame at `zoom` and returns the ids of the features pushed in it */
function drawnIds(manager: DatasetManager, zoom = 10): string[] {
  const { target, frames } = createBatchTarget();
  manager.beginFrame(zoom);
  manager.draw('below-store', target, {} as ProjectionData, zoom);
  return frames[0]?.map((feature) => feature.id) ?? [];
}

function add(manager: DatasetManager, options: DatasetOptions): ReturnType<DatasetManager['add']> {
  return manager.add(options);
}

/** Input for calling the pure function directly (the footprints are uniform px) */
function winnersOf(
  features: DatasetRow[],
  band: number,
  radiusPx: number | ((feature: Feature) => number),
): string[] {
  const normalized = features.map(normalizeDisplayFeature);
  const winners = selectCollisionWinners({
    features: normalized,
    band,
    radiusPx: typeof radiusPx === 'number' ? () => radiusPx : radiusPx,
  });
  // Returned in draw order (to make comparison easier)
  return normalized.filter((feature) => winners.has(feature.id)).map((feature) => feature.id);
}

describe('selectCollisionWinners (the selection itself)', () => {
  it('among overlapping points only the frontmost wins (the reverse of the draw order)', () => {
    const features = [pointAtPx('back', 0), pointAtPx('front', 5)];

    expect(winnersOf(features, 10, FOOTPRINT_PX)).toEqual(['front']);
  });

  it('both win at a distance where the footprints do not touch', () => {
    // Two footprints of 10px do not collide once they are 20px or more apart
    const features = [pointAtPx('a', 0), pointAtPx('b', 21)];

    expect(winnersOf(features, 10, FOOTPRINT_PX)).toEqual(['a', 'b']);
  });

  it('a winner in a neighbouring cell is judged by the real distance (not by occupancy)', () => {
    // The cell side is the diameter of the largest footprint (20px). p2 and p3 straddle cells but
    // are only 1.5px apart, so they collide. p1 is 21px away from p3 and the defeated p2 is not
    // an obstacle, so it wins
    const features = [pointAtPx('p1', 0), pointAtPx('p2', 19.5), pointAtPx('p3', 21)];

    expect(winnersOf(features, 10, FOOTPRINT_PX)).toEqual(['p1', 'p3']);
  });

  it('both win in the same cell when the footprints do not touch', () => {
    // 19px each diagonally (a distance of 26.8px > 20px). Occupancy alone must not reject it
    const features = [pointAtPx('a', 0, 10, 0), pointAtPx('b', 19, 10, 19)];

    expect(winnersOf(features, 10, FOOTPRINT_PX)).toEqual(['a', 'b']);
  });

  it('among points at the same coordinate only the frontmost wins', () => {
    const features = [pointAtPx('a', 0), pointAtPx('b', 0), pointAtPx('c', 0)];

    expect(winnersOf(features, 10, FOOTPRINT_PX)).toEqual(['c']);
  });

  it('a larger footprint leaves fewer winners', () => {
    const features = [pointAtPx('a', 0), pointAtPx('b', 21), pointAtPx('c', 42)];

    expect(winnersOf(features, 10, FOOTPRINT_PX)).toEqual(['a', 'b', 'c']);
    // With a doubled radius, a gap of 21px makes them touch
    expect(winnersOf(features, 10, FOOTPRINT_PX * 2)).toEqual(['a', 'c']);
  });

  it('the deeper the zoom band, the more winners (the same footprint looks farther apart)', () => {
    const features = [point('a', [0, 0]), point('b', [pxDeg(10) * 10, 0])];

    // In band 10 they are only 10px apart
    expect(winnersOf(features, 10, FOOTPRINT_PX)).toEqual(['b']);
    // In band 12 they look 40px apart
    expect(winnersOf(features, 12, FOOTPRINT_PX)).toEqual(['a', 'b']);
  });

  it('nothing but points is thinned (lines and polygons win unconditionally)', () => {
    const features = [
      line('l1', [
        [0, 0],
        [1, 1],
      ]),
      pointAtPx('p1', 0),
      pointAtPx('p2', 1),
    ];

    expect(winnersOf(features, 10, FOOTPRINT_PX)).toEqual(['l1', 'p2']);
  });

  it('a hidden feature becomes neither a winner nor an obstacle', () => {
    const features = [
      pointAtPx('a', 0),
      { ...pointAtPx('hidden', 3), visible: false },
      pointAtPx('b', 6),
    ];

    // If hidden were an obstacle, both a and b would drop. In fact only b (the front) wins
    expect(winnersOf(features, 10, FOOTPRINT_PX)).toEqual(['b']);
  });

  it('features with different footprints are judged by the real distance', () => {
    // The footprint of a is 30px and of b is 5px. A distance of 30px is below 35px, so they
    // collide
    const features = [pointAtPx('a', 0), pointAtPx('b', 30)];
    const radius = (feature: Feature): number => (feature.id === 'a' ? 30 : 5);

    expect(winnersOf(features, 10, radius)).toEqual(['b']);
  });

  it('the same input always gives the same set of winners (it is deterministic)', () => {
    const features = Array.from({ length: 500 }, (_, i) =>
      pointAtPx(`p${i}`, (i * 7919) % 1000, 10, (i * 104729) % 1000),
    );

    const first = winnersOf(features, 10, FOOTPRINT_PX);
    const second = winnersOf(features, 10, FOOTPRINT_PX);

    expect(second).toEqual(first);
    expect(first.length).toBeLessThan(features.length);
  });
});

describe('zoomBandFor', () => {
  it('a fractional zoom is floored into a band', () => {
    expect(zoomBandFor(12.9)).toBe(12);
    expect(zoomBandFor(12)).toBe(12);
  });

  it('an out-of-range or invalid value falls back to a safe band', () => {
    expect(zoomBandFor(-3)).toBe(0);
    expect(zoomBandFor(99)).toBe(22);
    expect(zoomBandFor(Number.NaN)).toBe(0);
  });
});

/**
 * Builds a sample camera where "the center to the top edge looks ratio times the flat distance"
 *
 * They are placed along the longitude on the equator, so the distance in world coordinates is the
 * longitude difference / 360.
 */
function pitchSamples(
  zoom: number,
  pixelDistance: number,
  ratio: number,
): Parameters<typeof effectiveZoomForPitch>[0] {
  const worldDistance = pixelDistance * worldUnitsPerPixel(zoom) * ratio;
  return {
    zoom,
    center: [0, 0],
    topCenter: [worldDistance * 360, 0],
    pixelDistance,
  };
}

describe('the pitch correction (the effective zoom)', () => {
  it('at pitch 0 (ratio 1) it is exactly the zoom of the camera', () => {
    expect(effectiveZoomForPitch(pitchSamples(17, 300, 1))).toBe(17);
    expect(effectiveZoomForPitch(pitchSamples(10, 512, 1))).toBe(10);
  });

  it('it is not lowered even when the ratio falls below 1 (as before)', () => {
    expect(effectiveZoomForPitch(pitchSamples(17, 300, 0.5))).toBe(17);
  });

  it('a ratio of 8 lowers the zoom by 3 steps', () => {
    expect(effectiveZoomForPitch(pitchSamples(17, 300, 8))).toBeCloseTo(14, 6);
  });

  it('at the equivalent of pitch 60 degrees (ratio 9.46), z17 becomes about z13.8', () => {
    const effective = effectiveZoomForPitch(pitchSamples(17, 300, 9.46));

    expect(effective).toBeCloseTo(17 - Math.log2(9.46), 6);
    expect(zoomBandFor(effective)).toBe(13);
  });

  it('the drop is capped even at a ratio where the horizon enters', () => {
    expect(effectiveZoomForPitch(pitchSamples(17, 300, 2 ** 20))).toBe(17 - MAX_PITCH_ZOOM_DROP);
  });

  it('it falls back to the zoom of the camera for input that cannot be measured', () => {
    expect(effectiveZoomForPitch(pitchSamples(17, 0, 4))).toBe(17);
    expect(effectiveZoomForPitch({ ...pitchSamples(17, 300, 4), pixelDistance: Number.NaN })).toBe(
      17,
    );
    expect(effectiveZoomForPitch({ ...pitchSamples(17, 300, 4), topCenter: [0, 0] })).toBe(17);
  });

  it('the same input always gives the same value (it is deterministic)', () => {
    const input = pitchSamples(17, 300, 5.5);

    expect(effectiveZoomForPitch(input)).toBe(effectiveZoomForPitch(input));
  });
});

describe('the effective zoom from a camera', () => {
  /** A camera where the center → the top edge looks ratio times the flat distance */
  function createCamera(
    zoom: number,
    pitch: number,
    ratio: number,
  ): { camera: ThinningCamera; unprojects: () => number } {
    const width = 800;
    const height = 600;
    let unprojects = 0;
    const worldDistance = (height / 2) * worldUnitsPerPixel(zoom) * ratio;

    const camera: ThinningCamera = {
      getZoom: () => zoom,
      getPitch: () => pitch,
      getCanvas: () => ({ clientWidth: width, clientHeight: height }),
      unproject: ([, y]) => {
        unprojects++;
        return y === 0 ? { lng: worldDistance * 360, lat: 0 } : { lng: 0, lat: 0 };
      },
    };

    return { camera, unprojects: () => unprojects };
  }

  it('at pitch 0 it returns the zoom of the camera without measuring', () => {
    const { camera, unprojects } = createCamera(17, 0, 9.46);

    expect(effectiveZoomForCamera(camera)).toBe(17);
    expect(unprojects()).toBe(0);
  });

  it('with a pitch it drops to the scale at the top of the screen', () => {
    const { camera } = createCamera(17, 60, 8);

    expect(effectiveZoomForCamera(camera)).toBeCloseTo(14, 6);
  });

  it('it returns the zoom of the camera when the size of the screen cannot be obtained', () => {
    const camera: ThinningCamera = {
      getZoom: () => 17,
      getPitch: () => 60,
      getCanvas: () => ({ clientWidth: 0, clientHeight: 0 }),
      unproject: () => ({ lng: 0, lat: 0 }),
    };

    expect(effectiveZoomForCamera(camera)).toBe(17);
  });
});

describe('the application to a dataset', () => {
  it('nothing is thinned by default (when it is not set)', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 1)],
    });

    expect(drawnIds(manager)).toEqual(['a', 'b']);
    expect(dataset.getThinningStats()).toMatchObject({
      enabled: false,
      active: false,
      total: 2,
      visible: 2,
      band: null,
    });
    expect(dataset.getVisibleFeatureIds()).toBeNull();
  });

  it('enabling it drops the overlapping points from what is drawn', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 5), pointAtPx('c', 40)],
      collisionThinning: { enabled: true },
    });

    expect(drawnIds(manager)).toEqual(['b', 'c']);
    expect(dataset.getThinningStats()).toMatchObject({
      enabled: true,
      active: true,
      total: 3,
      visible: 2,
      band: 10,
    });
    expect(dataset.getVisibleFeatureIds()?.has('a')).toBe(false);
    expect(dataset.getVisibleFeatureIds()?.has('b')).toBe(true);
  });

  it('a larger marker makes the thinning coarser (it follows the base style)', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 25), pointAtPx('c', 50)],
      collisionThinning: { enabled: true },
    });

    // By default (a footprint of 10px) a gap of 25px does not collide
    expect(drawnIds(manager)).toEqual(['a', 'b', 'c']);

    // Raising the radius from 6 to 20 makes the footprint 24px, which touches even at 25px
    dataset.setBaseStyle({ point: { pointRadius: 20 } });

    expect(drawnIds(manager)).toEqual(['a', 'c']);
  });

  it('the radius of an individual style affects the footprint too', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      rows: [
        point('big', [0, 0], { pointRadius: 30 }),
        point('small', [30 * pxDeg(10), 0], { pointRadius: 1 }),
      ],
      collisionThinning: { enabled: true },
    });

    // The footprint of big is 34px. At a gap of 30px small is swallowed (the front small wins)
    expect(drawnIds(manager)).toEqual(['small']);
  });

  it('everything is drawn at zooms at or above fullDisplayZoom', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 1)],
      collisionThinning: { enabled: true, fullDisplayZoom: 17 },
    });

    expect(drawnIds(manager)).toEqual(['b']);

    expect(drawnIds(manager, 17)).toEqual(['a', 'b']);
    expect(dataset.getThinningStats()).toMatchObject({
      enabled: true,
      active: false,
      visible: 2,
      band: null,
    });
  });

  it('fullDisplayZoom can be changed at runtime', () => {
    const { manager } = createManager(14);
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0, 14), pointAtPx('b', 1, 14)],
      collisionThinning: { enabled: true, fullDisplayZoom: 17 },
    });

    expect(drawnIds(manager, 14)).toEqual(['b']);

    dataset.setCollisionThinning({ enabled: true, fullDisplayZoom: 13 });

    expect(drawnIds(manager, 14)).toEqual(['a', 'b']);

    // Disabling it gives everything as before
    drawnIds(manager, 10);
    dataset.setCollisionThinning(null);
    expect(dataset.getCollisionThinning()).toBeNull();
    expect(drawnIds(manager)).toEqual(['a', 'b']);
  });

  it('widening marginPx leaves fewer winners', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 21)],
      collisionThinning: { enabled: true },
    });

    expect(drawnIds(manager)).toEqual(['a', 'b']);

    // A footprint of 8px + a margin of 4px = 12px. At a gap of 21px they touch
    dataset.setCollisionThinning({ enabled: true, marginPx: 4 });

    expect(drawnIds(manager)).toEqual(['b']);
  });

  it('it does not depend on the view (panning does not swap the winners)', () => {
    const { manager, setBounds } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 5), pointAtPx('c', 40)],
      collisionThinning: { enabled: true },
    });

    const before = [...(dataset.getVisibleFeatureIds() ?? [])].sort();

    // Even panning to a window that shows only a part, the winners stay decided from every
    // feature
    setBounds({ minX: 30 * pxDeg(10), minY: -1, maxX: 50 * pxDeg(10), maxY: 1 });
    manager.list();
    const after = [...(dataset.getVisibleFeatureIds() ?? [])].sort();

    expect(after).toEqual(before);
    // Even drawing only the visible range, the defeated points do not come out
    expect(drawnIds(manager)).toEqual(['c']);
  });

  it('drawing follows the band during a gesture, and tells the listeners after the frame', async () => {
    const { manager } = createManager(10);
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 5)],
      collisionThinning: { enabled: true },
    });
    const reasons: string[] = [];
    dataset.on('change', ({ reason }) => reasons.push(reason));

    expect(dataset.getThinningStats().band).toBe(10);

    // In band 12 they look 20px apart, so both win (no moveend in between)
    expect(drawnIds(manager, 12.5)).toEqual(['a', 'b']);
    expect(dataset.getThinningStats().band).toBe(12);
    expect(reasons).toEqual([]);
    await Promise.resolve();
    expect(reasons).toEqual(['thinning']);

    // Back in band 10 the first winners come back
    expect(drawnIds(manager, 10.5)).toEqual(['b']);
  });

  it('the start of a frame switches the rows the queries report, before anything is drawn', () => {
    const { manager } = createManager(10);
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 5)],
      collisionThinning: { enabled: true },
    });
    const revision = dataset.getDrawnRowsRevision();
    expect(dataset.collectDrawnRows(WORLD)).toEqual(new Int32Array([1]));

    manager.beginFrame(12.5);
    // A layer that draws in this frame reads the rows of this frame
    expect(dataset.getDrawnRowsRevision()).toBeGreaterThan(revision);
    expect(dataset.collectDrawnRows(WORLD)).toEqual(new Int32Array([0, 1]));
    expect(dataset.getThinningStats()).toMatchObject({ band: 12, visible: 2 });

    // The same band again changes nothing
    const next = dataset.getDrawnRowsRevision();
    manager.beginFrame(12.9);
    expect(dataset.getDrawnRowsRevision()).toBe(next);
  });

  it('the band is decided from the zoom of the frame, not from the zoom of the map', () => {
    // The elevation settlement of the terrain changes the zoom of the map while the picture (and
    // the zoom of the frame) stays the same: the band must not flip
    const { manager, setZoom, moveEnd } = createManager(10);
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 5)],
      collisionThinning: { enabled: true },
    });
    expect(drawnIds(manager, 10.9)).toEqual(['b']);
    const revision = dataset.getDrawnRowsRevision();

    setZoom(12.2);
    moveEnd();
    expect(drawnIds(manager, 10.9)).toEqual(['b']);
    // A change of the settings takes the zoom of the last frame as well
    dataset.setCollisionThinning({ enabled: true, marginPx: 2.5 });
    expect(dataset.getThinningStats().band).toBe(10);
    expect(dataset.getDrawnRowsRevision()).toBe(revision);
  });

  it('before the first frame the zoom of the map decides the band', () => {
    const { manager } = createManager(12.5);
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 5)],
      collisionThinning: { enabled: true },
    });
    expect(dataset.getThinningStats()).toMatchObject({ enabled: true, band: 12, visible: 2 });
  });

  it('a change of band leaves the terrain drape alone (it draws no point)', () => {
    const { manager } = createManager(10);
    add(manager, {
      id: 'c1',
      rows: [
        pointAtPx('a', 0),
        pointAtPx('b', 5),
        line('l1', [
          [0, 0],
          [pxDeg(10), 0],
        ]),
      ],
      collisionThinning: { enabled: true },
    });
    const dataset = manager.getInternal('c1');
    const revision = dataset?.drapeRevision;
    expect(dataset?.drapeFeatures().map((feature) => feature.id)).toEqual(['l1']);

    expect(drawnIds(manager, 12.5)).toEqual(['a', 'b', 'l1']);
    expect(dataset?.drapeRevision).toBe(revision);
    expect(dataset?.drapeFeatures().map((feature) => feature.id)).toEqual(['l1']);
  });

  it('a hidden dataset keeps its rows until it is drawn again', () => {
    const { manager } = createManager(10);
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 5)],
      collisionThinning: { enabled: true },
    });
    dataset.setVisible(false);
    manager.beginFrame(12.5);
    expect(dataset.getThinningStats().band).toBe(10);

    dataset.setVisible(true);
    expect(drawnIds(manager, 12.5)).toEqual(['a', 'b']);
    expect(dataset.getThinningStats().band).toBe(12);
  });

  it('setRows and a style change pick the winners again (the cache is invalidated)', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 5)],
      collisionThinning: { enabled: true },
    });

    expect(drawnIds(manager)).toEqual(['b']);

    dataset.setRows([pointAtPx('x', 0), pointAtPx('y', 40)]);
    expect(drawnIds(manager)).toEqual(['x', 'y']);
    expect(dataset.getThinningStats()).toMatchObject({ total: 2, visible: 2 });

    // Changing the zoom factor makes the markers larger and leaves fewer winners
    dataset.setZoomScale(() => ({ scale: 4, opacity: 1 }));
    expect(drawnIds(manager)).toEqual(['y']);
  });

  it('a thinned point drops out of the hit testing too', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 5)],
      collisionThinning: { enabled: true },
      interactive: true,
    });

    const at = (coord: Coordinate): string | null => {
      const hit = manager.hitTestSide('below-store', coord, pxDeg(10) * 2, (feature, position) => {
        const [x, y] = feature.coordinates as Coordinate;
        return Math.hypot(x - position[0], y - position[1]) <= pxDeg(10) * 2;
      });
      return hit?.feature?.id ?? null;
    };

    // The position of a is thinned away, so it cannot be grabbed (b is too far to be hit)
    expect(at([0, 0])).toBeNull();
    expect(at([5 * pxDeg(10), 0])).toBe('b');
    expect(dataset.getVisibleFeatureIds()?.has('a')).toBe(false);
  });

  it('clicking on a thinned point grabs the winner that covers it', () => {
    // In dense data the marker of a winner sits on top of a defeated point. Deciding by the
    // click tolerance alone would mean "clicking a visible circle grabs nothing", so a point is
    // judged by the size at which it is drawn
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 5)],
      collisionThinning: { enabled: true },
      interactive: true,
    });

    // The default marker is radius 6 + outline 2 = 8px. b, 5px away, covers the position of a
    const hit = manager.hitTestSide(
      'below-store',
      [0, 0],
      pxDeg(10),
      (feature, position, tolerance) => {
        const [x, y] = feature.coordinates as Coordinate;
        return Math.hypot(x - position[0], y - position[1]) <= tolerance;
      },
    );

    // What comes back is only the drawn b; the defeated a does not
    expect(hit?.feature?.id).toBe('b');
  });

  it('a change of the winners reports change (thinning)', async () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 40)],
      collisionThinning: { enabled: true },
    });

    const reasons: string[] = [];
    dataset.on('change', (payload) => reasons.push(payload.reason));

    // A change of the settings reports it at once
    dataset.setCollisionThinning({ enabled: true, marginPx: 30 });
    expect(reasons).toEqual(['thinning']);

    // A band entered by a frame reports it after the frame
    drawnIds(manager, 16);
    expect(reasons).toEqual(['thinning']);
    await Promise.resolve();
    expect(reasons).toEqual(['thinning', 'thinning']);
  });

  it('the zoom factors change the drawn rows without discarding the batches', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0), pointAtPx('b', 40)],
      collisionThinning: { enabled: true },
    });
    const reasons: string[] = [];
    dataset.on('change', (payload) => reasons.push(payload.reason));
    expect(drawnIds(manager)).toEqual(['a', 'b']);
    const revision = dataset.getDrawnRowsRevision();

    dataset.setZoomScale(() => ({ scale: 4, opacity: 1 }));
    expect(reasons).toEqual(['thinning']);
    expect(dataset.getDrawnRowsRevision()).toBe(revision + 1);
    expect(drawnIds(manager)).toEqual(['b']);
  });

  it('the band is decided by the effective zoom (with the pitch correction)', () => {
    // In band 16 they are 30px apart and both win, but at an effective 13 (a scale one eighth of
    // it) they are only 3.75px apart, so only the front one wins
    const { manager, setEffectiveZoom } = createManager(16);
    const dataset = add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0, 16), pointAtPx('b', 30, 16)],
      collisionThinning: { enabled: true },
    });

    expect(drawnIds(manager, 16)).toEqual(['a', 'b']);
    expect(dataset.getThinningStats().band).toBe(16);

    setEffectiveZoom(13);

    expect(drawnIds(manager, 16)).toEqual(['b']);
    // The band in the stats is the effective band too
    expect(dataset.getThinningStats().band).toBe(13);
  });

  it('the threshold of showing everything is judged by the effective zoom too', () => {
    // The camera is at z17.5 (which would normally stop the thinning), but the top of the screen
    // is about z14
    const { manager, setEffectiveZoom } = createManager(17.5);
    add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0, 17), pointAtPx('b', 30, 17)],
      collisionThinning: { enabled: true },
    });

    expect(drawnIds(manager, 17.5)).toEqual(['a', 'b']);

    setEffectiveZoom(14);

    expect(drawnIds(manager, 17.5)).toEqual(['b']);
  });

  it('at pitch 0 (the effective zoom = the zoom of the camera) the result is as before', () => {
    const { manager, setEffectiveZoom } = createManager(16);
    add(manager, {
      id: 'c1',
      rows: [pointAtPx('a', 0, 16), pointAtPx('b', 30, 16)],
      collisionThinning: { enabled: true },
    });

    setEffectiveZoom(16);

    expect(drawnIds(manager, 16)).toEqual(['a', 'b']);
  });

  it('a dataset of lines and polygons only draws everything even when it is enabled', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      rows: [
        line('l1', [
          [0, 0],
          [pxDeg(10), 0],
        ]),
        line('l2', [
          [0, 0],
          [pxDeg(10), pxDeg(10)],
        ]),
      ],
      collisionThinning: { enabled: true },
    });

    expect(drawnIds(manager)).toEqual(['l1', 'l2']);
  });
});

describe('the time the selection takes (a guide; no exact time is claimed)', () => {
  it('the selection of 260,000 points finishes in a practical time', () => {
    // A deterministic pseudo-random distribution (fixed seed) imitating the scale of central Tokyo.
    // The generator stays in 32-bit integers, so all of the points are distinct
    let seed = 12345;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    const count = 260_000;
    const features: Feature[] = new Array(count);
    for (let i = 0; i < count; i++) {
      features[i] = normalizeDisplayFeature(
        point(`p${i}`, [139.6 + random() * 0.6, 35.5 + random() * 0.4]),
        i,
      );
    }

    const started = performance.now();
    const winners = selectCollisionWinners({
      features,
      band: 12,
      radiusPx: () => FOOTPRINT_PX,
    });
    const elapsed = performance.now() - started;

    console.log(
      `collision thinning: ${count} points → ${winners.size} winners / ${elapsed.toFixed(1)}ms`,
    );

    expect(winners.size).toBeGreaterThan(0);
    expect(winners.size).toBeLessThan(count);
    // It takes a few tens of milliseconds, more than a frame: the bands next to the current one
    // are picked ahead in slices while the page is idle. The check is kept to a loose upper bound
    // so it does not fail on the jitter of CI
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('CollisionSelection (the selection in slices)', () => {
  it('gives the same winners however it is sliced', () => {
    const count = SELECTION_SLICE_ROWS * 3 + 17;
    const features = Array.from({ length: count }, (_, i) =>
      normalizeDisplayFeature(pointAtPx(`p${i}`, (i * 7) % 900, 10, (i * 13) % 700), i),
    );
    const rows = new FeatureArraySource(features);
    const whole = selectCollisionWinnerRows(rows, 10, () => FOOTPRINT_PX);

    const selection = new CollisionSelection(rows, 10, () => FOOTPRINT_PX);
    let steps = 0;
    // A deadline already passed: one slice per call
    while (!selection.step(0, () => 1)) steps++;
    expect(steps).toBeGreaterThanOrEqual(6);
    expect(selection.result()).toEqual(whole);
  });
});

describe('CollisionThinningState', () => {
  /** Two points 5px apart in band 10 (they collide) and one far away */
  function createHost(): CollisionThinningHost & {
    generation: number;
    revision: number;
    picks: number;
  } {
    const features = [pointAtPx('a', 0), pointAtPx('b', 5), pointAtPx('c', 1000)].map(
      normalizeDisplayFeature,
    );
    const source = new FeatureArraySource(features);
    const host = {
      generation: 1,
      revision: 0,
      picks: 0,
      rows: () => source,
      featuresGeneration: () => host.generation,
      styleRevision: () => host.revision,
      footprintPx: (_band: number, marginPx: number) => {
        host.picks++;
        return () => FOOTPRINT_PX - 2 + marginPx;
      },
    };
    return host;
  }

  it('without settings nothing is thinned', () => {
    const state = new CollisionThinningState(createHost());
    expect(state.enabled).toBe(false);
    expect(state.options).toBeNull();
    expect(state.sync(10)).toBe(false);
    expect(state.isDrawnRow(1)).toBe(true);
    expect(state.mask).toBeNull();
    expect(state.stats(3)).toEqual({
      enabled: false,
      active: false,
      total: 3,
      visible: 3,
      band: null,
    });
  });

  it('enabling it picks the winners, and the same settings again change nothing', () => {
    const state = new CollisionThinningState(createHost());
    expect(state.setOptions({ enabled: true }, 10)).toEqual({ drawnChanged: true });
    expect(state.isDrawnRow(1)).toBe(true);
    expect(state.isDrawnRow(0)).toBe(false);
    expect(state.stats(3)).toMatchObject({ active: true, visible: 2, band: 10 });
    expect(state.setOptions({ enabled: true }, 10)).toBeNull();
    // Settings that draw the same rows are a change of the settings, not of the rows
    expect(state.setOptions({ enabled: true, marginPx: 2.5 }, 10)).toEqual({
      drawnChanged: false,
    });
  });

  it('the winners are picked again only when the contents or the style went stale', () => {
    const host = createHost();
    const state = new CollisionThinningState(host, { enabled: true });
    expect(state.sync(10)).toBe(true);
    expect(state.sync(10)).toBe(false);
    // A zoom inside the same band during a gesture does not pick them again
    expect(state.sync(10.9)).toBe(false);
    expect(host.picks).toBe(1);

    host.generation++;
    // Same winners: nothing drawn changed even though they were picked again
    const revision = state.revision;
    expect(state.sync(10)).toBe(false);
    expect(host.picks).toBe(2);
    expect(state.revision).toBe(revision);
  });

  it('sync follows the band, and at the full display zoom nothing is thinned', () => {
    const state = new CollisionThinningState(createHost(), { enabled: true, fullDisplayZoom: 12 });
    state.sync(10);
    expect(state.isDrawnRow(0)).toBe(false);
    const revision = state.revision;

    expect(state.sync(12)).toBe(true);
    expect(state.drawable).toBeNull();
    expect(state.mask).toBeNull();
    expect(state.isDrawnRow(0)).toBe(true);
    expect(state.revision).toBe(revision + 1);
  });

  it('the winners of a band are picked once, and a band seen before costs nothing', () => {
    const host = createHost();
    const state = new CollisionThinningState(host, { enabled: true });
    state.sync(10);
    expect(host.picks).toBe(1);

    expect(state.sync(12)).toBe(true);
    expect(state.stats(3)).toMatchObject({ band: 12, visible: 3 });
    expect(state.sync(10)).toBe(true);
    expect(state.sync(12)).toBe(true);
    expect(host.picks).toBe(2);

    // New contents forget the bands picked for the old ones
    host.generation++;
    state.sync(10);
    state.sync(12);
    expect(host.picks).toBe(4);
  });

  it('the bands near the current one are picked ahead until the deadline', () => {
    const host = createHost();
    const state = new CollisionThinningState(host, { enabled: true });
    state.sync(10);

    // A deadline already passed: one band per call (a slice at least)
    expect(state.prefetch(0, () => 1)).toBe(true);
    expect(host.picks).toBe(2);
    // A deadline far away: the rest at once
    expect(state.prefetch(Number.POSITIVE_INFINITY, () => 0)).toBe(false);
    expect(host.picks).toBe(5);

    // Crossing into a band picked ahead costs no selection
    state.sync(9);
    state.sync(12);
    expect(host.picks).toBe(5);
  });

  it('a band being picked ahead is finished by a frame that needs it, not started again', () => {
    const count = SELECTION_SLICE_ROWS * 2;
    const features = Array.from({ length: count }, (_, i) =>
      normalizeDisplayFeature(pointAtPx(`p${i}`, i % 500, 10, Math.floor(i / 500)), i),
    );
    const host = createHost();
    const source = new FeatureArraySource(features);
    host.rows = () => source;
    const state = new CollisionThinningState(host, { enabled: true });
    state.sync(10);

    // One slice of band 9 (the first neighbour)
    expect(state.prefetch(0, () => 1)).toBe(true);
    expect(host.picks).toBe(2);
    state.sync(9);
    expect(host.picks).toBe(2);
    expect(state.stats(count).band).toBe(9);
    expect(state.mask).toEqual(selectCollisionWinnerRows(source, 9, () => FOOTPRINT_PX));
  });

  it('clear forgets the winners and keeps the settings', () => {
    const state = new CollisionThinningState(createHost(), { enabled: true });
    state.sync(10);
    state.clear();
    expect(state.drawable).toBeNull();
    expect(state.enabled).toBe(true);
  });
});
