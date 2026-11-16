// @sakuzu/maplibre-gl-draw/webgl 2.2.0 (main) の公開 API の宣言を 1 つにまとめた物。
// 元は tsc --emitDeclarationOnly の出力 (stripInternal)。再 export は元の宣言を写した。
// @internal のメンバーと private のメンバーは落としてある。
// 「export されない宣言」の領域は、export された宣言が参照するので、このファイルだけで
// 読めるように写した物で、入口からは export されていない。

import type { Geometry, Position } from 'geojson';
import type { ProjectionData } from 'maplibre-gl';

// 入口の説明 (入口の index の先頭の TSDoc)
/**
 * Write your own shaders that draw the way the library does.
 *
 * Use it only when a custom feature type or an overlay needs a shader of its own. The
 * {@link maplibre-gl-draw!RenderContext | RenderContext} a renderer receives already carries
 * the shared renderers of lines, areas and point markers, and most renderers need nothing
 * more. This entry holds the GLSL of the projection, the uniforms that go with it, the quad
 * shader, and the rules the shared renderers follow for dashes and terrain. The parts that draw
 * on the terrain take the render context of the draw call (or its `terrain`). Unlike the main
 * entry, it may change in a minor release.
 *
 * ```ts
 * import {
 *   createProgram, OFFSET_MODE_GLSL, ProjectionUniformManager,
 * } from '@sakuzu/maplibre-gl-draw/webgl';
 *
 * let program: WebGLProgram | null = null;
 * let uniforms: ProjectionUniformManager | null = null;
 * draw.extensions.overlays.add({
 *   name: 'my-shader',
 *   onAdd: () => {},
 *   draw(ctx) {
 *     if (!program) {
 *       const vertex = vertexSource(ctx.shader.vertexShaderPrelude, OFFSET_MODE_GLSL);
 *       program = createProgram(ctx.gl, vertex, fragmentSource);
 *       uniforms = new ProjectionUniformManager(ctx.gl);
 *       uniforms.getLocations(program);
 *     }
 *     ctx.gl.useProgram(program);
 *     uniforms?.setTerrain(ctx);
 *     uniforms?.setUniforms(ctx.projection, ctx.zoom, ctx.offset);
 *     // bind the buffers of your shape and draw it
 *   },
 *   onRemove: (_map, gl) => gl.deleteProgram(program),
 * });
 * ```
 *
 * Read next: the guide
 * [custom feature types](https://sakuzu.github.io/maplibre-gl-draw/guides/custom-types). The
 * parts used most are {@link createProgram}, {@link OFFSET_MODE_GLSL} and
 * {@link ProjectionUniformManager}.
 *
 * @module webgl
 */

// =============================================================================
// 領域: Shaders and projection
// =============================================================================

/**
 * Default tile size
 */
export declare const DEFAULT_TILE_SIZE = 512;

/**
 * Returns a position relative to the view center in degrees, computed at 64-bit precision
 * so that it survives Float32.
 *
 * Used to solve the coordinate precision problem at high zoom levels.
 * Converting absolute coordinates to Float32 loses precision, but relative
 * coordinates (small values) keep enough precision even in Float32.
 *
 * @param lngLat The WGS84 coordinates [lng, lat]
 * @param centerLngLat The center coordinates [lng, lat] (64-bit precision)
 * @returns The relative coordinates [dLng, dLat] (Float32 has enough precision)
 */
export declare function calculateLngLatOffset(lngLat: [number, number], centerLngLat: [number, number]): [number, number];

/**
 * Compiles and links a WebGL2 program from a vertex and a fragment shader source.
 *
 * Every program of the engine is compiled here, so the rules that apply to all of them live
 * here: both stages are given highp samplers (`withSamplerPrecision`).
 *
 * @param gl The WebGL2 context
 * @param vertexSource The vertex shader source, starting with `#version 300 es`
 * @param fragmentSource The fragment shader source, starting with `#version 300 es`
 * @returns The linked program
 * @throws Error with the info log when a shader fails to compile or the program fails to link
 */
export declare function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram;

/**
 * The GLSL functions that project positions relative to the view center (offset mode), with
 * globe support; include it in a vertex shader after the maplibre prelude.
 *
 * To solve the coordinate precision problem (jitter), it uses the same
 * approach as deck.gl's project module. The projection functions below include
 * a port from deck.gl. See THIRD_PARTY_NOTICES.md for the source and the
 * copyright notice.
 * In globe mode, MapLibre's projectTile() is used.
 *
 * The essential points:
 * 1. Do not add Mercator coordinates inside the shader
 * 2. Handle only relative coordinates (offsets) in the shader
 * 3. Compute the clip coordinates of the center at 64-bit precision on the CPU
 *    side and add them at the end
 *
 * The computation flow:
 * 1. position.xyz -= coordinateOrigin  // make it relative (Float32 is enough)
 * 2. offset = project_offset(position) // convert degrees -> Mercator units
 * 3. gl_Position = viewProjectionMatrix * offset + projectionCenter
 *    ^ projectionCenter is computed at 64-bit precision on the CPU side
 *
 * Globe mode support:
 * - When projectionTransition > 0, MapLibre's projectTile() is used
 * - Globe mode is active at zoom < 12, where the precision problem does not
 *   occur
 * - In Mercator mode, the precision problem is solved by offset mode
 *
 * The uniforms used:
 * - u_center_lnglat: the WGS84 coordinates of the viewport center (already
 *   rounded to Float32)
 * - u_projection_center: the center coordinates in clip space (computed at
 *   64-bit precision on the CPU side)
 * - u_units_per_degree: the conversion coefficient from degrees to Mercator
 *   units (computed on the CPU side)
 * - u_units_per_degree2: the non-linear correction coefficient (corrects the
 *   variation due to latitude)
 * - u_projection_transition: defined in MapLibre's prelude (0 = Mercator,
 *   1 = globe)
 *
 * The uniforms for globe mode (defined in MapLibre's prelude):
 * - u_projection_tile_mercator_coords: the Mercator coordinates of the tile
 * - u_projection_clipping_plane: the clipping plane
 * - u_projection_fallback_matrix: the fallback matrix
 */
export declare const OFFSET_MODE_GLSL: string;

/**
 * Looks up and sets the projection and terrain uniforms of a program, for a custom renderer
 * that uses {@link OFFSET_MODE_GLSL}.
 *
 * A class that manages the projection-related uniforms in one place
 */
export declare class ProjectionUniformManager {
    /**
     * @param gl - The WebGL context of the map
     * @param options - `surface`: whether the renderer draws things stuck to the ground (areas
     *   and lines), which lie flat on the frames that draw them flat
     */
    constructor(gl: WebGL2RenderingContext, options?: {
        surface?: boolean;
    });
    /**
     * Sets the terrain the next uniforms are taken from.
     *
     * @param terrain - The render context of the draw call, or its `terrain`; `null` (or an
     *   object the engine did not hand out) draws without terrain
     */
    setTerrain(terrain: RenderContext | TerrainAnchors | null): void;
    /**
     * Obtains the uniform locations from a program
     *
     * Rebuilding the program also resets the uniform values, so the record is
     * discarded as well.
     */
    getLocations(program: WebGLProgram): ProjectionUniformLocations;
    /**
     * Obtains the current locations (getLocations() must be called first)
     */
    getCurrentLocations(): ProjectionUniformLocations | null;
    /**
     * Sets the projection uniforms
     *
     * A uniform whose value is the same as last time is not rewritten. Retained
     * mode passes through here for every chunk, but the only thing that changes
     * between chunks is u_origin_shift; the matrix and the camera-related values
     * are invariant within a frame (see frame.ts).
     *
     * @param projectionData MapLibre's ProjectionData
     * @param zoom The current zoom level
     * @param offsetUniforms The uniforms for offset mode (null is allowed)
     * @param originShift The gap between the reference coordinates of the vertex offsets and
     *   the linearization center (the default is [0,0])
     */
    setUniforms(projectionData: ProjectionData, zoom: number, offsetUniforms: OffsetUniforms | null, originShift?: [number, number]): void;
}

// =============================================================================
// 領域: Blending and billboards
// =============================================================================

/**
 * Restores the blend state the library's renderers expect: blending on, straight alpha for
 * RGB and `ONE` / `ONE_MINUS_SRC_ALPHA` for alpha.
 *
 * A custom renderer that changes the blend state calls it before handing control back.
 *
 * @param gl The WebGL context of the map
 */
export declare function applyDrawBlendState(gl: BlendCapableGL): void;

/**
 * Runs a draw callback with the depth test off, then restores the depth test as it was.
 *
 * Use it around anything drawn as a billboard (a marker or an icon facing the screen) so that
 * the terrain mesh does not cut it in half. Polygons and lines should stay depth-tested.
 *
 * @param gl The WebGL context of the map
 * @param draw The drawing to run
 */
export declare function drawBillboardsWithoutDepth(gl: WebGL2RenderingContext, draw: () => void): void;

// =============================================================================
// 領域: Quads
// =============================================================================

/**
 * The text of a draped quad, as glyphs of an SDF atlas the caller owns.
 *
 * The glyph atlas owned by the caller is referenced as is. It is not
 * held a second time here.
 */
export interface QuadDrapeGlyphs {
    /** The texture of the SDF atlas */
    readonly atlas: WebGLTexture;
    /** Width of the atlas (texels) */
    readonly atlasWidth: number;
    /** Height of the atlas (texels) */
    readonly atlasHeight: number;
    /**
     * Glyph array (8 elements per glyph)
     *
     * The occupancy rectangle (x0, y0, x1, y1) is in the quad's local 0..1
     * coordinates, and the following 4 elements are the atlas UV (u0, v0, u1, v1).
     */
    readonly glyphs: Float32Array;
    /** Number of glyphs */
    readonly glyphCount: number;
    /** Key telling whether repacking is needed (content, style, size, atlas version) */
    readonly key: string;
    /** Number of atlas texels per 1 unit of local coordinates (x, y) */
    readonly atlasTexelsPerUnit: readonly [number, number];
    /** Color of the letterform */
    readonly color: QuadDrapeColor;
    /** Color of the halo (outline) */
    readonly haloColor: QuadDrapeColor;
    /** Width of the halo (in units of the SDF value. 0 means no halo) */
    readonly haloWidth: number;
    /** Isosurface of the letterform (SDF value) */
    readonly edge: number;
    /** Change of the SDF value per atlas texel (= 1 / the radius of the distance field) */
    readonly valuePerTexel: number;
    /** Bias for mip selection (negative is toward the sharper side) */
    readonly lodBias: number;
}

/**
 * The four corners of a quad, each `[lng, lat]` in degrees, as {@link computeQuadVertices}
 * returns them.
 */
export interface QuadVertices {
    /** The top-left corner (texture coordinate (0, 0)) */
    topLeft: [number, number];
    /** The top-right corner (texture coordinate (1, 0)) */
    topRight: [number, number];
    /** The bottom-left corner (texture coordinate (0, 1)) */
    bottomLeft: [number, number];
    /** The bottom-right corner (texture coordinate (1, 1)) */
    bottomRight: [number, number];
}

/**
 * Returns the corners of a rectangle of a size in degrees, rotated about its center.
 *
 * When a large image is placed at a low zoom level, the latitude may exceed
 * +/-90 degrees. In that case it is scaled down automatically so that the
 * whole thing is displayed.
 *
 * @param centerLng The center longitude
 * @param centerLat The center latitude
 * @param widthDeg The width (degrees)
 * @param heightDeg The height (degrees)
 * @param rotationRad The rotation angle (radians, counter-clockwise)
 * @returns The four vertices of the quad (WGS84 coordinates [lng, lat])
 */
export declare function computeQuadVertices(centerLng: number, centerLat: number, widthDeg: number, heightDeg: number, rotationRad: number): QuadVertices;

/**
 * Paints a quad with a fill and text as pixels of the terrain surface.
 *
 * Used by custom renderers that draw text on a filled quad. The fill is decided by a
 * rectangle fill and the text by an SDF atlas lookup, both within the same
 * fragment, so a mismatch of subdivision between the fill and the text cannot
 * occur.
 *
 * Returns false on frames with no terrain and on frames that have terrain but
 * no entry point for the analytic drape (the DEM has not arrived, the shader
 * cannot be built). The caller falls back to the conventional way of drawing
 * (the fill texture + a separate draw of the text).
 *
 * @param terrain - The render context of the draw call, or its `terrain`
 * @param corners - The corners of the quad in degrees
 * @param surface - The fill and the text
 * @param opacity - The opacity, 0..1
 * @returns true if it was painted; false when the caller must draw it another way
 */
export declare function drawQuadSurfaceOnTerrain(terrain: RenderContext | TerrainAnchors, corners: DrapeQuadCorners, surface: QuadDrapeSurface, opacity: number): boolean;

/**
 * Draws a textured quad on the map, such as a picture pasted onto it, following pitch,
 * globe and terrain.
 *
 * Call `ensureShader` with the shader data of the frame and `setOffsetUniforms` before
 * `draw`. On terrain the quad is painted as ground pixels when possible, otherwise it is
 * subdivided to the terrain mesh.
 */
export declare class QuadShader {
    /** @param gl - The WebGL context of the map */
    constructor(gl: WebGL2RenderingContext);
    /**
     * Sets the terrain the next draws use.
     *
     * @param terrain - The render context of the draw call, or its `terrain`; `null` (or an
     *   object the engine did not hand out) draws without terrain
     */
    setTerrain(terrain: RenderContext | TerrainAnchors | null): void;
    /**
     * Sets the uniforms for offset mode
     */
    setOffsetUniforms(uniforms: OffsetUniforms): void;
    /**
     * Ensures the shader (recreating it when necessary)
     */
    ensureShader(shaderData: {
        vertexShaderPrelude: string;
        define: string;
        variantName: string;
    }): void;
    /**
     * Draws a quad
     *
     * @param vertices The four vertices of the quad (WGS84 coordinates [lng, lat])
     * @param texture The texture
     * @param opacity The opacity
     * @param projectionData MapLibre's ProjectionData
     * @param zoom The current zoom level
     */
    draw(vertices: QuadVertices, texture: WebGLTexture, opacity: number, projectionData: ProjectionData, zoom: number): void;
    /**
     * Disposes of the resources
     */
    dispose(): void;
}

/**
 * The number of elements per glyph in {@link QuadDrapeGlyphs.glyphs}: 8.
 *
 * The occupancy rectangle (x0, y0, x1, y1) and the atlas UV (u0, v0, u1, v1). The
 * occupancy rectangle is in the quad's local 0..1 coordinates.
 */
export declare const QUAD_GLYPH_STRIDE = 8;

// =============================================================================
// 領域: Lines
// =============================================================================

/** The options of one `draw` call of the shared line renderer. */
export interface SDFStrokeOptions {
    /** The unit of the width. The renderer draws `width` in CSS px */
    widthUnit: WidthUnit;
    /** Whether the path is closed (the last position joins the first) */
    closed: boolean;
    /** The id of the feature drawn, for diagnostics */
    featureId?: string;
    /**
     * The zoom at which `width` applies; the width then scales as `width * 2^(zoom -
     * createdZoom)`. When omitted, the width is fixed on screen
     */
    createdZoom?: number;
}

/** The style of a line drawn by the shared line renderer. */
export interface SDFStrokeStyle {
    /** The line width in CSS px (at `createdZoom` when the options give one) */
    width: number;
    /** The color as `[r, g, b, a]`, each 0..1 */
    color: [number, number, number, number];
    /** The opacity, 0..1, multiplied into the color */
    opacity: number;
    /** Solid, dashed or dotted */
    lineStyle: LineStyle;
    /**
     * The dash and gap lengths in CSS px, `[dash, gap]`. When omitted, a preset of `lineStyle`
     * is used
     */
    dashArray?: number[];
}

/**
 * The unit of a line width: screen pixels (CSS px), or meters on the ground converted at the
 * zoom and the latitude.
 */
export type WidthUnit = 'pixels' | 'meters';

/**
 * Returns the dash and gap lengths in px that suit a line style at a line width.
 *
 * Unlike getDashPattern (preset) in shared/math, this computes dynamically from the stroke
 * width.
 *
 * @param lineStyle The line style
 * @param strokeWidth The line thickness at draw time (pixels)
 * @returns [dashLength, gapLength], or null (for a solid line)
 */
declare function getStrokeDashPattern(lineStyle: 'solid' | 'dashed' | 'dotted', strokeWidth?: number): [number, number] | null;
export { getStrokeDashPattern as dashPattern };

/**
 * Splits a line into the pieces of a dash pattern measured in screen pixels at a zoom.
 *
 * Lengths are measured in Web Mercator pixels of 512 px tiles, so the dashes look the
 * specified length on screen at `zoom`. The pattern continues across vertices.
 *
 * @param coords The vertices `[lng, lat]` in degrees
 * @param dashLength The dash length in screen px
 * @param gapLength The gap length in screen px
 * @param zoom The zoom the lengths are measured at
 * @returns The dashes, in order along the line. An empty array for fewer than 2 positions
 */
export declare function splitIntoDashes(coords: Coordinate[], dashLength: number, gapLength: number, zoom: number): DashSegment[];

// =============================================================================
// 領域: Terrain
// =============================================================================

/**
 * Returns the subdivision step of the terrain mesh for the current frame, to cut a shape so
 * that it follows the terrain (pass it to `densifyPath`).
 *
 * @param terrain - The render context of the draw call, or its `terrain`
 * @returns The step, or `null` when the terrain is disabled (or the object was not handed out
 *   by the engine)
 */
export declare function terrainTessellationStep(terrain: RenderContext | TerrainAnchors): TessellationStep | null;

/**
 * Inserts vertices where a line crosses the lattice of the terrain mesh, so that it follows
 * the terrain when each vertex is lifted.
 *
 * The original vertices are always kept, and only the intersections with the lattice lines
 * are inserted. The intersections are found by linear interpolation in Mercator space
 * (rendering also draws a straight line after projection, so an inserted point always lies
 * on the original line).
 *
 * @param path The vertices `[lng, lat]` in degrees
 * @param step The step from {@link terrainTessellationStep}
 * @returns The densified vertices. The input itself for fewer than 2 positions or a step of
 *   0; insertion stops when `step.maxPoints` is reached
 */
export declare function densifyPath(path: readonly Coordinate[], step: TessellationStep): Coordinate[];

// =============================================================================
// 領域: Hit testing
// =============================================================================

/**
 * The built-in hit test of `Point` features: hit within the tolerance of the position.
 *
 * The distance is measured in a local frame around the click, where a degree of longitude is
 * scaled by the cosine of the latitude. A feature type drawn as a point can reuse it, or
 * extend it to widen the hit area. The engine uses it as the hit test of its points.
 */
export declare class PointHitTestStrategy {
    /** The feature type, `'Point'` */
    readonly geometryType: FeatureType;
    /** Whether the feature is within `toleranceLngLat` degrees of the coordinate */
    test(feature: Feature, coordinate: [number, number], toleranceLngLat: number): boolean;
    /** The distance from the coordinate to the feature, in degrees of the local frame */
    distance(feature: Feature, coordinate: [number, number]): number;
}

// =============================================================================
// 領域: Supporting types
// =============================================================================

/**
 * A position as `[longitude, latitude]` in degrees (WGS 84), in the same order as GeoJSON
 */
export type Coordinate = [number, number];

/**
 * The part of a WebGL context {@link applyDrawBlendState} uses; a `WebGL2RenderingContext`
 * satisfies it.
 */
export interface BlendCapableGL {
    /** The `BLEND` capability constant */
    BLEND: number;
    /** The `ONE` blend factor constant */
    ONE: number;
    /** The `SRC_ALPHA` blend factor constant */
    SRC_ALPHA: number;
    /** The `ONE_MINUS_SRC_ALPHA` blend factor constant */
    ONE_MINUS_SRC_ALPHA: number;
    /** Enables a capability */
    enable(cap: number): void;
    /** Sets the RGB and alpha blend factors separately */
    blendFuncSeparate(srcRGB: number, dstRGB: number, srcAlpha: number, dstAlpha: number): void;
}

/** One dash of a dashed line, as returned by {@link splitIntoDashes}. */
export interface DashSegment {
    /** The positions `[lng, lat]` of the dash, at least 2 */
    coords: Coordinate[];
}

/**
 * The locations of the projection and terrain uniforms of one program, as
 * {@link ProjectionUniformManager} looks them up. A location is null when the program does
 * not declare the uniform.
 */
export interface ProjectionUniformLocations {
    /** `u_projection_matrix`: the projection matrix of the frame */
    matrix: WebGLUniformLocation | null;
    /** `u_center_lnglat`: the view center in degrees, rounded to Float32 (offset mode) */
    centerLngLat: WebGLUniformLocation | null;
    /** `u_projection_center`: the view center in clip space (offset mode) */
    projectionCenter: WebGLUniformLocation | null;
    /** `u_units_per_degree`: Mercator units per degree at the center (offset mode) */
    unitsPerDegree: WebGLUniformLocation | null;
    /** `u_units_per_degree2`: the latitude correction of the above (offset mode) */
    unitsPerDegree2: WebGLUniformLocation | null;
    /** `u_use_offset_mode`: 1 to project relative to the center, 0 otherwise */
    useOffsetMode: WebGLUniformLocation | null;
    /**
     * The gap between the reference coordinates of a retained batch and the linearization
     * center (immediate mode uses [0, 0])
     */
    originShift: WebGLUniformLocation | null;
    /** Globe: the Mercator coordinates of the tile (from maplibre's prelude) */
    mercatorCoords: WebGLUniformLocation | null;
    /** Globe: the clipping plane (from maplibre's prelude) */
    clippingPlane: WebGLUniformLocation | null;
    /** Globe: the transition between Mercator (0) and globe (1) */
    transition: WebGLUniformLocation | null;
    /** Globe: the fallback matrix (from maplibre's prelude) */
    fallbackMatrix: WebGLUniformLocation | null;
    /** Terrain: the Mercator coordinates of the view center */
    centerMercator: WebGLUniformLocation | null;
    /** Terrain: 1 while the terrain is drawn, 0 otherwise */
    terrainOn: WebGLUniformLocation | null;
    /** Terrain: the sampler of the DEM atlas */
    demAtlas: WebGLUniformLocation | null;
    /** Terrain: the Mercator rectangle the DEM atlas covers */
    demAtlasRect: WebGLUniformLocation | null;
    /** Terrain: the size of the DEM atlas */
    demAtlasSize: WebGLUniformLocation | null;
    /** Terrain: the parameters of the elevation lookup */
    elevationParams: WebGLUniformLocation | null;
    /** Terrain shading: the light direction (polygon fills only) */
    lightDir: WebGLUniformLocation | null;
    /** Terrain shading: the strength of the shading (polygon fills only) */
    shadeStrength: WebGLUniformLocation | null;
}

/** The four corners of a quad to drape on the terrain, each `[lng, lat]` in degrees. */
export interface DrapeQuadCorners {
    /** The corner at local (0, 0) */
    readonly topLeft: readonly [number, number];
    /** The corner at local (1, 0) */
    readonly topRight: readonly [number, number];
    /** The corner at local (0, 1) */
    readonly bottomLeft: readonly [number, number];
    /** The corner at local (1, 1) */
    readonly bottomRight: readonly [number, number];
}

/** A color as RGBA, each 0..1, not premultiplied. */
export type QuadDrapeColor = readonly [number, number, number, number];

/**
 * The fill of a draped quad: a background color and a border.
 *
 * Painted analytically instead of being baked into a Canvas. The border occupies
 * "borderWidth inward", the same extent as Canvas's
 * `strokeRect(bw/2, bw/2, w - bw, h - bw)`.
 */
export interface QuadDrapeFill {
    /** Background color */
    readonly color: QuadDrapeColor;
    /** Border color */
    readonly borderColor: QuadDrapeColor;
    /** Border width (in the quad's local 0..1 coordinates. Separate for x and y) */
    readonly border: readonly [number, number];
}

/** What {@link drawQuadSurfaceOnTerrain} paints inside a quad: a fill and optional text. */
export interface QuadDrapeSurface {
    /** The fill (background and border) */
    readonly fill: QuadDrapeFill;
    /** Text (null if there is none) */
    readonly text: QuadDrapeGlyphs | null;
}

/**
 * A rectangle in Web Mercator coordinates (0..1 across the world, y growing southward).
 */
export interface MercatorRect {
    /** The west edge */
    readonly x0: number;
    /** The north edge */
    readonly y0: number;
    /** The east edge */
    readonly x1: number;
    /** The south edge */
    readonly y1: number;
}

/**
 * How finely a line or a fill is subdivided to follow the terrain mesh, as
 * {@link terrainTessellationStep} returns it.
 */
export interface TessellationStep {
    /**
     * Lattice interval (in Mercator units)
     *
     * The node interval of MapLibre's terrain mesh, 1/(2^z * meshSize), or that value
     * coarsened by a power of two. Even when coarsened it still sits on a subset of the nodes.
     */
    readonly grid: number;
    /** Upper limit on the number of vertices that may be generated */
    readonly maxPoints: number;
    /**
     * The area that may be tessellated (in Mercator; null means no area = split anywhere)
     *
     * Elevation is read from the DEM atlas, but the atlas only covers the neighbourhood of
     * the view, and outside it the value saturates at the edge value (`dem_elevation_meters`
     * in `shaders/helpers.ts` clamps the uv). In other words, splitting finely outside the
     * atlas only splits a flat surface finely while it stays flat, and the elevation does not
     * change by a single metre.
     *
     * Splitting there anyway was the root of the slowness. With a dataset
     * (8,172 administrative boundaries, all of Japan), the cost of splitting even the features
     * that never appear on screen ate up the batch's tessellation budget, and the uniform
     * coarsening applied to stay within the budget (up to 64x) reached even the features on
     * screen. The chord of a coarse triangle dives below a hill, gets cut away by the depth
     * test, and a hole opens in the fill.
     *
     * So we limit the area we split to the atlas (plus a margin). The cost is decided by how
     * wide the view is and no longer depends on the number of records, so what is on screen
     * can always be split at the finest step.
     */
    readonly region?: MercatorRect | null;
    /**
     * The actual mesh step of each terrain tile (if null, `grid` is used everywhere)
     *
     * MapLibre's terrain is drawn with a fixed lattice per tile, and in a pitched view the
     * more distant the view is, the coarser the zoom of the tiles used. Matching the step to
     * the tile's actual mesh makes our own surface agree with MapLibre's both on the nodes and
     * inside the cells. If it is not matched, too fine a step sinks along the valley bottoms
     * and too coarse a step dives under the ridges, and both are cut away by depth.
     */
    readonly tiling?: TessellationTiling | null;
    /**
     * The coarsening factor applied to the tile step (a power of two; 1 = the actual mesh)
     *
     * Splitting at the actual mesh itself is ideal, but in a wide view the amount to split
     * jumps. As long as we coarsen by a power of two, the split points keep sitting on a
     * subset of the actual mesh nodes, so the problem of sinking along the valley bottoms does
     * not occur (sinking happens when we leave the nodes). What remains is only that the chord
     * dives slightly under a ridge, and that can be covered with a depth bias proportional to
     * the step. Keep the factor small (TERRAIN_MAX_TILED_COARSEN).
     */
    readonly coarsen?: number;
}

/**
 * The subdivision step of each terrain tile, indexed by a grid of cells.
 *
 * The set of tiles is indexed by cells the size of the finest tile. A coarse tile spans
 * several cells, but a cell boundary always lies on one of that tile's mesh lines (the side
 * length of the finest tile is an integer multiple of the mesh interval), so cutting along
 * the cells does not create a seam.
 */
export interface TessellationTiling {
    /** The area the index covers (in Mercator) */
    readonly rect: MercatorRect;
    /** The side length of an index cell (= the side length of the finest tile) */
    readonly cell: number;
    /** The number of cell columns */
    readonly cols: number;
    /** The number of cell rows */
    readonly rows: number;
    /** The step of each cell (0 = there is no tile = do not split) */
    readonly grids: Float64Array;
}

// =============================================================================
// 領域: export されない宣言 (export された宣言が参照する)
// =============================================================================

/**
 * Everything a renderer needs to draw a frame. The offsets are already computed.
 */
interface RenderContext {
    /** The WebGL context of the map */
    readonly gl: WebGL2RenderingContext;
    /** The shader prelude of the current projection */
    readonly shader: ShaderData;
    /** The values for drawing relative to the center of the view */
    readonly offset: OffsetUniforms;
    /** The projection of the frame, as the map passes it to a custom layer */
    readonly projection: ProjectionData;
    /** The zoom of the frame */
    readonly zoom: number;
    /** The pixel ratio of the drawing */
    readonly pixelRatio: number;
    /** The opacity of the layer being drawn, from 0 to 1 */
    readonly opacity: number;
    /**
     * The positions and the heights on the terrain. The building blocks of the `/webgl` entry
     * that draw on the terrain take it, or the whole render context.
     */
    readonly terrain: TerrainAnchors;
    /** The shared renderer of lines */
    readonly line: LineRenderer;
    /** The shared renderer of areas */
    readonly fill: FillRenderer;
    /** The shared renderer of point markers */
    readonly point: PointRenderer;
}

/** The positions and the heights on the terrain, for placing things on it. */
interface TerrainAnchors {
    /**
     * The point on the screen of a position lifted to the ground.
     *
     * @returns The point, or `null` when the terrain is off or not ready
     */
    project(lngLat: Position): ScreenPoint | null;
    /**
     * The height of the ground at a position.
     *
     * @returns The height in meters; 0 when the terrain is off
     */
    elevation(lngLat: Position): number;
    /**
     * The opacity for a mark at a position: lower when the terrain hides it from the camera.
     *
     * @returns A value from 0 to 1; 1 when the terrain is off
     */
    ghostOpacity(lngLat: Position): number;
    /** A number that changes whenever the heights `elevation` returns may have changed. */
    generation(): number;
}

/**
 * The values for drawing positions relative to the center of the view, which keeps the
 * precision of 32-bit floats near the camera.
 */
interface OffsetUniforms {
    /** The center, rounded to 32-bit floats for the shader */
    centerLngLat: [number, number];
    /** The center at 64-bit precision, for the offsets computed on the CPU */
    centerLngLat64: [number, number];
    /** The Mercator coordinates of the center, at 64-bit precision */
    centerMercator: [number, number];
    /** The center of the view in clip space, at 64-bit precision */
    projectionCenter: [number, number, number, number];
    /** The Mercator units per degree of longitude and latitude at the center */
    unitsPerDegree: [number, number, number];
    /** The second-order correction of `unitsPerDegree` for the change with latitude */
    unitsPerDegree2: [number, number, number];
}

/** The dash pattern of a line: solid, dashed or dotted. */
type LineStyle = 'solid' | 'dashed' | 'dotted';

/**
 * The type of a feature: a built-in type, or the name of a custom type.
 *
 * The built-in types are Point, LineString, Polygon, MultiPoint, MultiLineString,
 * MultiPolygon, Circle, Freehand and Image. Any other string names a custom type.
 */
type FeatureType = 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon' | 'Circle' | 'Freehand' | 'Image' | (string & {});

/**
 * A shape that can be drawn and edited, with its layer, group, attributes and look.
 */
interface Feature {
    /** The ID */
    id: string;
    /** The type */
    type: FeatureType;
    /** The GeoJSON geometry */
    geometry: Geometry;
    /** The ID of the layer it is in */
    layerId: string;
    /** The ID of the group it is in */
    groupId: string | undefined;
    /** The GeoJSON properties: the attributes of the user and the values of the library */
    properties: DrawProperties;
    /** The look of the feature */
    style: FeatureStyle;
    /** Whether it is visible */
    visible: boolean;
    /** Whether it is locked */
    locked: boolean;
}

/**
 * The shader prelude the map passes to a custom layer, for compiling programs for the current
 * projection.
 */
interface ShaderData {
    /** The GLSL the map prepends to a vertex shader (its projection functions) */
    vertexShaderPrelude: string;
    /** The `#define` lines of the current projection */
    define: string;
    /** The name of the projection variant; a program is compiled again when it changes */
    variantName: string;
}

/**
 * The shared renderer of lines. It only draws; the zoom, the projection and the terrain come
 * from the {@link RenderContext} it was taken from.
 */
interface LineRenderer {
    /**
     * Draws a line.
     *
     * @param coordinates - The positions of the line
     * @param style - The width in pixels, the CSS color, the opacity from 0 to 1, the dash
     *   pattern, and a custom `[dash, gap]` in pixels
     * @param options - `closed` joins the last position to the first; `widthUnit` says whether
     *   the width is in pixels or meters; `createdZoom` is the zoom at which the width applies,
     *   so that the line grows and shrinks with the zoom
     */
    draw(coordinates: readonly Position[], style: {
        width: number;
        color: string;
        opacity: number;
        lineStyle: LineStyle;
        dashArray?: number[];
    }, options?: {
        closed?: boolean;
        widthUnit?: 'pixels' | 'meters';
        createdZoom?: number;
    }): void;
}

/**
 * The shared renderer of areas. It only draws; the zoom, the projection and the terrain come
 * from the {@link RenderContext} it was taken from.
 */
interface FillRenderer {
    /**
     * Fills an area.
     *
     * @param rings - The outer ring first, then the holes
     * @param style - The CSS color and the opacity from 0 to 1
     */
    draw(rings: readonly (readonly Position[])[], style: {
        color: string;
        opacity: number;
    }): void;
}

/**
 * The shared renderer of point markers. It only draws; the zoom, the projection and the
 * terrain come from the {@link RenderContext} it was taken from.
 */
interface PointRenderer {
    /**
     * Draws a point marker.
     *
     * @param position - The position
     * @param style - The shape, the size in pixels, the fill and the outline (CSS colors,
     *   opacities from 0 to 1, the outline width in pixels)
     * @param options - `elevationMeters` places the marker at this height instead of on the
     *   ground
     */
    draw(position: Position, style: {
        shape: PointShape;
        size: number;
        fillColor: string;
        fillOpacity: number;
        strokeColor: string;
        strokeWidth: number;
        strokeOpacity: number;
    }, options?: {
        elevationMeters?: number;
    }): void;
}

/** A point on the screen, as `[x, y]` in CSS pixels. */
type ScreenPoint = [number, number];

/**
 * The `properties` of a feature: the GeoJSON properties themselves, with the keys of the
 * library typed.
 *
 * A key that starts with {@link DRAW_PROPERTY_PREFIX} holds a value of the library; any other
 * key is an attribute of the user. Export and load keep the keys as they are.
 */
type DrawProperties = Record<string, unknown> & {
    /** The reference zoom: the zoom the feature was drawn or created at */
    'maplibre-gl-draw:createdZoom'?: number;
    /** The rotation, in degrees */
    'maplibre-gl-draw:rotation'?: number;
    /** The scale factor */
    'maplibre-gl-draw:scale'?: number;
    /** The radius of a circle, in meters */
    'maplibre-gl-draw:radiusMeters'?: number;
    /** The direction of the radius handle of a circle, in degrees */
    'maplibre-gl-draw:radiusHandleAngle'?: number;
    /** The ID of the file of an image feature */
    'maplibre-gl-draw:imageFileId'?: string;
    /** The width of the image of an image feature, in pixels */
    'maplibre-gl-draw:imageWidth'?: number;
    /** The height of the image of an image feature, in pixels */
    'maplibre-gl-draw:imageHeight'?: number;
};

/**
 * How a feature looks; every key is optional, and a key left out takes the value of the
 * layer rule or the default.
 *
 * Colors are CSS colors. Widths and radii are in CSS pixels at the reference zoom of the
 * feature.
 */
interface FeatureStyle {
    /** The fill color */
    fillColor?: string;
    /** The opacity of the fill, from 0 to 1 */
    fillOpacity?: number;
    /** The color of a line or of the outline of an area (`pointStrokeColor` for a point) */
    strokeColor?: string;
    /**
     * The width of a line or of the outline of an area, in pixels at the reference zoom
     * (`pointStrokeWidth` for a point)
     */
    strokeWidth?: number;
    /** The opacity of a line or of the outline of an area, from 0 to 1 */
    strokeOpacity?: number;
    /** The dash pattern of a line or an outline */
    lineStyle?: LineStyle;
    /** The color of a point marker */
    pointColor?: string;
    /** The radius of a point marker, in pixels */
    pointRadius?: number;
    /** The shape of a point marker */
    pointShape?: PointShape;
    /** The opacity of a point marker, its fill and its outline, from 0 to 1 */
    pointOpacity?: number;
    /** The color of the outline of a point marker; `#ffffff` by default */
    pointStrokeColor?: string;
    /** The width of the outline of a point marker, in pixels (0 for none); 2 by default */
    pointStrokeWidth?: number;
    /** The opacity of an image, from 0 to 1 */
    imageOpacity?: number;
}

/** The shape of a point marker. */
type PointShape = 'circle' | 'square' | 'triangle' | 'star';
