// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drawing a shape vertex by vertex: what the line and the polygon drawing modes share
 *
 * A click places a vertex, and a click snapped to a boundary after one snapped to the same
 * network takes in the vertices between them (tracing). A click on the closing vertex or Enter
 * creates the shape, Backspace removes the last vertex, Escape drops the drawing (and leaves
 * the mode when nothing is drawn), and the vertices can be undone and redone. It is written to
 * the extension contract, through the `ModeContext` alone.
 */

import type { ModeContext } from '../../api/v2/extension/context.js';
import type { DrawPointerEvent, ModeHandler } from '../../api/v2/extension/mode.js';
import type { FeatureInput } from '../../api/v2/model.js';
import type { SnapPreference } from '../../api/v2/state.js';
import type { Coordinate } from '../../store/types.js';
import type { TraceAnchor } from './trace-support.js';
import { computeTracePath, readTraceAnchor, traceSourceOf } from './trace-support.js';

/** How near the closing vertex a click finishes the shape, in pixels */
const VERTEX_CLICK_TOLERANCE = 10;

/**
 * What differs between the shapes drawn vertex by vertex
 *
 * @internal
 */
export interface VertexShape {
  /** The number of vertices the shape needs */
  readonly minVertices: number;
  /** The index of the vertex a click on which finishes the shape */
  closingVertex(vertices: readonly Coordinate[]): number;
  /**
   * The preview of the shape
   *
   * @param pointer - The positions from the last vertex to the pointer (the traced ones, then
   *   the pointer), or null to show the placed vertices only
   * @param closable - Whether a click now would finish the shape
   */
  preview(
    vertices: readonly Coordinate[],
    pointer: readonly Coordinate[] | null,
    closable: boolean,
  ): {
    feature: FeatureInput;
    options?: { confirmedVertices?: number; highlightVertex?: number };
  };
  /** The feature the vertices make */
  feature(vertices: readonly Coordinate[]): FeatureInput;
}

/**
 * Creates the handler of a mode that draws a shape vertex by vertex
 *
 * @internal
 */
export function createVertexDrawing(ctx: ModeContext, shape: VertexShape): ModeHandler {
  const source = traceSourceOf(ctx);
  let vertices: Coordinate[] = [];
  /** The vertices undone, to redo */
  let redo: Coordinate[] = [];
  /** The last position of the pointer, to keep the dashed line on undo and redo */
  let pointer: Coordinate | null = null;
  /** Whether the pointer is on the closing vertex */
  let nearClosing = false;
  /** The snap target of the last placed vertex: where the next trace starts */
  let traceAnchor: TraceAnchor | null = null;
  /** The traced vertices up to the pointer, shown before they are placed */
  let tracePreview: Coordinate[] | null = null;

  const closable = (): boolean => vertices.length >= shape.minVertices && nearClosing;

  const show = (withPointer: boolean): void => {
    if (vertices.length === 0) {
      ctx.preview.clear();
      return;
    }
    const tail = withPointer && pointer ? [...(tracePreview ?? []), pointer] : null;
    const { feature, options } = shape.preview(vertices, tail, closable());
    ctx.preview.set(feature, options);
  };

  const clearTrace = (): void => {
    traceAnchor = null;
    tracePreview = null;
  };

  const reset = (): void => {
    vertices = [];
    redo = [];
    pointer = null;
    nearClosing = false;
    clearTrace();
    ctx.preview.clear();
  };

  const finish = (): void => {
    if (vertices.length < shape.minVertices) return;
    const input = shape.feature(vertices);
    ctx.draw.transact(() => {
      const feature = ctx.commitFeature(input);
      if (feature) ctx.draw.selection.set('feature', [feature.id]);
    });
    reset();
    ctx.setMode('select');
  };

  const place = (event: DrawPointerEvent): void => {
    // The vertices of the boundary between the last placed vertex and this one come first
    const anchor = readTraceAnchor(source, event);
    const path = computeTracePath(source, traceAnchor, anchor);
    if (path) vertices.push(...path);
    traceAnchor = anchor;
    tracePreview = null;
    vertices.push([event.snapped.lngLat[0], event.snapped.lngLat[1]]);
    redo = [];
    show(false);
  };

  const snapPreference: SnapPreference = {
    // The boundary the trace started along wins a tie between snapping candidates
    get prefer() {
      if (!traceAnchor || !source.isEnabled()) return null;
      return {
        featureId: traceAnchor.featureId,
        ...(traceAnchor.datasetId !== undefined && { datasetId: traceAnchor.datasetId }),
      };
    },
  };

  return {
    writes: true,
    snapPreference,

    onEnter() {
      ctx.cursor.set('crosshair');
      ctx.draw.transact(() => ctx.draw.selection.clear(), { source: 'silent' });
      reset();
    },

    onExit() {
      ctx.cursor.reset();
      reset();
    },

    // What was being drawn is dropped when the state is reset from outside
    onCancel: reset,

    // A double click while drawing is two clicks of the drawing; it never zooms the map
    onDoubleClick: () => true,

    onClick(event) {
      if (closable()) finish();
      else place(event);
      return true;
    },

    onPointerMove(event) {
      pointer = [event.snapped.lngLat[0], event.snapped.lngLat[1]];
      if (vertices.length > 0) {
        const [x, y] = ctx.screen.project(vertices[shape.closingVertex(vertices)]);
        nearClosing = Math.hypot(event.point[0] - x, event.point[1] - y) <= VERTEX_CLICK_TOLERANCE;
      } else {
        nearClosing = false;
      }
      tracePreview = computeTracePath(source, traceAnchor, readTraceAnchor(source, event));
      ctx.cursor.set(closable() ? 'pointer' : 'crosshair');
      if (vertices.length > 0) show(true);
      return false;
    },

    onKeyDown(event) {
      switch (event.key) {
        case 'Escape':
          if (vertices.length > 0) reset();
          else ctx.setMode('select');
          return true;
        case 'Enter':
          finish();
          return true;
        case 'Backspace':
        case 'Delete':
          if (vertices.length > 0) {
            vertices.pop();
            // A vertex removed with the keyboard cannot be redone, and the trace starts over
            redo = [];
            clearTrace();
            show(false);
          }
          return true;
        default:
          return false;
      }
    },

    onUndoVertex() {
      const removed = vertices.pop();
      if (!removed) return false;
      redo.push(removed);
      clearTrace();
      show(true);
      return true;
    },

    onRedoVertex() {
      const restored = redo.pop();
      if (!restored) return false;
      vertices.push(restored);
      clearTrace();
      show(true);
      return true;
    },
  };
}
