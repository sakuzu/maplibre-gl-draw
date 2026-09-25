// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Two draw instances on one page never share their extension registrations
 *
 * A second draw instance (a print preview, a thumbnail, a comparison view) registers the same
 * custom feature types and auxiliary handles as the first. Every registration goes into the
 * registries of the instance it was made on (createContext), so the second instance's handles
 * never appear in, or take the drags of, the first, and destroying one instance clears only
 * its own registrations.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import { PointHitTestStrategy } from '../dispatcher/hit-test/strategies/point.js';
import type { CustomFeatureHandler } from '../extension/index.js';
import type { ModeManager } from '../modes/manager.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import type { Feature } from '../store/types.js';
import { createFeatureCompanionRegistry } from '../view/feature-companion.js';
import type { CustomLayerInterface } from '../view/layer/index.js';
import type { AuxiliaryHandleProvider } from '../view/ui/auxiliary-handles.js';
import { createContext } from './context.js';
import { createExtensionApi } from './extension-api.js';

const map = {
  getCanvas: () => ({ style: { cursor: '' } }),
  getZoom: () => 10,
  getCenter: () => ({ lng: 0, lat: 0 }),
} as unknown as MapLibreMap;

/** One draw instance: its context and its extension API */
function createInstance() {
  const context = createContext(map);
  const api = createExtensionApi({
    pluginManager: {} as PluginManager,
    modeManager: {} as ModeManager,
    spatialIndex: context.spatialIndex,
    hitTestService: context.hitTestService,
    boxSelectionRegistry: context.boxSelectionRegistry,
    customLayer: {
      registerFeatureRenderer: vi.fn(),
      addOverlayRenderer: vi.fn(),
    } as unknown as CustomLayerInterface,
    featureCompanions: createFeatureCompanionRegistry(),
    selectionScope: context.selectionScope,
    snapTargets: context.snapTargets,
  });
  return { context, api };
}

const HANDLER: CustomFeatureHandler = {
  type: 'Card',
  renderer: { name: 'card', onAdd: vi.fn(), draw: vi.fn(), onRemove: vi.fn() },
  hitTest: Object.assign(new PointHitTestStrategy(), { geometryType: 'Card' }),
  resizeStrategy: 'scale',
  getSelectionBoundingBox: (feature) => {
    const [lng, lat] = feature.coordinates as [number, number];
    return {
      topLeft: [lng - 1, lat + 1],
      topRight: [lng + 1, lat + 1],
      bottomRight: [lng + 1, lat - 1],
      bottomLeft: [lng - 1, lat - 1],
      center: [lng, lat],
    };
  },
  getAdditionalResizeHandles: () => [],
  computeCustomResize: () => null,
  getPointFrameExtent: () => ({ halfWidth: 40, halfHeight: 20 }),
  getSnapTargets: () => [],
};

const card: Feature = {
  id: 'c1',
  type: 'Card',
  coordinates: [10, 10],
  layerId: 'default-layer',
  properties: {},
  locked: false,
  visible: true,
};

function provider(id: string): AuxiliaryHandleProvider {
  return {
    id,
    getHandles: () => [{ id: 'h', position: [0, 0] }],
    onHandleDragStart: () => true,
    onHandleDragMove: vi.fn(),
    onHandleDragEnd: vi.fn(),
  };
}

describe('the extension registrations of two draw instances', () => {
  it('a feature handler registered on one instance is unknown to the other', () => {
    const editor = createInstance();
    const preview = createInstance();

    preview.api.registerFeatureHandler(HANDLER);

    const previewExtensions = preview.context.selectionScope.extensions;
    expect(previewExtensions.getBoundingBoxCalculator('Card')).toBe(
      HANDLER.getSelectionBoundingBox,
    );
    expect(previewExtensions.getResizeStrategy('Card')).toBe('scale');
    expect(previewExtensions.resolvePointFrameExtent(card)).toEqual({
      halfWidth: 40,
      halfHeight: 20,
    });
    expect(preview.context.snapTargets.get('Card')).toBe(HANDLER.getSnapTargets);

    const editorExtensions = editor.context.selectionScope.extensions;
    expect(editorExtensions.getBoundingBoxCalculator('Card')).toBeUndefined();
    expect(editorExtensions.getResizeStrategy('Card')).toBeUndefined();
    expect(editorExtensions.getAdditionalResizeHandlesCalculator('Card')).toBeUndefined();
    expect(editorExtensions.getCustomResizeCalculator('Card')).toBeUndefined();
    // The default 12px square, not the preview's registration
    expect(editorExtensions.resolvePointFrameExtent(card)).toEqual({ halfWidth: 6, halfHeight: 6 });
    expect(editor.context.snapTargets.get('Card')).toBeUndefined();
  });

  it('an auxiliary handle provider of one instance never shows up in the other', () => {
    const editor = createInstance();
    const preview = createInstance();

    const editorProvider = provider('aux');
    editor.api.registerAuxiliaryHandleProvider(editorProvider);
    // The same id on the other instance does not overwrite the first
    preview.api.registerAuxiliaryHandleProvider(provider('aux'));

    expect(editor.context.selectionScope.auxiliaryHandles.get('aux')).toBe(editorProvider);
    expect(editor.context.selectionScope.auxiliaryHandles.list()).toHaveLength(1);
    expect(preview.context.selectionScope.auxiliaryHandles.get('aux')).not.toBe(editorProvider);
  });

  it('clearing one instance (its destroy) leaves the other registrations in place', () => {
    const editor = createInstance();
    const preview = createInstance();
    editor.api.registerFeatureHandler(HANDLER);
    preview.api.registerFeatureHandler(HANDLER);
    editor.api.registerAuxiliaryHandleProvider(provider('aux'));
    preview.api.registerAuxiliaryHandleProvider(provider('aux'));

    preview.context.selectionScope.clear();
    preview.context.snapTargets.clear();

    expect(preview.context.selectionScope.extensions.getBoundingBoxCalculator('Card')).toBe(
      undefined,
    );
    expect(preview.context.selectionScope.auxiliaryHandles.list()).toEqual([]);
    expect(preview.context.snapTargets.get('Card')).toBeUndefined();

    expect(editor.context.selectionScope.extensions.getBoundingBoxCalculator('Card')).toBe(
      HANDLER.getSelectionBoundingBox,
    );
    expect(editor.context.selectionScope.auxiliaryHandles.list()).toHaveLength(1);
    expect(editor.context.snapTargets.get('Card')).toBe(HANDLER.getSnapTargets);
  });

  it('the cancel function of an auxiliary provider removes only its own registration', () => {
    const editor = createInstance();
    const cancel = editor.api.registerAuxiliaryHandleProvider(provider('aux'));
    cancel();
    expect(editor.context.selectionScope.auxiliaryHandles.list()).toEqual([]);
  });

  it('the cancel function of a feature handler undoes every part of the registration', () => {
    const editor = createInstance();
    const removeRenderer = vi.fn();
    const customLayer = {
      registerFeatureRenderer: vi.fn(() => removeRenderer),
      addOverlayRenderer: vi.fn(),
    } as unknown as CustomLayerInterface;
    const api = createExtensionApi({
      pluginManager: {} as PluginManager,
      modeManager: {} as ModeManager,
      spatialIndex: editor.context.spatialIndex,
      hitTestService: editor.context.hitTestService,
      boxSelectionRegistry: editor.context.boxSelectionRegistry,
      customLayer,
      featureCompanions: createFeatureCompanionRegistry(),
      selectionScope: editor.context.selectionScope,
      snapTargets: editor.context.snapTargets,
    });

    const cancel = api.registerFeatureHandler({ ...HANDLER, candidateReachPx: 30 });
    cancel();
    // A second call does nothing
    cancel();

    const extensions = editor.context.selectionScope.extensions;
    expect(extensions.getBoundingBoxCalculator('Card')).toBeUndefined();
    expect(extensions.getResizeStrategy('Card')).toBeUndefined();
    expect(extensions.getAdditionalResizeHandlesCalculator('Card')).toBeUndefined();
    expect(extensions.getCustomResizeCalculator('Card')).toBeUndefined();
    expect(extensions.resolvePointFrameExtent(card)).toEqual({ halfWidth: 6, halfHeight: 6 });
    expect(editor.context.snapTargets.get('Card')).toBeUndefined();
    expect(removeRenderer).toHaveBeenCalledTimes(1);
    // The hit test no longer knows the type: a card is not hit
    editor.context.store.createFeature(card);
    expect(
      editor.context.hitTestService.hitTestFeature(
        editor.context.store.getFeature('c1') as Feature,
        [10, 10],
        1,
      ),
    ).toBe(false);
  });
});
