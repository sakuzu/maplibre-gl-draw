// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for SnapService
 *
 * They verify how a candidate is picked (priority and distance), the conversion of
 * the tolerance from pixels into degrees, the specification of exclusions, the
 * temporary disabling by a modifier key, the registration and unregistration of
 * providers, and the emission of 'snap.change'. The listing of candidates by the
 * built-in providers is covered by providers.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ModifierKeys } from '../dispatcher/types.js';
import { EventEmitterImpl } from '../shared/utils/event-emitter.js';
import { MemoryStore } from '../store/memory.js';
import { RBushSpatialIndex } from '../store/spatial/spatial-index.js';
import type { BoundingBox, Coordinate } from '../store/types.js';
import { degreesPerPixel } from './geometry.js';
import { createSnapService } from './service.js';
import type {
  SnapCandidate,
  SnapContext,
  SnapLngLat,
  SnapOptions,
  SnapProvider,
  SnapProviderContext,
  SnapResult,
  SnapService,
} from './types.js';
import { DEFAULT_SNAP_OPTIONS } from './types.js';

const NO_MODIFIERS: ModifierKeys = { shift: false, ctrl: false, alt: false, meta: false };

const ZOOM = 14;
/** The reference position of the tests (near Tokyo) */
const ORIGIN: SnapLngLat = { lng: 139.7, lat: 35.68 };

/** A provider that returns the given candidates as they are */
function fixedProvider(name: string, candidates: SnapCandidate[]): SnapProvider {
  return {
    name,
    candidates: () => candidates,
  };
}

/** A coordinate the given number of pixels away from the reference position */
function offsetByPixels(pixelsX: number, pixelsY: number, from: SnapLngLat = ORIGIN): Coordinate {
  const perPixel = degreesPerPixel(from.lat, ZOOM);
  return [from.lng + pixelsX * perPixel.lng, from.lat + pixelsY * perPixel.lat];
}

function context(overrides: Partial<SnapContext> = {}): SnapContext {
  return { zoom: ZOOM, modifiers: NO_MODIFIERS, ...overrides };
}

function resolveAt(
  service: ReturnType<typeof createSnapService>,
  lngLat: SnapLngLat = ORIGIN,
  ctx: Partial<SnapContext> = {},
): SnapResult {
  return service.resolve(lngLat, { x: 100, y: 100 }, context(ctx));
}

describe('SnapService', () => {
  describe('the tolerance', () => {
    it('snaps to a candidate inside the tolerance', () => {
      const service = createSnapService();
      const target = offsetByPixels(5, 0);
      service.register(fixedProvider('p', [{ kind: 'vertex', coordinate: target }]));

      const result = resolveAt(service);

      expect(result.target?.kind).toBe('vertex');
      expect(result.lngLat).toEqual({ lng: target[0], lat: target[1] });
    });

    it('does not snap to a candidate outside the tolerance', () => {
      const service = createSnapService();
      service.register(fixedProvider('p', [{ kind: 'vertex', coordinate: offsetByPixels(11, 0) }]));

      const result = resolveAt(service);

      expect(result.target).toBeUndefined();
      expect(result.lngLat).toEqual(ORIGIN);
    });

    it('applies the tolerance in pixels in the latitude direction as well (the degrees shrink at high latitudes)', () => {
      const service = createSnapService();
      const highLat: SnapLngLat = { lng: 139.7, lat: 60 };
      // A point shifted 9 pixels north at a latitude of 60 degrees (a small value in
      // degrees)
      const target = offsetByPixels(0, 9, highLat);
      service.register(fixedProvider('p', [{ kind: 'vertex', coordinate: target }]));

      const result = resolveAt(service, highLat);

      expect(result.target?.kind).toBe('vertex');
      expect(result.lngLat.lat).toBe(target[1]);
    });

    it('allows the tolerance to be changed with an option', () => {
      const service = createSnapService({ options: { tolerancePx: 20 } });
      const target = offsetByPixels(15, 0);
      service.register(fixedProvider('p', [{ kind: 'vertex', coordinate: target }]));

      expect(resolveAt(service).target?.kind).toBe('vertex');
      expect(createSnapService().getOptions().tolerancePx).toBe(10);
    });
  });

  describe('the priority order', () => {
    it('prefers a distant vertex over a nearby edge', () => {
      const service = createSnapService();
      const vertex = offsetByPixels(8, 0);
      service.register(
        fixedProvider('p', [
          { kind: 'edge', start: offsetByPixels(1, -5), end: offsetByPixels(1, 5) },
          { kind: 'vertex', coordinate: vertex },
        ]),
      );

      const result = resolveAt(service);

      expect(result.target?.kind).toBe('vertex');
      expect(result.lngLat).toEqual({ lng: vertex[0], lat: vertex[1] });
    });

    it('prefers an intersection over an edge but not over a vertex', () => {
      const service = createSnapService();
      service.register(
        fixedProvider('p', [
          { kind: 'edge', start: offsetByPixels(0, -5), end: offsetByPixels(0, 5) },
          { kind: 'intersection', coordinate: offsetByPixels(6, 0) },
        ]),
      );
      expect(resolveAt(service).target?.kind).toBe('intersection');

      const withVertex = createSnapService();
      withVertex.register(
        fixedProvider('p', [
          { kind: 'intersection', coordinate: offsetByPixels(2, 0) },
          { kind: 'vertex', coordinate: offsetByPixels(7, 0) },
        ]),
      );
      expect(resolveAt(withVertex).target?.kind).toBe('vertex');
    });

    it('gives a guide the lowest priority', () => {
      const service = createSnapService();
      service.register(
        fixedProvider('p', [
          { kind: 'guide', coordinate: offsetByPixels(1, 0), description: 'guide' },
          { kind: 'edge', start: offsetByPixels(7, -5), end: offsetByPixels(7, 5) },
        ]),
      );

      expect(resolveAt(service).target?.kind).toBe('edge');
    });

    it('picks the closer one within the same priority (regardless of the order in which the providers were registered)', () => {
      const near = offsetByPixels(2, 0);
      const service = createSnapService();
      service.register(
        fixedProvider('far', [{ kind: 'vertex', coordinate: offsetByPixels(7, 0) }]),
      );
      service.register(fixedProvider('near', [{ kind: 'vertex', coordinate: near }]));

      expect(resolveAt(service).lngLat).toEqual({ lng: near[0], lat: near[1] });

      const reversed = createSnapService();
      reversed.register(fixedProvider('near', [{ kind: 'vertex', coordinate: near }]));
      reversed.register(
        fixedProvider('far', [{ kind: 'vertex', coordinate: offsetByPixels(7, 0) }]),
      );

      expect(resolveAt(reversed).lngLat).toEqual({ lng: near[0], lat: near[1] });
    });
  });

  describe('edge candidates', () => {
    it('snaps a segment candidate to the nearest point', () => {
      const service = createSnapService();
      const start = offsetByPixels(4, -10);
      const end = offsetByPixels(4, 10);
      service.register(fixedProvider('p', [{ kind: 'edge', start, end }]));

      const result = resolveAt(service);

      expect(result.target?.kind).toBe('edge');
      expect(result.lngLat.lng).toBeCloseTo(start[0], 12);
      expect(result.lngLat.lat).toBeCloseTo(ORIGIN.lat, 8);
    });

    it('keeps the nearest point from going beyond the end points of the segment', () => {
      const service = createSnapService();
      const start = offsetByPixels(2, 2);
      const end = offsetByPixels(2, 8);
      service.register(fixedProvider('p', [{ kind: 'edge', start, end }]));

      const result = resolveAt(service);

      expect(result.lngLat).toEqual({ lng: start[0], lat: start[1] });
    });

    it('can treat a point candidate whose nearest point was computed by the provider as an edge as well', () => {
      const service = createSnapService();
      service.register(
        fixedProvider('p', [{ kind: 'edge', coordinate: offsetByPixels(3, 0), featureId: 'f1' }]),
      );

      const result = resolveAt(service);

      expect(result.target).toEqual({ kind: 'edge', featureId: 'f1' });
    });
  });

  describe('the geometric references of a snapping target', () => {
    it('attaches the vertex reference of a vertex candidate to target', () => {
      const service = createSnapService();
      service.register(
        fixedProvider('p', [
          {
            kind: 'vertex',
            coordinate: offsetByPixels(1, 0),
            featureId: 'f1',
            vertex: { ring: 0, index: 2 },
          },
        ]),
      );

      expect(resolveAt(service).target?.vertex).toEqual({ ring: 0, index: 2 });
    });

    it('attaches the segment of a segment candidate and the vertex references of both ends to target', () => {
      const service = createSnapService();
      const start = offsetByPixels(3, -10);
      const end = offsetByPixels(3, 10);
      service.register(
        fixedProvider('p', [
          {
            kind: 'edge',
            start,
            end,
            startRef: { ring: 0, index: 0 },
            endRef: { ring: 0, index: 1 },
            featureId: 'f1',
          },
        ]),
      );

      const target = resolveAt(service).target;

      expect(target?.segment).toEqual({
        start,
        end,
        startRef: { ring: 0, index: 0 },
        endRef: { ring: 0, index: 1 },
      });
      // The snapped point is the nearest point on the segment, so it is not the same as
      // an end point of the segment
      expect(target?.vertex).toBeUndefined();
    });

    it('attaches the datasetId of a candidate to target', () => {
      const service = createSnapService();
      service.register(
        fixedProvider('p', [
          {
            kind: 'vertex',
            coordinate: offsetByPixels(1, 0),
            featureId: 'f1',
            datasetId: 'data',
          },
        ]),
      );

      const target = resolveAt(service).target;

      expect(target?.featureId).toBe('f1');
      expect(target?.datasetId).toBe('data');
    });

    it('attaches no datasetId for a candidate originating from the Store', () => {
      const service = createSnapService();
      service.register(
        fixedProvider('p', [{ kind: 'vertex', coordinate: offsetByPixels(1, 0), featureId: 'f1' }]),
      );

      expect(resolveAt(service).target?.datasetId).toBeUndefined();
    });

    it('attaches only segment for a segment candidate without vertex references (a guide)', () => {
      const service = createSnapService();
      const start = offsetByPixels(2, -10);
      const end = offsetByPixels(2, 10);
      service.register(fixedProvider('p', [{ kind: 'guide', start, end }]));

      const target = resolveAt(service).target;

      expect(target?.kind).toBe('guide');
      expect(target?.segment).toEqual({ start, end });
    });
  });

  describe('turning each kind on and off', () => {
    it('enables every kind by default', () => {
      const service = createSnapService();

      expect(service.getOptions().kinds).toEqual({
        vertex: true,
        edge: true,
        intersection: true,
        guide: true,
      });
    });

    it('discards the candidates of a kind disabled with an option', () => {
      const service = createSnapService({ options: { kinds: { vertex: false } } });
      service.register(
        fixedProvider('p', [
          { kind: 'vertex', coordinate: offsetByPixels(1, 0) },
          { kind: 'edge', start: offsetByPixels(4, -5), end: offsetByPixels(4, 5) },
        ]),
      );

      // The vertex wins on priority, but it is disabled, so it snaps to the edge
      expect(resolveAt(service).target?.kind).toBe('edge');
      expect(service.isKindEnabled('vertex')).toBe(false);
      expect(service.isKindEnabled('edge')).toBe(true);
    });

    it('allows switching at run time with setKindEnabled', () => {
      const service = createSnapService();
      service.register(
        fixedProvider('p', [{ kind: 'intersection', coordinate: offsetByPixels(1, 0) }]),
      );

      expect(resolveAt(service).target?.kind).toBe('intersection');

      service.setKindEnabled('intersection', false);
      expect(resolveAt(service).target).toBeUndefined();
      expect(service.getOptions().kinds.intersection).toBe(false);

      service.setKindEnabled('intersection', true);
      expect(resolveAt(service).target?.kind).toBe('intersection');
    });

    it('keeps a change of a kind from spreading to another service (the defaults are not shared)', () => {
      const first = createSnapService();
      first.setKindEnabled('vertex', false);

      const second = createSnapService();

      expect(second.isKindEnabled('vertex')).toBe(true);
      expect(first.getOptions().kinds.vertex).toBe(false);
    });

    it('leaves the internal state unchanged even when the return value of getOptions is rewritten', () => {
      const service = createSnapService();
      const options = service.getOptions();
      options.kinds.edge = false;

      expect(service.isKindEnabled('edge')).toBe(true);
    });
  });

  describe('the step angle of the built-in guides', () => {
    /** A service with the built-in providers, drawing a line whose first point is ORIGIN */
    function drawingService(options: SnapOptions = {}): SnapService {
      const store = new MemoryStore();
      store.setMode('draw_line');
      const anchor: Coordinate = [ORIGIN.lng, ORIGIN.lat];
      store.setTentative({
        type: 'LineString',
        coordinates: [anchor, anchor],
        layerId: 'l1',
        confirmedCount: 1,
      });
      return createSnapService({ store, spatialIndex: new RBushSpatialIndex(), options });
    }

    /** A cursor 100 px from ORIGIN at a bearing of 15 degrees (off every 45-degree guide) */
    function cursorAt15Degrees(): SnapLngLat {
      const [lng, lat] = offsetByPixels(100 * Math.sin(Math.PI / 12), 100 * Math.cos(Math.PI / 12));
      return { lng, lat };
    }

    it('does not snap to a 15-degree bearing with the default step of 45 degrees', () => {
      const service = drawingService();

      expect(service.getOptions().guideStepDegrees).toBe(45);
      expect(resolveAt(service, cursorAt15Degrees()).target).toBeUndefined();
    });

    it('snaps to a 15-degree guide when options.guideStepDegrees is 15', () => {
      const service = drawingService({ guideStepDegrees: 15 });

      expect(resolveAt(service, cursorAt15Degrees()).target?.kind).toBe('guide');
    });

    it('applies setGuideStep from the next resolution', () => {
      const service = drawingService();
      expect(resolveAt(service, cursorAt15Degrees()).target).toBeUndefined();

      service.setGuideStep(15);

      expect(service.getOptions().guideStepDegrees).toBe(15);
      expect(resolveAt(service, cursorAt15Degrees()).target?.kind).toBe('guide');
    });

    it.each([0, -15, Number.NaN, Number.POSITIVE_INFINITY])(
      'falls back to the default 45 degrees for an invalid step (%s)',
      (step) => {
        expect(drawingService({ guideStepDegrees: step }).getOptions().guideStepDegrees).toBe(45);

        const service = drawingService({ guideStepDegrees: 15 });
        service.setGuideStep(step);
        expect(service.getOptions().guideStepDegrees).toBe(45);
        expect(resolveAt(service, cursorAt15Degrees()).target).toBeUndefined();
      },
    );
  });

  describe('the preferred feature on a tie', () => {
    /** Vertex candidates originating from 2 features that overlap at the same coordinate */
    function overlappingProvider(): SnapProvider {
      const coordinate = offsetByPixels(1, 0);
      return fixedProvider('p', [
        { kind: 'vertex', coordinate, featureId: 'big', datasetId: 'data' },
        { kind: 'vertex', coordinate, featureId: 'small', datasetId: 'data' },
      ]);
    }

    it('makes the candidate matching preferFeature win when both the distance and the priority tie', () => {
      const service = createSnapService();
      service.register(overlappingProvider());

      const result = resolveAt(service, ORIGIN, {
        preferFeature: { featureId: 'small', datasetId: 'data' },
      });

      expect(result.target?.featureId).toBe('small');
    });

    it('keeps the one that arrived first (the listing order) when there is no preferFeature', () => {
      const service = createSnapService();
      service.register(overlappingProvider());

      expect(resolveAt(service).target?.featureId).toBe('big');
    });

    it('does not prefer it unless the origin (datasetId) matches as well', () => {
      const service = createSnapService();
      service.register(overlappingProvider());

      // Even with the same feature ID, a specification originating from the Store (with
      // no datasetId) has no effect
      const result = resolveAt(service, ORIGIN, { preferFeature: { featureId: 'small' } });

      expect(result.target?.featureId).toBe('big');
    });

    it('prefers a closer candidate over preferFeature', () => {
      const service = createSnapService();
      service.register(
        fixedProvider('p', [
          { kind: 'vertex', coordinate: offsetByPixels(4, 0), featureId: 'far' },
          { kind: 'vertex', coordinate: offsetByPixels(1, 0), featureId: 'near' },
        ]),
      );

      const result = resolveAt(service, ORIGIN, { preferFeature: { featureId: 'far' } });

      expect(result.target?.featureId).toBe('near');
    });

    it('makes the priority of the kind stronger than preferFeature', () => {
      const service = createSnapService();
      const coordinate = offsetByPixels(1, 0);
      service.register(
        fixedProvider('p', [
          { kind: 'vertex', coordinate, featureId: 'v' },
          { kind: 'intersection', coordinate, featureId: 'x' },
        ]),
      );

      const result = resolveAt(service, ORIGIN, { preferFeature: { featureId: 'x' } });

      expect(result.target?.kind).toBe('vertex');
    });
  });

  describe('snapping to the data (datasets)', () => {
    it('is enabled by default', () => {
      const service = createSnapService();

      expect(service.isDatasetsEnabled()).toBe(true);
      expect(service.getOptions().datasets).toBe(true);
    });

    it('can be disabled with an option', () => {
      const service = createSnapService({ options: { datasets: false } });

      expect(service.isDatasetsEnabled()).toBe(false);
      expect(service.getOptions().datasets).toBe(false);
    });

    it('allows switching at run time with setDatasetsEnabled', () => {
      const service = createSnapService();

      service.setDatasetsEnabled(false);
      expect(service.isDatasetsEnabled()).toBe(false);
      expect(service.getOptions().datasets).toBe(false);

      service.setDatasetsEnabled(true);
      expect(service.isDatasetsEnabled()).toBe(true);
    });

    it('keeps a change from spreading to another service (the defaults are not shared)', () => {
      const first = createSnapService();
      first.setDatasetsEnabled(false);

      expect(createSnapService().isDatasetsEnabled()).toBe(true);
      expect(DEFAULT_SNAP_OPTIONS.datasets).toBe(true);
    });
  });

  describe('exclusions and the context', () => {
    it('passes the tolerance and the specification of exclusions to the providers', () => {
      const service = createSnapService();
      const seen: Array<{ bbox: BoundingBox; ctx: SnapProviderContext }> = [];
      service.register({
        name: 'spy',
        candidates: (bbox, ctx) => {
          seen.push({ bbox, ctx });
          return [];
        },
      });

      resolveAt(service, ORIGIN, {
        excludeFeatureId: 'f1',
        excludeVertex: { featureId: 'f2', vertex: { ring: 0, index: 3 } },
      });

      expect(seen).toHaveLength(1);
      const { bbox, ctx } = seen[0];
      const perPixel = degreesPerPixel(ORIGIN.lat, ZOOM);
      expect(ctx.tolerancePx).toBe(10);
      expect(ctx.toleranceLngDeg).toBeCloseTo(perPixel.lng * 10, 12);
      expect(ctx.toleranceLatDeg).toBeCloseTo(perPixel.lat * 10, 12);
      expect(ctx.excludeFeatureId).toBe('f1');
      expect(ctx.excludeVertex).toEqual({ featureId: 'f2', vertex: { ring: 0, index: 3 } });
      expect(ctx.lngLat).toEqual(ORIGIN);
      expect(ctx.point).toEqual({ x: 100, y: 100 });
      expect(bbox.maxX - bbox.minX).toBeCloseTo(perPixel.lng * 20, 12);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(perPixel.lat * 20, 12);
    });

    it('keeps the candidates of the other providers alive even when one provider throws', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const service = createSnapService();
      service.register({
        name: 'broken',
        candidates: () => {
          throw new Error('boom');
        },
      });
      service.register(fixedProvider('ok', [{ kind: 'vertex', coordinate: offsetByPixels(1, 0) }]));

      expect(resolveAt(service).target?.kind).toBe('vertex');
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('enabling and disabling', () => {
    it('does not snap while the modifier key (Alt by default) is held down', () => {
      const service = createSnapService();
      service.register(fixedProvider('p', [{ kind: 'vertex', coordinate: offsetByPixels(1, 0) }]));

      const result = resolveAt(service, ORIGIN, {
        modifiers: { ...NO_MODIFIERS, alt: true },
      });

      expect(result.target).toBeUndefined();
      expect(result.lngLat).toEqual(ORIGIN);
      // Other modifier keys do not disable it
      expect(
        resolveAt(service, ORIGIN, { modifiers: { ...NO_MODIFIERS, shift: true } }).target?.kind,
      ).toBe('vertex');
    });

    it('allows the disabling key to be changed with an option', () => {
      const service = createSnapService({ options: { disableKey: 'shift' } });
      service.register(fixedProvider('p', [{ kind: 'vertex', coordinate: offsetByPixels(1, 0) }]));

      expect(
        resolveAt(service, ORIGIN, { modifiers: { ...NO_MODIFIERS, alt: true } }).target?.kind,
      ).toBe('vertex');
      expect(
        resolveAt(service, ORIGIN, { modifiers: { ...NO_MODIFIERS, shift: true } }).target,
      ).toBeUndefined();
    });

    it("is not disabled by a modifier key with disableKey: 'none'", () => {
      const service = createSnapService({ options: { disableKey: 'none' } });
      service.register(fixedProvider('p', [{ kind: 'vertex', coordinate: offsetByPixels(1, 0) }]));

      const modifiers: ModifierKeys = { shift: true, ctrl: true, alt: true, meta: true };
      expect(resolveAt(service, ORIGIN, { modifiers }).target?.kind).toBe('vertex');
    });

    it('allows snapping to be stopped with setEnabled(false)', () => {
      const service = createSnapService();
      service.register(fixedProvider('p', [{ kind: 'vertex', coordinate: offsetByPixels(1, 0) }]));

      service.setEnabled(false);
      expect(service.isEnabled()).toBe(false);
      expect(resolveAt(service).target).toBeUndefined();

      service.setEnabled(true);
      expect(resolveAt(service).target?.kind).toBe('vertex');
    });

    it('does not snap from the start when options.snap.enabled is false', () => {
      const service = createSnapService({ options: { enabled: false } });
      service.register(fixedProvider('p', [{ kind: 'vertex', coordinate: offsetByPixels(1, 0) }]));

      expect(service.isEnabled()).toBe(false);
      expect(resolveAt(service).target).toBeUndefined();
    });
  });

  describe('registering and unregistering providers', () => {
    it('drops it from the candidates when the return value of register is called', () => {
      const service = createSnapService();
      const unregister = service.register(
        fixedProvider('external', [{ kind: 'vertex', coordinate: offsetByPixels(1, 0) }]),
      );

      expect(resolveAt(service).target?.kind).toBe('vertex');

      unregister();

      expect(resolveAt(service).target).toBeUndefined();
      // Unregistering twice does nothing
      expect(() => unregister()).not.toThrow();
    });

    it('registers no built-in providers when no Store is given', () => {
      const service = createSnapService();
      expect(resolveAt(service).target).toBeUndefined();
    });
  });

  describe("the 'snap.change' event", () => {
    it('is emitted once when it snaps and once when it comes off', () => {
      const eventEmitter = new EventEmitterImpl();
      const events: SnapResult[] = [];
      eventEmitter.on('snap.change', (result) => events.push(result));

      const service = createSnapService({ eventEmitter });
      const vertex = offsetByPixels(1, 0);
      service.register(fixedProvider('p', [{ kind: 'vertex', coordinate: vertex }]));

      // A resolution from a state where nothing is snapped emits nothing
      resolveAt(service, { lng: 140.5, lat: 35.68 });
      expect(events).toHaveLength(0);

      // It snapped
      resolveAt(service);
      expect(events).toHaveLength(1);
      expect(events[0].target?.kind).toBe('vertex');

      // Nothing is emitted while it stays snapped to the same vertex
      resolveAt(service, { lng: ORIGIN.lng + 1e-7, lat: ORIGIN.lat });
      expect(events).toHaveLength(1);

      // Once it comes off, it is emitted once without a target
      resolveAt(service, { lng: 140.5, lat: 35.68 });
      expect(events).toHaveLength(2);
      expect(events[1].target).toBeUndefined();
      resolveAt(service, { lng: 140.6, lat: 35.68 });
      expect(events).toHaveLength(2);
    });

    it('is emitted when the origin changes, even at the same coordinate on the same feature', () => {
      const eventEmitter = new EventEmitterImpl();
      const events: SnapResult[] = [];
      eventEmitter.on('snap.change', (result) => events.push(result));

      const service = createSnapService({ eventEmitter });
      const coordinate = offsetByPixels(1, 0);
      let datasetId: string | undefined;
      service.register({
        name: 'p',
        candidates: (): SnapCandidate[] => [
          { kind: 'vertex', coordinate, featureId: 'f1', datasetId },
        ],
      });

      resolveAt(service);
      expect(events).toHaveLength(1);
      expect(events[0].target?.datasetId).toBeUndefined();

      datasetId = 'data';
      resolveAt(service);

      expect(events).toHaveLength(2);
      expect(events[1].target?.datasetId).toBe('data');
    });

    it('emits the movement of the snapped point while moving along an edge', () => {
      const eventEmitter = new EventEmitterImpl();
      const events: SnapResult[] = [];
      eventEmitter.on('snap.change', (result) => events.push(result));

      const service = createSnapService({ eventEmitter });
      service.register(
        fixedProvider('p', [
          { kind: 'edge', start: offsetByPixels(2, -20), end: offsetByPixels(2, 20) },
        ]),
      );

      resolveAt(service);
      const moved = offsetByPixels(0, 3);
      resolveAt(service, { lng: moved[0], lat: moved[1] });

      expect(events).toHaveLength(2);
      expect(events[1].target?.kind).toBe('edge');
      expect(events[1].lngLat.lat).toBeCloseTo(moved[1], 12);
    });

    it('is emitted when the segment changes, even when the snapped point is the same', () => {
      const eventEmitter = new EventEmitterImpl();
      const events: SnapResult[] = [];
      eventEmitter.on('snap.change', (result) => events.push(result));

      const service = createSnapService({ eventEmitter });
      const x = offsetByPixels(2, 0)[0];
      const shortSegment = {
        kind: 'edge' as const,
        start: [x, offsetByPixels(0, -20)[1]] as Coordinate,
        end: [x, offsetByPixels(0, 20)[1]] as Coordinate,
        featureId: 'f1',
      };
      const longSegment = {
        ...shortSegment,
        start: [x, offsetByPixels(0, -30)[1]] as Coordinate,
        end: [x, offsetByPixels(0, 30)[1]] as Coordinate,
      };

      const short = service.register(fixedProvider('short', [shortSegment]));
      const first = resolveAt(service);
      expect(events).toHaveLength(1);

      short();
      service.register(fixedProvider('long', [longSegment]));
      const second = resolveAt(service);

      // The coordinate after snapping is the same, but the segment of the target differs,
      // so it is emitted as a change
      expect(second.lngLat).toEqual(first.lngLat);
      expect(events).toHaveLength(2);
      expect(events[1].target?.segment?.start).toEqual(longSegment.start);
    });

    it('allows the most recent result to be read with getResult', () => {
      const service = createSnapService();
      expect(service.getResult()).toBeNull();

      service.register(fixedProvider('p', [{ kind: 'vertex', coordinate: offsetByPixels(1, 0) }]));
      const result = resolveAt(service);

      expect(service.getResult()).toEqual(result);
    });
  });
});
