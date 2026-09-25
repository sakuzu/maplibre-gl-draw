# Coordinate precision

This document describes how the library keeps features in place at high
zoom levels, how the same coordinates serve globe mode, pitch and roll,
how the selection UI stays aligned with what is drawn, and how a view
across the antimeridian is drawn and hit-tested.

The offset projection follows deck.gl's approach; the copyright notice for
the ported parts is in `THIRD_PARTY_NOTICES.md` at the root of the
repository.

## Coordinate systems

Data, computation and hit testing are done in geographic coordinates
(longitude and latitude). Only at render time do maplibre's matrices and
the renderers turn them into screen positions, with pitch, roll and globe
mode applied.

- Data is geographic. The coordinates of a feature, bounding boxes and
  handle positions are all longitude and latitude, and so is what the
  Store holds
- Computation is geographic. A value given in pixels (a margin, an icon
  size, a frame around a point) is measured once in screen coordinates and
  converted back to geographic coordinates before it is kept. For example,
  `applyMarginToBoundingBox` measures the margin in pixels but returns a
  geographic bounding box
- Renderers receive geographic coordinates and project them in the vertex
  shader with the projection data of the frame
- Hit testing starts from geographic coordinates. The click is unprojected,
  and containment and distances are decided in a local frame around it.
  The exceptions are the handles of the selection UI and the symbols on
  terrain, which are tested in screen space against positions projected
  with the same transform the drawing uses (see
  [Hit testing](./hit-testing.md))

As a result, everything tilts and bends with the map under pitch, roll and
globe mode without special cases, and drawing and hit testing agree.

## The problem: Float32 at high zoom

WebGL shaders compute in Float32, which has about 7 significant digits. A
location near Tokyo Station is about (139.7671248, 35.6812362), or
(0.88824, 0.39891) in normalized Mercator units. At zoom 20 one pixel is
about 0.15 m, which is a change in the eighth or ninth digit of those
Mercator values. Projecting absolute coordinates in Float32 cannot resolve
that, and the symptoms are:

- Features tremble while they are dragged
- Features distort while they are rotated
- The selection UI and the feature it frames do not line up

## The offset method

The shader never sees absolute coordinates at high zoom. The CPU, which
computes in 64 bits, subtracts the viewport center from every vertex, and
the GPU projects only the small difference.

```text
Absolute (loses precision):
  GPU: gl_Position = matrix * mercator(lngLat)

Offset (precise):
  CPU: offset = lngLat - centerLngLat           (64-bit)
  GPU: gl_Position = matrix * toMercatorUnits(offset)
                   + projectionCenter           (Float32, small values)
```

### The uniforms

`calculateOffsetUniforms(centerLngLat, mainMatrix)` in
`src/view/shaders/helpers.ts` computes the uniforms of the frame:

- `centerLngLat`: the viewport center rounded to Float32, sent to the
  shader
- `centerLngLat64`: the same center in 64 bits, used for the offsets on the
  CPU
- `centerMercator`: the center in Mercator units (64 bits), used by the
  terrain to place the DEM atlas relative to the center
- `projectionCenter`: the center in clip space
- `unitsPerDegree`: the factor from degrees to Mercator units at the
  center
- `unitsPerDegree2`: the second-order correction for the change of that
  factor with latitude (a port of `getDistanceScales` from
  `@math.gl/web-mercator`)

`calculateLngLatOffset(lngLat, centerLngLat)` is the subtraction on the
CPU. A JavaScript number is a 64-bit float, and the result is small, so it
survives the conversion to Float32.

### The shader side

`OFFSET_MODE_GLSL` in the same file holds the shader functions. The core of
the offset path:

```glsl
// Relative degrees to Mercator units (second order in latitude)
vec3 project_offset(vec3 offset) {
    float dy = offset.y;
    vec3 unitsPerDegree = u_units_per_degree + u_units_per_degree2 * dy;
    return offset * unitsPerDegree;
}

vec4 project_offset_to_clipspace(vec2 lngLatOffset, mat4 viewProjectionMatrix) {
    vec3 mercatorOffset = project_offset(vec3(lngLatOffset, 0.0));
    // The terrain elevation goes into z (0 without terrain)
    mercatorOffset.z = terrain_elevation_from_offset(mercatorOffset.xy);
    vec4 offset = vec4(mercatorOffset, 0.0);
    return viewProjectionMatrix * offset + u_projection_center;
}
```

The renderers call `project_position_to_clipspace_from_offset`, which
chooses the path:

```glsl
vec4 project_position_to_clipspace_from_offset(
    vec2 lngLatOffset, mat4 viewProjectionMatrix) {
    // Origin of a retained batch minus the screen center ((0,0) otherwise)
    vec2 shifted = lngLatOffset + u_origin_shift;
    // Globe mode: maplibre's projection
    if (u_projection_transition > 0.0) {
        vec2 mercator = lngLatToMercator(shifted + u_center_lnglat);
        return projectTileWithElevation(mercator,
                                        terrain_elevation_at(mercator));
    }
    // High zoom: the offset path
    if (u_use_offset_mode > 0.5) {
        return project_offset_to_clipspace(shifted, viewProjectionMatrix);
    }
    // Low zoom: maplibre's projection
    vec2 mercator = lngLatToMercator(shifted + u_center_lnglat);
    return projectTileWithElevation(mercator, terrain_elevation_at(mercator));
}
```

`projectTileWithElevation` at elevation 0 gives the same result as
maplibre's `projectTile()`. `ProjectionUniformManager`
(`src/view/shaders/projection.ts`) writes `u_use_offset_mode` as 1 at
zoom 12 and above and 0 below. At low zoom the precision problem does not
arise, and the absolute path avoids the approximation error of the offset
path for data that covers a wide area.

Every program reads its textures at highp. GLSL ES 3.00 gives `sampler2D`
no default precision other than lowp, and a lookup returns the precision of
its sampler, which would quantize the coordinates in the line texture and
the elevations of the DEM atlas on GPUs that honour it. `createProgram`
inserts `precision highp sampler2D;` into both stages of every program
(`withSamplerPrecision`), so no shader source can leave it out.

## Renderers

Every renderer that draws geometry takes the same path: it receives the
offset uniforms of the frame through `setOffsetUniforms`, computes relative
coordinates on the CPU, and projects them with
`project_position_to_clipspace_from_offset`.

| Renderer | Draws |
| --- | --- |
| `PointInstanceRenderer` | Points |
| `PointShapeRenderer` | Handles of the selection UI |
| `StrokeRenderer` | Outline of the selection UI |
| `SDFLineRenderer` | LineString, Freehand (via a texture) |
| `PolygonBatchRenderer` | Polygon fills |
| `SDFPolygonRenderer` | Polygon fill and stroke |
| `FillShaderManager` | Fill of a polygon being drawn |
| `QuadShader` | Images |

The uniforms are computed once per frame, from the map center and the main
matrix of maplibre's projection data, and distributed to every renderer
with `ShaderInitializer.applyOffsetUniforms()` (`buildFrameState` in
`src/view/layer/frame-state.ts`). The frame and its batches are described
in [Rendering](./rendering.md).

### Immediate drawing

What is drawn immediately (the selection UI, the polygon being drawn, and
features that cannot be retained) computes its relative coordinates again
every frame, because the screen center moves from frame to frame and an
offset from last frame's center is useless. The triangulation of a polygon
is cached per feature and part, since indices refer to vertices, not to
coordinate values, and stay valid when the center moves.

### The origin of a retained batch

Retained batches (the Store's `src/view/layer/store-retained.ts` and the
datasets in `src/display/`) do not recompute offsets every
frame. Each chunk has its own origin, and the coordinates relative to that
origin are baked into the vertex buffer once, independent of the camera.
Only the projection uniforms change per frame.

- A Store chunk takes the center of its extent. Runs are cut in draw order,
  so the contents of a chunk are not necessarily close together in space
- A dataset chunk takes the center of the bounding box of
  its spatial chunk

Both are rounded to Float32. The baked `vertex - origin` and the uniform
`u_origin_shift` (origin minus screen center) are both rounded to 24 bits
and added on the GPU, so a vertex on screen is off by about
`2^-24 x (|vertex - origin| + |origin - center|)`. That error is fixed in
degrees, so it doubles on screen with every zoom level, and the part from
the shift changes as the camera pans. The rule is that the error for the
part of the chunk on screen stays within 0.1 px
(`RETAINED_ORIGIN_TOLERANCE_PX`). When a chunk seen at high zoom far from
its origin would exceed it, the chunk is rebuilt with the center of its
visible region as the origin (`rebasedRetainedOrigin` in
`src/view/shaders/retained-origin.ts`). Below about zoom 16 a chunk several
degrees wide stays within the tolerance, and the origin chosen for the
view is kept across rebuilds caused by data changes.

The center of linearization stays at the screen center, not at the chunk
origin. The Mercator conversion of the offset path is a second-order
approximation around its center, and its error grows with the cube of the
latitude difference from that center. A chunk cut in draw order can span a
wide area, so linearizing around its origin would displace vertices far
from it by many pixels at high zoom. Instead the screen-center uniforms of
the frame are used as they are, and `u_origin_shift` is added to the
vertex's relative coordinate first. That moves only the center of
linearization to the screen center, without changing the baked data. The
vertices in view are always near the screen center, so the approximation
error stays invisible at every zoom. In immediate drawing the shift is
(0, 0).

## Globe mode

maplibre's globe projection is supported with the same data.

- When `u_projection_transition` is greater than 0, the map is in globe
  mode (or transitioning to it), and the shader restores the absolute
  coordinate and uses maplibre's projection (`projectTileWithElevation`)
- Globe mode is used mainly at low zoom, where Float32 is precise enough,
  so the offset path is not needed there
- The globe uniforms (`u_projection_tile_mercator_coords`,
  `u_projection_clipping_plane`, `u_projection_transition`,
  `u_projection_fallback_matrix`) come from maplibre's prelude and are set
  directly from `ProjectionData`
- The data is the same, but the edges are cut finer on the globe: two
  projected vertices would be joined by a chord through the sphere, so an
  edge is cut along the Mercator plane before it is projected, as maplibre
  cuts its own layers (`shared/math/globe-subdivision.ts`; see
  [Edges on the globe](./rendering.md#edges-on-the-globe)). The points a
  cut adds are computed in 64 bits on the CPU, or, for the stations of a
  line, from the Float32 offsets on the GPU, which is precise enough at the
  zooms of the globe

## Pitch and roll

maplibre's projection matrix already contains pitch and roll. Because
features, the selection frame and the handles are all defined in
geographic coordinates and projected in the shader, they follow pitch and
roll with no extra work.

The rule that follows is that nothing on the map is drawn in screen
coordinates. A frame or handle laid out in pixels would stay flat while the
map tilts under it; laid out in geographic coordinates, it tilts with the
map. Pixel sizes are honored by converting them to geographic coordinates
around the feature, as in "Coordinate systems" above.

## The selection UI

The selection UI (the frame, the resize handles, the rotate handle, the
vertex and midpoint handles) is drawn with the same architecture:

1. The bounding box is computed in geographic coordinates; for a rotated
   Image it is the oriented box
2. `applyMarginToBoundingBox()` adds the margin, measured in pixels and
   converted to geographic coordinates
3. `StrokeRenderer` draws the frame and `PointShapeRenderer` the handles,
   both with relative coordinates computed on the CPU

### Agreement with hit testing

The handles are hit-tested in screen coordinates
(`src/view/ui/handle-test.ts`): each handle position is projected to the
screen and the pointer is compared with the handle rectangle.

The transform on both sides is the same `CoordinateTransform`, built from
the map by `createCoordinateTransform` in `src/shared/math/transform.ts`.
The drawing uses it to lay out the pixel-sized parts (the margin, the
handle positions) in geographic coordinates, and the hit test uses it to
project those same positions back to the screen. maplibre's `project()`
runs in 64 bits on the CPU, and the offset path of the shader resolves the
same point to well under a pixel, so a handle is hit where it is drawn at
every zoom.

With terrain, `project` goes through the anchor projection of the frame
(`setAnchorProjector`, implemented by `src/view/terrain/anchor.ts`), the
same projection, elevation and matrix the vertex shader uses for points and
handles. The drawn position and the hit region then agree by construction,
and hit testing does not call `map.project` per vertex (which is fast inside
the rendered tiles but slow outside them, where hit testing and bounding
boxes also project; see item 9 of maplibre-coupling.md).

## The antimeridian

The features are stored with longitudes in [-180, 180], and the offset is
the difference from the camera center (`lng - centerLng`), computed in 64
bits on the CPU. A view across the antimeridian is continuous (maplibre
reports it with unwrapped longitudes, 170 to 190 for example), so it shows
two copies of the world: the stored copy, and the copy moved by 360 degrees
that shows the stored longitudes on the other side of the line.

### Drawing

Each frame draws one pass per copy in view (`splitLongitudeCopies` in
`src/view/viewport.ts`). Away from the line that is the stored copy alone.
Across it, the features of the other side are drawn a second time through a
virtual camera:

- The center moves by `-lngShift` (179.95 becomes -180.05), so every offset
  the CPU computes against it comes out next to the camera: a point stored
  at -179.9 gets an offset of 0.15, not -359.85
- The matrix moves by `+lngShift` (`M' = M * T(lngShift / 360)` in Mercator
  units, `translateMatrixByLongitude` in `src/view/shaders/helpers.ts`), so
  the two cancel for the camera: `calculateOffsetUniforms` gives the same
  projection center, and the absolute path of the shader (low zoom) moves
  by the same amount
- The DEM atlas is handed to the shader in the frame of that camera

The CPU and the GPU use the same formula, and the shift is a whole number
of turns added in 64 bits, so no precision is lost. Each copy draws the
part of the view it shows (its range thins the chunks and the features), so
a feature is drawn once, on the copy the view shows it on. The selection UI
and the overlays are drawn per copy as well.

The offset is not normalized vertex by vertex into ±180. That would tear
every feature that straddles the meridian opposite the camera: its vertices
would land on both ends of the range, and the edges between them would run
across the whole view. A copy moves every vertex of a feature by the same
turn.

The world copies that maplibre renders at low zoom (`renderWorldCopies`)
are not replicated: when the view is 360 degrees wide or more, a feature is
drawn once, on the stored copy.

### Hit testing, handles and snapping

The pointer unprojects to the unwrapped longitude of the view (above 180 on
the copy east of the line), and every test must meet the copy drawn under
it. The alignment is made in the local frame of each test, around the
pointer:

- `HitTestService` and the unified z traversal test the click on each copy
  of the world it can reach (`clickCopies` in
  `src/dispatcher/hit-test/local-frame.ts`): the click brought into
  [-180, 180], plus the click on the neighbouring copy when its reach runs
  past ±180. A feature hit on several copies counts with its nearest
  distance
- The handle test projects every longitude on its copy nearest to the
  pointer (`alignToPointer` in `src/view/ui/handle-test.ts`), and its
  pre-filtering rectangle compares in the same frame. With terrain, the
  anchor projection (`src/view/terrain/anchor.ts`) takes the copy nearest
  to the camera, which is the copy the anchor is drawn on
- Snapping looks candidates up around the cursor brought into [-180, 180]
  (and on the neighbouring copy) and takes each candidate on its copy
  nearest to the cursor, so the snapped position is in the frame of the
  cursor while the target keeps its stored coordinates
  (`src/snapping/service.ts`)

Away from the antimeridian nothing moves. When the view is 360 degrees wide
or more, a click on an undrawn world copy still reaches the feature stored
under it. Box selection queries the unwrapped rectangle as it is, so a box
across the line does not select the features of the other side.

### What the input stores

The InputRouter is the one entry for coordinates. It brings the longitude
of every event onto the stored copy before snapping and before a mode sees
it (`toStoredCopy` in `src/dispatcher/input-router.ts`):

- A click, a move or a press lands in [-180, 180], the same point
  `clickCopies` starts from
- While a shape is being drawn, the pointer goes to the copy nearest to the
  first vertex of the shape, so a line drawn from 170 to 190 stays 170,
  190 rather than running the other way round the world
- A drag moves all its events by the one shift decided where it started

Synthetic input (`draw.input`) takes the same path, so what a mode stores
never carries the longitude of a world copy. A feature drawn across the
line can carry longitudes a little beyond ±180, which the rendering draws
on the copy that shows them. GeoJSON export brings them back into
[-180, 180] position by position, without cutting the geometry at the line
(see [Data format](../reference/data-format.md)).

## Troubleshooting

### Features tremble

- Check that the offset uniforms of the frame reach the renderer
  (`setOffsetUniforms`)
- Check that `u_use_offset_mode` is 1 at zoom 12 and above
- Check that the renderer computes relative coordinates with
  `calculateLngLatOffset` on the CPU rather than sending absolute ones
- For a retained batch, check that `u_origin_shift` is the origin minus
  the screen center of this frame

### Features are missing or far off

- A renderer whose offset uniforms are not set falls back to a center of
  (0, 0), and a center that differs from the real viewport center
  displaces the drawing by the difference

### The display is wrong in globe mode

- Check that `u_projection_transition` is set from the projection data
- In globe mode the absolute path (`projectTileWithElevation`) must be
  used, not the offset path
- An edge that cuts across the sphere instead of following its parallel or
  meridian was drawn without the cut of the globe: check that the renderer
  takes its step from `getSurfaceTessellationStep` and that the terrain
  context has the cells of the frame (`updateGlobeSubdivision`)

### The selection UI does not line up

- Check that the drawing and the hit test build their transform the same
  way (`createCoordinateTransform`), so both go through the anchor
  projection when terrain is on
- Check that pixel-sized parts are converted to geographic coordinates
  before they are drawn, not drawn in screen coordinates
