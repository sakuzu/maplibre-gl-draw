# Custom feature types

Besides the built-in types (`Point`, `LineString`, `Polygon`, the Multi
types, `Circle`, `Freehand` and `Image`), a draw instance can hold
features of a type you define. You tell the instance how to draw the
type, how to hit it, and optionally how to select, resize and snap to
it, with one call: `registerFeatureHandler`. Around it are three more
extension points for things that are not features: auxiliary handles,
companions and overlay renderers.

These extension points hand you the WebGL context of the map. The guide
assumes you know WebGL2 and the custom layers of maplibre-gl.

## The smallest example

A `Route` type: a line drawn dashed in a fixed color, hit within the
click tolerance.

```ts
import {
  createMapLibreGLDraw,
  type CustomFeatureHandler,
  type CustomFeatureRenderer,
  type Feature,
  type HitTestStrategy,
} from '@sakuzu/maplibre-gl-draw';

type Position = [number, number];

const routeRenderer: CustomFeatureRenderer = {
  name: 'route',
  onAdd() {},
  draw(feature, projectionData, zoom, context) {
    context.sdfLineRenderer.draw(
      feature.coordinates as Position[],
      // context.opacity is the opacity of the feature's layer
      {
        width: 3,
        color: [0.9, 0.3, 0.1, 1],
        opacity: context.opacity,
        lineStyle: 'dashed',
      },
      { widthUnit: 'pixels', closed: false },
      zoom,
      projectionData,
    );
  },
  onRemove() {},
};

/** Distance to a segment, in degrees of longitude at the latitude of p */
function segmentDistance(p: Position, a: Position, b: Position): number {
  const k = 1 / Math.cos((p[1] * Math.PI) / 180);
  const ax = a[0] - p[0];
  const ay = (a[1] - p[1]) * k;
  const bx = b[0] - p[0];
  const by = (b[1] - p[1]) * k;
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const raw = len === 0 ? 0 : -(ax * dx + ay * dy) / len;
  const t = Math.max(0, Math.min(1, raw));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function routeDistance(feature: Feature, p: Position): number {
  const c = feature.coordinates as Position[];
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < c.length; i++) {
    best = Math.min(best, segmentDistance(p, c[i - 1], c[i]));
  }
  return best;
}

const routeHitTest: HitTestStrategy = {
  geometryType: 'Route',
  distance: routeDistance,
  test: (feature, coordinate, toleranceLngLat) =>
    routeDistance(feature, coordinate) <= toleranceLngLat,
};

const routeHandler: CustomFeatureHandler = {
  type: 'Route',
  renderer: routeRenderer,
  hitTest: routeHitTest,
};

const draw = createMapLibreGLDraw(map);
const unregister = draw.registerFeatureHandler(routeHandler);

draw.addFeature({
  type: 'Route',
  coordinates: [
    [139.70, 35.68],
    [139.72, 35.69],
    [139.74, 35.68],
  ],
});
```

The route appears as an orange dashed line in the active layer, in its
place in the layer order, and a click on it selects it. No selection
frame is drawn, because the handler gives no `getSelectionBoundingBox`.
`unregister()` takes back everything the handler registered.

## How a custom type is stored

A custom feature is an ordinary Store feature whose `type` is your type
name. Its `coordinates` are a single position or a list of positions.
It is saved, loaded and exported like any other feature. In GeoJSON it
is written as a `Point` or a `LineString` by the shape of its
coordinates, with the type name in the `maplibre-gl-draw:featureType`
property, and the type comes back on load (see
[data format](../reference/data-format.md)).

A mode that creates a feature of the type names it with
`autoNameGenerator.generateName(type)` of its context. The word is the type
name unless the host gives one in `autoName.typeNames` under the same key,
so a type that is shown to users should say its type name in its
documentation, for the host to translate
([automatic names](drawing.md#names-in-another-language)).

A renderer often needs values of its own for each feature, such as an
icon or the side of a label. Keep them in `properties` or in `style` under
keys that core does not define. Such keys are stored, exported and
loaded back unchanged, and core does not check them, so the
renderer checks a value before it uses it. Declare the style keys for
TypeScript with declaration merging:

```ts
declare module '@sakuzu/maplibre-gl-draw' {
  interface FeatureStyle {
    routeArrow?: 'none' | 'end' | 'both';
  }
}

const arrow = feature.style?.routeArrow;
const drawArrow = arrow === 'end' || arrow === 'both';
```

## The renderer

`draw(feature, projectionData, zoom, context)` is called once per visible
feature of the type, in the feature's place in the layer order. The
library flushes its own batches around the call, so what you draw lands
between the features behind and in front.

The `context` carries what a renderer needs from the frame:

- `shaderData`, `centerLngLat` and `mainMatrixArray`, for the projection
  of your own shaders. Positions are drawn relative to the view center to
  keep the precision at high zoom; `calculateOffsetUniforms` computes the
  uniforms from the context. The shared renderers below are already set up
  for the frame, so a renderer that draws with them does not need these
- `pixelRatio`, the ratio from CSS pixels to device pixels. Use it rather
  than `window.devicePixelRatio`
- `terrain`, the terrain state of this frame (see below)
- `opacity`, the opacity of the feature's layer (0 to 1). The library
  multiplies it into what it draws for the layer; multiply it into your own
  alpha too, as the example does, so that the feature fades with its
  layer. The shared renderers do not apply it by themselves. It is 1 for
  an overlay renderer
- `sdfLineRenderer`, `fillShaderManager` and `pointShapeRenderer`, the
  shared renderers of the instance. The example draws with the line
  renderer, so it creates no GL object of its own

`onAdd(gl, map)` and `onRemove()` can arrive several times: the rendering
engine is torn down and built again when the layer is removed and added
back (after `setStyle`) and when the WebGL context is lost and restored.
Create GL objects in `onAdd` (or lazily in `draw`), release them in
`onRemove`, and accept `onAdd` again afterwards.

When the view crosses the antimeridian, a frame draws each copy of the
world, and `draw` is called once per copy with the projection of that
copy. Compute everything from the arguments rather than from the map's
camera, and the drawing lands on the right copy.

## Hit testing

`hitTest` decides whether a click hits a feature. `test` and `distance`
work in degrees of longitude at the latitude of the click:
`toleranceLngLat` is the click tolerance (6 CSS pixels by default)
converted that way. To compare with a latitude difference, divide the
latitude difference by the cosine of the latitude, as the example does.
`testDistance` is an optional single pass that returns the distance or
`null`.

Hit testing first narrows the candidates with a spatial index, using the
bounding box of each feature widened by the tolerance. A type that is hit
farther from its geometry, such as an icon, sets `candidateReachPx` (a
number or a function) so its features are not dropped before `test`.

The index follows the Store: every create, update and delete re-measures
that feature with `getBoundingBox` (the extent of the coordinates by
default). When the extent depends on something outside the Store, such
as a font that arrives later, call `ctx.invalidateFeatures(type)` from a
plugin when it changes.

`boxSelection` decides whether a feature is inside a selection box. It
defaults to a test on the coordinates.

## Selection, resize and snapping

The other members of the handler are optional:

| Member | Without it |
| --- | --- |
| `getSelectionBoundingBox` | No selection UI is drawn |
| `getPointFrameExtent` | A zero-area feature gets a 12 px frame |
| `getAdditionalResizeHandles` | Only the four corner handles |
| `computeCustomResize` | The standard resize |
| `resizeStrategy` | Chosen by the `scale` property |
| `getSnapTargets` | The feature's vertices and edges |

`getSelectionBoundingBox` returns an oriented box, which also carries a
rotation. `getPointFrameExtent` sizes the frame of a zero-area feature
(half width and half height in CSS pixels); such a feature keeps the look
of a point, with no resize or rotation handle. `getSnapTargets` returns
point and segment candidates in place of the standard enumeration.

## Terrain

With terrain on, your renderer places things on the ground through the
library, never through its internals. Inside `draw`, pass
`context.terrain` to `setTerrain` of your `ProjectionUniformManager` or
`QuadShader`, and as the first argument of the terrain functions
(`anchorElevationMeters`, `anchorGhostOpacity`,
`drawQuadSurfaceOnTerrain`, and so on). It is valid for that call only.
Outside rendering, a plugin uses `ctx.projectAnchor`,
`ctx.anchorElevationMeters` and `ctx.getAnchorElevationGeneration`, which
read the terrain of its own instance. See [terrain](terrain.md).

## Auxiliary handles

An auxiliary handle is a handle of your own that is neither a vertex nor
a resize handle: a control point of a curve, the tail of a callout.

<!-- docs-check:
type Position = [number, number];
-->

```ts
draw.registerAuxiliaryHandleProvider({
  id: 'route-midpoint',
  getHandles(feature) {
    if (feature.type !== 'Route') return [];
    const c = feature.coordinates as Position[];
    return [{ id: 'mid', position: c[Math.floor(c.length / 2)] }];
  },
  onHandleDragStart(hit) {
    return hit.handleId === 'mid'; // true takes over the drag
  },
  onHandleDragMove(event) {
    // Move your preview to event.lngLat
  },
  onHandleDragEnd(event) {
    // Commit with draw.updateFeature
  },
});
```

The library only hit-tests the handles and hands the drag over. You draw
them (with an overlay renderer, for example) and you write the result.

- `getHandles` is asked only while a single feature is selected, on
  every hit test, so keep it cheap. `getGlobalHandles` adds handles that
  do not depend on the selection
- A handle is tested right after the rotate and resize handles, before
  vertices and midpoints
- Returning true from `onHandleDragStart` stops the map's pan and routes
  the move and the end to you. `onHandleDragEnd` always arrives exactly
  once, also when a mode change or a change from outside interrupts the drag
- Nothing is delegated while the Store is read-only, under the
  interaction lock, or while the feature is locked
- During the drag the library writes nothing and runs no drag hook

## Companions

A companion is drawn with a feature, one step below it, and can be
clicked at that same place in the stacking order: a leader line, a
shadow, a badge. Register a `FeatureCompanionProvider` with
`registerFeatureCompanionProvider`.

- `has(feature)` is asked for every feature in every frame and every
  click, so it must answer in constant time from an index you keep
- `draw` is called just before the feature itself, with the opacity of
  the feature's layer in `context.opacity` to multiply into its alpha
- `hitTest` is asked when the click missed the feature itself, before the
  feature behind it. A hit consumes the click, leaves the selection as it
  is, and calls `onCompanionClick`
- A feature with a companion is drawn outside the retained batches, so
  keep such features few

## Overlay renderers

`addOverlayRenderer` adds WebGL drawing that is not tied to a feature:
behind the features (`order: 'background'`), in front of them
(`'foreground'`), or in front of the selection UI (`'overlay'`). The
renderer has the same `onAdd`, `draw` and `onRemove` as a feature
renderer, with the same rules for context loss and the antimeridian.
The returned function removes it.

A renderer that prepares something over several frames (resources made in
a Worker, say) implements `hasPendingWork()` and returns true until it is
done, requesting the repaints that finish it. `draw.hasPendingWork()` asks
every overlay renderer, so a host that waits for a complete picture (see
[Performance](performance.md#complete-frames-for-a-picture)) waits for it
too. With `timeSlicing: false` in the rendering settings, finish in the
frame what you would otherwise spread over frames.

## The building blocks

The parts the library uses for its own drawing are exported as building
blocks: the shared renderers, `ProjectionUniformManager`, `QuadShader`,
the terrain anchors, the oriented boxes and the projection math. They are
the second layer of the public surface, which may change in a minor
release; [the reference overview](../reference/README.md) explains the
difference. Use them when your type draws like a built-in one, and keep
your own code for the rest.

## Related example

- [examples/custom-feature-type/](../../examples/custom-feature-type/)
  registers a type with a renderer built on the shared line renderer, a
  hit test and a box selection strategy

## Reference

- [CustomFeatureHandler](../api/maplibre-gl-draw/interfaces/CustomFeatureHandler.md)
- [CustomFeatureRenderer](../api/maplibre-gl-draw/interfaces/CustomFeatureRenderer.md)
  and [CustomRendererDrawContext](../api/maplibre-gl-draw/interfaces/CustomRendererDrawContext.md)
- [HitTestStrategy](../api/maplibre-gl-draw/interfaces/HitTestStrategy.md)
  and [BoxSelectionStrategy](../api/maplibre-gl-draw/interfaces/BoxSelectionStrategy.md)
- [AuxiliaryHandleProvider](../api/maplibre-gl-draw/interfaces/AuxiliaryHandleProvider.md)
- [FeatureCompanionProvider](../api/maplibre-gl-draw/interfaces/FeatureCompanionProvider.md)
- [CustomOverlayRenderer](../api/maplibre-gl-draw/interfaces/CustomOverlayRenderer.md)
- [SDFLineRenderer](../api/maplibre-gl-draw/interfaces/SDFLineRenderer.md)
