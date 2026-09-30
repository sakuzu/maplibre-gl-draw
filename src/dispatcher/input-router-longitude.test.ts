// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the longitude InputRouter hands to the modes
 *
 * maplibre reports the pointer with the unwrapped longitude of the view: above 180 east of the
 * antimeridian, and on a copy of the world at low zoom. The router brings every event onto the
 * stored copy before any mode sees it, so what is stored stays in [-180, 180], a line drawn
 * across the antimeridian stays continuous, and a drag never jumps by 360 degrees.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EngineModeContext, EngineModeHandler } from '../modes/handler.js';
import type { ModeManager } from '../modes/manager.js';
import { MemoryStore } from '../store/memory.js';
import type { TentativeState } from '../store/types.js';
import { createInputRouter } from './input-router.js';
import type {
  DragNormalizedEvent,
  MapClickEventPayload,
  MouseNormalizedEvent,
  NormalizedEvent,
} from './types.js';

class FakeNormalizer {
  private handlers = new Set<(event: NormalizedEvent) => void>();
  attach(): void {}
  detach(): void {}
  on(handler: (event: NormalizedEvent) => void): void {
    this.handlers.add(handler);
  }
  off(handler: (event: NormalizedEvent) => void): void {
    this.handlers.delete(handler);
  }
  emit(event: NormalizedEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

/** A mode that records the longitudes it receives */
class RecordingMode implements EngineModeHandler {
  modeName = 'select';
  clicks: number[] = [];
  moves: number[] = [];
  drags: Array<{ lng: number; start: number }> = [];
  onClick(event: MouseNormalizedEvent): void {
    this.clicks.push(event.lngLat.lng);
  }
  onMouseMove(event: MouseNormalizedEvent): void {
    this.moves.push(event.lngLat.lng);
  }
  onDragStart(event: DragNormalizedEvent): void {
    this.drags.push({ lng: event.lngLat.lng, start: event.dragStartLngLat.lng });
  }
  onDragMove(event: DragNormalizedEvent): void {
    this.drags.push({ lng: event.lngLat.lng, start: event.dragStartLngLat.lng });
  }
  onDragEnd(event: DragNormalizedEvent): void {
    this.drags.push({ lng: event.lngLat.lng, start: event.dragStartLngLat.lng });
  }
}

const MODIFIERS = { shift: false, ctrl: false, alt: false, meta: false };

function mouse(type: MouseNormalizedEvent['type'], lng: number): MouseNormalizedEvent {
  return {
    type,
    point: { x: 0, y: 0 },
    lngLat: { lng, lat: 10 },
    originalEvent: { stopPropagation: () => {}, preventDefault: () => {} } as unknown as MouseEvent,
    modifiers: MODIFIERS,
  };
}

function drag(
  type: DragNormalizedEvent['type'],
  lng: number,
  startLng: number,
): DragNormalizedEvent {
  return {
    type,
    point: { x: 0, y: 0 },
    lngLat: { lng, lat: 10 },
    originalEvent: {} as unknown as MouseEvent,
    modifiers: MODIFIERS,
    dragStartPoint: { x: 0, y: 0 },
    dragStartLngLat: { lng: startLng, lat: 10 },
  };
}

let store: MemoryStore;
let normalizer: FakeNormalizer;
let mode: RecordingMode;
let mapClicks: MapClickEventPayload[];

function startRouter() {
  const map = { getZoom: () => 3 } as unknown as MapLibreMap;
  const router = createInputRouter({
    normalizer: normalizer as unknown as Parameters<typeof createInputRouter>[0]['normalizer'],
    modeManager: { getHandler: () => mode } as unknown as ModeManager,
    context: { store, map } as unknown as EngineModeContext,
    map,
    notifyMapClick: (payload) => mapClicks.push(payload),
  });
  router.start();
  return router;
}

function drawing(first: [number, number]): TentativeState {
  return { type: 'LineString', coordinates: [first], layerId: 'l1', confirmedCount: 1 };
}

beforeEach(() => {
  store = new MemoryStore();
  normalizer = new FakeNormalizer();
  mode = new RecordingMode();
  mapClicks = [];
});

describe('the longitude handed to the modes', () => {
  it('brings a click on a copy of the world into [-180, 180]', () => {
    startRouter();
    normalizer.emit(mouse('click', 200));
    normalizer.emit(mouse('click', -190));
    normalizer.emit(mouse('click', 560));
    normalizer.emit(mouse('click', 139.7));

    expect(mode.clicks).toEqual([-160, 170, -160, 139.7]);
    // The click notification of select mode carries the stored longitude too
    expect(mapClicks.map((c) => c.lngLat[0])).toEqual([-160, 170, -160, 139.7]);
  });

  it('keeps a shape being drawn continuous across the antimeridian', () => {
    startRouter();
    store.setTentative(drawing([170, 10]));

    normalizer.emit(mouse('mousemove', 185));
    normalizer.emit(mouse('click', 190));

    expect(mode.moves).toEqual([185]);
    expect(mode.clicks).toEqual([190]);
  });

  it('puts a shape started on a copy of the world next to its first vertex', () => {
    startRouter();
    // The first vertex was placed at 170 (stored), the view now shows the copy 360 degrees east
    store.setTentative(drawing([170, 10]));

    normalizer.emit(mouse('click', 535));

    expect(mode.clicks).toEqual([175]);
  });

  it('moves a whole drag by the shift of its start, so it never jumps by 360 degrees', () => {
    startRouter();
    // A drag started at 179 on the copy east of the main one (539) and crossing the line
    normalizer.emit(drag('dragstart', 539, 539));
    normalizer.emit(drag('dragmove', 541, 539));
    normalizer.emit(drag('dragend', 542, 539));

    expect(mode.drags).toEqual([
      { lng: 179, start: 179 },
      { lng: 181, start: 179 },
      { lng: 182, start: 179 },
    ]);
  });

  it('leaves an event on the main copy untouched', () => {
    startRouter();
    const event = mouse('click', 139.7);
    const received: MouseNormalizedEvent[] = [];
    mode.onClick = (e) => {
      received.push(e);
    };
    normalizer.emit(event);

    expect(received[0]).toBe(event);
  });

  it('applies to synthetic input as well', () => {
    const router = startRouter();
    router.dispatch(mouse('click', 250));

    expect(mode.clicks).toEqual([-110]);
  });
});
