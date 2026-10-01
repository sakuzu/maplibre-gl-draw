// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for InputNormalizer
 *
 * The map is a stub that records the handlers registered with map.on and lets a test
 * fire MapLibre-shaped mouse and touch events at them. These tests verify that one
 * finger is written onto the same NormalizedEvents as the mouse, that a gesture with
 * two fingers is left alone, that a second finger during a press cancels it, that the
 * compatibility mouse events a browser emits after a tap are not delivered twice, and
 * that pointerType is carried.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInputNormalizer, type InputNormalizer } from './normalizer.js';
import type { DragNormalizedEvent, MouseNormalizedEvent, NormalizedEvent } from './types.js';

type Handler = (e: unknown) => void;

interface FakeCanvas {
  tabIndex: number;
  style: Record<string, string>;
  listeners: Map<string, Set<Handler>>;
  addEventListener(type: string, handler: Handler): void;
  removeEventListener(type: string, handler: Handler): void;
  getBoundingClientRect(): { left: number; top: number };
  dispatch(type: string, event: unknown): void;
}

function createCanvas(): FakeCanvas {
  const listeners = new Map<string, Set<Handler>>();
  return {
    tabIndex: -1,
    style: {},
    listeners,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0 };
    },
    dispatch(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
}

class FakeMap {
  readonly canvas = createCanvas();
  private handlers = new Map<string, Set<Handler>>();

  getCanvas(): FakeCanvas {
    return this.canvas;
  }
  on(type: string, handler: Handler): this {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)?.add(handler);
    return this;
  }
  off(type: string, handler: Handler): this {
    this.handlers.get(type)?.delete(handler);
    return this;
  }
  fire(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
  handlerCount(): number {
    let count = 0;
    for (const set of this.handlers.values()) count += set.size;
    return count;
  }
  /** Screen pixels map to degrees one to one, which keeps the expectations readable */
  unproject([x, y]: [number, number]): { lng: number; lat: number } {
    return { lng: x, lat: y };
  }
}

const modifiers = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };

function touchList(points: Array<{ x: number; y: number }>, touchType?: string): unknown[] {
  return points.map((p) => ({ clientX: p.x, clientY: p.y, touchType }));
}

describe('InputNormalizer', () => {
  let map: FakeMap;
  let normalizer: InputNormalizer;
  let events: NormalizedEvent[];

  /** Fires a MapLibre touch event with the given fingers on the screen */
  function touch(
    type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
    touches: Array<{ x: number; y: number }>,
    options: { changed?: Array<{ x: number; y: number }>; touchType?: string } = {},
  ): void {
    const changed = options.changed ?? touches;
    const points = type === 'touchend' ? changed : touches;
    const point =
      points.length === 0
        ? { x: 0, y: 0 }
        : {
            x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
            y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
          };
    map.fire(type, {
      type,
      point,
      lngLat: { lng: point.x, lat: point.y },
      originalEvent: {
        type,
        target: map.canvas,
        touches: touchList(touches, options.touchType),
        changedTouches: touchList(changed, options.touchType),
        ...modifiers,
        preventDefault() {},
        stopPropagation() {},
      },
      preventDefault: vi.fn(),
    });
  }

  /** Fires a MapLibre mouse event (at the coordinate of the point unless one is given) */
  function mouse(
    type: 'mousedown' | 'mousemove' | 'mouseup' | 'click' | 'dblclick' | 'contextmenu',
    point: { x: number; y: number },
    extra: Record<string, unknown> = {},
    lngLat: { lng: number; lat: number } = { lng: point.x, lat: point.y },
  ): void {
    map.fire(type, {
      type,
      point,
      lngLat,
      originalEvent: {
        type,
        button: 0,
        target: map.canvas,
        clientX: point.x,
        clientY: point.y,
        ...modifiers,
        preventDefault() {},
        stopPropagation() {},
        ...extra,
      },
      preventDefault() {},
    });
  }

  function types(): string[] {
    return events.map((e) => e.type);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    map = new FakeMap();
    normalizer = createInputNormalizer(map as unknown as MapLibreMap);
    events = [];
    normalizer.on((e) => events.push(e));
    normalizer.attach();
  });

  afterEach(() => {
    normalizer.detach();
    vi.useRealTimers();
  });

  it('leaves drag and drop on the map to the host', () => {
    // Where a dropped file goes is the application's decision, so the library neither
    // listens to the drop nor cancels the browser's default for it
    expect(map.canvas.listeners.get('dragover')?.size ?? 0).toBe(0);
    expect(map.canvas.listeners.get('drop')?.size ?? 0).toBe(0);
  });

  it('makes the canvas focusable while attached and gives its tabIndex back on detach', () => {
    expect(map.canvas.tabIndex).toBe(0);
    normalizer.detach();
    expect(map.canvas.tabIndex).toBe(-1);
    normalizer.attach();
    expect(map.canvas.tabIndex).toBe(0);
  });

  describe('one finger', () => {
    it('normalizes touchstart / touchmove / touchend into mousedown / dragstart / dragmove / dragend / mouseup', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchmove', [{ x: 130, y: 100 }]);
      touch('touchmove', [{ x: 150, y: 100 }]);
      touch('touchend', [], { changed: [{ x: 150, y: 100 }] });

      expect(types()).toEqual([
        'mousemove',
        'mousedown',
        'dragstart',
        'dragmove',
        'dragend',
        'mouseup',
      ]);
      const dragStart = events[2];
      if (dragStart.type !== 'dragstart') throw new Error('expected dragstart');
      expect(dragStart.dragStartPoint).toEqual({ x: 100, y: 100 });
      expect(dragStart.dragStartLngLat).toEqual({ lng: 100, lat: 100 });
      expect(dragStart.point).toEqual({ x: 130, y: 100 });
      const dragEnd = events[4];
      if (dragEnd.type !== 'dragend') throw new Error('expected dragend');
      expect(dragEnd.lngLat).toEqual({ lng: 150, lat: 100 });
    });

    it('carries pointerType touch and the TouchEvent as originalEvent', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchend', [], { changed: [{ x: 100, y: 100 }] });

      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        if (!('pointerType' in event)) throw new Error(`unexpected ${event.type}`);
        expect(event.pointerType).toBe('touch');
        expect('touches' in event.originalEvent).toBe(true);
      }
    });

    it('turns a tap into mouseup and click', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchend', [], { changed: [{ x: 101, y: 100 }] });

      expect(types()).toEqual(['mousemove', 'mousedown', 'mouseup', 'click']);
    });

    it('keeps a finger wobble within the touch slop a tap (mousemove, not a drag)', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchmove', [{ x: 106, y: 100 }]);
      touch('touchend', [], { changed: [{ x: 106, y: 100 }] });

      expect(types()).toEqual(['mousemove', 'mousedown', 'mousemove', 'mouseup', 'click']);
    });

    it('holds a tap up to 10 px of movement, and turns a finger 11 px away into a drag', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchmove', [{ x: 110, y: 100 }]);
      touch('touchend', [], { changed: [{ x: 110, y: 100 }] });
      expect(types()).toEqual(['mousemove', 'mousedown', 'mousemove', 'mouseup', 'click']);

      events = [];
      vi.advanceTimersByTime(1000);
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchmove', [{ x: 111, y: 100 }]);
      touch('touchend', [], { changed: [{ x: 111, y: 100 }] });
      expect(types()).toEqual(['mousemove', 'mousedown', 'dragstart', 'dragend', 'mouseup']);
    });

    it('does not drop a slow tap (the 300 ms click limit is for the mouse only)', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      vi.advanceTimersByTime(450);
      touch('touchend', [], { changed: [{ x: 100, y: 100 }] });

      expect(types()).toContain('click');
    });

    it('emits contextmenu on a long press and no click on its release', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      vi.advanceTimersByTime(600);
      touch('touchend', [], { changed: [{ x: 100, y: 100 }] });

      expect(types()).toEqual(['mousemove', 'mousedown', 'contextmenu', 'mouseup']);
      expect(events[2].type === 'contextmenu' && events[2].pointerType).toBe('touch');
    });

    it('does not emit contextmenu once the press has become a drag', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchmove', [{ x: 140, y: 100 }]);
      vi.advanceTimersByTime(600);

      expect(types()).not.toContain('contextmenu');
    });

    it('forms a dblclick from two quick taps, after the second click', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchend', [], { changed: [{ x: 100, y: 100 }] });
      vi.advanceTimersByTime(150);
      touch('touchstart', [{ x: 104, y: 100 }]);
      touch('touchend', [], { changed: [{ x: 104, y: 100 }] });

      expect(types().slice(-3)).toEqual(['mouseup', 'click', 'dblclick']);
    });

    it('reports a stylus on the touch events as pointerType pen', () => {
      touch('touchstart', [{ x: 100, y: 100 }], { touchType: 'stylus' });

      const down = events.find((e) => e.type === 'mousedown');
      expect(down?.type === 'mousedown' && down.pointerType).toBe('pen');
    });

    it('ignores a touch that does not land on the canvas', () => {
      map.fire('touchstart', {
        point: { x: 1, y: 1 },
        lngLat: { lng: 1, lat: 1 },
        originalEvent: {
          target: {},
          touches: touchList([{ x: 1, y: 1 }]),
          changedTouches: touchList([{ x: 1, y: 1 }]),
          ...modifiers,
        },
      });

      expect(events).toEqual([]);
    });
  });

  describe('two fingers', () => {
    it('leaves a two-finger gesture to MapLibre (nothing is emitted)', () => {
      touch('touchstart', [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
      ]);
      touch('touchmove', [
        { x: 90, y: 100 },
        { x: 210, y: 100 },
      ]);
      touch('touchend', [{ x: 90, y: 100 }], { changed: [{ x: 210, y: 100 }] });
      touch('touchmove', [{ x: 80, y: 100 }]);
      touch('touchend', [], { changed: [{ x: 80, y: 100 }] });

      expect(events).toEqual([]);
    });

    it('cancels a drag in progress with dragcancel when a second finger lands', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchmove', [{ x: 140, y: 100 }]);
      touch('touchstart', [
        { x: 140, y: 100 },
        { x: 250, y: 100 },
      ]);
      // The rest of the gesture is MapLibre's
      touch('touchmove', [
        { x: 150, y: 100 },
        { x: 260, y: 100 },
      ]);
      touch('touchend', [{ x: 150, y: 100 }], { changed: [{ x: 260, y: 100 }] });
      touch('touchend', [], { changed: [{ x: 150, y: 100 }] });

      expect(types()).toEqual(['mousemove', 'mousedown', 'dragstart', 'dragcancel']);
      const cancel = events[3];
      if (cancel.type !== 'dragcancel') throw new Error('expected dragcancel');
      expect(cancel.point).toEqual({ x: 140, y: 100 });
      expect(cancel.dragStartPoint).toEqual({ x: 100, y: 100 });
      expect(cancel.pointerType).toBe('touch');
    });

    it('cancels a press that has not become a drag yet as well', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchstart', [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
      ]);

      expect(types()).toEqual(['mousemove', 'mousedown', 'dragcancel']);
    });

    it('does not fire the long press after the press was cancelled', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchstart', [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
      ]);
      vi.advanceTimersByTime(600);

      expect(types()).not.toContain('contextmenu');
    });
  });

  describe('touchcancel', () => {
    it('cancels the press with dragcancel', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchmove', [{ x: 140, y: 100 }]);
      touch('touchcancel', []);

      expect(types()).toEqual(['mousemove', 'mousedown', 'dragstart', 'dragcancel']);
    });
  });

  describe('compatibility mouse events after a tap', () => {
    it('are not delivered a second time', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchend', [], { changed: [{ x: 100, y: 100 }] });
      const afterTouch = types();

      mouse('mousemove', { x: 100, y: 100 });
      mouse('mousedown', { x: 100, y: 100 });
      mouse('mouseup', { x: 100, y: 100 });
      mouse('click', { x: 100, y: 100 });

      expect(types()).toEqual(afterTouch);
    });

    it('follow sourceCapabilities when the browser provides it', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchend', [], { changed: [{ x: 100, y: 100 }] });
      const count = events.length;

      // A real mouse right after the tap (the browser says it does not fire touch events)
      mouse('mousemove', { x: 300, y: 300 }, { sourceCapabilities: { firesTouchEvents: false } });

      expect(events.length).toBe(count + 1);
      expect(events[count].type === 'mousemove' && events[count].pointerType).toBe('mouse');
    });

    it('stop being filtered once the window after the tap has passed', () => {
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchend', [], { changed: [{ x: 100, y: 100 }] });
      vi.advanceTimersByTime(1500);
      const count = events.length;

      mouse('mousemove', { x: 300, y: 300 });

      expect(events.length).toBe(count + 1);
    });
  });

  describe('mouse', () => {
    it('keeps the mouse path: pointerType mouse, 3 px threshold, drag then mouseup', () => {
      mouse('mousedown', { x: 10, y: 10 });
      mouse('mousemove', { x: 12, y: 10 });
      mouse('mousemove', { x: 20, y: 10 });
      mouse('mouseup', { x: 20, y: 10 });
      mouse('click', { x: 20, y: 10 });

      expect(types()).toEqual(['mousedown', 'mousemove', 'dragstart', 'dragend', 'mouseup']);
      for (const event of events) {
        expect('pointerType' in event && event.pointerType).toBe('mouse');
      }
    });

    it('keeps a press that moved up to the 3 px threshold a click', () => {
      mouse('mousedown', { x: 10, y: 10 });
      mouse('mousemove', { x: 13, y: 10 });
      mouse('mouseup', { x: 13, y: 10 });
      mouse('click', { x: 13, y: 10 });

      expect(types()).toEqual(['mousedown', 'mousemove', 'mouseup', 'click']);
    });

    it('measures the threshold as a distance, not per axis', () => {
      // 2.5 px on each axis is 3.5 px away: a drag, although neither axis passes 3 px
      mouse('mousedown', { x: 10, y: 10 });
      mouse('mousemove', { x: 12.5, y: 12.5 });
      mouse('mouseup', { x: 12.5, y: 12.5 });
      mouse('click', { x: 12.5, y: 12.5 });

      expect(types()).toEqual(['mousedown', 'dragstart', 'dragend', 'mouseup']);
    });

    it('carries the press position on every event of the drag', () => {
      mouse('mousedown', { x: 10, y: 10 });
      mouse('mousemove', { x: 20, y: 10 });
      mouse('mousemove', { x: 30, y: 15 });
      mouse('mouseup', { x: 30, y: 15 });

      const drags = events.filter((e): e is DragNormalizedEvent => e.type.startsWith('drag'));
      expect(drags.map((e) => e.type)).toEqual(['dragstart', 'dragmove', 'dragend']);
      for (const event of drags) {
        expect(event.dragStartPoint).toEqual({ x: 10, y: 10 });
        expect(event.dragStartLngLat).toEqual({ lng: 10, lat: 10 });
      }
      expect(drags[2].point).toEqual({ x: 30, y: 15 });
    });

    it('keeps the coordinates of a press continuous where the globe jumps from 180 to -180', () => {
      // The globe gives the longitudes in [-180, 180], so the pointer crossing the antimeridian
      // eastwards jumps from 179.5 to -179; within the press it runs on past 180
      mouse('mousedown', { x: 10, y: 10 }, {}, { lng: 178, lat: -10 });
      mouse('mousemove', { x: 20, y: 10 }, {}, { lng: 179.5, lat: -10 });
      mouse('mousemove', { x: 30, y: 10 }, {}, { lng: -179, lat: -10 });
      mouse('mousemove', { x: 40, y: 12 }, {}, { lng: -177, lat: -11 });
      mouse('mouseup', { x: 40, y: 12 }, {}, { lng: -177, lat: -11 });

      expect(types()).toEqual([
        'mousedown',
        'dragstart',
        'dragmove',
        'dragmove',
        'dragend',
        'mouseup',
      ]);
      const lngs = events.map((e) => ('lngLat' in e ? e.lngLat.lng : Number.NaN));
      expect(lngs).toEqual([178, 179.5, 181, 183, 183, 183]);
      expect(events[4]).toMatchObject({ lngLat: { lng: 183, lat: -11 } });

      // The next press starts from where the pointer is
      events = [];
      mouse('mousedown', { x: 40, y: 12 }, {}, { lng: -177, lat: -11 });
      expect(events[0]).toMatchObject({ type: 'mousedown', lngLat: { lng: -177, lat: -11 } });
    });

    it('stays a drag once started, even when the pointer comes back to the press', () => {
      mouse('mousedown', { x: 10, y: 10 });
      mouse('mousemove', { x: 20, y: 10 });
      mouse('mousemove', { x: 10, y: 10 });
      mouse('mouseup', { x: 10, y: 10 });
      mouse('click', { x: 10, y: 10 });

      expect(types()).toEqual(['mousedown', 'dragstart', 'dragmove', 'dragend', 'mouseup']);
    });

    it('swallows only the click that follows a drag, not the next one', () => {
      mouse('mousedown', { x: 10, y: 10 });
      mouse('mousemove', { x: 20, y: 10 });
      mouse('mouseup', { x: 20, y: 10 });
      mouse('click', { x: 20, y: 10 });
      events = [];

      mouse('mousedown', { x: 20, y: 10 });
      mouse('mouseup', { x: 20, y: 10 });
      mouse('click', { x: 20, y: 10 });

      expect(types()).toEqual(['mousedown', 'mouseup', 'click']);
    });

    it('takes the mouse threshold from the options and keeps the touch slop at least 10 px', () => {
      normalizer.detach();
      normalizer = createInputNormalizer(map as unknown as MapLibreMap, { dragThreshold: 8 });
      normalizer.on((e) => events.push(e));
      normalizer.attach();

      mouse('mousedown', { x: 10, y: 10 });
      mouse('mousemove', { x: 18, y: 10 });
      mouse('mouseup', { x: 18, y: 10 });
      mouse('click', { x: 18, y: 10 });
      expect(types()).toEqual(['mousedown', 'mousemove', 'mouseup', 'click']);

      events = [];
      vi.advanceTimersByTime(1000);
      touch('touchstart', [{ x: 100, y: 100 }]);
      touch('touchmove', [{ x: 110, y: 100 }]);
      touch('touchend', [], { changed: [{ x: 110, y: 100 }] });
      expect(types()).toContain('click');
    });

    it('ignores a press of another button than the left one', () => {
      mouse('mousedown', { x: 10, y: 10 }, { button: 2 });
      mouse('mousemove', { x: 30, y: 10 }, { buttons: 2 });
      mouse('mouseup', { x: 30, y: 10 }, { button: 2 });

      expect(types()).toEqual(['mousemove']);
    });

    it('still drops a click held longer than 300 ms', () => {
      mouse('mousedown', { x: 10, y: 10 });
      vi.advanceTimersByTime(400);
      mouse('mouseup', { x: 10, y: 10 });
      mouse('click', { x: 10, y: 10 });

      expect(types()).toEqual(['mousedown', 'mouseup']);
    });

    it('reports a pen that arrives through the mouse events as pointerType pen and keeps its slow tap', () => {
      map.canvas.dispatch('pointerdown', { pointerType: 'pen' });
      mouse('mousedown', { x: 10, y: 10 });
      vi.advanceTimersByTime(400);
      mouse('mouseup', { x: 10, y: 10 });
      mouse('click', { x: 10, y: 10 });

      expect(types()).toEqual(['mousedown', 'mouseup', 'click']);
      for (const event of events) {
        expect('pointerType' in event && event.pointerType).toBe('pen');
      }
    });
  });

  describe('a press that ends without a release', () => {
    let windowListeners: Map<string, Set<Handler>>;

    /** Gives the canvas a document and a window, and attaches a fresh normalizer */
    function withWindow(): void {
      normalizer.detach();
      windowListeners = new Map();
      const view = {
        addEventListener(type: string, handler: Handler) {
          if (!windowListeners.has(type)) windowListeners.set(type, new Set());
          windowListeners.get(type)?.add(handler);
        },
        removeEventListener(type: string, handler: Handler) {
          windowListeners.get(type)?.delete(handler);
        },
      };
      Object.assign(map.canvas, { ownerDocument: { defaultView: view, activeElement: null } });
      normalizer = createInputNormalizer(map as unknown as MapLibreMap);
      normalizer.on((e) => events.push(e));
      normalizer.attach();
    }

    function key(k: string, extra: Record<string, unknown> = {}) {
      const event = {
        key: k,
        code: k,
        ...modifiers,
        defaultPrevented: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...extra,
      };
      map.canvas.dispatch('keydown', event);
      return event;
    }

    function drag(): void {
      mouse('mousedown', { x: 10, y: 10 });
      mouse('mousemove', { x: 20, y: 10 });
    }

    it('cancels the press when the window loses the focus, and swallows the late click', () => {
      withWindow();
      drag();
      for (const handler of windowListeners.get('blur') ?? []) handler({});
      mouse('mouseup', { x: 20, y: 10 });
      mouse('click', { x: 20, y: 10 });

      expect(types()).toEqual(['mousedown', 'dragstart', 'dragcancel', 'mouseup']);
      const cancel = events[2] as DragNormalizedEvent;
      expect(cancel.point).toEqual({ x: 20, y: 10 });
      // The originalEvent of the cancel is the last pointer event of the press
      expect((cancel.originalEvent as MouseEvent).type).toBe('mousemove');

      normalizer.detach();
      expect(windowListeners.get('blur')?.size).toBe(0);
    });

    it('turns Escape during a drag into dragcancel and does not deliver the key', () => {
      drag();
      key('Escape');

      expect(types()).toEqual(['mousedown', 'dragstart', 'dragcancel']);
    });

    it('delivers Escape as a keydown when no drag is in progress', () => {
      mouse('mousedown', { x: 10, y: 10 });
      key('Escape');

      expect(types()).toEqual(['mousedown', 'keydown']);
    });

    it('releases a press whose button is found up, at its last position', () => {
      drag();
      mouse('mousemove', { x: 40, y: 10 }, { buttons: 0 });
      mouse('click', { x: 40, y: 10 });

      expect(types()).toEqual(['mousedown', 'dragstart', 'dragend', 'mouseup', 'mousemove']);
      expect((events[2] as DragNormalizedEvent).point).toEqual({ x: 20, y: 10 });
      expect((events[4] as MouseNormalizedEvent).point).toEqual({ x: 40, y: 10 });
    });

    it('keeps a press whose button is still down', () => {
      drag();
      mouse('mousemove', { x: 40, y: 10 }, { buttons: 1 });

      expect(types()).toEqual(['mousedown', 'dragstart', 'dragmove']);
    });
  });

  describe('focus, double click zoom and map keys', () => {
    it('focuses the canvas on a press without scrolling, and leaves its outline alone', () => {
      const focus = vi.fn();
      Object.assign(map.canvas, { focus, ownerDocument: { activeElement: null } });
      mouse('mousedown', { x: 10, y: 10 });

      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(map.canvas.style.outline).toBeUndefined();
    });

    it('stops MapLibre from zooming on a double click a mode consumed', () => {
      normalizer.on((e) => {
        if (e.type === 'dblclick' && e.point.x === 10) e.originalEvent.preventDefault();
      });
      const fire = (x: number) => {
        const original = {
          type: 'dblclick',
          button: 0,
          target: map.canvas,
          ...modifiers,
          defaultPrevented: false,
          preventDefault() {
            original.defaultPrevented = true;
          },
        };
        const mapEvent = {
          point: { x, y: 10 },
          lngLat: { lng: x, lat: 10 },
          originalEvent: original,
          preventDefault: vi.fn(),
        };
        map.fire('dblclick', mapEvent);
        return mapEvent.preventDefault;
      };

      expect(fire(10)).toHaveBeenCalled();
      expect(fire(30)).not.toHaveBeenCalled();
    });

    it('keeps a map key a mode used from reaching MapLibre, and lets other keys bubble', () => {
      normalizer.on((e) => {
        if (e.type === 'keydown')
          (e.originalEvent as { defaultPrevented: boolean }).defaultPrevented = true;
      });
      const fire = (k: string) => {
        const event = {
          key: k,
          code: k,
          ...modifiers,
          defaultPrevented: false,
          stopPropagation: vi.fn(),
        };
        map.canvas.dispatch('keydown', event);
        return event.stopPropagation;
      };

      expect(fire('ArrowLeft')).toHaveBeenCalled();
      expect(fire('g')).not.toHaveBeenCalled();
    });
  });

  it('removes every listener on detach', () => {
    normalizer.detach();
    expect(map.handlerCount()).toBe(0);
    expect(map.canvas.listeners.get('pointerdown')?.size ?? 0).toBe(0);
  });
});
