// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The feature type "Route" of the custom-feature-types example: a line drawn with style keys of
// its own. One definition says how it is drawn (with the library's shared line renderer), hit,
// box-selected, framed and reshaped.

import type {
  Feature,
  FeatureRenderer,
  FeatureTypeDefinition,
  Position,
  ScreenPoint,
} from '@sakuzu/maplibre-gl-draw';
import type { LineString } from 'geojson';

// The style keys of a route. Core keeps a key it does not define with the feature (stored,
// exported and loaded back) and does not read it; the type declares them, and its renderer
// checks their values, which can arrive from anywhere
declare module '@sakuzu/maplibre-gl-draw' {
  interface FeatureStyle {
    routeColor?: string;
    routeWidth?: number;
    routeDashed?: boolean;
  }
}

/** The look of a route without style keys of its own */
export const ROUTE_DEFAULTS = { routeColor: '#e64d1a', routeWidth: 3, routeDashed: true };

/** The look a route is drawn with: its own keys where they are valid, the defaults elsewhere */
export function routeLook(feature: Feature): typeof ROUTE_DEFAULTS {
  const { routeColor, routeWidth, routeDashed } = feature.style ?? {};
  return {
    routeColor: typeof routeColor === 'string' ? routeColor : ROUTE_DEFAULTS.routeColor,
    routeWidth:
      typeof routeWidth === 'number' && routeWidth > 0 ? routeWidth : ROUTE_DEFAULTS.routeWidth,
    routeDashed: typeof routeDashed === 'boolean' ? routeDashed : ROUTE_DEFAULTS.routeDashed,
  };
}

// Drawn in the feature's place in the layer order. The shared renderers are ready for the frame
// (shader and projection), so the renderer creates no GL object of its own
const routeRenderer: FeatureRenderer = {
  onAdd() {},
  draw(feature, ctx) {
    const look = routeLook(feature);
    ctx.line.draw(verticesOf(feature), {
      width: look.routeWidth,
      color: look.routeColor,
      opacity: ctx.opacity,
      lineStyle: look.routeDashed ? 'dashed' : 'solid',
    });
  },
  onRemove() {},
};

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
  renderer: routeRenderer,
  // A click within the click tolerance of the line, or within its half width, hits it
  hitTest(feature, ctx) {
    const points = verticesOf(feature).map((v) => ctx.screen.project(v));
    let best = Number.POSITIVE_INFINITY;
    for (let i = 1; i < points.length; i++) {
      best = Math.min(best, segmentDistance(ctx.point, points[i - 1], points[i]));
    }
    const reach = Math.max(ctx.tolerancePx, routeLook(feature).routeWidth / 2);
    return best <= reach
      ? { kind: 'feature', id: feature.id, featureId: feature.id, distancePx: best }
      : null;
  },
  // A selection box takes a route when one of its vertices is inside
  boxSelect(feature, box, ctx) {
    return verticesOf(feature).some((v) => {
      const [x, y] = ctx.screen.project(v);
      return x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1];
    });
  },
  // The frame of the selection
  bounds(feature, ctx) {
    const points = verticesOf(feature).map((v) => ctx.project(v));
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return {
      min: [Math.min(...xs), Math.min(...ys)],
      max: [Math.max(...xs), Math.max(...ys)],
    };
  },
  // A handle on each vertex, which moves that vertex
  handles(feature) {
    return verticesOf(feature).map((position, index) => ({
      id: String(index),
      position,
      kind: 'vertex',
      cursor: 'move',
    }));
  },
  onHandleDrag(feature, handle, event) {
    const coordinates = [...verticesOf(feature)];
    coordinates[Number(handle.id)] = event.lngLat;
    return { geometry: { type: 'LineString', coordinates } };
  },
};
