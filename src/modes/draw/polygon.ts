// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The polygon drawing mode: clicks add vertices, and a click on the first vertex or Enter
 * creates the polygon. A click snapped to a boundary after one snapped to the same boundary
 * network takes in the vertices between them (tracing).
 *
 * It is written to the extension contract, through the `ModeContext` alone.
 */

import type { ModeFactory } from '../../api/extension/mode.js';
import type { Coordinate } from '../../store/types.js';
import { createVertexDrawing } from './vertex-drawing.js';

/**
 * The factory of the polygon drawing mode
 *
 * @internal
 */
export const drawPolygonMode: ModeFactory = (ctx) =>
  createVertexDrawing(ctx, {
    minVertices: 3,
    // The first vertex closes the ring
    closingVertex: () => 0,
    preview(vertices, pointer, closable) {
      const coordinates: Coordinate[] = pointer ? [...vertices, ...pointer] : [...vertices];
      if (coordinates.length < 2) {
        // One vertex shows as a marker
        return {
          feature: { type: 'Point', geometry: { type: 'Point', coordinates: coordinates[0] } },
        };
      }
      return {
        feature: {
          type: 'Polygon',
          geometry: { type: 'Polygon', coordinates: [[...coordinates, coordinates[0]]] },
        },
        options: { confirmedVertices: vertices.length, ...(closable && { highlightVertex: 0 }) },
      };
    },
    feature: (vertices) => ({
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [[...vertices, vertices[0]]] },
    }),
  });
