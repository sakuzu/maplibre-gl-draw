// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The projection of positions relative to the center of the view
 *
 * Every position the shaders draw is given as its offset in degrees from the center of the view
 * (computed in float64 on the CPU, then rounded to a 32-bit float). The GPU turns the offset into
 * the offset of the position in the space the matrix of the frame takes (the Mercator plane, the
 * unit sphere of the globe, or both mixed by the transition between them), puts it through the
 * matrix, and adds the center in clip space, computed in float64 on the CPU. No absolute
 * coordinate is ever held in a 32-bit float, so the error of a position is a few roundoffs of its
 * distance from the center at every zoom.
 *
 * The GLSL uses only the operations GLSL ES 3.00 (4.5.1) bounds the error of: `+ - *`, `/`,
 * `log`, `exp` and `inversesqrt`. The trigonometric built-ins are not used, as the specification
 * gives no bound for them and some GPUs (SwiftShader among them) miss the Mercator y of a latitude
 * by several pixels from zoom 10. sin and cos of half the offsets are polynomials, the Mercator y
 * of the offset of the latitude is formed from them and from sin and cos of the center (computed
 * in float64 on the CPU), and the globe is formed the same way. The derivation of the bound of the
 * error is in `docs/internals/coordinate-precision.md`.
 *
 * The same projection is computed on the CPU in float64 (`clipOfPosition`): the center in clip
 * space the GPU adds, and the projection of the anchors the hit testing reads over terrain.
 */

import type { ProjectionData } from 'maplibre-gl';

/** The part of the projection data of a frame the projection reads */
export type ProjectionMatrices = Pick<ProjectionData, 'mainMatrix'> &
  Partial<Pick<ProjectionData, 'fallbackMatrix' | 'projectionTransition' | 'clippingPlane'>>;

const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));

/**
 * The coefficients and constants of the GLSL, as the 32-bit floats the GPU holds
 *
 * @internal
 */
export const CENTER_PROJECTION_CONSTANTS = {
  /** sin(x) / x in x²: 1, -1/3!, 1/5!, ... 1/13! (|x| <= π/2) */
  sine: [1, 3, 5, 7, 9, 11, 13].map((n, i) => Math.fround((i % 2 === 0 ? 1 : -1) / factorial(n))),
  /** cos(x) in x²: 1, -1/2!, 1/4!, ... -1/14! */
  cosine: [0, 2, 4, 6, 8, 10, 12, 14].map((n, i) =>
    Math.fround((i % 2 === 0 ? 1 : -1) / factorial(n)),
  ),
  /** atanh(w) / w in w²: 1, 1/3, 1/5, ... 1/19 */
  atanh: Array.from({ length: 10 }, (_, k) => Math.fround(1 / (2 * k + 1))),
  /** tanh(x) / x in x²: the Taylor coefficients of tanh up to x^15 */
  tanh: [
    1,
    -1 / 3,
    2 / 15,
    -17 / 315,
    62 / 2835,
    -1382 / 155925,
    21844 / 6081075,
    -929569 / 638512875,
  ].map(Math.fround),
  /** Radians per degree, halved */
  halfDegree: Math.fround(Math.PI / 360),
  /** Mercator units per degree of longitude */
  perDegree: Math.fround(1 / 360),
  /** The Mercator y of an isometric latitude of 1 */
  mercatorY: Math.fround(-1 / (2 * Math.PI)),
  pi: Math.fround(Math.PI),
  /** The radius of the sphere of the globe (maplibre's) */
  globeRadius: Math.fround(6371008.8),
  /** Where the series of atanh and tanh give way to log and exp */
  seriesLimit: Math.fround(0.4),
  /** Over this transition maplibre draws the globe alone */
  globeOnly: Math.fround(0.999),
} as const;

/**
 * A float as a GLSL literal that gives back the same 32-bit float
 *
 * @internal
 */
export function glslFloat32(value: number): string {
  const text = Math.fround(value).toPrecision(9);
  return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

/** Horner's rule in GLSL: c0 + x * (c1 + x * (c2 + ...)) */
function horner(x: string, coefficients: readonly number[]): string {
  let out = glslFloat32(coefficients[coefficients.length - 1] as number);
  for (let i = coefficients.length - 2; i >= 0; i--) {
    out = `${glslFloat32(coefficients[i] as number)} + ${x} * (${out})`;
  }
  return out;
}

const C = CENTER_PROJECTION_CONSTANTS;

/**
 * The GLSL of the functions of the offsets from the center: sin and cos of half an offset, the
 * Mercator y of a latitude offset and back, and on the globe (`GLOBE`) the offset on the unit
 * sphere. It reads `u_center_sine_cosine` alone, so a fragment stage can take it too
 *
 * @internal
 */
export const CENTER_OFFSET_FUNCTIONS_GLSL = `
// sin and cos of the latitude, sin and cos of the longitude of u_center_lnglat (float64 on the CPU)
uniform vec4 u_center_sine_cosine;

// sin and cos of an angle in radians (|x| <= PI / 2), by polynomials
vec2 offset_sine_cosine(float x) {
    float x2 = x * x;
    return vec2(x * (${horner('x2', C.sine)}), ${horner('x2', C.cosine)});
}

// sin and cos of half the offset of a latitude (degrees)
vec2 half_latitude_offset(float latOffset) {
    return offset_sine_cosine(latOffset * ${glslFloat32(C.halfDegree)});
}

// The Mercator y offset of a latitude, from sin and cos of half its offset h
//
// With m = latitude of the center + h, the offset of the isometric latitude is 2 atanh(w) with
// w = sin h / cos m. A small w takes the series of atanh; a large one the log of
// (cos m + sin h) / (cos m - sin h), both sides formed from the center directly (1 - sin and
// 1 + sin of its latitude as cos² over the other), so that no difference of numbers near 1 is left
// to the log.
float mercator_offset_y(vec2 halfLat) {
    float s0 = u_center_sine_cosine.x;
    float c0 = u_center_sine_cosine.y;
    float cosMid = c0 * halfLat.y - s0 * halfLat.x;
    float w = halfLat.x / cosMid;
    float psi;
    if (abs(w) < ${glslFloat32(C.seriesLimit)}) {
        float w2 = w * w;
        psi = 2.0 * w * (${horner('w2', C.atanh)});
    } else {
        float c2 = c0 * c0;
        float onePlus;
        float oneMinus;
        if (s0 >= 0.0) {
            onePlus = 1.0 + s0;
            oneMinus = c2 / onePlus;
        } else {
            oneMinus = 1.0 - s0;
            onePlus = c2 / oneMinus;
        }
        float cosH = c0 * halfLat.y;
        psi = log((cosH + oneMinus * halfLat.x) / (cosH - onePlus * halfLat.x));
    }
    return psi * ${glslFloat32(C.mercatorY)};
}

// sin and cos of half the offset of a latitude, from its Mercator y offset
//
// tanh of half the offset of the isometric latitude is w = sin h / cos m (as above), so
// tan h = w cos(lat0) / (1 + w sin(lat0)).
vec2 half_latitude_of_mercator_offset(float dy) {
    float s0 = u_center_sine_cosine.x;
    float c0 = u_center_sine_cosine.y;
    float x = ${glslFloat32(C.pi)} * dy;
    float a = abs(x);
    float t;
    if (a < ${glslFloat32(C.seriesLimit)}) {
        float a2 = a * a;
        t = a * (${horner('a2', C.tanh)});
    } else {
        float e = exp(-2.0 * a);
        t = (1.0 - e) / (1.0 + e);
    }
    float w = x > 0.0 ? -t : t;
    float tanHalf = (w * c0) / (1.0 + w * s0);
    float c = inversesqrt(1.0 + tanHalf * tanHalf);
    return vec2(tanHalf * c, c);
}

#ifdef GLOBE
// A longitude offset brought into [-180, 180]
float wrapped_longitude_offset(float d) {
    float x = d;
    for (int i = 0; i < 2; i++) {
        if (x > 180.0) x = x - 360.0;
        if (x < -180.0) x = x + 360.0;
    }
    return x;
}

// The offset on the unit sphere of the globe, from sin and cos of half the offsets of the
// latitude and of the longitude: every term is a difference formed from the half offsets, so it
// keeps the precision of the offset however small
vec3 sphere_offset(vec2 halfLat, vec2 halfLng) {
    vec4 c = u_center_sine_cosine;
    float cosMid = c.y * halfLat.y - c.x * halfLat.x;
    float sinMid = c.x * halfLat.y + c.y * halfLat.x;
    float dSin = 2.0 * halfLat.x * cosMid;
    float dCos = -2.0 * halfLat.x * sinMid;
    float cosLngMid = c.w * halfLng.y - c.z * halfLng.x;
    float sinLngMid = c.z * halfLng.y + c.w * halfLng.x;
    float dSinLng = 2.0 * halfLng.x * cosLngMid;
    float dCosLng = -2.0 * halfLng.x * sinLngMid;
    float cosLat = c.y + dCos;
    return vec3(c.z * dCos + dSinLng * cosLat, dSin, c.w * dCos + dCosLng * cosLat);
}
#endif

`;

/**
 * The GLSL of the offsets from the center (included in `OFFSET_MODE_GLSL`): the functions of the
 * offsets (`CENTER_OFFSET_FUNCTIONS_GLSL`) and the projection of a position given by its offsets
 *
 * It reads `u_center_sine_cosine` and `u_projection_center`, and on the globe the uniforms of
 * maplibre's prelude (`u_projection_transition`, `u_projection_fallback_matrix`,
 * `u_projection_clipping_plane`).
 *
 * @internal
 */
export const CENTER_OFFSET_GLSL =
  CENTER_OFFSET_FUNCTIONS_GLSL +
  `
// The center in clip space, as maplibre projects it in the frame (float64 on the CPU)
uniform vec4 u_projection_center;

// The position in clip space of a position given by its offsets from the center: its Mercator
// offset, its longitude offset, sin and cos of half its latitude offset, and its elevation (in
// Mercator units; on the globe maplibre's prelude takes it as meters, as projectTileWithElevation
// does)
vec4 project_center_offset(vec2 mercatorOffset, float lngOffset, vec2 halfLat, float elevation, mat4 viewProjectionMatrix) {
    vec4 center = u_projection_center;
#ifdef GLOBE
    if (u_projection_transition > 0.0) {
        vec2 halfLng = offset_sine_cosine(wrapped_longitude_offset(lngOffset) * ${glslFloat32(C.halfDegree)});
        vec3 sphere = sphere_offset(halfLat, halfLng);
        vec4 c = u_center_sine_cosine;
        vec3 centerOnSphere = vec3(c.z * c.y, c.x, c.w * c.y);
        float lift = elevation / ${glslFloat32(C.globeRadius)};
        vec3 offset = sphere + (centerOnSphere + sphere) * lift;
        vec4 globe = viewProjectionMatrix * vec4(offset, 0.0);
        // The depth that hides the far side of the sphere, as maplibre's prelude gives it (from
        // the position itself: it needs no more precision than the clipping)
        vec3 position = centerOnSphere + offset;
        float clipping = 1.0 - (dot(position, u_projection_clipping_plane.xyz) + u_projection_clipping_plane.w);
        if (u_projection_transition > ${glslFloat32(C.globeOnly)}) {
            float w = center.w + globe.w;
            return vec4(center.x + globe.x, center.y + globe.y, clipping * w, w);
        }
        // The transition: both projections mixed as maplibre mixes them
        vec4 plane = u_projection_fallback_matrix * vec4(mercatorOffset, elevation, 0.0);
        float t = u_projection_transition;
        float s = 1.0 - t;
        float globeW = (viewProjectionMatrix * vec4(position, 1.0)).w;
        float depth = clamp((t - 0.2) / 0.8, 0.0, 1.0);
        return vec4(
            center.x + (plane.x * s + globe.x * t),
            center.y + (plane.y * s + globe.y * t),
            depth * clipping * globeW,
            center.w + (plane.w * s + globe.w * t));
    }
#endif
    return viewProjectionMatrix * vec4(mercatorOffset, elevation, 0.0) + center;
}
`;

/**
 * sin and cos of the latitude and of the longitude of a center, as `u_center_sine_cosine` holds
 * them (computed in float64)
 *
 * @internal
 */
export function centerSineCosineOf(
  center: readonly [number, number],
): [number, number, number, number] {
  const lat = (center[1] * Math.PI) / 180;
  const lng = (center[0] * Math.PI) / 180;
  return [Math.sin(lat), Math.cos(lat), Math.sin(lng), Math.cos(lng)];
}

/** The Mercator coordinates of a position, in float64 */
function mercatorOf(lng: number, lat: number): [number, number] {
  return [(lng + 180) / 360, 0.5 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / (2 * Math.PI)];
}

/** A matrix (column-major) times a vector, in float64 */
function transform(
  m: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  w: number,
): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}

/**
 * The position in clip space of a longitude, a latitude and an elevation, as the shaders draw it,
 * computed in float64
 *
 * On Web Mercator, the matrix of the Mercator coordinates; on the globe, the matrix of the unit
 * sphere with the depth that hides its far side; in the transition, both mixed by the transition
 * as maplibre mixes them (the depth from the globe). The elevation is in Mercator units, which
 * the globe takes as meters (as the shaders do).
 *
 * @internal
 */
export function clipOfPosition(
  projection: ProjectionMatrices,
  lng: number,
  lat: number,
  elevation = 0,
): [number, number, number, number] {
  const [mx, my] = mercatorOf(lng, lat);
  const t = Math.fround(projection.projectionTransition ?? 0);
  if (!(t > 0) || !projection.fallbackMatrix) {
    return transform(projection.mainMatrix, mx, my, elevation, 1);
  }
  const phi = (lat * Math.PI) / 180;
  const lambda = (lng * Math.PI) / 180;
  const lift = 1 + elevation / C.globeRadius;
  const sx = Math.sin(lambda) * Math.cos(phi) * lift;
  const sy = Math.sin(phi) * lift;
  const sz = Math.cos(lambda) * Math.cos(phi) * lift;
  const globe = transform(projection.mainMatrix, sx, sy, sz, 1);
  const plane = projection.clippingPlane ?? [0, 0, 0, 0];
  const clipping = 1 - (sx * plane[0] + sy * plane[1] + sz * plane[2] + plane[3]);
  if (t > C.globeOnly) return [globe[0], globe[1], clipping * globe[3], globe[3]];
  const flat = transform(projection.fallbackMatrix, mx, my, elevation, 1);
  const depth = Math.min(Math.max((t - 0.2) / 0.8, 0), 1);
  return [
    flat[0] * (1 - t) + globe[0] * t,
    flat[1] * (1 - t) + globe[1] * t,
    depth * clipping * globe[3],
    flat[3] * (1 - t) + globe[3] * t,
  ];
}
