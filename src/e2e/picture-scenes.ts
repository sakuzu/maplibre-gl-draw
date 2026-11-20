// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scenes of the pictures of what is drawn (`pictures.e2e.test.ts`)
 *
 * A scene is one value of each of three axes, and the scenes are every combination of them:
 *
 * - the map: flat, pitched, on a terrain, on the globe
 * - the kind of feature: the four shapes of a point, the three dash patterns of a line, an area
 *   (its fill and its outline), an image, the built-in Circle and Freehand, and a feature of a
 *   custom type drawn by its own renderer
 * - the state: nothing done, selected, hidden by this client, locked, locked and selected, in a
 *   layer whose opacity is below 1, colored by the style rule of the layer, and in a layer that
 *   stacks points, lines and areas in turn
 *
 * Every scene writes one document: two features of its kind (`a` on the left, `b` on the right),
 * in one layer, at places and with a camera fixed for each map. The state changes `a` only, so
 * that `b` shows the feature as it is next to it. The scenes are made here as plain values (the
 * document and the calls of the public API to make after it is loaded), so that the page is given
 * them as they are.
 */

import { crc32 } from 'node:zlib';
import type { DrawDocument, Feature, FeatureStyle, StyleRule } from '../index.js';
import type { Camera } from './harness.js';

/** The maps */
export const MAPS = ['flat', 'pitched', 'terrain', 'globe'] as const;
/** The kinds of feature */
export const KINDS = [
  'point-circle',
  'point-square',
  'point-triangle',
  'point-star',
  'line-solid',
  'line-dashed',
  'line-dotted',
  'area',
  'image',
  'circle',
  'freehand',
  'custom-type',
] as const;
/** The states */
export const STATES = [
  'plain',
  'selected',
  'hidden-here',
  'locked',
  'locked-selected',
  'layer-opacity',
  'style-rule',
  'interleaved',
] as const;

export type MapName = (typeof MAPS)[number];
export type KindName = (typeof KINDS)[number];
export type StateName = (typeof STATES)[number];

/** A call of the public API the page makes: the path of the method and its arguments */
export type Call = readonly [string, ...unknown[]];

/** A scene: its name, its three values, the document it writes and the calls after it */
export interface PictureScene {
  /** `<map>/<kind>/<state>` */
  readonly name: string;
  readonly map: MapName;
  readonly kind: KindName;
  readonly state: StateName;
  readonly document: DrawDocument;
  readonly calls: readonly Call[];
}

/** How a map is set up: its camera, and the size of the unit the places are given in */
export interface MapSetup {
  readonly camera: Camera;
  /** Whether the map has the test terrain */
  readonly terrain: boolean;
  /** Whether the map is drawn as a globe */
  readonly globe: boolean;
}

export const MAP_SETUPS: Readonly<Record<MapName, MapSetup>> = {
  flat: { camera: { center: [139.7, 35.68], zoom: 14 }, terrain: false, globe: false },
  pitched: {
    camera: { center: [139.7, 35.68], zoom: 14, pitch: 55, bearing: 30 },
    terrain: false,
    globe: false,
  },
  // Beside the peak of the test terrain, on its slope
  terrain: {
    camera: { center: [138.738, 35.355], zoom: 13, pitch: 50, bearing: 20 },
    terrain: true,
    globe: false,
  },
  globe: { camera: { center: [0, 20], zoom: 1.5 }, terrain: false, globe: true },
};

/** The exaggeration of the test terrain */
export const TERRAIN_EXAGGERATION = 1.5;

/** The name of the custom type the scenes draw (the page registers it) */
export const CUSTOM_TYPE = 'PictureMark';

/** The ID of the layer of the scenes */
const LAYER = 'pictures';

/** The ID of the file of the image */
const IMAGE_FILE = 'picture-file';

/** The size of the unit of the places, in CSS pixels of the map at the zoom of its camera */
const UNIT_PX = 28;

/** The degrees of longitude a unit spans at the zoom of the camera */
function unitOf(camera: Camera): number {
  return (UNIT_PX * 360) / (512 * 2 ** camera.zoom);
}

/** The places of a map: a position `dx`, `dy` units from the center of the camera */
function placesOf(map: MapName): (dx: number, dy: number) => [number, number] {
  const { center } = MAP_SETUPS[map].camera;
  const unit = unitOf(MAP_SETUPS[map].camera);
  return (dx, dy) => [center[0] + dx * unit, center[1] + dy * unit];
}

/** The meters a unit spans at the center of the camera of a map */
function unitMeters(map: MapName): number {
  const { camera } = MAP_SETUPS[map];
  return unitOf(camera) * 111_320 * Math.cos((camera.center[1] * Math.PI) / 180);
}

/** The colors of the two features of a scene, by their side */
const COLORS = { a: '#d1495b', b: '#2e86ab' } as const;

/** The colors the style rule gives the two sides */
const RULE: StyleRule = {
  kind: 'categorical',
  property: 'side',
  map: { a: '#7b2cbf', b: '#f4a259' },
  other: '#888888',
};

/** The keys of a style that hold a color */
const COLOR_KEYS = ['fillColor', 'strokeColor', 'pointColor'] as const;

type Side = keyof typeof COLORS;

/** A feature of the document, with the values a scene does not change */
function feature(
  map: MapName,
  id: string,
  type: string,
  geometry: Feature['geometry'],
  style: FeatureStyle,
  properties: Record<string, unknown> = {},
): Feature {
  return {
    id,
    type,
    geometry,
    layerId: LAYER,
    groupId: undefined,
    visible: true,
    locked: false,
    properties: {
      'maplibre-gl-draw:createdZoom': MAP_SETUPS[map].camera.zoom,
      ...properties,
    },
    style,
  };
}

/** A feature of a kind, on one side of the center of the camera */
function featureOfKind(map: MapName, kind: KindName, side: Side): Feature {
  const at = placesOf(map);
  const x = side === 'a' ? -3 : 3;
  const color = COLORS[side];
  const properties = { side };
  if (kind.startsWith('point-')) {
    const shape = kind.slice('point-'.length) as NonNullable<FeatureStyle['pointShape']>;
    return feature(
      map,
      side,
      'Point',
      { type: 'Point', coordinates: at(x, 0) },
      { pointColor: color, pointRadius: 12, pointShape: shape, pointStrokeWidth: 2 },
      properties,
    );
  }
  if (kind.startsWith('line-')) {
    const lineStyle = kind.slice('line-'.length) as NonNullable<FeatureStyle['lineStyle']>;
    return feature(
      map,
      side,
      'LineString',
      {
        type: 'LineString',
        coordinates: [at(x - 2, -1.5), at(x - 0.7, 1.5), at(x + 0.7, -1.5), at(x + 2, 1.5)],
      },
      { strokeColor: color, strokeWidth: 4, lineStyle },
      properties,
    );
  }
  switch (kind) {
    case 'area':
      return feature(
        map,
        side,
        'Polygon',
        {
          type: 'Polygon',
          coordinates: [
            [at(x - 2, -2), at(x + 2, -2), at(x + 2, 2), at(x, 0.8), at(x - 2, 2), at(x - 2, -2)],
          ],
        },
        { fillColor: color, fillOpacity: 0.6, strokeColor: '#1b1b3a', strokeWidth: 3 },
        properties,
      );
    case 'image':
      return feature(
        map,
        side,
        'Image',
        { type: 'Point', coordinates: at(x, 0) },
        { imageOpacity: 1 },
        {
          ...properties,
          'maplibre-gl-draw:imageFileId': IMAGE_FILE,
          'maplibre-gl-draw:imageWidth': 4 * UNIT_PX,
          'maplibre-gl-draw:imageHeight': 3 * UNIT_PX,
        },
      );
    case 'circle':
      return feature(
        map,
        side,
        'Circle',
        { type: 'Point', coordinates: at(x, 0) },
        { fillColor: color, fillOpacity: 0.5, strokeColor: '#1b1b3a', strokeWidth: 2 },
        { ...properties, 'maplibre-gl-draw:radiusMeters': 2 * unitMeters(map) },
      );
    case 'freehand': {
      const coordinates: [number, number][] = [];
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        coordinates.push(at(x - 2 + 4 * t, 1.5 * Math.sin(t * 2 * Math.PI)));
      }
      return feature(
        map,
        side,
        'Freehand',
        { type: 'LineString', coordinates },
        { strokeColor: color, strokeWidth: 5 },
        properties,
      );
    }
    case 'custom-type':
      return feature(
        map,
        side,
        CUSTOM_TYPE,
        {
          type: 'Polygon',
          coordinates: [[at(x - 2, -2), at(x + 2, -2), at(x, 2), at(x - 2, -2)]],
        },
        { fillColor: color },
        properties,
      );
    default:
      throw new Error(`no feature for the kind ${kind}`);
  }
}

/**
 * The features a layer that stacks the kinds in turn holds besides `a` and `b`, from the back:
 * an area under `a`, a line and a point over it, and an area over `b`
 */
function interleavedFeatures(map: MapName): Feature[] {
  const at = placesOf(map);
  return [
    feature(
      map,
      'under-area',
      'Polygon',
      {
        type: 'Polygon',
        coordinates: [[at(-5, -1), at(-1, -1), at(-1, 3), at(-5, 3), at(-5, -1)]],
      },
      { fillColor: '#3a7d44', fillOpacity: 0.8, strokeColor: '#203a24', strokeWidth: 2 },
    ),
    feature(
      map,
      'over-line',
      'LineString',
      { type: 'LineString', coordinates: [at(-6, -0.5), at(6, 0.5)] },
      { strokeColor: '#ffbf00', strokeWidth: 6 },
    ),
    feature(
      map,
      'over-point',
      'Point',
      { type: 'Point', coordinates: at(-3, -1) },
      { pointColor: '#111111', pointRadius: 9, pointShape: 'square' },
    ),
    feature(
      map,
      'over-area',
      'Polygon',
      {
        type: 'Polygon',
        coordinates: [[at(2, -3), at(6, -3), at(6, 0.5), at(2, 0.5), at(2, -3)]],
      },
      { fillColor: '#5c4d7d', fillOpacity: 0.7, strokeColor: '#2b2140', strokeWidth: 2 },
    ),
  ];
}

/** A style without the keys that hold a color, so that the style rule gives them */
function withoutColors(style: FeatureStyle): FeatureStyle {
  const out: FeatureStyle = { ...style };
  for (const key of COLOR_KEYS) delete out[key];
  return out;
}

/** The document and the calls of a scene */
function sceneOf(map: MapName, kind: KindName, state: StateName): PictureScene {
  let a = featureOfKind(map, kind, 'a');
  let b = featureOfKind(map, kind, 'b');
  const calls: Call[] = [];
  let opacity = 1;
  let styleRule: StyleRule | undefined;
  let features = [a, b];
  let items = ['a', 'b'];
  switch (state) {
    case 'plain':
      break;
    case 'selected':
      calls.push(['selection.set', 'feature', ['a']]);
      break;
    case 'hidden-here':
      calls.push(['hidden.add', 'a']);
      break;
    case 'locked':
      a = { ...a, locked: true };
      features = [a, b];
      break;
    case 'locked-selected':
      a = { ...a, locked: true };
      features = [a, b];
      calls.push(['selection.set', 'feature', ['a']]);
      break;
    case 'layer-opacity':
      opacity = 0.4;
      break;
    case 'style-rule':
      styleRule = RULE;
      a = { ...a, style: withoutColors(a.style) };
      b = { ...b, style: withoutColors(b.style) };
      features = [a, b];
      break;
    case 'interleaved': {
      const [underArea, overLine, overPoint, overArea] = interleavedFeatures(map);
      features = [underArea, a, overLine, overPoint, b, overArea];
      items = features.map((f) => f.id);
      break;
    }
  }
  const document: DrawDocument = {
    version: '3.0.0',
    metadata: { title: 'pictures' },
    layerOrder: [LAYER],
    layers: [
      {
        id: LAYER,
        name: 'Pictures',
        visible: true,
        locked: false,
        opacity,
        styleRule,
        metadata: undefined,
        items,
      },
    ],
    features,
    files: kind === 'image' ? { [IMAGE_FILE]: imageFile() } : undefined,
  };
  return { name: `${map}/${kind}/${state}`, map, kind, state, document, calls };
}

// ============================================================================
// The file of the image: a PNG made here, without a dependency
// ============================================================================

/** The side of a square of the pattern of the image, in pixels of the file */
const IMAGE_CELL = 8;
const IMAGE_WIDTH = 48;
const IMAGE_HEIGHT = 32;
/** The colors of the squares of the pattern (RGBA) */
const IMAGE_COLORS = [
  [255, 0, 255, 255],
  [0, 200, 120, 255],
  [250, 220, 40, 255],
  [30, 30, 160, 200],
] as const;

/** A chunk of a PNG: its length, its type, its data and its CRC */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * The data of a zlib stream that holds `data` in stored blocks, without compression (the image
 * is small, and its bytes need no more)
 */
function storedZlib(data: Buffer): Buffer {
  const blocks: Buffer[] = [Buffer.from([0x78, 0x01])];
  const BLOCK = 0xffff;
  for (let at = 0; at < data.length; at += BLOCK) {
    const part = data.subarray(at, at + BLOCK);
    const head = Buffer.alloc(5);
    head[0] = at + BLOCK >= data.length ? 1 : 0; // the last block
    head.writeUInt16LE(part.length, 1);
    head.writeUInt16LE(~part.length & 0xffff, 3);
    blocks.push(head, part);
  }
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0);
  blocks.push(adler);
  return Buffer.concat(blocks);
}

/** A PNG of RGBA pixels, 8 bits a channel, without filtering */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0; // no filter
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      rows,
      y * (width * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', storedZlib(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

let imageDataUrl: string | undefined;

/** The file of the image of the scenes: squares of four colors, one of them half transparent */
function imageFile(): { id: string; mimeType: string; dataURL: string } {
  if (imageDataUrl === undefined) {
    const rgba = new Uint8Array(IMAGE_WIDTH * IMAGE_HEIGHT * 4);
    for (let y = 0; y < IMAGE_HEIGHT; y++) {
      for (let x = 0; x < IMAGE_WIDTH; x++) {
        const color =
          IMAGE_COLORS[(Math.floor(x / IMAGE_CELL) + 2 * Math.floor(y / IMAGE_CELL)) % 4];
        rgba.set(color, (y * IMAGE_WIDTH + x) * 4);
      }
    }
    const png = encodePng(IMAGE_WIDTH, IMAGE_HEIGHT, rgba);
    imageDataUrl = `data:image/png;base64,${png.toString('base64')}`;
  }
  return { id: IMAGE_FILE, mimeType: 'image/png', dataURL: imageDataUrl };
}

// ============================================================================
// The scenes
// ============================================================================

/** Every scene: every map, every kind and every state */
export const SCENES: readonly PictureScene[] = MAPS.flatMap((map) =>
  KINDS.flatMap((kind) => STATES.map((state) => sceneOf(map, kind, state))),
);

/**
 * A document with one image at the center of the camera of a map, which the page loads once
 * before the scenes, so that every scene finds the image decoded
 */
export function imageWarmUp(map: MapName): { document: DrawDocument; at: [number, number] } {
  const at = placesOf(map)(0, 0);
  const image = {
    ...featureOfKind(map, 'image', 'a'),
    id: 'warm-up',
    geometry: { type: 'Point' as const, coordinates: at },
  };
  return {
    document: {
      version: '3.0.0',
      layerOrder: [LAYER],
      layers: [
        {
          id: LAYER,
          name: 'Pictures',
          visible: true,
          locked: false,
          opacity: 1,
          styleRule: undefined,
          metadata: undefined,
          items: [image.id],
        },
      ],
      features: [image],
      files: { [IMAGE_FILE]: imageFile() },
    },
    at,
  };
}
