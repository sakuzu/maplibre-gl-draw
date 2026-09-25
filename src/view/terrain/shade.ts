// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Formula for terrain shading (an aid to reading the map)
 *
 * There are two paths that put a polygon fill onto the ground surface: analytic drape
 * (filling as pixels of the ground surface, `drape/renderer.ts` and `drape/quad.ts`) and
 * vertex displacement (the path in `shaders/helpers.ts` that lifts the vertices of a
 * feature and fills them). So that both produce the same pixels, the formula that derives
 * the brightness factor from the gradient is kept here in a single place, and only the way
 * the samples are taken is adapted to each path. If each path had its own formula, the
 * brightness of the fill would jump where the bands switch over.
 *
 * Shading does not change the hue; it is applied to the brightness only. It is not 3D
 * lighting that illuminates symbols with an arbitrary light, it is also distinct from
 * vertical exaggeration of the terrain (which follows the map's own factor), and it does not
 * change the dimensions of the relief at all.
 */

/**
 * Light source for the shading
 *
 * It is a pair of a unit vector in the map coordinate system (east, north, up) and a
 * strength.
 */
export interface TerrainShadeLight {
  /** Unit vector in the map coordinate system (east, north, up) */
  readonly direction: readonly [number, number, number];
  /** Strength of the shading (0 means no shading) */
  readonly strength: number;
}

/**
 * GLSL that derives the brightness factor from the gradient
 *
 * The caller must declare `u_light_dir` (map coordinate system, east / north / up) and
 * `u_shade_strength`. The unit of the gradient is meters per meter (eastward and
 * northward), and every path converts its samples to this unit before passing them in.
 */
export const TERRAIN_SHADE_CORE_GLSL = `
float terrainShadeFromGradient(float dzdEast, float dzdNorth) {
    if (u_shade_strength <= 0.0) return 1.0;
    vec3 normal = normalize(vec3(-dzdEast, -dzdNorth, 1.0));
    float lambert = dot(normal, u_light_dir);
    // The value on level ground (the normal pointing straight up). It is normalized to
    // 1.0 here, so no shading is applied on flat places (the name flat cannot be used
    // because it is a reserved word in GLSL)
    float level = max(u_light_dir.z, 1e-3);
    float factor = 1.0 + u_shade_strength * (lambert - level) / level;
    return clamp(factor, 1.0 - u_shade_strength, 1.0 + u_shade_strength * 0.5);
}
`;

/**
 * CPU mirror of `terrainShadeFromGradient`
 *
 * The GLSL is the authority for the implementation, but the formula itself is placed here
 * as a pure function so that it can be verified (the same practice as `drapeShadeWindow`).
 * Given the same samples, every path arrives at this value.
 *
 * @param dzdEast Eastward gradient (meters per meter)
 * @param dzdNorth Northward gradient (meters per meter)
 * @param light The light source
 */
export function terrainShadeFactor(
  dzdEast: number,
  dzdNorth: number,
  light: TerrainShadeLight,
): number {
  const strength = light.strength;
  if (strength <= 0) return 1;
  const length = Math.hypot(dzdEast, dzdNorth, 1);
  const normal: [number, number, number] = [-dzdEast / length, -dzdNorth / length, 1 / length];
  const dir = light.direction;
  const lambert = normal[0] * dir[0] + normal[1] * dir[1] + normal[2] * dir[2];
  const level = Math.max(dir[2], 1e-3);
  const factor = 1 + (strength * (lambert - level)) / level;
  return Math.min(Math.max(factor, 1 - strength), 1 + strength * 0.5);
}
