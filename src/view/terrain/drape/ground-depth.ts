// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ground seen at each pixel, read back from the depth of the terrain MapLibre draws
 *
 * On a map with terrain, MapLibre draws the depth of its terrain mesh into a texture once a
 * frame the camera or the tiles changed in, before the layers are drawn (`getTerrainDepth` in
 * `detect.ts`): one texel a CSS pixel, the depth of the clip space packed into its four bytes,
 * white where no terrain is drawn. The polygons and the lines drawn in the order of their rows
 * read the ground of each pixel they may cover from it: the depth at the pixel, interpolated
 * from the texels around it, is taken back through the inverse of the projection to the
 * position on the ground, as a Mercator offset from the center of the view. A pixel then tells,
 * as the drape does, whether it is in a polygon or how far it is from a line. Their draws are
 * those of the rows, so whatever is drawn between them (points, pictures) keeps its place in the
 * order in every pixel, and nothing of the size of the screen is held for it.
 *
 * - The depth is packed by MapLibre as the digits of base 256 of the depth, the most significant
 *   in alpha, each digit d written as the byte nearest to 255 d / 256. A byte s is the digit s
 *   below 128 and s + 1 above it; 128 is either 128 or 129. For the second digit (the one that
 *   moves the ground by up to a pixel), the two are taken back to the ground, and the one whose
 *   place is on the ground of the DEM atlas is taken (the other is a step of the digit away from
 *   it along the ray); where neither is (out of the atlas), it is read halfway, and the depth the
 *   polygons and the lines take is half a step nearer, so the terrain the map drew there never
 *   hides them. The other digits are read halfway (the first is 128 only by the camera, the third
 *   moves the ground by little). A byte of 255 in alpha is never written for a depth below 1: it
 *   is the white of no terrain. The depth is held as its distance from 1, exact in a 32-bit float.
 * - A pixel of the screen is a part of a texel (the texels are CSS pixels). The depth there is
 *   interpolated between the four texels around it, bilinear where they are on one surface (the
 *   depth of a plane is affine on the screen, so this is exact on a plane). Where they are not
 *   (the edge of a ridge in front of the ground behind it, a step of the depth of more than
 *   `GROUND_DEPTH_JUMP` of the distance from the camera), the depth of the nearest of them to the
 *   camera is taken, with the steps to the texels next to it on the same surface (along an axis
 *   where none of the four is, to the texel on its other side). A pixel whose nearest texel on
 *   the screen is white has no ground.
 * - The depth is taken back to the ground through the projection the terrain is drawn with
 *   (maplibre's `projectTileFor3D`), relative to the center of the view (`groundProjectionOf`,
 *   formed on the CPU in float64, so only offsets are held in 32-bit floats): on the flat map by
 *   its inverse, on the globe alone by the inverse of its projection of the unit sphere and the
 *   offset on the sphere turned into the Mercator offset, in the transition by the projection
 *   linearized at the center, put right by the projection itself.
 * - The ground is taken lifted over the terrain as the drape lifts its ground: the place on the
 *   ray of the pixel that far over the place read back (the lift at the center, `liftMeters`,
 *   and more as the place is further from the camera). Its depth is the one the polygons and the
 *   lines take (the 3D layers of the map in front of the ground hide them as they hide the
 *   ground), and it wins against the terrain the map drew there.
 */

import { CENTER_PROJECTION_CONSTANTS, glslFloat32 } from '../../shaders/center-projection.js';

/**
 * The blocks of a tile on a side the ranges of the elevations of its ground are kept for: a
 * polygon or a line is drawn as a box on the screen that holds its ground between the lowest and
 * the highest elevation of the blocks it meets
 */
export const DRAPE_GROUND_BLOCKS = 32;

/** The coarser blocks of a tile on a side, each of 4 x 4 blocks (for a box over many blocks) */
export const DRAPE_GROUND_COARSE_BLOCKS = 8;

/** The ranges of the blocks of a tile: the blocks, then the coarser blocks */
export const DRAPE_GROUND_BLOCK_TEXELS =
  DRAPE_GROUND_BLOCKS * DRAPE_GROUND_BLOCKS +
  DRAPE_GROUND_COARSE_BLOCKS * DRAPE_GROUND_COARSE_BLOCKS;

/**
 * The slots of tiles the tables of the ground hold at most: a slot is a line of each table, and
 * WebGL2 makes a texture of 2048 lines at least (as many tiles as maplibre draws the terrain
 * with, which are far fewer)
 */
export const DRAPE_GROUND_MAX_SLOTS = 2048;

/**
 * The step of the distance from the camera between two texels of the depth next to each other
 * past which they are taken as two surfaces (a share of the nearer distance). Two texels on one
 * surface differ by a share of about 1 / (the focal length in CSS pixels x the tangent of the
 * angle the ground is seen at), under 1 % down to a ground seen at 5 degrees
 */
export const GROUND_DEPTH_JUMP = 1 / 32;

/** The digits of base 256 of a depth MapLibre packs into a texel, as bytes, the most first */
const DIGIT_WEIGHTS = [1 / 256, 1 / 65_536, 1 / 16_777_216] as const;

/**
 * The digit a byte of the depth holds (`GROUND_DEPTH_GLSL` decodes it so)
 *
 * @internal
 */
export function groundDepthDigit(byte: number): number {
  if (byte < 128) return byte;
  return byte === 128 ? 128.5 : byte + 1;
}

/**
 * The depth (z over w of the clip space) of a texel MapLibre packed, from its four bytes (null
 * for the white of no terrain): the CPU mirror of `ground_depth_at`
 *
 * @internal
 */
export function unpackGroundDepth(r: number, g: number, b: number, a: number): number | null {
  if (a > 254.5) return null;
  return (
    groundDepthDigit(a) * DIGIT_WEIGHTS[0] +
    groundDepthDigit(b) * DIGIT_WEIGHTS[1] +
    groundDepthDigit(g) * DIGIT_WEIGHTS[2] +
    (r / 255) * DIGIT_WEIGHTS[2]
  );
}

/**
 * The four bytes MapLibre packs a depth into (its `terrain_depth.fragment.glsl`, written to an
 * RGBA8 texel): for the tests of the reading
 *
 * @internal
 */
export function packGroundDepth(depth: number): [number, number, number, number] {
  const fract = (x: number): number => x - Math.floor(x);
  const x = fract(depth * 16_777_216);
  const y = fract(depth * 65_536) - x / 256;
  const z = fract(depth * 256) - fract(depth * 65_536) / 256;
  const w = fract(depth) - fract(depth * 256) / 256;
  const byte = (v: number): number => Math.round(Math.min(Math.max(v, 0), 1) * 255);
  return [byte(x), byte(y), byte(z), byte(w)];
}

/** The radius of the sphere of the globe (maplibre's, meters) */
const GLOBE_RADIUS = 6_371_008.8;

/**
 * What the ground is read back with in a frame (`groundProjectionOf`), as the uniforms of
 * `GROUND_DEPTH_GLSL` take it (matrices column-major)
 *
 * A place on the ground is its Mercator offset from the center of the view and its elevation in
 * meters, u = (dx, dy, e). The projection the depth of the terrain is drawn with (maplibre's
 * `projectTileFor3D`) takes u to the clip space: on the flat map, the matrix of the frame times
 * (dx, dy, e k, 0) plus the center (k the Mercator units of a meter); on the globe, the matrix of
 * the unit sphere times the offset of the place on the sphere, lifted by its elevation, plus the
 * center; in the transition, the two mixed by it, every component.
 *
 * The depth of the ground is near 1 (it crowds to 1 far from the camera, more so as the near
 * plane is nearer: maplibre puts it half a pixel from the camera on the globe), so it is held as
 * its distance from 1: the inverses take (x, y, z - 1, 1) for a point of the clip space over its
 * w (their last column is the sum of their last two, in float64), and the matrices of the
 * transition give (x, y, w - z, w) (their third row is the difference of their last two). No
 * difference of two numbers near 1 is then formed in a 32-bit float.
 */
export interface GroundProjection {
  /**
   * The inverse of the projection linearized at the center of the view (the projection itself on
   * the flat map): (x, y, z - 1, 1) of a point of the clip space to (u, 1) over its w
   */
  readonly unproject: Float64Array;
  /**
   * On the globe alone: the inverse of its projection of the offsets on the unit sphere from the
   * center (lifted), (x, y, z - 1, 1) to (the offset, 1) over its w (0 otherwise)
   */
  readonly globe: Float64Array;
  /**
   * In the transition: the matrices of the globe and of the flat map, and their centers, giving
   * (x, y, w - z, w)
   */
  readonly main: Float64Array;
  readonly mainCenter: Float64Array;
  readonly fallback: Float64Array;
  readonly fallbackCenter: Float64Array;
  /** The transition of the frame, as a 32-bit float (0: the flat map) */
  readonly transition: number;
  /** The lift of the ground at the center over the w of the clip space of the center (meters) */
  readonly lift: number;
}

/** The part of the projection of a frame the ground is read back with */
export interface GroundProjectionInput {
  readonly mainMatrix: ArrayLike<number>;
  readonly fallbackMatrix?: ArrayLike<number>;
  readonly projectionTransition?: number;
}

/**
 * Forms in float64 what the ground is read back with in a frame (null where the projection has
 * no inverse)
 *
 * @param centerLngLat The center the offsets are taken from (rounded to 32-bit floats)
 * @param centerMercator Its Mercator coordinates
 * @param elevationScale The Mercator units of a meter of elevation in the frame
 * @param liftMeters The lift of the ground over the terrain at the center (meters)
 */
export function groundProjectionOf(
  projection: GroundProjectionInput,
  centerLngLat: readonly [number, number],
  centerMercator: readonly [number, number],
  elevationScale: number,
  liftMeters: number,
): GroundProjection | null {
  const t = Math.fround(projection.projectionTransition ?? 0);
  const flat = !(t > 0) || !projection.fallbackMatrix;
  const plane = flat ? projection.mainMatrix : (projection.fallbackMatrix as ArrayLike<number>);
  const k = elevationScale;
  const fallbackCenter = transform(plane, centerMercator[0], centerMercator[1], 0, 1);
  const linear = new Float64Array(16);
  const main = new Float64Array(16);
  const fallback = new Float64Array(16);
  const mainCenter = new Float64Array(4);
  const globe = new Float64Array(16);
  for (let i = 0; i < 16; i++) fallback[i] = plane[i] as number;
  // The flat map: (dx, dy, e k, 0) through the matrix, plus the center
  const flatColumns = [
    [plane[0], plane[1], plane[2], plane[3]],
    [plane[4], plane[5], plane[6], plane[7]],
    [
      (plane[8] as number) * k,
      (plane[9] as number) * k,
      (plane[10] as number) * k,
      (plane[11] as number) * k,
    ],
    fallbackCenter,
  ] as number[][];
  let columns = flatColumns;
  if (!flat) {
    const m = projection.mainMatrix;
    for (let i = 0; i < 16; i++) main[i] = m[i] as number;
    const lat = (centerLngLat[1] * Math.PI) / 180;
    const lng = (centerLngLat[0] * Math.PI) / 180;
    const [sinLat, cosLat, sinLng, cosLng] = [
      Math.sin(lat),
      Math.cos(lat),
      Math.sin(lng),
      Math.cos(lng),
    ];
    const center = [sinLng * cosLat, sinLat, cosLng * cosLat];
    const at = transform(m, center[0] as number, center[1] as number, center[2] as number, 1);
    mainCenter.set(at);
    // The offsets on the unit sphere of a Mercator offset east and south, and of a meter up
    const east = [2 * Math.PI * cosLng * cosLat, 0, -2 * Math.PI * sinLng * cosLat];
    const south = [
      -2 * Math.PI * cosLat * -sinLng * sinLat,
      -2 * Math.PI * cosLat * cosLat,
      -2 * Math.PI * cosLat * -cosLng * sinLat,
    ];
    const up = center.map((v) => v / GLOBE_RADIUS);
    const globeColumns = [
      transform(m, east[0] as number, east[1] as number, east[2] as number, 0),
      transform(m, south[0] as number, south[1] as number, south[2] as number, 0),
      transform(m, up[0] as number, up[1] as number, up[2] as number, 0),
      at,
    ];
    if (t > Math.fround(GLOBE_ONLY)) {
      columns = globeColumns;
      const sphere = new Float64Array(16);
      for (let i = 0; i < 12; i++) sphere[i] = m[i] as number;
      sphere.set(at, 12);
      const inverse = invert4(sphere);
      if (!inverse) return null;
      globe.set(fromOne(inverse));
    } else {
      columns = flatColumns.map((column, c) =>
        column.map((v, i) => v * (1 - t) + ((globeColumns[c] as number[])[i] as number) * t),
      );
    }
  }
  for (let c = 0; c < 4; c++) linear.set(columns[c] as number[], c * 4);
  const centerW = linear[15] as number;
  const unproject = invert4(linear);
  if (!unproject) return null;
  return {
    unproject: fromOne(unproject),
    globe,
    main: wLessZ(main),
    mainCenter: wLessZ(mainCenter),
    fallback: wLessZ(fallback),
    fallbackCenter: wLessZ(Float64Array.from(fallbackCenter)),
    transition: flat ? 0 : t,
    lift: centerW > 0 ? liftMeters / centerW : 0,
  };
}

/**
 * An inverse that takes (x, y, z, 1), made to take (x, y, z - 1, 1): its last column the sum of
 * its last two
 */
function fromOne(m: Float64Array): Float64Array {
  for (let i = 0; i < 4; i++) m[12 + i] = (m[12 + i] as number) + (m[8 + i] as number);
  return m;
}

/** A matrix (or a vector) of the clip space, made to give w - z in place of z */
function wLessZ(m: Float64Array): Float64Array {
  for (let c = 0; c < m.length; c += 4) m[c + 2] = (m[c + 3] as number) - (m[c + 2] as number);
  return m;
}

/** Over this transition maplibre draws the globe alone */
const GLOBE_ONLY = 0.999;

/** atan(u) / u in u²: 1, -1/3, 1/5, ... (|u| < 0.4, to a 32-bit float) */
const ATAN_SERIES = (() => {
  const coefficients = Array.from({ length: 12 }, (_, k) => (k % 2 === 0 ? 1 : -1) / (2 * k + 1));
  let out = glslFloat32(coefficients[coefficients.length - 1] as number);
  for (let i = coefficients.length - 2; i >= 0; i--) {
    out = `${glslFloat32(coefficients[i] as number)} + u2 * (${out})`;
  }
  return out;
})();

/** A matrix (column-major) times a vector, in float64 */
function transform(
  m: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  w: number,
): [number, number, number, number] {
  return [
    (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number) * w,
    (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number) * w,
    (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number) * w,
    (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number) * w,
  ];
}

/** The inverse of a 4 x 4 matrix (column-major, float64; null where it has none) */
function invert4(m: Float64Array): Float64Array | null {
  const a00 = m[0] as number;
  const a01 = m[1] as number;
  const a02 = m[2] as number;
  const a03 = m[3] as number;
  const a10 = m[4] as number;
  const a11 = m[5] as number;
  const a12 = m[6] as number;
  const a13 = m[7] as number;
  const a20 = m[8] as number;
  const a21 = m[9] as number;
  const a22 = m[10] as number;
  const a23 = m[11] as number;
  const a30 = m[12] as number;
  const a31 = m[13] as number;
  const a32 = m[14] as number;
  const a33 = m[15] as number;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || det === 0) return null;
  const inv = 1 / det;
  const out = new Float64Array(16);
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * inv;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * inv;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * inv;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * inv;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * inv;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * inv;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * inv;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * inv;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * inv;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * inv;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * inv;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * inv;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * inv;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * inv;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * inv;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * inv;
  return out;
}

/**
 * The GLSL that reads the ground of a pixel of the screen back from the depth MapLibre draws (for
 * a fragment stage that declares `u_viewport`, the size of the drawing buffer, and takes
 * `DEM_SAMPLE_GLSL`, the DEM atlas, before it, and `CENTER_OFFSET_FUNCTIONS_GLSL` on the globe)
 *
 * - `u_ground_depth`: the depth of the terrain MapLibre draws (RGBA8, a texel a CSS pixel)
 * - `u_ground_unproject`, `u_ground_lift`, and on the globe `u_ground_transition`,
 *   `u_ground_globe`, `u_ground_main`, `u_ground_main_center`, `u_ground_fallback`,
 *   `u_ground_fallback_center`: `groundProjectionOf`
 *
 * `ground_at(frag, q, depth)` gives the Mercator offset from the center of the ground seen at a
 * place of the screen (device pixels, as `gl_FragCoord`), lifted, and the depth there (the z of the
 * clip space over its w, taken no further than it was drawn at), false where no ground is seen.
 *
 * A point of the clip space is taken back to its place on the ground (`ground_place`): on the
 * flat map through the inverse of the projection; on the globe alone through the inverse of the
 * projection of the unit sphere, the offset on the sphere then turned into the Mercator offset
 * and the elevation in the terms of the offsets (no difference of numbers near 1 is formed); in
 * the transition from the projection linearized at the center, put right by the projection
 * itself (`ground_forward`) three times.
 */
export const GROUND_DEPTH_GLSL = `
uniform highp sampler2D u_ground_depth;
uniform highp mat4 u_ground_unproject;
uniform float u_ground_lift;
#ifdef GLOBE
uniform float u_ground_transition;
uniform highp mat4 u_ground_globe;
uniform highp mat4 u_ground_main;
uniform vec4 u_ground_main_center;
uniform highp mat4 u_ground_fallback;
uniform vec4 u_ground_fallback_center;
#endif

// The place a point of the clip space over its w, (x, y, z - 1), stands for by the projection
// linearized at the center (the projection itself on the flat map): its Mercator offset and its
// elevation (meters)
vec3 ground_linear(vec3 p) {
    vec4 h = u_ground_unproject * vec4(p, 1.0);
    return h.xyz / h.w;
}

#ifdef GLOBE
// The angle of (x, y) from the x axis (radians), by its series near it
float ground_angle(float y, float x) {
    float u = y / x;
    if (x > 0.0 && abs(u) < 0.4) {
        float u2 = u * u;
        return u * (${ATAN_SERIES});
    }
    return atan(y, x);
}

// The place of a point of the clip space over its w, (x, y, z - 1), on the globe alone
vec3 ground_globe_alone(vec3 p) {
    vec4 h = u_ground_globe * vec4(p, 1.0);
    // The offset of the point from the center on the unit sphere (lifted by its elevation)
    vec3 d = h.xyz / h.w;
    vec4 c = u_center_sine_cosine;
    vec3 center = vec3(c.z * c.y, c.x, c.w * c.y);
    float len = length(center + d);
    // Its distance from the center of the sphere less 1
    float rise = (2.0 * dot(center, d) + dot(d, d)) / (len + 1.0);
    // East of the meridian of the center, and toward its axis less cos of its latitude
    float east = d.x * c.w - d.z * c.z;
    float along = d.x * c.z + d.z * c.w;
    float toward = c.y + along;
    float radial = sqrt(east * east + toward * toward);
    float radialStep = (east * east + along * (2.0 * c.y + along)) / (radial + c.y);
    // sin and cos of the latitude offset (times the distance from the center of the sphere), and
    // of its half
    float sinD = d.y * c.y - radialStep * c.x;
    float cosD = radial * c.y + (c.x + d.y) * c.x;
    vec2 halfLat = vec2(sinD, len + cosD) * inversesqrt(sinD * sinD + (len + cosD) * (len + cosD));
    return vec3(ground_angle(east, toward) * ${glslFloat32(1 / (2 * Math.PI))},
        mercator_offset_y(halfLat), rise * ${glslFloat32(GLOBE_RADIUS)});
}

// The clip space of a place in the transition, as maplibre's projectTileFor3D gives it, as
// (x, y, w - z, w)
vec4 ground_forward(vec3 u) {
    vec2 halfLat = half_latitude_of_mercator_offset(u.y);
    vec2 halfLng = offset_sine_cosine(wrapped_longitude_offset(u.x * 360.0)
        * ${glslFloat32(CENTER_PROJECTION_CONSTANTS.halfDegree)});
    vec3 sphere = sphere_offset(halfLat, halfLng);
    vec4 c = u_center_sine_cosine;
    vec3 center = vec3(c.z * c.y, c.x, c.w * c.y);
    vec3 offset = sphere + (center + sphere) * (u.z / ${glslFloat32(GLOBE_RADIUS)});
    vec4 globe = u_ground_main * vec4(offset, 0.0) + u_ground_main_center;
    vec4 plane = u_ground_fallback * vec4(u.xy, u.z * u_elevation_params.x, 0.0)
        + u_ground_fallback_center;
    return mix(plane, globe, u_ground_transition);
}
#endif

// The place on the ground a point of the clip space over its w, (x, y, z - 1), stands for: its
// Mercator offset and its elevation (meters)
vec3 ground_place(vec3 p) {
#ifdef GLOBE
    if (u_ground_transition > ${glslFloat32(CENTER_PROJECTION_CONSTANTS.globeOnly)}) {
        return ground_globe_alone(p);
    }
    if (u_ground_transition > 0.0) {
        vec3 target = ground_linear(p);
        vec3 u = target;
        for (int i = 0; i < 3; i++) {
            vec4 clip = ground_forward(u);
            u += target - ground_linear(vec3(clip.xy, -clip.z) / clip.w);
        }
        return u;
    }
#endif
    return ground_linear(p);
}

// Whether a Mercator offset is in the DEM atlas
bool ground_in_atlas(vec2 q) {
    vec2 uv = (q - u_dem_atlas_rect.xy) * u_dem_atlas_rect.zw;
    return u_dem_atlas_size.x > 0.0 && all(greaterThanEqual(uv, vec2(0.0)))
        && all(lessThanEqual(uv, vec2(1.0)));
}

// For a depth read halfway at its second digit (at the place c of the clip space, the lower of its
// two depths less 1, and the step to the higher): 0 or 1 where the lower or the higher puts its
// place on the ground of the DEM atlas, within a quarter of how far the other is from it; 0.5
// where neither does (the ground of the atlas is not that of the mesh drawn, or is not there)
float ground_pick(vec2 c, float low, float apart) {
    vec3 a = ground_place(vec3(c, low));
    vec3 b = ground_place(vec3(c, low + apart));
    if (!ground_in_atlas(a.xy) || !ground_in_atlas(b.xy)) return 0.5;
    float ha = a.z - dem_elevation_meters(a.xy);
    float hb = b.z - dem_elevation_meters(b.xy);
    float gap = abs(ha - hb);
    if (abs(ha) < 0.25 * gap) return 0.0;
    if (abs(hb) < 0.25 * gap) return 1.0;
    return 0.5;
}

// The most a depth read since it was reset may be further than it was drawn at: half a step of a
// digit read halfway
float g_ground_slack = 0.0;

// The depth of a texel less 1, from the digits of base 256 MapLibre packs it into (a byte s holds
// the digit s below 128, s + 1 above it, and 128 or 129 at 128: the second digit is picked by the
// DEM atlas, the others are read halfway), exact in a 32-bit float; 1.0 for the white of no
// terrain
float ground_depth_at(ivec2 at, ivec2 size) {
    ivec2 own = clamp(at, ivec2(0), size - 1);
    vec4 t = texelFetch(u_ground_depth, own, 0);
    vec3 s = floor(t.abg * 255.0 + 0.5);
    if (s.x > 254.5) return 1.0;
    vec3 halfway = step(127.5, s) - step(128.5, s);
    vec3 weights = vec3(${glslFloat32(DIGIT_WEIGHTS[0])}, ${glslFloat32(DIGIT_WEIGHTS[1])},
        ${glslFloat32(DIGIT_WEIGHTS[2])});
    vec3 digit = s + step(128.5, s) + 0.5 * vec3(halfway.x, 0.0, halfway.z) - vec3(256.0, 0.0, 0.0);
    float depth = dot(digit, weights) + t.r * ${glslFloat32(DIGIT_WEIGHTS[2])};
    float slack = 0.5 * (halfway.x * weights.x + halfway.z * weights.z);
    if (halfway.y > 0.5) {
        vec2 c = (vec2(own) + 0.5) / vec2(size) * 2.0 - 1.0;
        float pick = ground_pick(c, depth, weights.y);
        depth += pick * weights.y;
        if (pick == 0.5) slack += 0.5 * weights.y;
    }
    g_ground_slack = max(g_ground_slack, slack);
    return depth;
}

// The w of a point of the clip space over the w of the clip space, (x, y, z - 1) (one over its
// distance from the camera, in the units of the clip space), by the projection linearized at the
// center
float ground_inverse_w(vec2 ndc, float z) {
    return dot(vec4(u_ground_unproject[0].w, u_ground_unproject[1].w, u_ground_unproject[2].w,
        u_ground_unproject[3].w), vec4(ndc, z, 1.0));
}

// The step of the depth (less 1) from a texel to the next one away from it along an axis (texels
// of the axis and of the clip space over its w), where that one is on the surface of the texel (0
// where it is not); iw is one over the distance of the texel from the camera, c its place
float ground_outer_step(ivec2 at, ivec2 axis, float depth, float iw, vec2 c, vec2 toward,
        ivec2 size) {
    float next = ground_depth_at(at + axis, size);
    if (next > 0.5) return 0.0;
    float other = ground_inverse_w(c + toward, next);
    if (max(other, iw) > min(other, iw) * ${glslFloat32(1 + GROUND_DEPTH_JUMP)}) return 0.0;
    return next - depth;
}

// The ground seen at a place of the screen (device pixels), lifted over the terrain as the drape
// lifts its ground: its Mercator offset from the center and the depth there (the z of the clip
// space over its w), no further than it was drawn at (less half a step of a digit where one was
// read halfway: that depth is taken by the polygons and the lines, tested against the depth of
// the terrain the map drew); false where none is seen
bool ground_at(vec2 frag, out vec2 q, out float depth) {
    q = vec2(0.0);
    depth = 1.0;
    // The depth at the place less 1 (as the texels are read)
    float z = 0.0;
    g_ground_slack = 0.0;
    ivec2 size = textureSize(u_ground_depth, 0);
    vec2 ndc01 = frag / u_viewport;
    // The texels are at the centers of the CSS pixels of the same screen
    vec2 t = ndc01 * vec2(size) - 0.5;
    vec2 base = floor(t);
    vec2 f = t - base;
    ivec2 at = ivec2(base);
    float d00 = ground_depth_at(at, size);
    float d10 = ground_depth_at(at + ivec2(1, 0), size);
    float d01 = ground_depth_at(at + ivec2(0, 1), size);
    float d11 = ground_depth_at(at + ivec2(1, 1), size);
    float nearest = f.y < 0.5 ? (f.x < 0.5 ? d00 : d10) : (f.x < 0.5 ? d01 : d11);
    if (nearest > 0.5) return false;
    vec2 ndc = ndc01 * 2.0 - 1.0;
    vec2 texel = 2.0 / vec2(size);
    vec2 c = (base + 0.5) * texel - 1.0;
    // One over the distance of each from the camera (0 for none)
    vec4 d = vec4(d00, d10, d01, d11);
    vec4 iw = vec4(
        d00 > 0.5 ? 0.0 : ground_inverse_w(c, d00),
        d10 > 0.5 ? 0.0 : ground_inverse_w(c + vec2(texel.x, 0.0), d10),
        d01 > 0.5 ? 0.0 : ground_inverse_w(c + vec2(0.0, texel.y), d01),
        d11 > 0.5 ? 0.0 : ground_inverse_w(c + texel, d11));
    float most = max(max(iw.x, iw.y), max(iw.z, iw.w));
    // On the surface of the nearest to the camera: no further from it than the step of a surface
    bvec4 same = greaterThanEqual(iw * ${glslFloat32(1 + GROUND_DEPTH_JUMP)}, vec4(most));
    if (all(same)) {
        z = mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y);
    } else {
        // The nearest, with the steps to the texels next to it on its surface
        int k = iw.x == most ? 0 : (iw.y == most ? 1 : (iw.z == most ? 2 : 3));
        vec2 corner = vec2(float(k & 1), float(k >> 1));
        float gx = 0.0;
        float gy = 0.0;
        float nx = 0.0;
        float ny = 0.0;
        if (same.x && same.y) { gx += d10 - d00; nx += 1.0; }
        if (same.z && same.w) { gx += d11 - d01; nx += 1.0; }
        if (same.x && same.z) { gy += d01 - d00; ny += 1.0; }
        if (same.y && same.w) { gy += d11 - d10; ny += 1.0; }
        if (nx > 0.0) gx /= nx;
        if (ny > 0.0) gy /= ny;
        // Along an axis no texel next to it in the four is on its surface: the step is taken from
        // the texel on its other side
        ivec2 own = at + ivec2(corner);
        vec2 place = c + corner * texel;
        if (nx == 0.0) {
            float sx = corner.x == 0.0 ? -1.0 : 1.0;
            gx = sx * ground_outer_step(own, ivec2(int(sx), 0), d[k], most, place,
                vec2(sx * texel.x, 0.0), size);
        }
        if (ny == 0.0) {
            float sy = corner.y == 0.0 ? -1.0 : 1.0;
            gy = sy * ground_outer_step(own, ivec2(0, int(sy)), d[k], most, place,
                vec2(0.0, sy * texel.y), size);
        }
        z = d[k] + gx * (f.x - corner.x) + gy * (f.y - corner.y);
    }
    vec4 h = u_ground_unproject * vec4(ndc, z, 1.0);
    if (h.w <= 0.0) return false;
    // Lifted: the depth on the ray of the pixel where the elevation is the lift more (the lift
    // grows with the distance from the camera, 1 / h.w), by the step of the elevation with the
    // depth there
    vec4 b = u_ground_unproject[2];
    float rate = (b.z * h.w - h.z * b.w) / (h.w * h.w);
    float lifted = rate < 0.0 ? z + (u_ground_lift / h.w) / rate : z;
    q = ground_place(vec3(ndc, lifted)).xy;
    depth = 1.0 + (lifted - g_ground_slack);
    return true;
}
`;
