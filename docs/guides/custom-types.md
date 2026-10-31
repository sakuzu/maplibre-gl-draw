# Custom feature types

Besides the built-in types (`Point`, `LineString`, `Polygon`, the Multi
types, `Circle`, `Freehand` and `Image`), a draw instance can hold
features of a type you define. One definition, a
`FeatureTypeDefinition`, says how the type is drawn and hit, and
optionally how it is selected, reshaped and snapped to. Around it are
three more kinds of extension for things that are not features of your
own type: overlays, which draw above the features, and providers, which
add snapping candidates, handles and companions to any type.

The renderers receive the WebGL context of the map, but most of them
draw through the shared renderers of the library and write no shader.

## The smallest example

A `Route` type: a line drawn dashed in a fixed color.

```ts
import type { Feature, FeatureTypeDefinition, Position } from '@sakuzu/maplibre-gl-draw';
import type { LineString } from 'geojson';

function verticesOf(feature: Feature): Position[] {
  return (feature.geometry as LineString).coordinates;
}

const route: FeatureTypeDefinition = {
  type: 'Route',
  geometry: 'LineString',
  renderer: {
    onAdd() {},
    draw(feature, ctx) {
      ctx.line.draw(verticesOf(feature), {
        width: 3,
        color: '#e64d1a',
        opacity: ctx.opacity,
        lineStyle: 'dashed',
      });
    },
    onRemove() {},
  },
};

const removeRoute = draw.extensions.featureTypes.add(route);

draw.features.create({
  type: 'Route',
  geometry: {
    type: 'LineString',
    coordinates: [
      [139.7, 35.68],
      [139.72, 35.69],
      [139.74, 35.68],
    ],
  },
});
```

The route appears as an orange dashed line in the active layer, in its
place in the stacking order, and a click on it selects it: without a
`hitTest` of its own, a type is hit like its geometry. `removeRoute()`
takes the definition back. The features of the type stay in the
document, but they are neither drawn nor hit until the type is added
again.

## How a custom type is stored

A feature of a custom type is an ordinary feature whose `type` is the
name of the type and whose `geometry` is a GeoJSON geometry of the kind
the definition names. It is created, changed, saved and loaded like any
other feature.

- The native format keeps the type as it is
- GeoJSON has no type of its own for it, so the export writes the
  geometry with the name of the type in the property
  `maplibre-gl-draw:featureType`. Loading the file restores the type,
  whatever the kind of the geometry
  ([data format](../reference/data-format.md))
- The names of the built-in types are taken:
  `draw.extensions.featureTypes.add` throws `already-exists` for them.
  To change how a built-in type is drawn, override it
  ([overriding a built-in type](#overriding-a-built-in-type))

A mode that creates a feature of the type with `commitFeature` gives it
an automatic name. Its word is the name of the type unless the host
gives one in `autoName.typeNames` under the same key, so a type that is
shown to users should say its name in its documentation, for the host
to translate ([automatic names](drawing.md#names-in-another-language)).

A renderer often needs values of its own for each feature, such as the
size of a marker. Keep them in `style` or in `properties` under keys
that the library does not define. They are stored, exported and loaded
back as they are, and the library does not check them, so the renderer
checks a value before it uses it. Declare the style keys for TypeScript
by declaration merging:

```ts
declare module '@sakuzu/maplibre-gl-draw' {
  interface FeatureStyle {
    routeEnds?: 'none' | 'dot';
  }
}

const ends = feature.style.routeEnds === 'dot' ? 'dot' : 'none';
```

## The renderer

A `FeatureRenderer` has three methods, in the order of a MapLibre
custom layer:

- `onAdd(map, gl)` is called when the renderer is put on the map. A
  renderer that has GL objects of its own creates them here
- `draw(feature, ctx)` is called once for every visible feature of the
  type, in the place of the feature in the stacking order, so what it
  draws lands between the features behind and in front
- `onRemove(map, gl)` releases what `onAdd` created

`onAdd` and `onRemove` can arrive more than once: the drawing is torn
down and built again when the map changes its style and when the WebGL
context is lost and restored. Accept `onAdd` again after `onRemove`.

The `RenderContext` carries what a renderer needs to draw:

- `line`, `fill` and `point`, the shared renderers of lines, areas and
  point markers. They take positions in degrees, CSS colors, and sizes
  in pixels, and they follow the projection and the terrain by
  themselves
- `opacity`, the opacity of the layer of the feature, from 0 to 1. The
  shared renderers do not apply it by themselves: multiply it into the
  opacity you pass, so that the feature fades with its layer
- `screen`, the conversion between positions and points of the screen
  in the frame being drawn (`project`, `unproject`, `metersPerPixel`),
  its `zoom` and its `pixelRatio`: the same object as `ctx.screen` of a
  plugin, which answers for the frame drawn last once it is drawn. Use
  `screen.pixelRatio` rather than `window.devicePixelRatio`, and read
  the screen from the context rather than keeping one from elsewhere
- `terrain`, the heights of the ground (see [Terrain](#terrain))
- `gl`, the WebGL context, for a renderer that writes its own shaders,
  which reads the values of the GPU of the frame through `/webgl` (see
  [Your own shaders](#your-own-shaders))

A type that fills an area and outlines it:

```ts
import type { FeatureRenderer } from '@sakuzu/maplibre-gl-draw';
import type { Polygon } from 'geojson';

const zoneRenderer: FeatureRenderer = {
  onAdd() {},
  draw(feature, ctx) {
    const rings = (feature.geometry as Polygon).coordinates;
    const color = feature.style.fillColor ?? '#2563eb';
    ctx.fill.draw(rings, { color, opacity: 0.2 * ctx.opacity });
    for (const ring of rings) {
      ctx.line.draw(
        ring,
        { width: 2, color, opacity: ctx.opacity, lineStyle: 'dotted' },
        { closed: true },
      );
    }
  },
  onRemove() {},
};

draw.extensions.featureTypes.add({
  type: 'Zone',
  geometry: 'Polygon',
  renderer: zoneRenderer,
});
```

The line renderer takes a width in pixels by default.
`widthUnit: 'meters'` gives it in meters on the ground, and
`referenceZoom` makes the line grow and shrink with the zoom from the
width it has at that zoom. The point renderer takes `referenceZoom` too,
for the size and the outline of its marker: a marker of a feature that
keeps its size on the map passes the zoom the feature keeps
(`maplibre-gl-draw:createdZoom`).

When the view crosses the ±180 degree meridian, a drawing shows each
copy of the world, and `draw` is called once per copy. Compute what you
draw from the feature and the context, not from the camera of the map,
and it lands on the right copy.

## Hit testing

Without `hitTest`, a feature of the type is hit like its geometry: a
line near the pointer, an area under it. `hitTest(feature, ctx)`
replaces that. It receives the point on the screen, its position on the
map, the click tolerance in pixels and `screen` to project positions,
and it returns a `Hit` or `null`:

<!-- docs-check:
declare function verticesOf(feature: Feature): Position[];
declare const routeRenderer: import('@sakuzu/maplibre-gl-draw').FeatureRenderer;
-->

```ts
import type { FeatureTypeDefinition, ScreenPoint } from '@sakuzu/maplibre-gl-draw';

/** The distance from a point to a segment, in pixels */
function segmentDistance(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const dot = (p[0] - a[0]) * dx + (p[1] - a[1]) * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, dot / len));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

const hitRoute: FeatureTypeDefinition = {
  type: 'Route',
  geometry: 'LineString',
  renderer: routeRenderer,
  hitTest(feature, ctx) {
    const points = verticesOf(feature).map((v) => ctx.screen.project(v));
    let best = Number.POSITIVE_INFINITY;
    for (let i = 1; i < points.length; i++) {
      const d = segmentDistance(ctx.point, points[i - 1], points[i]);
      best = Math.min(best, d);
    }
    if (best > ctx.tolerancePx) return null;
    const id = feature.id;
    return { kind: 'feature', id, distancePx: best };
  },
};
```

- The candidates of a hit test are gathered by the extent of each
  feature, widened by the tolerance. A type that is hit farther from
  its geometry, such as a marker drawn around a point, sets
  `hitPaddingPx` to that distance, so that its features are not left
  out before `hitTest` sees them
- A type that draws beyond its geometry by a distance on the ground,
  such as a disc of a given radius around a point, returns that extent
  from `bbox(feature)` as `[west, south, east, north]` in degrees. The
  spatial index takes it in place of the extent of the geometry, for
  the candidates of a hit test and of a box selection, for
  `features.list({ bbox })`, and to decide which features are near
  enough to the view to be drawn
- The extent follows the document: it is measured again whenever a
  feature changes. When it depends on something outside the document,
  call `ctx.invalidate({ type: 'Route' })` from a plugin when that
  changes
- `boxSelect(feature, boxPx, ctx)` decides whether a selection box takes
  a feature, with the box in pixels. Without it the geometry decides

## Selection and handles

The other members of a definition are optional:

| Member | Without it |
| --- | --- |
| `footprint` | The footprint of the geometry |
| `handles` | The type has no handles of its own |
| `onHandleDrag` | A drag of its handles changes nothing |
| `snapCandidates` | The vertices and edges of the geometry |

`footprint(feature, ctx)` says what a feature covers, and the library
makes the selection box from it: it draws the box, hits it, and places
the resize and rotate handles on it. It returns one of two kinds, and the
kind, not the geometry, decides how the box is drawn and hit:

- `{ kind: 'ground', corners: { topLeft, topRight, bottomRight,
  bottomLeft } }`, four positions on the map, in the order of the shape
  as it stands unturned, for a shape drawn on the map, such as a box
  drawn at an angle. The selection box is drawn and hit on the map, with
  the resize and rotate handles on its corners and edges, and it tilts
  and turns with the map. `ground` names the plane of the map here, not
  the surface of the terrain
- `{ kind: 'screen', position, halfWidthPx, halfHeightPx }`, a box of a
  fixed size on the screen around a position on the map, for a mark that
  keeps its size on the screen. The selection box is drawn and hit on
  the screen around the position, the way a point marker is, so it keeps
  its size on a pitched view and is hidden with the marker behind the
  globe. It has no resize or rotate handles

It returns `null` for a feature with nothing to draw, which has no
selection box. Without `footprint`, or when it returns anything else
than the two kinds, the footprint is that of the geometry: the extent of
its positions, or a box the size of a point marker around a single
position. A size kept with a zoom, such as a box drawn at the zoom it was
made at, is laid on the map with `pixelsToMeters` and `metersToDegrees`
of `/geometry`, the formula the library draws such sizes by.

The footprint does not include the margin of the selection box
(`selectionStyle.box.margin`, 10 pixels by default). The library adds it:
every edge of the box stands the margin outside the footprint, for every
type, points included. A box of the screen takes the margin on the
screen. A box on the map takes it on the map: the margin is turned into
meters at the feature with `ctx.screen.metersPerPixel` and laid on the
ground, so the box tilts and turns with the map. Something you draw
around a feature for the current view, such as a handle out of its box,
stands where the library would put it when you lay its pixels on the
ground the same way, and your hit test then finds it where it is drawn.

`handles` returns the handles of a selected feature, each with an ID,
a position and a cursor. A drag of one calls `onHandleDrag` for every
move of the pointer and once more when the drag ends, and the
`FeaturePatch` it returns is applied to the feature. The patches of the
moves are intermediate updates; the one of the end is the one that
stays:

<!-- docs-check:
declare function verticesOf(feature: Feature): Position[];
declare const routeRenderer: import('@sakuzu/maplibre-gl-draw').FeatureRenderer;
-->

```ts
import type { FeatureTypeDefinition } from '@sakuzu/maplibre-gl-draw';

const reshapeRoute: FeatureTypeDefinition = {
  type: 'Route',
  geometry: 'LineString',
  renderer: routeRenderer,
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
```

The library draws the handles of the selected feature with the look of
its vertex handles (the `vertexHandle` of `selectionStyle`), hit tests
them at the same size, and hands the drag over. The handles are hidden
while another handle is dragged, and nothing is shown or dragged while
the drawing is read-only, under the interaction lock, or while the
feature is locked.

`onHandleDragStart(feature, handle, event)` is asked before a drag of
a handle starts; it returns `false` to refuse the drag, and the pointer
then does what it would do without the handle.
`onHandleDragEnd(feature, handle, event)` is called once after the
last `onHandleDrag` of a drag that started, with the feature as it is
then (or `null` when it is gone), also when the drag is cut short. Use
them for what a drag holds from its start to its end, such as a value
measured when it starts.

`snapCandidates` returns the positions a pointer snaps to near a
feature of the type, in place of the vertices and edges of its
geometry.

## Overriding a built-in type

`draw.extensions.featureTypes.override(definition)` puts a definition
in the place of a built-in type of the same name: `Point`,
`LineString`, `Polygon`, `Circle`, `Freehand` or `Image`. The
definition has the `geometry` the built-in type holds (`Point` for a
circle and an image, `LineString` for a freehand line). The features
of the type are then drawn by its renderer. Its `hitTest`, `boxSelect`,
`footprint`, `bbox` and `snapCandidates` replace those of the
built-in type when it has them; for the members it leaves out, the
built-in type keeps its own. Its `handles` are shown with the handles
of the built-in type:

<!-- docs-check:
declare const draw: import('@sakuzu/maplibre-gl-draw').Draw;
declare const pointRenderer: import('@sakuzu/maplibre-gl-draw').FeatureRenderer;
-->

```ts
const restore = draw.extensions.featureTypes.override({
  type: 'Point',
  geometry: 'Point',
  renderer: pointRenderer,
});

// The built-in points come back
restore();
```

The returned function, `remove('Point')` and the removal of a plugin
that overrode the type through its context all put the built-in type
back. `add` keeps refusing the names of the built-in types, and a type
that is already overridden cannot be overridden again until it is put
back.

`appliesTo(feature)` narrows an override to some features of the type,
such as the points that carry an icon. A feature for which it returns
false keeps the built-in type entirely: it is drawn in batches with the
other built-in features, and keeps the built-in hit test, box
selection, frame, handles, snapping candidates and extent. The others
are drawn and hit by the definition. It is asked again whenever a
feature changes, so its answer follows from the feature alone. `add`
ignores it: a custom type takes every feature of its type.

<!-- docs-check:
declare const draw: import('@sakuzu/maplibre-gl-draw').Draw;
declare const iconRenderer: import('@sakuzu/maplibre-gl-draw').FeatureRenderer;
-->

```ts
draw.extensions.featureTypes.override({
  type: 'Point',
  geometry: 'Point',
  renderer: iconRenderer,
  appliesTo: (feature) => typeof feature.properties.icon === 'string',
});
```

On a layer held as rows, the points such a renderer takes are drawn one at a
time by `draw`, each between the rows around it. What a definition and its
renderer do from the rows themselves, without making a feature of each row,
is in one member of each, `rows`, experimental with its types in `/kasane`
(`FeatureTypeRows`, `FeatureRendererRows`):

- `renderer.rows.sprites` gives the pictures a renderer draws its points
  with: a texture, the rectangle of the picture of a style, and its size on
  screen. Such a point is then drawn with the other rows of its layer, in
  their order and in their draw, so a layer where points with icons and areas
  alternate is drawn in a few draws
- `rows.appliesTo(view, handle)` gives the answer of `appliesTo` from the
  row, read from the `LayerTableView` of the layer (`getRowValue`,
  `getRowType`). Without it, a feature is made from each row of the type to
  ask `appliesTo` whenever the rows are sorted for the drawing
- `renderer.rows.draw(view, handles, ctx)` draws the rows the renderer draws
  one at a time from the rows: consecutive rows of the type, not hidden and in
  view, in the order of the layer. Without it, the features of such rows are
  made, kept up to a limit, and drawn by `draw`. A row being dragged in bulk
  is given as it is written; `draggedRowsOf` tells where it is drawn

## Terrain

With terrain on, the shared renderers lay what they draw on the terrain
by themselves. For a mark of your own, `ctx.terrain` (`TerrainSurface`)
gives the surface of the terrain:

- `elevation(lngLat)` is the height of the terrain in meters, 0 without
  terrain. Pass it to the point renderer as `elevationMeters` to place
  a marker on the terrain
- `occlusionOpacity(lngLat)` is lower where the terrain hides the
  position from the camera; multiply it into the opacity of the mark
- `generation()` changes whenever the heights may have changed, so a
  renderer that keeps heights knows when to read them again

Where a position is on the screen, on the terrain when it is on, is
`ctx.screen.project(lngLat)`, as for every position.

Outside the drawing, a plugin reads the same terrain through
`ctx.terrain` of its context. See [terrain](terrain.md).

## Overlays

An overlay draws what is not one feature: marks over the selection, a
grid, a preview of your own. It has the `onAdd`, `draw` and `onRemove`
of a renderer, with the same rules, and a `name`. Add it with
`draw.extensions.overlays.add`, which returns the function that
removes it.

An overlay that marks the handles of the selected routes:

<!-- docs-check:
declare function verticesOf(feature: Feature): Position[];
-->

```ts
import type { OverlayRenderer } from '@sakuzu/maplibre-gl-draw';

const routeHandleMarks: OverlayRenderer = {
  name: 'route-handles',
  onAdd() {},
  draw(ctx) {
    for (const feature of draw.selection.features()) {
      if (feature.type !== 'Route') continue;
      for (const position of verticesOf(feature)) {
        ctx.point.draw(position, {
          shape: 'circle',
          size: 8,
          fillColor: '#ffffff',
          fillOpacity: 1,
          strokeColor: '#e64d1a',
          strokeWidth: 2,
          strokeOpacity: 1,
        });
      }
    }
  },
  onRemove() {},
};

draw.extensions.overlays.add(routeHandleMarks);
```

- `draw(ctx)` draws above the features and the selection
- `drawForLayer(layerId, ctx)` draws just above one layer, for what
  belongs between the layers
- `drawVertices(ctx)` draws above the features of every layer and the
  selection, for vertices that must stay visible over the layers in
  front
- `order` sets the place among the overlays: a lower one is drawn
  first, below a higher one. Overlays of the same order are drawn in
  the order they were added

An overlay that prepares something over several drawings, such as data
made in a Worker, implements `hasPendingWork()` and returns true until
it is done. `draw.hasPendingWork()` asks every overlay, so a host that
waits for a complete picture waits for it too
([performance](performance.md)).

## Providers

A provider adds snapping candidates, handles or a companion to features
of types that are not yours, the built-in types included. Each has a
`name` and is added to its own collection of `draw.extensions`.

### Snapping candidates

A `SnapProvider` returns candidates near the pointer. A provider that
snaps to a grid of 0.001 degrees:

```ts
import type { SnapProvider } from '@sakuzu/maplibre-gl-draw';

const grid: SnapProvider = {
  name: 'grid',
  candidates(ctx) {
    const step = 0.001;
    const [lng, lat] = ctx.lngLat;
    return [
      {
        position: [Math.round(lng / step) * step, Math.round(lat / step) * step],
        kind: 'guide',
        source: 'grid',
      },
    ];
  },
};

draw.extensions.snapProviders.add(grid);
```

The context gives the pointer on the screen and on the map, the
tolerance in pixels, `screen`, and `excludeIds`, the features that must
not be snapped to, such as the one being drawn. `priority` breaks ties
between candidates at the same distance; the higher one wins. A `kind`
of your own is ranked as a vertex and reaches the snapping result
(`target.kind`) as it is.

### Handles

A `HandleProvider` shows handles of its own on the selected features:
`handles(feature, screen)` returns them, and `onDrag(feature, handle,
event)` returns the patch a drag makes, as `onHandleDrag` of a
definition does. `globalHandles(screen)` returns handles that belong to
no feature and are shown whatever is selected; their drag arrives with
`feature` as `null`, and the provider writes what the drag changes
itself. `onDragStart` and `onDragEnd` surround a drag as
`onHandleDragStart` and `onHandleDragEnd` of a definition do, and
`onDragStart` refuses it by returning `false`. As with a definition,
the library draws the handles with the look of its vertex handles.

### Companions

A `CompanionProvider` draws something one step below a feature and
takes clicks there, at the same place in the stacking order. A halo
under the points marked `highlight`:

```ts
import type { CompanionProvider } from '@sakuzu/maplibre-gl-draw';
import type { Point } from 'geojson';

const halo: CompanionProvider = {
  name: 'halo',
  has: (feature) =>
    feature.type === 'Point' && feature.properties.highlight === true,
  draw(feature, ctx) {
    ctx.point.draw((feature.geometry as Point).coordinates, {
      shape: 'circle',
      size: 28,
      fillColor: '#facc15',
      fillOpacity: 0.4 * ctx.opacity,
      strokeColor: '#facc15',
      strokeWidth: 0,
      strokeOpacity: 0,
    });
  },
  hitTest(feature, ctx) {
    const [x, y] = ctx.screen.project((feature.geometry as Point).coordinates);
    const distancePx = Math.hypot(ctx.point[0] - x, ctx.point[1] - y);
    return distancePx <= 14
      ? { kind: 'companion', id: feature.id, featureId: feature.id, distancePx }
      : null;
  },
  onClick(feature) {
    console.log('the halo of', feature.id);
    return true;
  },
};

draw.extensions.companionProviders.add(halo);
```

- `has(feature)` is asked for every feature on every drawing and every
  hit test, so it must answer at once, from the feature or from an
  index you keep. On a layer held as rows, `rows.has(view, handle)`
  (experimental, its types in `/kasane`) gives the same answer from the
  row; without it, a feature is made from each row to ask `has` whenever
  the rows are sorted for the drawing
- `draw` is called just before the feature itself
- `hitTest` is asked at the step of its feature: when the pointer missed
  the feature itself, before the feature behind it. At one point on the
  screen a click therefore goes, in this order:
  - to the handles of the selection, which are grabbed even under a
    companion
  - then, from the front of the stacking order, to each feature and then
    to its companions. A feature, hit on its marker, its line or its area
    with the click tolerance, wins over its own companion, and a companion
    wins over the features behind its feature
  - to the rows of a dataset only where no feature and no companion in
    front of them is hit. A dataset stacked in front of a feature comes
    before both
- A hit calls `onClick`: when it returns true the click is consumed and
  the selection stays as it is; otherwise the select mode takes the click
  as one on the feature

## Your own shaders

The shared renderers cover lines, areas and point markers. For
anything else, a renderer compiles its own shaders with `ctx.gl`, and
positions them with the values of the GPU of the frame, which
`viewUniforms(ctx)` of `/webgl` gives: `shader` (the projection
functions of the map), `projection`, and `offset` (the center of the
view, for drawing near the camera without losing precision).
`offsetUniformsAt(ctx, position)` gives the offsets from another
position, for a shape far from the center drawn around its own
position.

The entry `@sakuzu/maplibre-gl-draw/webgl` has the parts the shaders of
the library are built on: the GLSL of the projection and
`ProjectionUniformManager` for its uniforms, `createProgram`,
`QuadShader`, and the rules the shared renderers follow for dashes and
terrain ([the webgl entry](../api/webgl/index.md)). It may change in a
minor release, unlike the main entry
([versions](../reference/README.md)).

The parts that draw on the terrain take the render context of the draw
call, or its `terrain`: `setTerrain(ctx)` on a
`ProjectionUniformManager` or a `QuadShader` before drawing, and
`terrainTessellationStep(ctx)` and `drawQuadSurfaceOnTerrain(ctx, ...)`.
The render context is valid for its draw call only, so pass the one of
each call; given `null`, or an object the library did not hand out,
they draw without terrain.

```ts
import type { RenderContext } from '@sakuzu/maplibre-gl-draw';
import {
  densifyPath,
  type ProjectionUniformManager,
  terrainTessellationStep,
  viewUniforms,
} from '@sakuzu/maplibre-gl-draw/webgl';

function pathOnTerrain(
  ctx: RenderContext,
  program: WebGLProgram,
  uniforms: ProjectionUniformManager,
  coordinates: [number, number][],
): [number, number][] {
  const view = viewUniforms(ctx);
  ctx.gl.useProgram(program);
  uniforms.setTerrain(ctx);
  uniforms.setUniforms(view.projection, ctx.screen.zoom, view.offset);
  const step = terrainTessellationStep(ctx);
  // upload the path and draw it
  return step ? densifyPath(coordinates, step) : coordinates;
}
```

## Related example

- [Custom feature types](../examples/custom-feature-types.md) adds a
  route, a type drawn with the shared line renderer, with a hit test, a
  box selection, handles and style keys of its own, and a section of the
  standard UI for those keys; a key unregisters the type and registers it
  again

## Reference

- [FeatureTypeDefinition](../api/maplibre-gl-draw/interfaces/FeatureTypeDefinition.md)
  and [Handle](../api/maplibre-gl-draw/interfaces/Handle.md)
- [FeatureRenderer](../api/maplibre-gl-draw/interfaces/FeatureRenderer.md)
  and [RenderContext](../api/maplibre-gl-draw/interfaces/RenderContext.md)
- [LineRenderer](../api/maplibre-gl-draw/interfaces/LineRenderer.md),
  [FillRenderer](../api/maplibre-gl-draw/interfaces/FillRenderer.md) and
  [PointRenderer](../api/maplibre-gl-draw/interfaces/PointRenderer.md)
- [HitTestContext](../api/maplibre-gl-draw/interfaces/HitTestContext.md)
  and [Hit](../api/maplibre-gl-draw/interfaces/Hit.md)
- [OverlayRenderer](../api/maplibre-gl-draw/interfaces/OverlayRenderer.md)
- [SnapProvider](../api/maplibre-gl-draw/interfaces/SnapProvider.md),
  [HandleProvider](../api/maplibre-gl-draw/interfaces/HandleProvider.md)
  and [CompanionProvider](../api/maplibre-gl-draw/interfaces/CompanionProvider.md)
- [TerrainSurface](../api/maplibre-gl-draw/interfaces/TerrainSurface.md)
