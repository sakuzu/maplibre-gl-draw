// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The feature type "Board" of the custom-feature-types example: a board laid flat on the map
// around a point. Its size is given in pixels at the zoom it was made at, so it grows and shrinks
// with the map like a drawn shape. The library draws and hits its selection box, and turns and
// scales it with the handles of the box (the fields of transformFields); a handle in the middle
// of its east edge changes its width alone. Its fill takes the color of the rule of its layer.

import type {
  Feature,
  FeatureTypeDefinition,
  Footprint,
  GroundFootprint,
  Position,
} from '@sakuzu/maplibre-gl-draw';
import { metersToDegrees, pixelsToMeters } from '@sakuzu/maplibre-gl-draw/geometry';
import type { Point } from 'geojson';

/** The keys of `properties` a board keeps its size, its rotation and its scale under */
const WIDTH_KEY = 'boardWidth';
const HEIGHT_KEY = 'boardHeight';
const ANGLE_KEY = 'boardAngle';
const SCALE_KEY = 'boardScale';

/** The size of a board without one of its own, in pixels at the zoom it was made at */
const DEFAULT_WIDTH_PX = 120;
const DEFAULT_HEIGHT_PX = 80;
/** The narrowest a drag of the east edge makes a board, in pixels at that zoom */
const MIN_WIDTH_PX = 40;
/** The zoom a board without one is taken as made at */
const DEFAULT_ZOOM = 14;

/** A number of the properties of a board, or the default when it is not a finite number */
function numberOf(feature: Feature, key: string, fallback: number): number {
  const value = feature.properties[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The position of a board */
function centerOf(feature: Feature): Position {
  return (feature.geometry as Point).coordinates;
}

/** The zoom a board was made at, which its sizes in pixels are given at */
function zoomOf(feature: Feature): number {
  return numberOf(feature, 'maplibre-gl-draw:createdZoom', DEFAULT_ZOOM);
}

/**
 * Lays an offset in meters east and north of a position on the map, turned by an angle in
 * degrees counterclockwise
 */
function offsetOf(center: Position, east: number, north: number, angle: number): Position {
  const radians = (angle * Math.PI) / 180;
  const x = east * Math.cos(radians) - north * Math.sin(radians);
  const y = east * Math.sin(radians) + north * Math.cos(radians);
  const perMeter = metersToDegrees(1, center[1]);
  return [center[0] + x * perMeter.lng, center[1] + y * perMeter.lat];
}

/**
 * What a board covers: its four corners laid on the map. Its width and height are pixels at the
 * zoom it was made at, times its scale, which `pixelsToMeters` turns into meters on the ground
 * by the formula the library draws such sizes by, and `metersToDegrees` lays at its latitude
 */
export function boardFootprint(feature: Feature): GroundFootprint {
  const center = centerOf(feature);
  const scale = numberOf(feature, SCALE_KEY, 1);
  const angle = numberOf(feature, ANGLE_KEY, 0);
  const zoom = zoomOf(feature);
  const halfWidth =
    pixelsToMeters(numberOf(feature, WIDTH_KEY, DEFAULT_WIDTH_PX) * scale, zoom, center[1]) / 2;
  const halfHeight =
    pixelsToMeters(numberOf(feature, HEIGHT_KEY, DEFAULT_HEIGHT_PX) * scale, zoom, center[1]) / 2;
  return {
    kind: 'ground',
    corners: {
      topLeft: offsetOf(center, -halfWidth, halfHeight, angle),
      topRight: offsetOf(center, halfWidth, halfHeight, angle),
      bottomRight: offsetOf(center, halfWidth, -halfHeight, angle),
      bottomLeft: offsetOf(center, -halfWidth, -halfHeight, angle),
    },
  };
}

/** The middle of the east edge of a box laid on the map (the selection box of a board) */
export function eastMiddleOf(box: Footprint): Position {
  if (box.kind === 'screen') return box.position;
  const { topRight, bottomRight } = box.corners;
  return [(topRight[0] + bottomRight[0]) / 2, (topRight[1] + bottomRight[1]) / 2];
}

/**
 * The width of a board, in pixels at the zoom it was made at and before its scale, that puts its
 * east edge at the pointer: twice the distance from its center to the pointer along its turned
 * width
 */
export function widthFromCenter(feature: Feature, pointer: Position): number {
  const center = centerOf(feature);
  const perMeter = metersToDegrees(1, center[1]);
  const east = (pointer[0] - center[0]) / perMeter.lng;
  const north = (pointer[1] - center[1]) / perMeter.lat;
  const radians = (numberOf(feature, ANGLE_KEY, 0) * Math.PI) / 180;
  const along = east * Math.cos(radians) + north * Math.sin(radians);
  const metersPerPixel = pixelsToMeters(1, zoomOf(feature), center[1]);
  const width = (2 * Math.abs(along)) / (metersPerPixel * numberOf(feature, SCALE_KEY, 1));
  return Math.max(MIN_WIDTH_PX, width);
}

/** The board type */
export const boardType: FeatureTypeDefinition = {
  type: 'Board',
  geometry: 'Point',
  // The look of a board without a style of its own: a pale yellow fill with a darker edge
  defaultStyle: {
    fillColor: '#fff3a8',
    fillOpacity: 1,
    strokeColor: '#b8962e',
    strokeWidth: 1,
    strokeOpacity: 1,
  },
  // The rule of the layer colors the fill (fillColor), though the geometry is a Point, whose
  // channel would be the marker (pointColor)
  styleRuleChannel: 'fill',
  // The renderer draws the look the library puts together (the fill colored by the rule, the
  // style of the board over it) at the corners of the footprint
  renderer: {
    onAdd() {},
    draw(feature, ctx) {
      const look = ctx.appliedStyle(feature);
      const { topLeft, topRight, bottomRight, bottomLeft } = boardFootprint(feature).corners;
      const ring = [topLeft, topRight, bottomRight, bottomLeft, topLeft];
      ctx.fill.draw([ring], { color: look.fillColor, opacity: look.fillOpacity * ctx.opacity });
      ctx.line.draw(
        ring,
        {
          width: look.strokeWidth,
          color: look.strokeColor,
          opacity: look.strokeOpacity * ctx.opacity,
          lineStyle: look.lineStyle,
        },
        { closed: true, referenceZoom: zoomOf(feature) },
      );
    },
    onRemove() {},
  },
  // A click inside the board selects it
  hitTest(feature, ctx) {
    const { topLeft, topRight, bottomRight, bottomLeft } = boardFootprint(feature).corners;
    const corners = [topLeft, topRight, bottomRight, bottomLeft].map((c) => ctx.screen.project(c));
    return insidePolygon(ctx.point, corners) ? { distancePx: 0 } : null;
  },
  footprint: (feature) => boardFootprint(feature),
  // The resize and rotate handles of the selection box turn the board and scale it, keeping its
  // shape: they write these keys, which the footprint reads
  transformFields: { angleDegreesKey: ANGLE_KEY, scaleKey: SCALE_KEY, uniformScale: true },
  // A handle in the middle of the east edge of the selection box, drawn as a resize handle, which
  // changes the width alone
  handles(_feature, ctx) {
    if (!ctx.selectionBox) return [];
    return [
      { kind: 'resize', id: 'east', position: eastMiddleOf(ctx.selectionBox), cursor: 'ew-resize' },
    ];
  },
  onHandleDrag(feature, _handle, event) {
    return { properties: { [WIDTH_KEY]: widthFromCenter(feature, event.lngLat) } };
  },
};

/** Whether a point on the screen is inside a polygon of points on the screen */
function insidePolygon(point: [number, number], polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}
