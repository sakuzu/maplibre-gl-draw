// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The line drawing mode: clicks add vertices, and a click on the last vertex, a double click or
 * Enter creates the line. A click snapped to a boundary after one snapped to the same boundary
 * network takes in the vertices between them (tracing).
 *
 * It is written to the extension contract, through the `ModeContext` alone.
 */

import type { ModeFactory } from '../../api/extension/mode.js';
import type { Coordinate } from '../../store/types.js';
import { createVertexDrawing } from './vertex-drawing.js';

/**
 * The factory of the line drawing mode
 *
 * @internal
 */
export const drawLineMode: ModeFactory = (ctx) =>
  createVertexDrawing(ctx, {
    minVertices: 2,
    // The last vertex finishes the line
    closingVertex: (vertices) => vertices.length - 1,
    preview(vertices, pointer, closable) {
      const coordinates: Coordinate[] = pointer ? [...vertices, ...pointer] : [...vertices];
      return {
        feature: { type: 'LineString', geometry: { type: 'LineString', coordinates } },
        options: {
          confirmedVertices: vertices.length,
          ...(closable && { highlightVertex: vertices.length - 1 }),
        },
      };
    },
    feature: (vertices) => ({
      type: 'LineString',
      geometry: { type: 'LineString', coordinates: [...vertices] },
    }),
  });
