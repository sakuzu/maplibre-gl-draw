// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the draw order of renderLayers
 *
 * Rendering is controlled by the painter's algorithm (what is drawn later is on top), not by
 * depth (z-order). The draw order within one layer must therefore match layer.order. These tests
 * verify that core features (batched rendering) and custom features (immediate rendering) are
 * painted in the order of layer.order even when they are mixed.
 *
 * The test doubles record the "order in which painting actually fires":
 *   - batchManager: processFeature does not draw but queues, and endFrame paints the queue in
 *     order (imitating the behaviour of the real batched rendering)
 *   - customRenderer.draw: paints immediately
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { DatasetManager } from '../../dataset/manager.js';
import { createDatasetManager } from '../../dataset/manager.js';
import type {
  CustomFeatureHandler,
  CustomRendererDrawContext,
  LayerAwareOverlayRenderer,
} from '../../extension/index.js';
import { geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import type { Store } from '../../store/store.js';
import type { Feature, Layer } from '../../store/types.js';
import { toRow } from '../../test-utils.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { type RenderLayersRange, renderLayers } from './render.js';
import type { Renderers } from './renderers.js';
import type { StoreRetainedCache, StoreRetainedDrawDeps } from './store-retained.js';

function makeFeature(id: string, type: Feature['type'], layerId: string): Feature {
  return {
    id,
    type,
    geometry: geometryFromCoordinates(
      type,
      type === 'Polygon'
        ? [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ]
        : [0, 0],
    ),
    layerId,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

/**
 * Stub that looks up a layer for an entry of the stacking order
 *
 * In the real Store, a layer id on the order can always be looked up with getLayer. The
 * rendering loop treats an "entry that cannot be looked up as a layer" as a
 * dataset, and otherwise as an unknown id, so the consistency with the order is reproduced
 * here.
 */
function makeGetLayer(layerIds: string[]): (id: string) => Layer | undefined {
  const layers = new Set(layerIds);
  return (id: string) =>
    layers.has(id)
      ? ({ id, name: id, visible: true, locked: false, opacity: 1, items: [] } as Layer)
      : undefined;
}

/**
 * A renderLayers call for tests that imitates the painter's algorithm.
 * Returns the order of the feature ids that were actually painted.
 */
function runRenderLayers(
  features: Feature[],
  layerOrder: string[],
  datasets?: DatasetManager,
  layerIds?: string[],
  range?: RenderLayersRange,
): string[] {
  const paintLog: string[] = [];
  let pending: string[] = [];

  const batchManager = {
    beginFrame: (): void => {
      pending = [];
    },
    processFeature: (feature: Feature): boolean => {
      // Only queued into the batch; nothing is painted at this point
      pending.push(feature.id);
      return false;
    },
    endFrame: (): void => {
      // Paint the accumulated batch all at once
      for (const id of pending) {
        paintLog.push(id);
      }
      pending = [];
    },
  };

  const tentativeRenderer = {
    drawGeometry: (): void => {},
  };

  const r = { batchManager, tentativeRenderer } as unknown as Renderers;

  const store = {
    getLayerOrder: (): string[] => layerOrder,
    // A layer is looked up to evaluate the style rule, but these tests do not use the rule
    getLayer: makeGetLayer(layerIds ?? layerOrder),
    getTentative: (): null => null,
  } as unknown as Store;

  const customRenderers = new Map<string, CustomFeatureHandler['renderer']>();
  const makeCustomRenderer = (): CustomFeatureHandler['renderer'] =>
    ({
      draw: (feature: { id: string }): void => {
        // A custom feature is painted immediately
        paintLog.push(feature.id);
      },
    }) as unknown as CustomFeatureHandler['renderer'];
  // Custom feature types an extension could register (Marker / Sticker, plus Point taken over)
  customRenderers.set('Marker', makeCustomRenderer());
  customRenderers.set('Sticker', makeCustomRenderer());
  customRenderers.set('Point', makeCustomRenderer());

  renderLayers(
    r,
    store,
    features,
    new Set<string>(),
    {} as unknown as ProjectionData,
    14,
    customRenderers,
    {} as unknown as CustomRendererDrawContext,
    createFeatureCompanionRegistry(),
    [] as LayerAwareOverlayRenderer[],
    datasets,
    undefined,
    undefined,
    range,
  );

  return paintLog;
}

describe('renderLayers draw order', () => {
  it('custom features and core features in one layer are painted in layer.order', () => {
    // layer.order: Polygon → Marker → Polygon
    const features = [
      makeFeature('poly-1', 'Polygon', 'layer-1'),
      makeFeature('marker-1', 'Marker', 'layer-1'),
      makeFeature('poly-2', 'Polygon', 'layer-1'),
    ];

    const paintOrder = runRenderLayers(features, ['layer-1']);

    // Marker (in the middle of the order) must be painted after poly-1 and before poly-2
    expect(paintOrder).toEqual(['poly-1', 'marker-1', 'poly-2']);
  });

  it('putting Marker last paints it last (shown in the foreground)', () => {
    const features = [
      makeFeature('poly-1', 'Polygon', 'layer-1'),
      makeFeature('poly-2', 'Polygon', 'layer-1'),
      makeFeature('marker-1', 'Marker', 'layer-1'),
    ];

    const paintOrder = runRenderLayers(features, ['layer-1']);

    expect(paintOrder).toEqual(['poly-1', 'poly-2', 'marker-1']);
  });

  it('custom types (Marker/Sticker/Point) mixed with core types still keep layer.order', () => {
    // A custom renderer may take over a core type such as Point too, so its relative
    // order against Polygon / LineString (the batched core types) used to break.
    const features = [
      makeFeature('poly-1', 'Polygon', 'layer-1'),
      makeFeature('sticker-1', 'Sticker', 'layer-1'),
      makeFeature('line-1', 'LineString', 'layer-1'),
      makeFeature('point-1', 'Point', 'layer-1'),
      makeFeature('marker-1', 'Marker', 'layer-1'),
      makeFeature('poly-2', 'Polygon', 'layer-1'),
    ];

    const paintOrder = runRenderLayers(features, ['layer-1']);

    expect(paintOrder).toEqual(['poly-1', 'sticker-1', 'line-1', 'point-1', 'marker-1', 'poly-2']);
  });

  it('the order across layers is kept', () => {
    // layer-bottom comes first (below), layer-top later (above)
    const features = [
      makeFeature('poly-bottom', 'Polygon', 'layer-bottom'),
      makeFeature('marker-top', 'Marker', 'layer-top'),
    ];

    const paintOrder = runRenderLayers(features, ['layer-bottom', 'layer-top']);

    expect(paintOrder).toEqual(['poly-bottom', 'marker-top']);
  });
});

describe('renderLayers and datasets', () => {
  /** Manager of the datasets (the viewport is the whole globe) */
  function createDisplay(): DatasetManager {
    return createDatasetManager({
      getViewportBounds: () => ({ minX: -180, minY: -85, maxX: 180, maxY: 85 }),
      getZoom: () => 14,
      onViewportChange: () => () => {},
      requestRepaint: () => {},
    });
  }

  const storeFeatures = [
    makeFeature('poly-1', 'Polygon', 'layer-1'),
    makeFeature('poly-2', 'Polygon', 'layer-1'),
  ];

  it('below-store is drawn before every layer of the Store', () => {
    const display = createDisplay();
    display.add({
      id: 'disp',
      rows: [toRow({ id: 'disp-1', type: 'Point', coordinates: [0, 0] })],
      order: 'below-store',
    });

    const paintOrder = runRenderLayers(storeFeatures, ['layer-1'], display);

    expect(paintOrder).toEqual(['disp-1', 'poly-1', 'poly-2']);
  });

  it('above-store is drawn after every layer of the Store', () => {
    const display = createDisplay();
    display.add({
      id: 'disp',
      rows: [toRow({ id: 'disp-1', type: 'Point', coordinates: [0, 0] })],
      order: 'above-store',
    });

    const paintOrder = runRenderLayers(storeFeatures, ['layer-1'], display);

    expect(paintOrder).toEqual(['poly-1', 'poly-2', 'disp-1']);
  });

  it('the two insertion points sandwich the several layers of the Store', () => {
    const display = createDisplay();
    display.add({
      id: 'under',
      rows: [toRow({ id: 'under-1', type: 'Point', coordinates: [0, 0] })],
      order: 'below-store',
    });
    display.add({
      id: 'over',
      rows: [toRow({ id: 'over-1', type: 'Point', coordinates: [0, 0] })],
      order: 'above-store',
    });

    const features = [
      makeFeature('poly-bottom', 'Polygon', 'layer-bottom'),
      makeFeature('poly-top', 'Polygon', 'layer-top'),
    ];
    const paintOrder = runRenderLayers(features, ['layer-bottom', 'layer-top'], display);

    expect(paintOrder).toEqual(['under-1', 'poly-bottom', 'poly-top', 'over-1']);
  });

  it('the rendering of the Store is unchanged when no dataset is passed', () => {
    const withDisplay = runRenderLayers(storeFeatures, ['layer-1'], createDisplay());
    const withoutDisplay = runRenderLayers(storeFeatures, ['layer-1']);

    expect(withDisplay).toEqual(withoutDisplay);
  });

  describe('insertion into the stacking order (order: layer-order)', () => {
    const layered = [
      makeFeature('poly-bottom', 'Polygon', 'layer-bottom'),
      makeFeature('poly-top', 'Polygon', 'layer-top'),
    ];

    it('a dataset inserted into the order is drawn between the layers', () => {
      const display = createDisplay();
      display.add({
        id: 'middle',
        rows: [toRow({ id: 'mid-1', type: 'Point', coordinates: [0, 0] })],
        order: 'layer-order',
      });

      const paintOrder = runRenderLayers(
        layered,
        ['layer-bottom', 'middle', 'layer-top'],
        display,
        ['layer-bottom', 'layer-top'],
      );

      expect(paintOrder).toEqual(['poly-bottom', 'mid-1', 'poly-top']);
    });

    it('changing the position in the order changes the draw order too', () => {
      const display = createDisplay();
      display.add({
        id: 'middle',
        rows: [toRow({ id: 'mid-1', type: 'Point', coordinates: [0, 0] })],
        order: 'layer-order',
      });

      const paintOrder = runRenderLayers(
        layered,
        ['middle', 'layer-bottom', 'layer-top'],
        display,
        ['layer-bottom', 'layer-top'],
      );

      expect(paintOrder).toEqual(['mid-1', 'poly-bottom', 'poly-top']);
    });

    it('a layer-order dataset that is not on the order is not drawn', () => {
      const display = createDisplay();
      display.add({
        id: 'orphan',
        rows: [toRow({ id: 'orphan-1', type: 'Point', coordinates: [0, 0] })],
        order: 'layer-order',
      });

      const paintOrder = runRenderLayers(storeFeatures, ['layer-1'], display);

      expect(paintOrder).toEqual(['poly-1', 'poly-2']);
    });

    it('an id that is neither a layer nor a dataset is skipped', () => {
      const display = createDisplay();
      display.add({
        id: 'middle',
        rows: [toRow({ id: 'mid-1', type: 'Point', coordinates: [0, 0] })],
        order: 'layer-order',
      });

      const paintOrder = runRenderLayers(
        layered,
        ['layer-bottom', 'unknown-entry', 'middle', 'layer-top'],
        display,
        ['layer-bottom', 'layer-top'],
      );

      expect(paintOrder).toEqual(['poly-bottom', 'mid-1', 'poly-top']);
    });

    it('an unknown id is harmless even when no dataset is passed', () => {
      const paintOrder = runRenderLayers(
        layered,
        ['layer-bottom', 'unknown-entry', 'layer-top'],
        undefined,
        ['layer-bottom', 'layer-top'],
      );

      expect(paintOrder).toEqual(['poly-bottom', 'poly-top']);
    });

    it('a dataset on the order coexists with below-store / above-store', () => {
      const display = createDisplay();
      display.add({
        id: 'under',
        rows: [toRow({ id: 'under-1', type: 'Point', coordinates: [0, 0] })],
        order: 'below-store',
      });
      display.add({
        id: 'middle',
        rows: [toRow({ id: 'mid-1', type: 'Point', coordinates: [0, 0] })],
        order: 'layer-order',
      });
      display.add({
        id: 'over',
        rows: [toRow({ id: 'over-1', type: 'Point', coordinates: [0, 0] })],
        order: 'above-store',
      });

      const paintOrder = runRenderLayers(
        layered,
        ['layer-bottom', 'middle', 'layer-top'],
        display,
        ['layer-bottom', 'layer-top'],
      );

      expect(paintOrder).toEqual(['under-1', 'poly-bottom', 'mid-1', 'poly-top', 'over-1']);
    });
  });
});

describe('viewport of renderLayers', () => {
  it('the bbox is computed once and passed to the datasets even in immediate mode', () => {
    let boundsCalls = 0;
    const bounds = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    let managerBoundsCalls = 0;

    const display = createDatasetManager({
      getViewportBounds: () => {
        managerBoundsCalls++;
        return { minX: -180, minY: -85, maxX: 180, maxY: 85 };
      },
      getZoom: () => 14,
      onViewportChange: () => () => {},
      requestRepaint: () => {},
    });
    display.add({
      id: 'under',
      rows: [toRow({ id: 'under-1', type: 'Point', coordinates: [0, 0] })],
    });
    display.add({
      id: 'over',
      rows: [toRow({ id: 'over-1', type: 'Point', coordinates: [0, 0] })],
      order: 'above-store',
    });
    managerBoundsCalls = 0;

    const r = {
      batchManager: {
        beginFrame: (): void => {},
        processFeature: (): boolean => false,
        endFrame: (): void => {},
      },
      tentativeRenderer: { drawGeometry: (): void => {} },
      viewportFilter: {
        getBounds: () => {
          boundsCalls++;
          return bounds;
        },
        getVisibleIds: (): Set<string> => new Set(),
      },
    } as unknown as Renderers;

    const store = {
      getLayerOrder: (): string[] => ['layer-1'],
      getLayer: makeGetLayer(['layer-1']),
      getTentative: (): null => null,
    } as unknown as Store;

    renderLayers(
      r,
      store,
      [],
      new Set<string>(),
      {} as unknown as ProjectionData,
      14,
      new Map<string, CustomFeatureHandler['renderer']>(),
      {} as unknown as CustomRendererDrawContext,
      createFeatureCompanionRegistry(),
      [] as LayerAwareOverlayRenderer[],
      display,
    );

    // Even in immediate mode (no renderers for retained mode) it is computed only once, and
    // the lazy lookup on the manager side is not used
    expect(boundsCalls).toBe(1);
    expect(managerBoundsCalls).toBe(0);
  });
});

describe('renderLayers and the retained mode of the Store', () => {
  /** Stub of the cache that records the calls of retained mode */
  function createStoreRetained(log: string[]): StoreRetainedCache {
    return {
      beginFrame: (): void => {
        log.push('beginFrame');
      },
      drawLayer: (layerId: string): void => {
        log.push(`drawLayer:${layerId}`);
      },
    } as unknown as StoreRetainedCache;
  }

  /**
   * Stub of a batchManager that supports retained mode
   *
   * The retained path is taken only when getRetainedRenderers returns a value.
   */
  function createRenderers(
    log: string[],
    retained: boolean,
    layerOrder: string[],
  ): { r: Renderers; store: Store } {
    const batchManager = {
      beginFrame: (): void => {},
      processFeature: (feature: Feature): boolean => {
        log.push(`immediate:${feature.id}`);
        return false;
      },
      endFrame: (): void => {},
      getRetainedRenderers: () => (retained ? ({} as never) : undefined),
    };

    const r = {
      batchManager,
      tentativeRenderer: { drawGeometry: (): void => {} },
    } as unknown as Renderers;

    const store = {
      getLayerOrder: (): string[] => layerOrder,
      getLayer: makeGetLayer(layerOrder),
      getTentative: (): null => null,
    } as unknown as Store;

    return { r, store };
  }

  function run(retained: boolean, layerOrder: string[]): string[] {
    const log: string[] = [];
    const { r, store } = createRenderers(log, retained, layerOrder);

    renderLayers(
      r,
      store,
      // Not used in retained mode (the caller passes an empty array)
      [makeFeature('poly-1', 'Polygon', 'layer-1')],
      new Set<string>(),
      {} as unknown as ProjectionData,
      14,
      new Map<string, CustomFeatureHandler['renderer']>(),
      {} as unknown as CustomRendererDrawContext,
      createFeatureCompanionRegistry(),
      [] as LayerAwareOverlayRenderer[],
      undefined,
      createStoreRetained(log),
    );

    return log;
  }

  it('calls drawLayer in layer order and calls beginFrame at the start of the frame', () => {
    expect(run(true, ['layer-bottom', 'layer-top'])).toEqual([
      'beginFrame',
      'drawLayer:layer-bottom',
      'drawLayer:layer-top',
    ]);
  });

  it('the features argument is not walked in retained mode', () => {
    expect(run(true, ['layer-1'])).not.toContain('immediate:poly-1');
  });

  it('falls back to the path used before when the renderers lack retained mode', () => {
    // getRetainedRenderers returning undefined = a stub renderer
    expect(run(false, ['layer-1'])).toEqual(['immediate:poly-1']);
  });
});

describe('renderLayers and the visible id set of immediate chunks', () => {
  /**
   * Stub of the cache that can specify how many times drawLayer calls deps.getVisibleIds
   *
   * The real one calls it once per immediate chunk. We want to confirm that however many times
   * it is called within a frame, the spatial index is queried only once.
   */
  function createStoreRetained(
    seen: Array<ReadonlySet<string> | undefined>,
    callsPerLayer: number,
  ): StoreRetainedCache {
    return {
      beginFrame: (): void => {},
      drawLayer: (
        _layerId: string,
        _layer: unknown,
        _projectionData: unknown,
        _zoom: number,
        deps: StoreRetainedDrawDeps,
      ): void => {
        for (let i = 0; i < callsPerLayer; i++) seen.push(deps.getVisibleIds?.());
      },
    } as unknown as StoreRetainedCache;
  }

  function run(
    layerOrder: string[],
    callsPerLayer: number,
    withViewportFilter: boolean,
  ): { seen: Array<ReadonlySet<string> | undefined>; queries: number } {
    const seen: Array<ReadonlySet<string> | undefined> = [];
    let queries = 0;

    const viewportFilter = {
      getBounds: () => ({ minX: -1, minY: -1, maxX: 1, maxY: 1 }),
      getVisibleIds: (): Set<string> => {
        queries++;
        return new Set(['visible-1']);
      },
    };

    const r = {
      batchManager: {
        beginFrame: (): void => {},
        processFeature: (): boolean => false,
        endFrame: (): void => {},
        getRetainedRenderers: () => ({}) as never,
      },
      tentativeRenderer: { drawGeometry: (): void => {} },
      ...(withViewportFilter ? { viewportFilter } : {}),
    } as unknown as Renderers;

    const store = {
      getLayerOrder: (): string[] => layerOrder,
      getLayer: makeGetLayer(layerOrder),
      getTentative: (): null => null,
    } as unknown as Store;

    renderLayers(
      r,
      store,
      [],
      new Set<string>(),
      {} as unknown as ProjectionData,
      14,
      new Map<string, CustomFeatureHandler['renderer']>(),
      {} as unknown as CustomRendererDrawContext,
      createFeatureCompanionRegistry(),
      [] as LayerAwareOverlayRenderer[],
      undefined,
      createStoreRetained(seen, callsPerLayer),
    );

    return { seen, queries };
  }

  it('the spatial index is queried only once however often it is asked in a frame', () => {
    const { seen, queries } = run(['layer-1', 'layer-2'], 2, true);

    expect(queries).toBe(1);
    expect(seen).toHaveLength(4);
    for (const ids of seen) expect(ids).toEqual(new Set(['visible-1']));
  });

  it('the spatial index is not queried in a frame where nobody asks', () => {
    expect(run(['layer-1', 'layer-2'], 0, true).queries).toBe(0);
  });

  it('getVisibleIds is not passed for an implementation without a ViewportFilter', () => {
    const { seen } = run(['layer-1'], 1, false);

    expect(seen).toEqual([undefined]);
  });
});

describe('segment (slot) specification of renderLayers', () => {
  const features = [
    makeFeature('a-1', 'Polygon', 'layer-a'),
    makeFeature('b-1', 'Polygon', 'layer-b'),
    makeFeature('c-1', 'Polygon', 'layer-c'),
  ];
  const order = ['layer-a', 'ext:x', 'layer-b', 'layer-c'];
  const layerIds = ['layer-a', 'layer-b', 'layer-c'];

  it('draws only the entries of the segment and skips the separator entries', () => {
    expect(
      runRenderLayers(features, order, undefined, layerIds, {
        from: 0,
        to: 1,
        first: true,
        last: false,
      }),
    ).toEqual(['a-1']);
    expect(
      runRenderLayers(features, order, undefined, layerIds, {
        from: 2,
        to: 4,
        first: false,
        last: true,
      }),
    ).toEqual(['b-1', 'c-1']);
  });

  it('draws the whole order when no segment is given (separators become unknown ids)', () => {
    expect(runRenderLayers(features, order, undefined, layerIds)).toEqual(['a-1', 'b-1', 'c-1']);
  });
});

describe('renderLayers and the opacity of the layers', () => {
  const OPACITY: Record<string, number> = { 'layer-faint': 0.3, 'layer-solid': 1 };

  function makeStore(): Store {
    return {
      getLayerOrder: (): string[] => ['layer-faint', 'layer-solid'],
      getLayer: (id: string) =>
        id in OPACITY
          ? ({
              id,
              name: id,
              visible: true,
              locked: false,
              opacity: OPACITY[id],
              items: [],
            } as Layer)
          : undefined,
      getTentative: (): null => null,
    } as unknown as Store;
  }

  const baseContext = { opacity: 1 } as unknown as CustomRendererDrawContext;

  it('passes each custom renderer the opacity of its layer, and overlays 1 (immediate mode)', () => {
    const seen: string[] = [];
    const r = {
      batchManager: { beginFrame: () => {}, processFeature: () => false, endFrame: () => {} },
      tentativeRenderer: { drawGeometry: (): void => {} },
    } as unknown as Renderers;
    const customRenderers = new Map<string, CustomFeatureHandler['renderer']>([
      [
        'Marker',
        {
          draw: (
            feature: { id: string },
            _p: unknown,
            _z: number,
            context: CustomRendererDrawContext,
          ) => {
            seen.push(`${feature.id}:${context.opacity}`);
          },
        } as unknown as CustomFeatureHandler['renderer'],
      ],
    ]);
    const overlay = {
      drawForLayer: (
        layerId: string,
        _p: unknown,
        _z: number,
        context: CustomRendererDrawContext,
      ) => {
        seen.push(`overlay:${layerId}:${context.opacity}`);
      },
    } as unknown as LayerAwareOverlayRenderer;

    renderLayers(
      r,
      makeStore(),
      [makeFeature('m1', 'Marker', 'layer-faint'), makeFeature('m2', 'Marker', 'layer-solid')],
      new Set<string>(),
      {} as unknown as ProjectionData,
      14,
      customRenderers,
      baseContext,
      createFeatureCompanionRegistry(),
      [overlay],
    );

    expect(seen).toEqual(['m1:0.3', 'overlay:layer-faint:1', 'm2:1', 'overlay:layer-solid:1']);
  });

  it('passes the context with the opacity of the layer to the retained drawing', () => {
    const seen: number[] = [];
    const r = {
      batchManager: {
        beginFrame: () => {},
        processFeature: () => false,
        endFrame: () => {},
        getRetainedRenderers: () => ({}) as never,
      },
      tentativeRenderer: { drawGeometry: (): void => {} },
    } as unknown as Renderers;
    const storeRetained = {
      beginFrame: (): void => {},
      drawLayer: (
        _id: string,
        _layer: Layer,
        _p: unknown,
        _z: number,
        deps: StoreRetainedDrawDeps,
      ) => {
        seen.push(deps.customRendererContext.opacity);
      },
    } as unknown as StoreRetainedCache;

    renderLayers(
      r,
      makeStore(),
      [],
      new Set<string>(),
      {} as unknown as ProjectionData,
      14,
      new Map(),
      baseContext,
      createFeatureCompanionRegistry(),
      [],
      undefined,
      storeRetained,
    );

    expect(seen).toEqual([0.3, 1]);
  });
});
