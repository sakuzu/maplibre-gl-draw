// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the consumption of feature companions within SelectMode's click handling
 *
 * When the unified z traversal returns a companion as the very foreground, this verifies that
 * core merely consumes the click and passes it to the provider, changing the selection in no way
 * at all (not even clearing it as an empty click would). As controls, the conventional behavior
 * for a Store feature and for no hit is checked as well.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TopHit } from '../../dispatcher/hit-test/topmost.js';
import type { MouseNormalizedEvent } from '../../dispatcher/types.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { MemoryStore } from '../../store/memory.js';
import type { Feature } from '../../store/types.js';
import type { FeatureCompanionProvider } from '../../view/feature-companion.js';
import {
  createFeatureCompanionRegistry,
  type FeatureCompanionRegistry,
} from '../../view/feature-companion.js';
import { createSelectionScope } from '../../view/ui/selection-scope.js';
import type { ModeContext } from '../handler.js';
import { handleSelectClick } from './click-handler.js';

function polygon(id: string, layerId: string): Feature {
  return {
    id,
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ],
    layerId,
    properties: {},
    locked: false,
    visible: true,
  };
}

const NO_MODIFIERS = { shift: false, ctrl: false, alt: false, meta: false };

function clickEvent(): MouseNormalizedEvent {
  return {
    type: 'click',
    point: { x: 50, y: -50 },
    lngLat: { lng: 5, lat: 5 },
    originalEvent: {} as MouseEvent,
    modifiers: { ...NO_MODIFIERS },
  };
}

function makeMap() {
  return {
    getCanvas: () => ({ style: { cursor: '' } }),
    getZoom: () => 10,
    triggerRepaint: vi.fn(),
    project: (lngLat: { lng: number; lat: number }) => ({
      x: lngLat.lng * 10,
      y: -lngLat.lat * 10,
    }),
    unproject: (p: { x: number; y: number }) => ({ lng: p.x / 10, lat: -p.y / 10 }),
  };
}

let store: MemoryStore;
let top: TopHit | null;
let context: ModeContext;
/** There is one companion rendering provider per draw instance */
let companions: FeatureCompanionRegistry = createFeatureCompanionRegistry();
let onCompanionClick: ReturnType<typeof vi.fn<FeatureCompanionProvider['onCompanionClick']>>;

/** Register a provider that has a companion which is "always hit" */
function registerCompanion(id = 'p1'): void {
  onCompanionClick = vi.fn<FeatureCompanionProvider['onCompanionClick']>();
  companions.register({
    id,
    has: () => true,
    draw: () => {},
    hitTest: () => ({ id: 'c1' }),
    onCompanionClick,
  });
}

function click(): void {
  handleSelectClick(clickEvent(), context, DEFAULT_SELECTION_CONFIG);
}

beforeEach(() => {
  companions = createFeatureCompanionRegistry();
  store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, order: [] });
  store.createFeature(polygon('f1', 'l1'));
  store.createFeature(polygon('f2', 'l1'));
  top = null;
  context = {
    store,
    map: makeMap(),
    hitTestTopmost: () => top,
    featureCompanions: companions,
    pluginManager: undefined,
    selectionScope: createSelectionScope(),
  } as unknown as ModeContext;
});

describe('consumption of a companion click', () => {
  it('the feature ID and the hit are passed to the provider', () => {
    registerCompanion();
    top = {
      kind: 'companion',
      companion: { providerId: 'p1', featureId: 'f1', hit: { id: 'c1' } },
    };

    click();

    expect(onCompanionClick).toHaveBeenCalledWith('f1', { id: 'c1' });
  });

  it('it does not change the selection (the selected feature stays as it is)', () => {
    registerCompanion();
    store.setSelection('feature', ['f2']);
    top = {
      kind: 'companion',
      companion: { providerId: 'p1', featureId: 'f1', hit: { id: 'c1' } },
    };

    click();

    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f2'] });
  });

  it('it does not clear the selection either (it is not treated as an empty click)', () => {
    registerCompanion();
    store.setSelection('feature', ['f1']);
    const setSelection = vi.spyOn(store, 'setSelection');
    top = {
      kind: 'companion',
      companion: { providerId: 'p1', featureId: 'f1', hit: { id: 'c1' } },
    };

    click();

    expect(setSelection).not.toHaveBeenCalled();
    setSelection.mockRestore();
  });
});

describe('controls (the conventional path)', () => {
  it('when a Store feature is in the foreground the selection is updated', () => {
    top = { kind: 'store', feature: store.getFeature('f1') as Feature };

    click();

    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f1'] });
  });

  it('when nothing is hit the selection is cleared', () => {
    store.setSelection('feature', ['f1']);
    top = null;

    click();

    expect(store.getSelection().type).toBeNull();
  });
});
