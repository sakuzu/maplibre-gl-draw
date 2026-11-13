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
import { createCoordinateTransform } from '../../shared/math/index.js';
import { createId } from '../../shared/utils/id.js';
import type { TerrainRenderState } from '../../view/terrain/context.js';
import { INITIAL_DRAPE_DEBUG } from '../../view/terrain/context.js';
import {
  getTerrainDrapeDebug,
  getTerrainRenderState,
  INACTIVE_TERRAIN_STATE,
} from '../../view/terrain/state.js';
import type { Draw } from '../draw.js';
import type { Drawing, DrawingResource } from '../drawing.js';
import { DrawError } from '../errors.js';
import type { Feature } from '../model.js';
import type { GpuMemoryDiagnostics, LayerStackEntry, Mode, TerrainDiagnostics } from '../state.js';
import type { Write, WriteResult } from '../write.js';
import type { DrawingCommit } from './contexts.js';
import type { Engine } from './engine.js';
import { invalidInput, isRecord, notFound } from './shared.js';
import { abortedError, checkWriteOptions } from './write.js';

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
      gpu(): GpuMemoryDiagnostics {
        const memory = customLayer.getGpuMemory();
        return Object.freeze({
          bytes: memory.bytes,
          bufferBytes: memory.bufferBytes,
          textureBytes: memory.textureBytes,
          rowBytes: memory.rowBytes,
          peakBytes: memory.peakBytes,
          leakedBytes: memory.leakedBytes,
          allocations: memory.allocations,
          byOwner: memory.byOwner,
        });
      },
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
  engine: Pick<Engine, 'map' | 'context' | 'modeManager' | 'inputRouter' | 'sketches'>,
): DrawingResource {
  const { map, modeManager, inputRouter, sketches } = engine;
  const { shapes } = engine.context;

  const isDrawing = (): boolean => shapes.drawing() !== null;
  const isActive = (): boolean => isDrawing() || modeManager.getHandler()?.writesFeatures === true;

  const pointer = (type: 'mousemove' | 'click', [lng, lat]: [number, number]) => {
    // The point the position is drawn at in the frame drawn last; the position stays as given
    const point = createCoordinateTransform(map).project([lng, lat]);
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
      // The mode drops what it was drawing (onCancel of a mode of the contract), and the shape
      // it showed with it
      modeManager.notifyStateReset();
      const drawings = sketches.ownDrawings();
      if (drawings.length > 0) sketches.removeMany(drawings.map((sketch) => sketch.id));
      return true;
    },

    undoVertex: () => modeManager.undoVertex(),
    redoVertex: () => modeManager.redoVertex(),
  };
}

// ============================================================================
// draw.mode
// ============================================================================

/**
 * `draw.mode.set`: changes the mode, as `draw.setMode` does, and keeps the mode with `repeat`
 *
 * @internal
 */
export function createModeSet(
  engine: Pick<Engine, 'modeManager'>,
): (mode: Mode, options?: { readonly repeat?: boolean }) => void {
  const { modeManager } = engine;
  return (mode, options) => {
    if (typeof mode !== 'string') throw invalidInput('The mode must be a string');
    if (options !== undefined && !isRecord(options)) {
      throw invalidInput('The options must be an object');
    }
    const repeat = options?.repeat;
    if (repeat !== undefined && typeof repeat !== 'boolean') {
      throw invalidInput('repeat must be a boolean');
    }
    if (!modeManager.hasMode(mode)) throw notFound('mode', mode);
    modeManager.setMode(mode, repeat === true);
  };
}

/** A write that failed before anything was committed, with the ID it would have had */
function failedWrite<T>(error: unknown, id = createId()): Write<T> {
  const result = Promise.reject<WriteResult<T>>(error);
  const done = result.then(({ value }) => value);
  return Object.assign(done, { id, result }) as Write<T>;
}

/**
 * `draw.mode.drawing` over `draw.drawing`: the same input, refused outside a drawing mode, and the
 * commit of the shape as one commit with the options of a write
 *
 * @internal
 */
export function createModeDrawing(
  engine: Pick<Engine, 'context' | 'extensions'>,
  resource: DrawingResource,
): Drawing {
  const { store } = engine.context;
  const requireDrawingMode = (): void => {
    if (!resource.isActive()) {
      throw new DrawError('invalidState', 'The current mode is no drawing mode');
    }
  };

  return {
    get active() {
      return resource.isDrawing();
    },

    add(at) {
      const position = requirePosition(at);
      requireDrawingMode();
      resource.addVertex(position);
    },

    move(at) {
      const position = requirePosition(at);
      requireDrawingMode();
      resource.moveTo(position);
    },

    undo() {
      requireDrawingMode();
      resource.undoVertex();
    },

    redo() {
      requireDrawingMode();
      resource.redoVertex();
    },

    commit(options) {
      let checked: ReturnType<typeof checkWriteOptions>;
      try {
        checked = checkWriteOptions(options);
        requireDrawingMode();
        if (checked.signal.aborted) throw abortedError(checked.signal);
        if (store.isReadOnly()) throw new DrawError('notEditable', 'The document is read-only');
        if (!resource.isDrawing()) throw new DrawError('invalidState', 'No shape is being drawn');
      } catch (error) {
        return failedWrite(error);
      }
      const id = createId();
      // The mode creates the feature as Enter makes it, written as the commit asked for
      const asked: DrawingCommit = {
        info: { id, label: checked.label, undo: checked.undo },
        made: null,
      };
      const slot = engine.extensions.drawingCommit;
      const outer = slot.current;
      slot.current = asked;
      try {
        resource.finish();
      } finally {
        slot.current = outer;
      }
      const made: Feature | null = asked.made;
      if (made === null) {
        return failedWrite(
          new DrawError('invalidState', 'The mode created no feature from the shape being drawn'),
          id,
        );
      }
      const result = Promise.resolve<WriteResult<Feature>>({ value: made, skipped: 0 });
      const done = result.then(({ value }) => value);
      return Object.assign(done, { id, result }) as Write<Feature>;
    },

    cancel() {
      requireDrawingMode();
      resource.cancel();
    },
  };
}
