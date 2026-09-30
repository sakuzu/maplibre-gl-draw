// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The members of the draw instance about the drawing: the divisions of the stacking order,
 * the work left to later frames and the diagnostics of the terrain, and `draw.drawing`, the
 * shape the current drawing mode is drawing
 */

import type {
  KeyNormalizedEvent,
  ModifierKeys,
  MouseNormalizedEvent,
} from '../../dispatcher/types.js';
import type { TerrainRenderState } from '../../view/terrain/context.js';
import { INITIAL_DRAPE_DEBUG } from '../../view/terrain/context.js';
import {
  getTerrainDrapeDebug,
  getTerrainRenderState,
  INACTIVE_TERRAIN_STATE,
} from '../../view/terrain/state.js';
import type { Draw } from '../draw.js';
import type { DrawingResource } from '../drawing.js';
import type { LayerStackEntry, TerrainDiagnostics } from '../state.js';
import type { Engine } from './engine.js';
import { invalidInput } from './shared.js';

/**
 * `getLayerStack`, `hasPendingWork` and `debug` over the engine
 *
 * @internal
 */
export function createDrawing(
  engine: Pick<Engine, 'customLayer'>,
): Pick<Draw, 'getLayerStack' | 'hasPendingWork' | 'debug'> {
  const { customLayer } = engine;
  return {
    getLayerStack(): readonly LayerStackEntry[] {
      return Object.freeze(
        customLayer
          .getStackSlots()
          .map(({ layerId, from, to }) => Object.freeze({ layerId, from, to })),
      );
    },

    hasPendingWork: () => customLayer.hasPendingWork(),

    debug: {
      terrain(): TerrainDiagnostics {
        const terrain = customLayer.getTerrainContext();
        return Object.freeze({
          render: toRenderDiagnostics(
            terrain ? getTerrainRenderState(terrain) : INACTIVE_TERRAIN_STATE,
          ),
          drape: Object.freeze({
            ...(terrain ? getTerrainDrapeDebug(terrain) : INITIAL_DRAPE_DEBUG),
          }),
        });
      },
    },
  };
}

/** The plain numbers of a terrain state, without the GL objects and the internal plans */
function toRenderDiagnostics(state: TerrainRenderState): TerrainDiagnostics['render'] {
  return Object.freeze({
    active: state.active,
    atlasRect: Object.freeze([
      ...state.atlasRect,
    ]) as unknown as TerrainDiagnostics['render']['atlasRect'],
    atlasSize: Object.freeze([
      ...state.atlasSize,
    ]) as unknown as TerrainDiagnostics['render']['atlasSize'],
    elevationScale: state.elevationScale,
    liftMeters: state.liftMeters,
    stepMeters: state.stepMeters,
    stepGrid: state.stepGrid,
    generation: state.generation,
  });
}

// ============================================================================
// draw.drawing
// ============================================================================

/** No modifier key held */
const NO_MODIFIERS: ModifierKeys = Object.freeze({
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
});

/** Throws unless the value is a position of two finite numbers, and returns them */
function requirePosition(value: unknown): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    typeof value[0] !== 'number' ||
    typeof value[1] !== 'number' ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1])
  ) {
    throw invalidInput('The position must be [longitude, latitude] of finite numbers');
  }
  return [value[0], value[1]];
}

/** An event of the browser that has what a receiver reads, where the browser has none to make */
function inertEvent(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    target: null,
    currentTarget: null,
    defaultPrevented: false,
    isTrusted: false,
    preventDefault(): void {},
    stopPropagation(): void {},
    stopImmediatePropagation(): void {},
    ...fields,
  };
}

/**
 * The event of the browser a made pointer event carries: a `PointerEvent` (or a `MouseEvent`)
 * where the browser can make one, otherwise an object with the same fields
 */
function makePointerOriginal(
  type: string,
  point: { x: number; y: number },
  container: HTMLElement | undefined,
): MouseEvent {
  const rect = container?.getBoundingClientRect?.();
  const init = {
    clientX: (rect?.left ?? 0) + point.x,
    clientY: (rect?.top ?? 0) + point.y,
    button: 0,
    buttons: 0,
  };
  const eventType = type === 'mousemove' ? 'pointermove' : type;
  if (typeof PointerEvent === 'function') {
    return new PointerEvent(eventType, { ...init, pointerType: 'mouse', isPrimary: true });
  }
  if (typeof MouseEvent === 'function') return new MouseEvent(eventType, init);
  return inertEvent({ type: eventType, ...init }) as unknown as MouseEvent;
}

/** The event of the browser a made key event carries */
function makeKeyOriginal(key: string): KeyboardEvent {
  if (typeof KeyboardEvent === 'function') return new KeyboardEvent('keydown', { key, code: key });
  return inertEvent({ type: 'keydown', key, code: key, repeat: false }) as unknown as KeyboardEvent;
}

/**
 * `draw.drawing` over the engine: the input it makes goes through the router of the input,
 * the same way as the input of the map
 *
 * @internal
 */
export function createDrawingResource(
  engine: Pick<Engine, 'map' | 'context' | 'modeManager' | 'inputRouter'>,
): DrawingResource {
  const { map, modeManager, inputRouter } = engine;
  const { store } = engine.context;

  const isDrawing = (): boolean => store.getTentative() !== null;
  const isActive = (): boolean => isDrawing() || modeManager.getHandler()?.writesFeatures === true;

  const pointer = (type: 'mousemove' | 'click', [lng, lat]: [number, number]) => {
    const projected = map.project([lng, lat]);
    const point = { x: projected.x, y: projected.y };
    const event: MouseNormalizedEvent = {
      type,
      point,
      lngLat: { lng, lat },
      originalEvent: makePointerOriginal(type, point, map.getContainer?.()),
      modifiers: { ...NO_MODIFIERS },
      pointerType: 'mouse',
      // The position is used as it is: it is not snapped, and no click tolerance applies
      snap: false,
      programmatic: true,
    };
    return inputRouter.dispatch(event);
  };

  return {
    isActive,
    isDrawing,

    addVertex(position) {
      const at = requirePosition(position);
      if (!isActive()) return false;
      // A click comes after the pointer moved to where it clicks, and the modes read that move
      // (a click on the closing vertex finishes the shape)
      pointer('mousemove', at);
      return pointer('click', at);
    },

    moveTo(position) {
      const at = requirePosition(position);
      if (!isActive()) return;
      pointer('mousemove', at);
    },

    finish() {
      if (!isDrawing()) return false;
      const event: KeyNormalizedEvent = {
        type: 'keydown',
        key: 'Enter',
        code: 'Enter',
        modifiers: { ...NO_MODIFIERS },
        originalEvent: makeKeyOriginal('Enter'),
      };
      return inputRouter.dispatch(event) && !isDrawing();
    },

    cancel() {
      if (!isDrawing()) return false;
      // The mode drops what it was drawing (onCancel of a mode of the contract)
      modeManager.notifyStateReset();
      if (store.getTentative() !== null) store.setTentative(null);
      return true;
    },

    undoVertex: () => modeManager.undoVertex(),
    redoVertex: () => modeManager.redoVertex(),
  };
}
