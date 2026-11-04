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
 *   below 128 and s + 1 above it (128 is either 128 or 129, taken as halfway: the ground there
 *   is read up to half a step of the digit along the ray, and the depth the polygons and the
 *   lines take is that much nearer, so the terrain the map drew there never hides them). A byte
 *   of 255 in alpha is never written for a depth below 1: it is the white of no terrain.
 * - A pixel of the screen is a part of a texel (the texels are CSS pixels). The depth there is
 *   interpolated between the four texels around it, bilinear where they are on one surface (the
 *   depth of a plane is affine on the screen, so this is exact on a plane). Where they are not
 *   (the edge of a ridge in front of the ground behind it, a step of the depth of more than
 *   `GROUND_DEPTH_JUMP` of the distance from the camera), the depth of the nearest of them to the
 *   camera is taken, with the steps to the texels next to it on the same surface (along an axis
 *   where none of the four is, to the texel on its other side). A pixel whose nearest texel on
 *   the screen is white has no ground.
 * - The inverse is the one of the projection relative to the center of the view the shaders of
 *   the rows draw with (`project_center_offset`): the Mercator offset from the center and the
 *   elevation (in Mercator units) put through the matrix of the frame, plus the center in clip
 *   space. It is formed on the CPU in float64 (`groundUnprojectOf`), so only offsets are held in
 *   32-bit floats.
 * - The ground is taken lifted over the terrain as the drape lifts its ground (`groundRiseOf`):
 *   the place on the ray of the pixel that far over the position read back. Its depth is the one
 *   the polygons and the lines take (the 3D layers of the map in front of the ground hide them as
 *   they hide the ground), and it wins against the terrain the map drew there.
 */

import { glslFloat32 } from '../../shaders/center-projection.js';

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

/**
 * The inverse of the projection of the rows relative to the center of the view, for a flat map:
 * the clip space of a position is the matrix of the frame times its Mercator offset from the
 * center and its elevation (Mercator units), plus the center in clip space. Formed in float64,
 * written to `out` (column-major): a point of the clip space over its w, (x, y, z, 1), goes to
 * (the offset, the elevation, 1) over the w of the clip space
 *
 * @param matrix The matrix of the frame (`mainMatrix`, column-major)
 * @param center The center in clip space (`projectionCenter` of the offset uniforms)
 * @returns false where the projection cannot be inverted
 */
export function groundUnprojectOf(
  matrix: ArrayLike<number>,
  center: readonly [number, number, number, number],
  out: Float32Array | Float64Array,
): boolean {
  const m = new Float64Array(16);
  for (let i = 0; i < 12; i++) m[i] = matrix[i] as number;
  m[12] = center[0];
  m[13] = center[1];
  m[14] = center[2];
  m[15] = center[3];
  const inverse = invert4(m);
  if (!inverse) return false;
  out.set(inverse);
  return true;
}

/**
 * The lift of the ground read back over the terrain, as the drape lifts its ground (`u_ground_rise`
 * of `GROUND_DEPTH_GLSL`): `liftMeters` at the center of the view, and as much more as the ground
 * is further from the camera (the drape lifts the ground of a tile by a share of its size, and the
 * tiles maplibre draws are larger the further they are), in Mercator units of elevation over the
 * w of the clip space
 *
 * @param elevationScale The Mercator units of a meter of elevation in the frame
 * @param liftMeters The lift at the center of the view (meters)
 * @param centerW The w of the clip space of the center of the view
 */
export function groundRiseOf(elevationScale: number, liftMeters: number, centerW: number): number {
  return centerW > 0 ? (liftMeters * elevationScale) / centerW : 0;
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
 * The GLSL that reads the ground of a pixel of the screen from the depth MapLibre draws (for a
 * fragment stage that declares `u_viewport`, the size of the drawing buffer)
 *
 * - `u_ground_depth`: the depth of the terrain MapLibre draws (RGBA8, a texel a CSS pixel)
 * - `u_ground_unproject`: `groundUnprojectOf`
 * - `u_ground_rise`: `groundRiseOf`
 *
 * `ground_at(frag, q, depth)` gives the Mercator offset from the center of the ground seen at a
 * place of the screen (device pixels, as `gl_FragCoord`), lifted, and the depth there (the z of the
 * clip space over its w, taken no further than it was drawn at), false where no ground is seen.
 */
export const GROUND_DEPTH_GLSL = `
uniform highp sampler2D u_ground_depth;
uniform highp mat4 u_ground_unproject;
uniform float u_ground_rise;

// The most a depth read since it was reset may be further than it was drawn at: half a step of a
// digit read halfway
float g_ground_slack = 0.0;

// The depth of a texel, from the digits of base 256 MapLibre packs it into (a byte s holds the
// digit s below 128, s + 1 above it, and 128 or 129 at 128); 2.0 for the white of no terrain
float ground_depth_at(ivec2 at, ivec2 size) {
    vec4 t = texelFetch(u_ground_depth, clamp(at, ivec2(0), size - 1), 0);
    vec3 s = floor(t.abg * 255.0 + 0.5);
    if (s.x > 254.5) return 2.0;
    vec3 halfway = step(127.5, s) - step(128.5, s);
    vec3 digit = s + step(128.5, s) + 0.5 * halfway;
    vec3 weights = vec3(${glslFloat32(DIGIT_WEIGHTS[0])}, ${glslFloat32(DIGIT_WEIGHTS[1])},
        ${glslFloat32(DIGIT_WEIGHTS[2])});
    g_ground_slack = max(g_ground_slack, 0.5 * dot(halfway, weights));
    return dot(digit, weights) + t.r * ${glslFloat32(DIGIT_WEIGHTS[2])};
}

// The w of a point of the clip space over the w of the clip space (one over its distance from
// the camera, in the units of the clip space)
float ground_inverse_w(vec2 ndc, float z) {
    return dot(vec4(u_ground_unproject[0].w, u_ground_unproject[1].w, u_ground_unproject[2].w,
        u_ground_unproject[3].w), vec4(ndc, z, 1.0));
}

// The step of the depth from a texel to the next one away from it along an axis (texels of the
// axis and of the clip space over its w), where that one is on the surface of the texel (0 where
// it is not); iw is one over the distance of the texel from the camera, c its place
float ground_outer_step(ivec2 at, ivec2 axis, float depth, float iw, vec2 c, vec2 toward,
        ivec2 size) {
    float next = ground_depth_at(at + axis, size);
    if (next > 1.5) return 0.0;
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
    float z = 1.0;
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
    if (nearest > 1.5) return false;
    vec2 ndc = ndc01 * 2.0 - 1.0;
    vec2 texel = 2.0 / vec2(size);
    vec2 c = (base + 0.5) * texel - 1.0;
    // One over the distance of each from the camera (0 for none)
    vec4 d = vec4(d00, d10, d01, d11);
    vec4 iw = vec4(
        d00 > 1.5 ? 0.0 : ground_inverse_w(c, d00),
        d10 > 1.5 ? 0.0 : ground_inverse_w(c + vec2(texel.x, 0.0), d10),
        d01 > 1.5 ? 0.0 : ground_inverse_w(c + vec2(0.0, texel.y), d01),
        d11 > 1.5 ? 0.0 : ground_inverse_w(c + texel, d11));
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
    vec3 p = h.xyz / h.w;
    // The camera: the point the clip space has at its w of 0 (x and y of 0), and the share of the
    // way to it the lift takes (the lift grows with the distance from the camera, 1 / h.w)
    vec4 eye = u_ground_unproject[2];
    vec3 camera = eye.xyz / eye.w;
    float s = clamp(u_ground_rise / (h.w * max(camera.z - p.z, 1e-30)), 0.0, 0.5);
    q = p.xy + (camera.xy - p.xy) * s;
    // The depth of the place that far toward the camera on the ray: (1 - s) of the position over
    // its w and s of the camera, (0, 0, 1 / eye.w, 0) in the clip space
    depth = z - g_ground_slack + s * h.w / ((1.0 - s) * eye.w);
    return true;
}
`;
