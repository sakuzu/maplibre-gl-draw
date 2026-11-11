// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The feature type "Route" of the custom-feature-types example: a line drawn with style keys of
// its own. One definition says how it is drawn (with the library's shared line renderer), hit,
// box-selected, framed and reshaped, with a handle on each vertex whose mark it draws.

import {
  type Feature,
  type FeatureTypeDefinition,
  type Position,
  readFeature,
  type ScreenPoint,
} from '@sakuzu/maplibre-gl-draw';
import type { LineString } from 'geojson';

// The style keys of a route. Core keeps a key it does not define with the feature (stored,
// exported and loaded back) and does not read it; the type declares them, and its `render`
// checks their values, which can arrive from anywhere
declare module '@sakuzu/maplibre-gl-draw' {
  interface FeatureStyle {
    routeColor?: string;
    routeWidth?: number;
    routeDashed?: boolean;
  }
}

/** The diameter of the mark of a handle on a vertex of a route, the size it is hit at, in CSS pixels */
const VERTEX_MARK_SIZE_PX = 10;

/** The look of a route without style keys of its own */
export const ROUTE_DEFAULTS = { routeColor: '#e64d1a', routeWidth: 3, routeDashed: true };

/** The look a route is drawn with: its own keys where they are valid, the defaults elsewhere */
export function routeLook(feature: Feature): typeof ROUTE_DEFAULTS {
  const { routeColor, routeWidth, routeDashed } = readFeature(feature).style;
  return {
    routeColor: typeof routeColor === 'string' ? routeColor : ROUTE_DEFAULTS.routeColor,
    routeWidth:
      typeof routeWidth === 'number' && routeWidth > 0 ? routeWidth : ROUTE_DEFAULTS.routeWidth,
    routeDashed: typeof routeDashed === 'boolean' ? routeDashed : ROUTE_DEFAULTS.routeDashed,
  };
}

function verticesOf(feature: Feature): Position[] {
  return (feature.geometry as LineString).coordinates;
}

/** Distance from a point to a segment, in pixels */
function segmentDistance(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t =
    len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

export const routeType: FeatureTypeDefinition = {
  type: 'Route',
  geometry: 'LineString',
  // Drawn in the feature's place in the layer order. The shared renderers are ready for the draw
  // (shader and projection), so the type holds nothing on the GPU
  render(feature, ctx) {
    const look = routeLook(feature);
    ctx.line.draw(verticesOf(feature), {
      width: look.routeWidth,
      color: look.routeColor,
      opacity: ctx.opacity,
      lineStyle: look.routeDashed ? 'dashed' : 'solid',
    });
  },
  // A click within the click tolerance of the line, or within its half width, hits it
  hitTest(feature, ctx) {
    const points = verticesOf(feature).map((v) => ctx.screen.project(v));
    let best = Number.POSITIVE_INFINITY;
    for (let i = 1; i < points.length; i++) {
      best = Math.min(best, segmentDistance(ctx.point, points[i - 1], points[i]));
    }
    const reach = Math.max(ctx.tolerancePx, routeLook(feature).routeWidth / 2);
    return best <= reach ? { distancePx: best } : null;
  },
  // A selection box takes a route when one of its vertices is inside
  boxSelect(feature, boxPx, ctx) {
    return verticesOf(feature).some((v) => {
      const [x, y] = ctx.screen.project(v);
      return x >= boxPx.min[0] && x <= boxPx.max[0] && y >= boxPx.min[1] && y <= boxPx.max[1];
    });
  },
  // What the route covers, which the selection box goes around: the extent of its vertices, laid on
  // the map
  footprint(feature) {
    const points = verticesOf(feature);
    const west = Math.min(...points.map((p) => p[0]));
    const east = Math.max(...points.map((p) => p[0]));
    const south = Math.min(...points.map((p) => p[1]));
    const north = Math.max(...points.map((p) => p[1]));
    return {
      kind: 'ground',
      corners: {
        topLeft: [west, north],
        topRight: [east, north],
        bottomRight: [east, south],
        bottomLeft: [west, south],
      },
    };
  },
  // A handle on each vertex, which moves that vertex. The library draws the resize and rotate
  // handles of the footprint; the type draws the marks of these handles (drawHandles), and the
  // library hits each within the size of its mark. The library asks for them, and draws them, only
  // while the route is the one feature selected and can be edited
  handles(feature) {
    return verticesOf(feature).map((position, index) => ({
      kind: 'custom',
      id: String(index),
      position,
      sizePx: VERTEX_MARK_SIZE_PX,
      cursor: 'move',
    }));
  },
  // The marks of the handles: a white circle with an outline of the color of the route, as wide as
  // the handle is hit
  drawHandles(feature, handles, ctx) {
    const look = routeLook(feature);
    for (const handle of handles) {
      ctx.point.draw(handle.position, {
        shape: 'circle',
        size: VERTEX_MARK_SIZE_PX,
        fillColor: '#ffffff',
        fillOpacity: 1,
        strokeColor: look.routeColor,
        strokeWidth: 2,
        strokeOpacity: 1,
      });
    }
  },
  onHandleDrag(feature, handle, event) {
    const coordinates = [...verticesOf(feature)];
    coordinates[Number(handle.id)] = event.lngLat;
    return { geometry: { type: 'LineString', coordinates } };
  },
};
