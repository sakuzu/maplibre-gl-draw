// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * InputRouter
 *
 * Routes normalized events to the ModeHandler.
 * InputNormalizer is responsible for normalizing the events.
 *
 * This is the single entry point for coordinates, so the lngLat of click /
 * mousemove / dragstart / dragmove / dragend is replaced through SnapService just
 * before the event is delivered to the mode. This way every mode (including custom
 * modes from plugins) and the vertex drag of select mode support snapping with no
 * modification of their own.
 *
 * A mode can decline snapping per input type via isSnapEnabledFor (freehand uses
 * this to let only the points in the middle of a stroke pass through untouched).
 *
 * Before that, the longitude of every event is brought onto the copy of the world the features
 * are stored in (`toStoredCopy`). maplibre reports the pointer with the unwrapped longitude of
 * the view (above 180 east of the antimeridian, or on a world copy at low zoom), and a mode
 * would otherwise store it as it is.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

import type { DisplayInteractions } from '../display/interaction.js';
import type { ModeContext, ModeHandler, SnapInputType } from '../modes/handler.js';
import type { ModeManager } from '../modes/manager.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import { nearestLongitude, wrapLongitude } from '../shared/math/longitude.js';
import type { SnapContext, SnapService } from '../snapping/types.js';
import type { Coordinate, TentativeState } from '../store/types.js';
import type { InputNormalizer } from './normalizer.js';
import type {
  DragNormalizedEvent,
  MapClickEventPayload,
  ModifierKeys,
  MouseNormalizedEvent,
  NormalizedEvent,
} from './types.js';

/**
 * The InputRouter interface
 *
 * @internal
 */
export interface InputRouter {
  /** Starts handling events */
  start(): void;
  /** Stops handling events */
  stop(): void;
  /**
   * Feeds a normalized event directly (the entry point for synthetic input)
   *
   * It takes exactly the same path as an event arriving from InputNormalizer.
   * Snapping, delivery to plugins and the interception by datasets
   * all take effect in the same way. `draw.input` uses this to advance drawing from
   * numeric input, tests or automation.
   */
  dispatch(event: NormalizedEvent): void;

  /**
   * Toggles the hold on input that originates from the pointer
   *
   * While held, the click / dblclick / mousemove of the real pointer are not
   * delivered to the mode. Synthetic input (dispatch) is unaffected.
   */
  setPointerHold(held: boolean): void;

  /** Whether input originating from the pointer is currently held */
  isPointerHeld(): boolean;
}

/**
 * The dependencies of InputRouter
 *
 * @internal
 */
export interface InputRouterDeps {
  normalizer: InputNormalizer;
  modeManager: ModeManager;
  context: ModeContext;
  map: MapLibreMap;
  /**
   * The plugin manager
   * Used to call the onKeyDown of the plugins.
   */
  pluginManager?: PluginManager;
  /**
   * The hit testing interception of datasets
   *
   * click / mousemove are passed on after they have been delivered to the mode.
   * The rule that a hit in the Store always wins is decided on the interception
   * side, so the behavior of the mode does not change.
   */
  displayInteractions?: DisplayInteractions;
  /**
   * Notification of a click in select mode (the source of draw.map.click, the event
   * exposed on the instance)
   *
   * Called once, regardless of whether anything was hit or of what was hit. The
   * coordinates are copied from the raw normalized event before snapping. It is for
   * read-only subscription and does not affect the selection behavior of the mode.
   */
  notifyMapClick?(payload: MapClickEventPayload): void;
  /**
   * The snapping service
   *
   * When omitted, no snapping is performed. It replaces the lngLat of click /
   * mousemove / dragstart / dragmove / dragend just before delivery to the mode.
   */
  snapService?: SnapService;
}

/**
 * The event types that are stopped while the pointer is held
 *
 * Only the ones that determine coordinates are stopped. Stopping mousedown /
 * mouseup / the drag events would also break the pan and zoom of MapLibre.
 */
const HELD_EVENT_TYPES: ReadonlySet<NormalizedEvent['type']> = new Set([
  'click',
  'dblclick',
  'mousemove',
]);

/**
 * The first coordinate of a shape being drawn (null when there is none)
 */
function firstTentativeCoordinate(tentative: TentativeState | null): Coordinate | null {
  let value: unknown = tentative?.coordinates;
  while (Array.isArray(value) && Array.isArray(value[0])) value = value[0];
  if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') {
    return value as Coordinate;
  }
  return null;
}

/**
 * Brings the longitudes of an event onto the stored copy of the world
 *
 * The rule, from the point of view of the pointer:
 *
 * - A click, a move or a press on its own lands in [-180, 180], the range the features are
 *   stored in. This is the same point hit testing starts from (`clickCopies` in
 *   hit-test/local-frame.ts), so a point placed or a feature picked on the copy east of the
 *   antimeridian gets its stored longitude
 * - While a shape is being drawn, the pointer goes to the copy nearest to the first vertex of the
 *   shape instead, so a line drawn across the antimeridian stays continuous (170 then 190, not
 *   170 then -170, which would run the other way round the world). Its vertices can then lie a
 *   little beyond ±180; the rendering and the export deal with that
 * - A drag moves every coordinate of its events by the one shift decided from where it started
 *   (`dragStartLngLat`), so the distance dragged never jumps by 360 degrees when the pointer
 *   crosses the antimeridian during the drag
 *
 * Away from the antimeridian, on the main copy of the world, nothing changes and the event is
 * returned as it is.
 */
function toStoredCopy<E extends NormalizedEvent>(event: E, reference: Coordinate | null): E {
  if (!('lngLat' in event)) return event;
  const anchor = 'dragStartLngLat' in event ? event.dragStartLngLat.lng : event.lngLat.lng;
  const target = reference ? nearestLongitude(anchor, reference[0]) : wrapLongitude(anchor);
  const shift = target - anchor;
  if (shift === 0) return event;

  const moved = { ...event, lngLat: { lng: event.lngLat.lng + shift, lat: event.lngLat.lat } };
  if ('dragStartLngLat' in event) {
    (moved as DragNormalizedEvent).dragStartLngLat = {
      lng: event.dragStartLngLat.lng + shift,
      lat: event.dragStartLngLat.lat,
    };
  }
  return moved;
}

/**
 * The options used when delivering an event
 */
interface HandleEventOptions {
  /** Whether this is synthetic input (via dispatch). It is exempt from the hold */
  synthetic?: boolean;
}

/**
 * Creates an InputRouter
 *
 * @internal
 */
export function createInputRouter(deps: InputRouterDeps): InputRouter {
  const {
    normalizer,
    modeManager,
    context,
    map,
    pluginManager,
    displayInteractions,
    notifyMapClick,
    snapService,
  } = deps;

  let boundHandleEvent: ((event: NormalizedEvent) => void) | null = null;

  /**
   * Whether input originating from the pointer is currently held
   *
   * While the keyboard is determining the coordinates, as with a numeric input
   * panel, interruption by the real pointer is stopped. What is stopped is only the
   * events that "determine" coordinates (click / dblclick / mousemove); mousedown /
   * mouseup / the drag events are let through (so as not to kill the pan and zoom of
   * MapLibre; drawing modes do not consume them).
   */
  let pointerHeld = false;

  /**
   * Builds the snapping context
   *
   * While a vertex / midpoint is being dragged, the grabbed vertex itself is
   * excluded (the other vertices of the same feature stay as candidates so that a
   * ring can be closed). The exclusion can be derived from the drag state of the
   * Store, so no modification is needed on the select mode side.
   *
   * While a move drag is in progress, the features being moved are excluded whole.
   * A feature being moved travels with the cursor, so if it stayed a candidate it
   * would always sit inside the tolerance, the cursor would be pulled back to its
   * own position, and it would repeat "drift every frame by the offset from when it
   * was grabbed, then leave the tolerance and catch up all at once" (which looks
   * like a vibration). It is the same reasoning as excludeVertex for a vertex drag,
   * except that the unit that is removed is the whole feature.
   *
   * The feature to prefer when candidates tie is read from the current mode (a
   * drawing mode returns the boundary it started tracing).
   */
  function buildSnapContext(modifiers: ModifierKeys): SnapContext {
    const dragState = context.store.getDragState();
    const isVertexDrag = dragState?.operation === 'vertex' || dragState?.operation === 'midpoint';
    const excludeVertex =
      isVertexDrag && dragState?.activeFeatureId && dragState.activeVertex
        ? { featureId: dragState.activeFeatureId, vertex: dragState.activeVertex }
        : undefined;

    const moving = dragState?.operation === 'move' ? dragState.movingFeatureIds : undefined;
    const excludeFeatureIds = moving && moving.length > 0 ? new Set(moving) : undefined;

    const preferFeature = modeManager.getHandler()?.getSnapPreference?.() ?? undefined;

    return {
      zoom: map.getZoom(),
      excludeVertex,
      excludeFeatureIds,
      preferFeature,
      modifiers,
    };
  }

  /**
   * Replaces lngLat with the snapped coordinates just before delivery to the mode
   *
   * When nothing was snapped, the event is returned as-is (no pointless copy).
   *
   * Whether snapping is wanted is asked of the current mode per input type
   * (isSnapEnabledFor). A mode that does not declare it snaps for every input type
   * (as before).
   */
  function applySnap<E extends MouseNormalizedEvent | DragNormalizedEvent>(
    event: E,
    inputType: SnapInputType,
  ): E {
    if (!snapService || event.snap === false) return event;
    if (modeManager.getHandler()?.isSnapEnabledFor?.(inputType) === false) return event;

    const result = snapService.resolve(
      event.lngLat,
      event.point,
      buildSnapContext(event.modifiers),
    );
    if (result.lngLat.lng === event.lngLat.lng && result.lngLat.lat === event.lngLat.lat) {
      return event;
    }
    return { ...event, lngLat: { lng: result.lngLat.lng, lat: result.lngLat.lat } };
  }

  function handleEvent(input: NormalizedEvent, options: HandleEventOptions = {}): void {
    // Only input originating from the real pointer is stopped while held.
    // Synthetic input (dispatch) is let through
    if (pointerHeld && !options.synthetic && HELD_EVENT_TYPES.has(input.type)) return;

    const handler = modeManager.getHandler();
    if (!handler) return;

    // The single place where the longitude of the input is decided (see toStoredCopy)
    const event = toStoredCopy(input, firstTentativeCoordinate(context.store.getTentative()));

    switch (event.type) {
      case 'click': {
        // Deliver to the mode with the snapped coordinates (if nothing snapped,
        // the original event is used unchanged)
        const snapped = applySnap(event, 'click');
        handleClick(handler, snapped);
        // Delivery to datasets happens only in select mode. A click
        // in a drawing mode places a vertex, and delivering that same click as a
        // click on the data as well would make the host application's "click to
        // select" fire by mistake while drawing (for example, starting to draw a
        // circle on top of a huge polygon of data would cover the whole screen with
        // the selection highlight). The rule that a hit in the Store always wins is
        // decided on the interception side, so the selection behavior of the mode
        // during select is unaffected.
        if (handler.modeName === 'select') displayInteractions?.handleClick(snapped);
        // Emit the click of select mode as a single stream regardless of whether
        // anything was hit (draw.map.click). display.click is designed not to fire
        // when a feature in the Store is hit, so a host application that needs "a
        // click anywhere on the map" (placing a comment pin, for instance) watches
        // this one. The coordinates are copied from the raw event before snapping.
        if (handler.modeName === 'select') {
          notifyMapClick?.({
            lngLat: [event.lngLat.lng, event.lngLat.lat],
            point: { x: event.point.x, y: event.point.y },
          });
        }
        break;
      }
      case 'dblclick':
        handler.onDoubleClick?.(event);
        break;
      case 'mousedown':
        handleMouseDown(handler, event);
        break;
      case 'mouseup':
        handler.onMouseUp?.(event);
        break;
      case 'mousemove': {
        const snapped = applySnap(event, 'mousemove');
        // Call the onMouseMove of the plugins (they do not consume it)
        pluginManager?.handleMouseMove(snapped);
        handler.onMouseMove?.(snapped);
        // The hover of datasets is likewise limited to select mode,
        // by the same rule as click. When switching to a drawing mode, a hover that
        // is still held is discarded (so that it does not fire on the stale target
        // when coming back).
        if (handler.modeName === 'select') {
          displayInteractions?.handleMouseMove(snapped);
        } else {
          displayInteractions?.reset();
        }
        break;
      }
      case 'contextmenu':
        // contextmenu currently has no special handling
        break;
      // The start and end of a drag also go through snapping. This is to keep
      // "start drawing exactly at a corner of a boundary and end at a corner" for
      // drag-driven drawing (freehand). The drag operations of select mode use
      // dragStartLngLat (the press position from before the threshold was exceeded)
      // as their start position, so they are unaffected by the replacement here.
      case 'dragstart': {
        const snapped = applySnap(event, 'dragstart');
        handler.onDragStart?.(snapped);
        break;
      }
      case 'dragmove': {
        const snapped = applySnap(event, 'dragmove');
        // Call the onDragMove of the plugins (they do not consume it; the
        // counterpart of onMouseMove)
        pluginManager?.handleDragMove(snapped);
        handler.onDragMove?.(snapped);
        break;
      }
      case 'dragend': {
        const snapped = applySnap(event, 'dragend');
        handler.onDragEnd?.(snapped);
        break;
      }
      // A press ended without a release (a second finger, or the browser cancelled the
      // touch). No coordinates are decided, so it does not go through snapping, and it
      // is never held: the mode must always get the chance to abort the press.
      case 'dragcancel':
        handler.onDragCancel?.(event);
        break;
      case 'keydown':
        // Call the onKeyDown of the plugins first
        if (pluginManager?.handleKeyDown(event)) {
          // Handled by a plugin
          break;
        }
        handler.onKeyDown?.(event);
        break;
      case 'keyup':
        handler.onKeyUp?.(event);
        break;
    }
  }

  function handleClick(handler: ModeHandler, event: MouseNormalizedEvent): void {
    handler.onClick?.(event);
  }

  function handleMouseDown(handler: ModeHandler, event: MouseNormalizedEvent): void {
    if (handler.onMouseDown) {
      const consumed = handler.onMouseDown(event);
      // When the event has been consumed, stop it from propagating to MapLibre
      if (consumed) {
        const original = event.originalEvent;
        original.stopPropagation();
        // MapLibre listens to touchstart as a passive listener, where preventDefault() is
        // ignored and makes the browser warn. The pan and the pinch of a touch are left to
        // MapLibre, so only a mouse press has its default action prevented.
        if (!('touches' in original)) {
          original.preventDefault();
        }
      }
    }
  }

  function start(): void {
    boundHandleEvent = handleEvent;
    normalizer.on(boundHandleEvent);
  }

  function stop(): void {
    if (boundHandleEvent) {
      normalizer.off(boundHandleEvent);
      boundHandleEvent = null;
    }
  }

  return {
    start,
    stop,
    dispatch: (event: NormalizedEvent) => handleEvent(event, { synthetic: true }),

    setPointerHold(held: boolean): void {
      pointerHeld = held;
    },

    isPointerHeld(): boolean {
      return pointerHeld;
    },
  };
}
