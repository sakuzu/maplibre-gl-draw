// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the report of an image that fails to load
 *
 * The renderers of a CustomLayer are built with a place to report the failure to load the image
 * of an Image feature. The draw instance turns the report into the load.error event
 * (source 'image'), so a host application can tell the person that an image is broken instead
 * of the image being silently left out.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../../shared/config/feature-style.js';
import { DEFAULT_RENDERING_CONFIG } from '../../shared/config/rendering.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Feature } from '../../store/types.js';
import { createSelectionScope } from '../ui/selection-scope.js';
import { createRenderScope } from './render-scope.js';
import { disposeRenderers, initRenderers } from './renderers.js';

/** A WebGL2 context that accepts every call (create* returns a fresh object) */
function createGlStub(): WebGL2RenderingContext {
  const constants = new Map<string, number>();
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (/^[A-Z0-9_]+$/.test(prop)) {
          let value = constants.get(prop);
          if (value === undefined) {
            value = 0x1000 + constants.size;
            constants.set(prop, value);
          }
          return value;
        }
        if (prop.startsWith('create')) return () => ({ kind: prop });
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true;
        if (prop === 'getShaderInfoLog' || prop === 'getProgramInfoLog') return () => '';
        if (prop === 'getUniformLocation') return () => ({});
        if (prop === 'getAttribLocation' || prop === 'getUniformBlockIndex') return () => 0;
        if (prop === 'getParameter') return () => 4096;
        if (prop === 'getSupportedExtensions') return () => [];
        if (prop === 'getExtension') return () => null;
        if (prop === 'isContextLost') return () => false;
        return () => undefined;
      },
    },
  ) as unknown as WebGL2RenderingContext;
}

function createMapStub(): MapLibreMap {
  return {
    getCanvas: () => ({ width: 800, height: 600, clientWidth: 800, clientHeight: 600 }),
    triggerRepaint: vi.fn(),
    getZoom: () => 12,
    getPitch: () => 0,
    getTerrain: () => null,
    transform: { tileSize: 512 },
  } as unknown as MapLibreMap;
}

function imageFeature(id: string, fileId: string): Feature {
  return {
    id,
    type: 'Image',
    geometry: { type: 'Point', coordinates: [139.7, 35.7] },
    layerId: 'l1',
    properties: { imageFileId: fileId, imageWidth: 10, imageHeight: 10, createdZoom: 12 },
    locked: false,
    visible: true,
    style: {},
  };
}

describe('the report of an image that fails to load', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes the feature ID and the error to onImageError', async () => {
    const store = new MemoryStore();
    // Only embedded raster data URLs are decoded, so this one is refused
    store.createFile({ id: 'f1', mimeType: 'image/png', dataURL: 'https://example.com/a.png' });
    const onImageError = vi.fn();
    const renderers = initRenderers({
      gl: createGlStub(),
      map: createMapStub(),
      store,
      spatialIndex: new RBushSpatialIndex(),
      featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
      selectionConfig: DEFAULT_SELECTION_CONFIG,
      renderingConfig: DEFAULT_RENDERING_CONFIG,
      customFeatureHandlers: undefined,
      scope: createRenderScope(createSelectionScope()),
      onImageError,
    });

    renderers.imageRenderer.draw(imageFeature('img-1', 'f1'), {} as ProjectionData, 12);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onImageError).toHaveBeenCalledTimes(1);
    expect(onImageError.mock.calls[0][0]).toBe('img-1');
    expect(onImageError.mock.calls[0][1]).toBeInstanceOf(Error);

    // A failed image is not retried, so a later frame does not report it again
    renderers.imageRenderer.draw(imageFeature('img-1', 'f1'), {} as ProjectionData, 12);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onImageError).toHaveBeenCalledTimes(1);

    disposeRenderers(renderers);
  });

  it('reports every feature that shares a failed image, each once', async () => {
    const store = new MemoryStore();
    store.createFile({ id: 'f1', mimeType: 'image/png', dataURL: 'https://example.com/a.png' });
    const onImageError = vi.fn();
    const renderers = initRenderers({
      gl: createGlStub(),
      map: createMapStub(),
      store,
      spatialIndex: new RBushSpatialIndex(),
      featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
      selectionConfig: DEFAULT_SELECTION_CONFIG,
      renderingConfig: DEFAULT_RENDERING_CONFIG,
      customFeatureHandlers: undefined,
      scope: createRenderScope(createSelectionScope()),
      onImageError,
    });
    const draw = (id: string) =>
      renderers.imageRenderer.draw(imageFeature(id, 'f1'), {} as ProjectionData, 12);

    // Two features drawn in the same frame, before the failure is known
    draw('img-1');
    draw('img-2');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A third feature drawn after the failure
    draw('img-3');
    // Later frames do not report any of them again
    draw('img-1');
    draw('img-2');
    draw('img-3');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onImageError.mock.calls.map((call) => call[0])).toEqual(['img-1', 'img-2', 'img-3']);

    disposeRenderers(renderers);
  });
});
