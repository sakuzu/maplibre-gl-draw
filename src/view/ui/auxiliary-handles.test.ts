// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The registry and hit testing of the auxiliary handles (handles provided by an extension
 * implementation)
 *
 * The first part covers the registry (registration / enumeration / cancellation). The
 * middle part covers the priority order of hitTestHandles, verifying that they are taken
 * after resize and before vertex, that they are limited to a single selection, and that the
 * path is the same as before when no provider at all is registered. The last part covers
 * the selection-independent handles (getGlobalHandles), verifying that they can be grabbed
 * even when the selection is empty and that they do not mix into the hit testing of the
 * selection's handles.
 *
 * Coordinates are handled with a mock transform in the same convention as
 * drag-handler.test.ts (longitude/latitude mapped linearly at 1 degree = 10px).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAuxiliaryHandlesCallback,
  getGlobalAuxiliaryHandlesCallback,
} from '../../modes/select/hit-helpers.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import type { CoordinateTransform } from '../../shared/math/index.js';
import type { Coordinate, Feature } from '../../store/types.js';
import type {
  AuxiliaryHandle,
  AuxiliaryHandleContext,
  AuxiliaryHandleProvider,
} from './auxiliary-handles.js';
import type { AuxiliaryHandlesCallback } from './handle-test.js';
import {
  getCursorForHandle,
  hitTestGlobalAuxiliaryHandles,
  hitTestHandles,
} from './handle-test.js';
import { createSelectionScope } from './selection-scope.js';

// A transform that maps longitude/latitude naively and linearly (1 degree = 10px)
const transform: CoordinateTransform = {
  project: (lngLat: Coordinate) => ({ x: lngLat[0] * 10, y: -lngLat[1] * 10 }),
  unproject: (point: { x: number; y: number }) => ({ lng: point.x / 10, lat: -point.y / 10 }),
};

const ZOOM = 10;

/** A polygon that is a translated unit square (a closed ring) */
function square(id: string, minX: number, minY: number, size = 10): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [minX, minY],
          [minX + size, minY],
          [minX + size, minY + size],
          [minX, minY + size],
          [minX, minY],
        ],
      ],
    },
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

function point(id: string, lng: number, lat: number): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

/** A provider that merely returns a fixed set of handles */
function stubProvider(id: string, handles: AuxiliaryHandle[]): AuxiliaryHandleProvider {
  return {
    id,
    getHandles: () => handles,
    onHandleDragStart: () => true,
    onHandleDragMove: () => {},
    onHandleDragEnd: () => {},
  };
}

function hitTest(
  screenPoint: { x: number; y: number },
  features: Feature[],
  getAuxiliaryHandles?: AuxiliaryHandlesCallback,
) {
  return hitTestHandles(
    screenPoint,
    features,
    transform,
    DEFAULT_SELECTION_CONFIG,
    ZOOM,
    scope,
    undefined,
    getAuxiliaryHandles,
  );
}

/** The selection scope of the draw instance under test (a fresh one per test) */
let scope = createSelectionScope();

beforeEach(() => {
  scope = createSelectionScope();
});

describe('registry of the auxiliary handles', () => {
  it('can enumerate a registered provider', () => {
    const provider = stubProvider('p1', []);
    scope.auxiliaryHandles.register(provider);

    expect(scope.auxiliaryHandles.list()).toEqual([provider]);
    expect(scope.auxiliaryHandles.get('p1')).toBe(provider);
  });

  it('can cancel the registration with the returned function', () => {
    const unregister = scope.auxiliaryHandles.register(stubProvider('p1', []));
    unregister();

    expect(scope.auxiliaryHandles.list()).toEqual([]);
    expect(scope.auxiliaryHandles.get('p1')).toBeUndefined();
  });

  it('re-registering with the same id overwrites', () => {
    scope.auxiliaryHandles.register(stubProvider('p1', []));
    const second = stubProvider('p1', []);
    scope.auxiliaryHandles.register(second);

    expect(scope.auxiliaryHandles.list()).toEqual([second]);
  });

  it('calling the old cancel function after a re-registration keeps the new provider', () => {
    const unregisterFirst = scope.auxiliaryHandles.register(stubProvider('p1', []));
    const second = stubProvider('p1', []);
    scope.auxiliaryHandles.register(second);

    unregisterFirst();

    expect(scope.auxiliaryHandles.list()).toEqual([second]);
  });

  it('is safe to call the cancellation twice', () => {
    const unregister = scope.auxiliaryHandles.register(stubProvider('p1', []));
    unregister();
    unregister();

    expect(scope.auxiliaryHandles.list()).toEqual([]);
  });

  it('a provider registered in another draw instance is never enumerated here', () => {
    const other = createSelectionScope();
    other.auxiliaryHandles.register(stubProvider('p1', [{ id: 'h1', position: [1, 1] }]));

    expect(scope.auxiliaryHandles.list()).toEqual([]);
    expect(getAuxiliaryHandlesCallback([square('f1', 0, 0)], scope)).toBeUndefined();
    expect(getGlobalAuxiliaryHandlesCallback(scope)).toBeUndefined();
  });

  it('clear removes everything', () => {
    scope.auxiliaryHandles.register(stubProvider('p1', []));
    scope.auxiliaryHandles.register(stubProvider('p2', []));

    scope.auxiliaryHandles.clear();

    expect(scope.auxiliaryHandles.list()).toEqual([]);
  });
});

describe('the auxiliary handle enumeration callback (the single-selection restriction)', () => {
  it('is undefined when there is no provider (the same path as before)', () => {
    expect(getAuxiliaryHandlesCallback([square('f1', 0, 0)], scope)).toBeUndefined();
  });

  it('is undefined for a multiple selection', () => {
    scope.auxiliaryHandles.register(stubProvider('p1', [{ id: 'h1', position: [0, 0] }]));

    expect(
      getAuxiliaryHandlesCallback([square('f1', 0, 0), square('f2', 20, 0)], scope),
    ).toBeUndefined();
  });

  it('collects the handles of all providers in registration order for a single selection', () => {
    scope.auxiliaryHandles.register(stubProvider('p1', [{ id: 'h1', position: [1, 1] }]));
    scope.auxiliaryHandles.register(stubProvider('p2', [{ id: 'h2', position: [2, 2] }]));

    const callback = getAuxiliaryHandlesCallback([square('f1', 0, 0)], scope);
    const candidates = callback?.({
      point: { x: 0, y: 0 },
      project: transform.project,
      unproject: transform.unproject,
      zoom: ZOOM,
    });

    expect(candidates).toEqual([
      { providerId: 'p1', handle: { id: 'h1', position: [1, 1] } },
      { providerId: 'p2', handle: { id: 'h2', position: [2, 2] } },
    ]);
  });

  it('getHandles receives the selected feature and context (test point / transform / zoom)', () => {
    const feature = square('f1', 0, 0);
    const getHandles = vi.fn<(f: Feature, context: AuxiliaryHandleContext) => AuxiliaryHandle[]>(
      () => [],
    );
    scope.auxiliaryHandles.register({ ...stubProvider('p1', []), getHandles });

    hitTest({ x: 35, y: -45 }, [feature], getAuxiliaryHandlesCallback([feature], scope));

    expect(getHandles).toHaveBeenCalledTimes(1);
    const [passedFeature, context] = getHandles.mock.calls[0];
    expect(passedFeature).toBe(feature);
    expect(context.point).toEqual({ x: 35, y: -45 });
    expect(context.zoom).toBe(ZOOM);
    expect(context.project([1, 2])).toEqual({ x: 10, y: -20 });
    expect(context.unproject({ x: 10, y: -20 })).toEqual({ lng: 1, lat: 2 });
  });
});

describe('the priority order of hitTestHandles', () => {
  const feature = square('f1', 0, 0);

  /** A callback that returns a single position */
  function handlesAt(position: Coordinate, cursor?: string): AuxiliaryHandlesCallback {
    return () => [{ providerId: 'p1', handle: { id: 'h1', position, cursor } }];
  }

  it('takes the auxiliary handle before the vertex', () => {
    // [10,0] is a vertex of f1
    expect(hitTest({ x: 100, y: 0 }, [feature])?.type).toBe('vertex');

    const hit = hitTest({ x: 100, y: 0 }, [feature], handlesAt([10, 0]));
    expect(hit?.type).toBe('auxiliary');
    expect(hit?.auxiliary).toEqual({ providerId: 'p1', handleId: 'h1', featureId: 'f1' });
    expect(hit?.featureId).toBe('f1');
  });

  it('takes the auxiliary handle before the midpoint', () => {
    // [5,0] is the midpoint of [0,0]-[10,0]
    expect(hitTest({ x: 50, y: 0 }, [feature])?.type).toBe('midpoint');
    expect(hitTest({ x: 50, y: 0 }, [feature], handlesAt([5, 0]))?.type).toBe('auxiliary');
  });

  it('takes the resize handle first', () => {
    // The margin is 10px = 1 degree, so the top-left resize handle is at [-1, 11]
    expect(hitTest({ x: -10, y: -110 }, [feature])?.type).toBe('resize');
    expect(hitTest({ x: -10, y: -110 }, [feature], handlesAt([-1, 11]))?.type).toBe('resize');
  });

  it('is taken before the inside of the bounding box (move)', () => {
    expect(hitTest({ x: 50, y: -50 }, [feature])?.type).toBe('move');
    expect(hitTest({ x: 50, y: -50 }, [feature], handlesAt([5, 5]))?.type).toBe('auxiliary');
  });

  it('does not take an auxiliary handle that is far away (the test is a screen-px rect)', () => {
    // Farther than the radius of a vertex handle (12/2 = 6px)
    expect(hitTest({ x: 50, y: -50 }, [feature], handlesAt([5.7, 5]))?.type).toBe('move');
  });

  it('takes the auxiliary handle even on a Point that has no rotate or resize handle', () => {
    const pointFeature = point('p1', 5, 5);
    expect(hitTest({ x: 50, y: -50 }, [pointFeature])?.type).toBe('move');
    expect(hitTest({ x: 50, y: -50 }, [pointFeature], handlesAt([5, 5]))?.type).toBe('auxiliary');
  });

  it('does not take an auxiliary handle for a multiple selection', () => {
    const features = [square('f1', 0, 0), square('f2', 20, 0)];
    expect(hitTest({ x: 50, y: -50 }, features, handlesAt([5, 5]))?.type).not.toBe('auxiliary');
  });

  it('performs no test at all when no callback is passed (as before)', () => {
    const getHandles = vi.fn(() => []);
    scope.auxiliaryHandles.register({ ...stubProvider('p1', []), getHandles });

    // No callback specified = the same path as when no provider is registered
    expect(hitTest({ x: 100, y: 0 }, [feature])?.type).toBe('vertex');
    expect(getHandles).not.toHaveBeenCalled();
  });

  it('falls back to the previous test when no handle at all is returned', () => {
    expect(hitTest({ x: 100, y: 0 }, [feature], () => [])?.type).toBe('vertex');
  });

  it('uses the cursor specified by the handle, or pointer when it is unset', () => {
    const withCursor = hitTest({ x: 50, y: -50 }, [feature], handlesAt([5, 5], 'grab'));
    expect(getCursorForHandle(withCursor)).toBe('grab');

    const withoutCursor = hitTest({ x: 50, y: -50 }, [feature], handlesAt([5, 5]));
    expect(getCursorForHandle(withoutCursor)).toBe('pointer');
  });
});

describe('invariance when no provider is registered', () => {
  const feature = square('f1', 0, 0);

  it('the existing handle tests work as before', () => {
    const withoutProviders = [
      hitTest({ x: 100, y: 0 }, [feature])?.type,
      hitTest({ x: 50, y: 0 }, [feature])?.type,
      hitTest({ x: -10, y: -110 }, [feature])?.type,
      hitTest({ x: 50, y: -50 }, [feature])?.type,
      hitTest({ x: 1000, y: 1000 }, [feature])?.type,
    ];

    // Even if the callback is assembled, it becomes undefined without a provider, so the
    // path is the same
    const callback = getAuxiliaryHandlesCallback([feature], scope);
    const withCallback = [
      hitTest({ x: 100, y: 0 }, [feature], callback)?.type,
      hitTest({ x: 50, y: 0 }, [feature], callback)?.type,
      hitTest({ x: -10, y: -110 }, [feature], callback)?.type,
      hitTest({ x: 50, y: -50 }, [feature], callback)?.type,
      hitTest({ x: 1000, y: 1000 }, [feature], callback)?.type,
    ];

    expect(withoutProviders).toEqual(['vertex', 'midpoint', 'resize', 'move', undefined]);
    expect(withCallback).toEqual(withoutProviders);
  });
});

describe('selection-independent auxiliary handles (getGlobalHandles)', () => {
  /** A provider that has getGlobalHandles */
  function globalProvider(id: string, handles: AuxiliaryHandle[]): AuxiliaryHandleProvider {
    return { ...stubProvider(id, []), getGlobalHandles: () => handles };
  }

  function hitGlobal(
    screenPoint: { x: number; y: number },
    getGlobalHandles?: AuxiliaryHandlesCallback,
  ) {
    return hitTestGlobalAuxiliaryHandles(
      screenPoint,
      transform,
      DEFAULT_SELECTION_CONFIG,
      ZOOM,
      getGlobalHandles,
    );
  }

  describe('the enumeration callback', () => {
    it('is undefined when no provider has getGlobalHandles (the same path as before)', () => {
      scope.auxiliaryHandles.register(stubProvider('p1', [{ id: 'h1', position: [5, 5] }]));

      expect(getGlobalAuxiliaryHandlesCallback(scope)).toBeUndefined();
    });

    it('collects the handles of all providers in order even when the selection is empty', () => {
      scope.auxiliaryHandles.register(globalProvider('p1', [{ id: 'g1', position: [1, 1] }]));
      scope.auxiliaryHandles.register(globalProvider('p2', [{ id: 'g2', position: [2, 2] }]));

      const candidates = getGlobalAuxiliaryHandlesCallback(scope)?.({
        point: { x: 0, y: 0 },
        project: transform.project,
        unproject: transform.unproject,
        zoom: ZOOM,
      });

      expect(candidates).toEqual([
        { providerId: 'p1', handle: { id: 'g1', position: [1, 1] } },
        { providerId: 'p2', handle: { id: 'g2', position: [2, 2] } },
      ]);
    });

    it('a provider without getGlobalHandles does not mix in', () => {
      scope.auxiliaryHandles.register(
        stubProvider('selection-only', [{ id: 'h1', position: [5, 5] }]),
      );
      scope.auxiliaryHandles.register(globalProvider('p1', [{ id: 'g1', position: [1, 1] }]));

      const candidates = getGlobalAuxiliaryHandlesCallback(scope)?.({
        point: { x: 0, y: 0 },
        project: transform.project,
        unproject: transform.unproject,
        zoom: ZOOM,
      });

      expect(candidates).toEqual([{ providerId: 'p1', handle: { id: 'g1', position: [1, 1] } }]);
    });

    it('getGlobalHandles receives the context (test point / transform / zoom)', () => {
      const getGlobalHandles = vi.fn<(context: AuxiliaryHandleContext) => AuxiliaryHandle[]>(
        () => [],
      );
      scope.auxiliaryHandles.register({ ...stubProvider('p1', []), getGlobalHandles });

      hitGlobal({ x: 35, y: -45 }, getGlobalAuxiliaryHandlesCallback(scope));

      expect(getGlobalHandles).toHaveBeenCalledTimes(1);
      const [context] = getGlobalHandles.mock.calls[0];
      expect(context.point).toEqual({ x: 35, y: -45 });
      expect(context.zoom).toBe(ZOOM);
      expect(context.project([1, 2])).toEqual({ x: 10, y: -20 });
    });
  });

  describe('hit testing', () => {
    /** A callback that returns a single position */
    function handlesAt(position: Coordinate, cursor?: string): AuxiliaryHandlesCallback {
      return () => [{ providerId: 'p1', handle: { id: 'g1', position, cursor } }];
    }

    it('a handle can be grabbed even without a selection (returned as auxiliary)', () => {
      const hit = hitGlobal({ x: 50, y: -50 }, handlesAt([5, 5]));

      expect(hit?.type).toBe('auxiliary');
      expect(hit?.auxiliary).toEqual({
        providerId: 'p1',
        handleId: 'g1',
        featureId: '',
        global: true,
      });
      // There is no feature it sits on, so no featureId is attached
      expect(hit?.featureId).toBeUndefined();
    });

    it('the test is a screen-px rectangle (no hit when it is far away)', () => {
      expect(hitGlobal({ x: 50, y: -50 }, handlesAt([5.7, 5]))).toBeNull();
    });

    it('performs no test at all when no callback is passed', () => {
      const getGlobalHandles = vi.fn(() => []);
      scope.auxiliaryHandles.register({ ...stubProvider('p1', []), getGlobalHandles });

      expect(hitGlobal({ x: 50, y: -50 })).toBeNull();
      expect(getGlobalHandles).not.toHaveBeenCalled();
    });

    it('uses the cursor specified by the handle, or pointer when it is unset', () => {
      expect(getCursorForHandle(hitGlobal({ x: 50, y: -50 }, handlesAt([5, 5], 'grab')))).toBe(
        'grab',
      );
      expect(getCursorForHandle(hitGlobal({ x: 50, y: -50 }, handlesAt([5, 5])))).toBe('pointer');
    });
  });

  describe('non-interference with the handles of the selection', () => {
    it('getGlobalHandles is not called by hitTestHandles (selection handles as before)', () => {
      const feature = square('f1', 0, 0);
      const getGlobalHandles = vi.fn(() => [{ id: 'g1', position: [10, 0] as Coordinate }]);
      scope.auxiliaryHandles.register({ ...stubProvider('p1', []), getGlobalHandles });

      // [10,0] is a vertex of f1. The selection handle test returns vertex as before
      expect(
        hitTest({ x: 100, y: 0 }, [feature], getAuxiliaryHandlesCallback([feature], scope))?.type,
      ).toBe('vertex');
      expect(getGlobalHandles).not.toHaveBeenCalled();
    });
  });
});
