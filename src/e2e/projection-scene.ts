// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scene of the end-to-end tests of where things are drawn against where maplibre projects
 * them (`map.project`)
 *
 * One instance over a Store of a kind is made for the views of a test. A view (a projection, a
 * zoom, a latitude) puts on it a small square fill, a short line, a point marker, an image and a
 * larger square around the center whose vertex handles are drawn while it is selected, each of
 * its own color and apart from the others. The frame is read once everything is built and each
 * thing is found by its color near where maplibre puts it: the center of its pixels weighted by
 * their coverage (alpha) is held to the center of the shape maplibre projects (the area centroid
 * of the projected corners of the fill and the image, the middle of the projected ends of the
 * line, the projected position of a point and of a vertex). Then the four small things are
 * selected together, with two points far out that keep the frame of the whole selection away
 * from them, and their frames are held the same way to the center of the projected corners of
 * their boxes (on a Store of rows that holds one feature open, the frames of the rows selected in
 * bulk, drawn on the GPU).
 *
 * The sizes follow the view: on the globe at a low zoom everything is kept on the sphere.
 */

import type { Page } from 'playwright-core';
import { degreesPerPixelAtZoom } from '../shared/math/index.js';
import { computeQuadVertices } from '../view/shaders/quad.js';
import {
  type FeatureInput,
  hex,
  load,
  pointLook,
  type Rgb,
  type StoreKind,
  select,
} from './drag-scene.js';
import { settle } from './harness.js';

/** The projection of a view */
export type ViewProjection = 'mercator' | 'globe' | 'transition';

/** A view of the scene */
export interface ProjectionView {
  projection: ViewProjection;
  zoom: number;
  latitude: number;
}

/** How far a thing is drawn from where maplibre projects it */
export interface Miss {
  what: string;
  /** The distance in CSS px (Infinity when nothing of its color is drawn near it) */
  px: number;
}

/** The latitudes of the views */
export const VIEW_LATITUDES = [0, 15, 35.68, 60] as const;

/** The zooms of the views */
export const VIEW_ZOOMS = [0, 4, 8, 10, 11, 11.99, 12, 14, 18, 22, 24] as const;

const FILL: Rgb = [0xc2, 0x92, 0x10];
const LINE: Rgb = [0x10, 0x90, 0xc0];
const MARKER: Rgb = [0xe0, 0x30, 0x00];
const IMAGE: Rgb = [0x90, 0x10, 0xe0];
const VERTEX: Rgb = [0x00, 0x30, 0xd0];
const FRAME: Rgb = [0xff, 0x00, 0xb0];
/** The rotation of the image (degrees) */
const IMAGE_ROTATION = 27;
const IDS = ['fill', 'line', 'point', 'image', 'held', 'far-1', 'far-2'];

/** A center of pixels of a color looked for, and the positions it is held to */
interface Look {
  what: string;
  color: Rgb;
  /** The positions whose projection gives the reference (one, two ends, or the corners) */
  positions: Array<[number, number]>;
  /** How the reference is made from their projections */
  reference: 'point' | 'middle' | 'area' | 'box';
  /** The radius in CSS px of the circle around the reference where the pixels are taken */
  radius: number;
}

/**
 * Makes the instance of the views over a Store of a kind (on a Store of rows, one feature is held
 * open, so that features selected together are selected in bulk)
 */
export async function openProjectionScene(page: Page, kind: StoreKind): Promise<void> {
  await load(
    page,
    {
      kind,
      features: [],
      images: { color: hex(IMAGE) },
      rowsOptions: { holdLimit: 1 },
    },
    10,
  );
}

/**
 * Puts the projection, the zoom and the latitude of a view on the map, and returns the center it
 * takes (Web Mercator at a low zoom holds the center away from the poles)
 */
async function putView(page: Page, view: ProjectionView): Promise<[number, number]> {
  return page.evaluate((v) => {
    const { map, draw } = window as unknown as {
      map: import('maplibre-gl').Map;
      draw: import('../index.js').Draw;
    };
    const type =
      v.projection === 'mercator'
        ? 'mercator'
        : v.projection === 'globe'
          ? 'vertical-perspective'
          : 'globe';
    draw.selection.clear();
    // A change of the projection compiles the programs again: only when it changes
    if (map.getProjection()?.type !== type) map.setProjection({ type } as never);
    map.jumpTo({ center: [139.7, v.latitude], zoom: v.zoom, pitch: 0, bearing: 0 });
    const c = map.getCenter();
    return [c.lng, c.lat] as [number, number];
  }, view);
}

/** The spacing of the things of a view and their size, in CSS px */
function sizesOf(view: ProjectionView): { spacing: number; size: number } {
  // On the globe the sphere is at least worldSize / 2π px in radius (more away from the equator);
  // on Web Mercator everything stays within the latitudes of the world at the lowest zooms. The
  // sizes do not depend on the latitude, so that the style of the selection changes seldom
  const worldSize = 512 * 2 ** view.zoom;
  const reach =
    view.projection === 'mercator' ? worldSize * 0.08 : (worldSize / (2 * Math.PI)) * 0.4;
  const spacing = Math.min(80, reach);
  return { spacing, size: spacing / 6 };
}

/** The scene of a view: the features, the selection style and what is looked for */
function sceneOf(
  view: ProjectionView,
  center: [number, number],
): { features: FeatureInput[]; selectionStyle: unknown; looks: Look[]; frames: Look[] } {
  const { spacing: s, size } = sizesOf(view);
  const [lngPerPx, latPerPx] = degreesPerPixelAtZoom(center[1], view.zoom);
  /** A position at an offset from the center in CSS px (x east, y north) */
  const at = (x: number, y: number): [number, number] => [
    center[0] + x * lngPerPx,
    center[1] + y * latPerPx,
  ];
  const square = (x: number, y: number, r: number): Array<[number, number]> => [
    at(x - r, y - r),
    at(x + r, y - r),
    at(x + r, y + r),
    at(x - r, y + r),
  ];
  // A fill of twelve sides and an image turned, whose slanted edges keep the pixels they cover
  // centered on them
  const fill = Array.from({ length: 12 }, (_, i) => {
    const a = (i * Math.PI) / 6 + 0.2;
    return at(-s + Math.cos(a) * size, s * 0.7 + Math.sin(a) * size);
  });
  const line: Array<[number, number]> = [at(s - size * 1.2, s * 0.7), at(s + size * 1.2, s * 0.7)];
  const point = at(-s, -s * 0.7);
  const imageCenter = at(s, -s * 0.7);
  const imagePx = Math.max(2, Math.round(size * 1.6));
  // The corners of the image as the renderer makes them
  const [lngPerPxImage, latPerPxImage] = degreesPerPixelAtZoom(imageCenter[1], view.zoom);
  const quad = computeQuadVertices(
    imageCenter[0],
    imageCenter[1],
    imagePx * lngPerPxImage,
    imagePx * latPerPxImage,
    (IMAGE_ROTATION * Math.PI) / 180,
  );
  const imageCorners = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft].map(
    (c) => [c[0], c[1]] as [number, number],
  );
  const held = square(0, 0, s * 0.45);
  const handle = Math.max(3, size);
  const margin = Math.max(2, size * 0.8);
  const features: FeatureInput[] = [
    {
      id: 'fill',
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [[...fill, fill[0]]] },
      style: { fillColor: hex(FILL), fillOpacity: 1, strokeWidth: 0 },
    },
    {
      id: 'line',
      type: 'LineString',
      geometry: { type: 'LineString', coordinates: line },
      style: { strokeColor: hex(LINE), strokeWidth: Math.max(2, size * 0.6), strokeOpacity: 1 },
    },
    {
      id: 'point',
      type: 'Point',
      geometry: { type: 'Point', coordinates: point },
      style: {
        pointShape: 'circle',
        pointRadius: Math.max(2, size * 0.6),
        pointColor: hex(MARKER),
        pointStrokeWidth: 0,
      },
    },
    {
      id: 'image',
      type: 'Image',
      geometry: { type: 'Point', coordinates: imageCenter },
      properties: {
        'maplibre-gl-draw:createdZoom': view.zoom,
        'maplibre-gl-draw:imageFileId': 'color',
        'maplibre-gl-draw:imageWidth': imagePx,
        'maplibre-gl-draw:imageHeight': imagePx,
        'maplibre-gl-draw:rotation': IMAGE_ROTATION,
      },
      style: { imageOpacity: 1 },
    },
    {
      id: 'held',
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [[...held, held[0]]] },
      style: { fillColor: '#000000', fillOpacity: 0, strokeWidth: 0 },
    },
    // Far out, so that the frame of the whole selection keeps away from the frames held
    ...[at(-s * 2.2, s * 1.9), at(s * 2.2, -s * 1.9)].map(
      (coordinates, i): FeatureInput => ({
        id: `far-${i + 1}`,
        type: 'Point',
        geometry: { type: 'Point', coordinates },
        style: { pointShape: 'circle', pointRadius: 1, pointColor: '#000000', pointOpacity: 0 },
      }),
    ),
  ];
  const hidden = (shape: string) => ({ ...pointLook(shape, VERTEX, 2), fillOpacity: 0 });
  const selectionStyle = {
    boundingBox: {
      stroke: { width: 1.5, color: hex(FRAME), opacity: 1, lineStyle: 'solid' },
      margin,
    },
    resizeHandle: { point: hidden('square') },
    rotateHandle: {
      point: hidden('circle'),
      connector: { width: 1, color: hex(FRAME), opacity: 0, lineStyle: 'solid' },
    },
    vertexHandle: {
      point: pointLook('square', VERTEX, handle),
      selected: pointLook('square', VERTEX, handle),
      followed: pointLook('square', VERTEX, handle),
    },
    midpointHandle: { point: hidden('circle') },
  };
  const near = size * 1.8;
  const looks: Look[] = [
    { what: 'fill', color: FILL, positions: fill, reference: 'area', radius: near },
    { what: 'line', color: LINE, positions: line, reference: 'middle', radius: near },
    { what: 'point', color: MARKER, positions: [point], reference: 'point', radius: near },
    { what: 'image', color: IMAGE, positions: imageCorners, reference: 'area', radius: near },
    ...held.map(
      (vertex, i): Look => ({
        what: `vertex handle ${i}`,
        color: VERTEX,
        positions: [vertex],
        reference: 'point',
        radius: handle * 1.2,
      }),
    ),
  ];
  const radius = size * 1.6 + margin + 4;
  const frameOf = (what: string, positions: Array<[number, number]>): Look => ({
    what: `frame of the ${what}`,
    color: FRAME,
    positions,
    reference: positions.length === 1 ? 'point' : 'box',
    radius,
  });
  const frames = [
    frameOf('fill', fill),
    frameOf('line', line),
    frameOf('point', [point]),
    frameOf('image', imageCorners),
  ];
  return { features, selectionStyle, looks, frames };
}

/** Puts the features of a view on the instance and waits until everything is built */
async function putFeatures(
  page: Page,
  features: FeatureInput[],
  selectionStyle: unknown,
): Promise<void> {
  await page.evaluate(
    async ({ features, selectionStyle, ids }) => {
      const { map, draw } = window as unknown as {
        map: import('maplibre-gl').Map;
        draw: import('../index.js').Draw;
      };
      // A change of the style of the selection builds its programs again: only when it changes
      const w = window as unknown as { projectionSceneStyle?: string };
      const style = JSON.stringify(selectionStyle);
      if (w.projectionSceneStyle !== style) {
        draw.options.update({ selectionStyle } as never);
        w.projectionSceneStyle = style;
      }
      const present = new Set(draw.features.list(undefined, { limit: 100 }).map((f) => f.id));
      const gone = ids.filter((id) => present.has(id));
      if (gone.length > 0) draw.features.deleteMany(gone);
      if (!draw.features.createMany(features.map((f) => ({ ...f, layerId: 'L' })) as never)) {
        throw new Error('the features were not created');
      }
      const frame = (): Promise<void> =>
        new Promise((resolve) => {
          map.once('render', () => resolve());
          map.triggerRepaint();
        });
      await frame();
      for (let i = 0; i < 200 && draw.hasPendingWork(); i++) await frame();
    },
    { features, selectionStyle, ids: IDS },
  );
}

/**
 * The frame once everything is built, and for each look the distance from the center of its
 * pixels to its reference
 */
function measure(page: Page, looks: Look[]): Promise<Miss[]> {
  return page.evaluate(
    async (list) => {
      const { map, draw } = window as unknown as {
        map: import('maplibre-gl').Map;
        draw: import('../index.js').Draw;
      };
      const read = (): Promise<Uint8Array> =>
        new Promise((resolve) => {
          map.once('render', () => {
            const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
            const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
            gl.readPixels(
              0,
              0,
              gl.drawingBufferWidth,
              gl.drawingBufferHeight,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              pixels,
            );
            resolve(pixels);
          });
          map.triggerRepaint();
        });
      let pixels = await read();
      for (let i = 0; i < 100 && draw.hasPendingWork(); i++) pixels = await read();
      pixels = await read();
      const canvas = map.getCanvas();
      const width = canvas.width;
      const height = canvas.height;
      const ratio = width / canvas.clientWidth;
      const project = (p: readonly number[]): [number, number] => {
        const q = map.project(p as [number, number]);
        return [q.x, q.y];
      };
      const mean = (ps: Array<[number, number]>): [number, number] => [
        ps.reduce((a, c) => a + c[0], 0) / ps.length,
        ps.reduce((a, c) => a + c[1], 0) / ps.length,
      ];
      const referenceOf = (look: (typeof list)[number]): [number, number] => {
        const ps = look.positions.map(project);
        if (look.reference === 'point') return ps[0] as [number, number];
        if (look.reference === 'middle') return mean(ps);
        if (look.reference === 'box') {
          // The corners of the box of the positions, projected
          const lngs = look.positions.map((p) => p[0] as number);
          const lats = look.positions.map((p) => p[1] as number);
          const x0 = Math.min(...lngs);
          const x1 = Math.max(...lngs);
          const y0 = Math.min(...lats);
          const y1 = Math.max(...lats);
          return mean(
            [
              [x0, y0],
              [x1, y0],
              [x1, y1],
              [x0, y1],
            ].map(project),
          );
        }
        // The area centroid of the projected polygon
        let area = 0;
        let cx = 0;
        let cy = 0;
        for (let i = 0; i < ps.length; i++) {
          const [ax, ay] = ps[i] as [number, number];
          const [bx, by] = ps[(i + 1) % ps.length] as [number, number];
          const cross = ax * by - bx * ay;
          area += cross;
          cx += (ax + bx) * cross;
          cy += (ay + by) * cross;
        }
        return [cx / (3 * area), cy / (3 * area)];
      };
      return list.map((look) => {
        const [rx, ry] = referenceOf(look);
        const colorLength = Math.hypot(look.color[0], look.color[1], look.color[2]);
        const radius = look.radius * ratio;
        const px = rx * ratio;
        const py = ry * ratio;
        let weight = 0;
        let sx = 0;
        let sy = 0;
        const top = Math.max(0, Math.floor(py - radius));
        const bottom = Math.min(height - 1, Math.ceil(py + radius));
        const left = Math.max(0, Math.floor(px - radius));
        const right = Math.min(width - 1, Math.ceil(px + radius));
        for (let y = top; y <= bottom; y++) {
          for (let x = left; x <= right; x++) {
            const cx = x + 0.5;
            const cy = y + 0.5;
            if (Math.hypot(cx - px, cy - py) > radius) continue;
            // The frame is read from the bottom, its colors multiplied by the coverage
            const i = ((height - 1 - y) * width + x) * 4;
            const a = pixels[i + 3] as number;
            if (a < 8) continue;
            // Of the hue of the color, whether the color is multiplied by the coverage or not
            const r = pixels[i] as number;
            const g = pixels[i + 1] as number;
            const b = pixels[i + 2] as number;
            const dot = r * look.color[0] + g * look.color[1] + b * look.color[2];
            if (dot < 0.985 * Math.hypot(r, g, b) * colorLength) continue;
            weight += a;
            sx += cx * a;
            sy += cy * a;
          }
        }
        if (weight === 0) return { what: look.what, px: Number.POSITIVE_INFINITY };
        return {
          what: look.what,
          px: Math.hypot(sx / weight / ratio - rx, sy / weight / ratio - ry),
        };
      });
    },
    looks as unknown as Look[],
  );
}

/**
 * Draws the scene of a view on the instance, and returns how far each thing is drawn from where
 * maplibre projects it: the fill, the line, the point, the image and the vertex handles, then the
 * frames of the four small things selected together
 */
export async function missesOf(page: Page, view: ProjectionView): Promise<Miss[]> {
  const center = await putView(page, view);
  const { features, selectionStyle, looks, frames } = sceneOf(view, center);
  await putFeatures(page, features, selectionStyle);
  await select(page, ['held']);
  await settle(page);
  const drawn = await measure(page, looks);
  await select(page, ['fill', 'line', 'point', 'image', 'far-1', 'far-2']);
  await settle(page);
  return [...drawn, ...(await measure(page, frames))];
}

/** The largest miss of the things drawn in some views, and where */
export async function worstMiss(
  page: Page,
  views: readonly ProjectionView[],
): Promise<{ px: number; where: string }> {
  let worst = { px: 0, where: '' };
  for (const view of views) {
    for (const miss of await missesOf(page, view)) {
      if (!(miss.px <= worst.px)) {
        worst = {
          px: miss.px,
          where: `${miss.what} at zoom ${view.zoom}, latitude ${view.latitude} (${view.projection})`,
        };
      }
    }
  }
  return worst;
}
