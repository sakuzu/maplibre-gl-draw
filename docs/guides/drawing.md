# Drawing and editing

This guide covers what a user can do on the map: the six drawing modes, the
`select` mode that moves, resizes, rotates and edits the vertices of what is
selected, the keyboard and touch input, Multi geometries and holes, creating
features from code and the names given to new features.

The examples assume a `draw` instance created as in
[Getting started](../getting-started.md).

## Minimal code

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map);

// Click to add vertices; Enter or a click on the first vertex finishes
draw.setMode('draw_polygon');

draw.on('feature.created', ({ feature }) => {
  console.log(feature.type, feature.properties.name);
});

draw.on('mode.changed', ({ mode }) => {
  console.log('mode', mode); // 'select' once the polygon is finished
});
```

After the polygon is finished, the new feature is selected and the mode is
`select`, so the user can move or reshape it right away.

## Modes

There are seven built-in modes, listed in `MODES`. `select` is the default
(the `defaultMode` option).

| Mode | Creates | How |
| --- | --- | --- |
| `select` | nothing | select, move, resize, rotate, edit vertices |
| `draw_point` | `Point` | one click |
| `draw_line` | `LineString` | clicks, then finish |
| `draw_polygon` | `Polygon` | clicks, then finish |
| `draw_circle` | `Circle` | click the center, click the radius |
| `draw_freehand` | `Freehand` | drag a stroke |
| `draw_image` | `Image` | the application picks a file (see below) |

`draw.setMode(mode)` returns `true` when the mode is `mode` after the call.
It returns `false`, and nothing changes, for a drawing mode while the
interaction lock is on, and for a drawing mode while no layer can be
written (every layer is locked or hidden; see
[Layers and groups](layers.md)). A name with no mode behind it throws a
`DrawError` with the code `not-found`.

`draw.getMode()` reads the current mode, and `mode.changed` reports every
change with the mode before it. Modes of your own are added with
`draw.extensions.modes.add` ([Plugins](plugins.md)).

## Drawing modes

The table shows what each input does while a drawing mode is active.
"Discard" drops the drawing in progress and stays in the mode; the key
leaves the mode for `select` only when nothing is being drawn.

| Mode | Adds | Finishes | Escape | Backspace |
| --- | --- | --- | --- | --- |
| `draw_point` | click | the click | to select | - |
| `draw_line` | click | Enter, last vertex | discard | last vertex |
| `draw_polygon` | click | Enter, first vertex | discard | last vertex |
| `draw_circle` | click, move | second click | discard | - |
| `draw_freehand` | drag | release | discard | - |

- A line needs two vertices and a polygon three before Enter, a double
  click or a click on the last (line) or first (polygon) vertex finishes
  it. The cursor turns into a pointer over that vertex
- Backspace and Delete remove the last placed vertex of a line or polygon
- A circle takes its radius from the distance between the center and the
  pointer, and a second click finishes it once the radius is at least 1 m
- Switching to another mode while a line, polygon or circle is in progress
  discards it
- A double click on a new position adds that vertex once and then
  finishes the shape; a double click never zooms the map while drawing. A
  click on the last placed vertex adds no second vertex there
- A drawing mode clears the selection when it starts

The shape being drawn is shown with the `previewStyle` option, which takes
the keys of a feature style: the stroke keys give its lines, the point
keys its vertices (`pointStrokeColor` and `pointStrokeWidth` their
outlines).

```ts
draw.options.update({
  previewStyle: { strokeColor: '#e11d48', strokeWidth: 2, pointRadius: 5 },
});
```

`preview.changed` fires every time that shape changes, and once with
`feature: null` when it is created, discarded or left. It is not
throttled, so a listener that does heavy work waits for the next frame
itself. Besides `feature`, it carries `confirmedVertices` (how many
vertices from the start are placed) and `highlightVertex` (the vertex
drawn highlighted) when the mode gave them. Use it to show the length
while drawing, or to share the shape with other users.

```ts
import { length } from '@sakuzu/maplibre-gl-draw/geometry';

draw.on('preview.changed', ({ feature }) => {
  if (feature?.geometry.type === 'LineString') {
    console.log(`${Math.round(length(feature.geometry))} m`);
  }
});
```

### After finishing

A point, line, polygon or circle is created in one transaction with its
selection, and the mode returns to `select` with the new feature selected.
`feature.created` and `selection.changed` fire for it, and
`document.changed` once for the whole change.

Freehand is different: every stroke (press, drag, release) becomes its own
feature, the mode stays `draw_freehand` so that strokes can follow one
another, and the new features are not selected. A second finger landing
during a stroke, or the browser cancelling the touch, discards the stroke.

Every drawn feature gets `properties['maplibre-gl-draw:createdZoom']`, the
zoom when it was drawn, and its line widths then follow the map (see
[Styles](styles.md)). An application that wants the widths to stay the
same on the screen creates the instance with `scaleWithZoom: false`; a
drawn feature then gets no reference zoom, like a feature created from
code.

When automatic names are on, every drawn feature also gets
`properties.name`. The new feature goes into the active layer, or into the
first writable layer when the active one is locked or hidden.

### Images

The library does not open a file dialog. Entering `draw_image` emits
`image.requested` with a position, the zoom and the layer to place the
image in, and returns to `select` at once. The position is the clicked one
when a click led to the mode (a listener of `map.clicked` entered it), and
the center of the map otherwise. The application shows
its own file picker and passes the file to `draw.document.load`:

```ts
draw.on('image.requested', ({ lngLat, zoom, layerId }) => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    await draw.document.load(file, { coordinate: lngLat, zoom, layerId });
  });
  input.click();
});

draw.setMode('draw_image');
```

The image is centered on `coordinate`, converted to WebP (scaled down when
a side exceeds 4096 px), stored once in the files of the document and
referenced by the feature, and the new feature is selected. Several Image
features can share one stored file.

The library does not take files dropped on the map. To place a dropped
image where it was dropped, the application listens to the drop and calls
`draw.document.load` with that position; see
[Save and load](save-load.md).

## Selecting and editing

In `select` mode a click on a feature selects it, and a click on empty map
clears the selection. A selected feature shows a frame and the handles its
type supports:

| Type | Move | Vertices | Midpoints | Corners | Rotate |
| --- | --- | --- | --- | --- | --- |
| `Point` | yes | - | - | - | - |
| `LineString`, `Polygon` | yes | yes | yes | yes | yes |
| `MultiLineString`, `MultiPolygon` | yes | yes | yes | yes | yes |
| `MultiPoint` | yes | yes | - | yes | yes |
| `Circle` | yes | - | - | yes | - |
| `Freehand` | yes | - | - | yes | yes |
| `Image` | yes | - | - | yes | yes |

What each part does when it is dragged:

| Part | Drag |
| --- | --- |
| The feature or the inside of its frame | moves the feature |
| A vertex handle | moves that vertex |
| A midpoint handle | inserts a vertex there and moves it |
| A corner handle | scales from the opposite corner |
| The rotation handle | rotates around the center of the frame |
| The radius handle (`Circle`) | changes the radius, center fixed |

- A drag with a corner changes the radius and the center of a circle
  together; the radius handle keeps the center and remembers its angle
  (`maplibre-gl-draw:radiusHandleAngle`)
- An image is scaled as a whole (`maplibre-gl-draw:scale`), not per axis
- A point keeps a constant size on screen, so it has only a frame
- A midpoint handle sits on the edge as it is drawn, halfway across in
  longitude
- On the globe an edge between two vertices follows the path it takes on
  the Mercator map (a parallel stays a parallel), as the layers of the map
  do. The fill, the outline, the frame, the handles and the hit test all
  follow that path
- A single-coordinate feature (a one-point `MultiPoint`) shows its vertex
  handles but no corners or rotation handle
- Every drag is one change: while it lasts, `feature.updated` arrives with
  `intermediate: true`, and the release writes the final state.
  `drag.started` and `drag.ended` mark its start and end
- A locked feature can be selected but shows no handles and does not move
  ([Layers and groups](layers.md))

The colors and sizes of the frame and the handles are the
`selectionStyle` option. For a line or polygon with very many vertices the
handles are thinned on screen; see [Performance](performance.md).

### Vertices

A click on a vertex handle selects that vertex, and Shift+click adds or
removes another vertex of the same feature. Delete or Backspace removes the
selected vertices. The same can be done from code with
`draw.vertexSelection`:

```ts
draw.vertexSelection.set(featureId, [{ ring: 0, index: 2 }]);
draw.vertexSelection.get(); // { featureId, vertices: [...] }
const removed = draw.vertexSelection.delete();
```

A vertex is named by a `VertexRef` (`{ part?, ring, index }`); see
[Multi geometries and holes](#multi-geometries-and-holes). `set` returns
`false` for a locked feature, and `vertexSelection.changed` reports every
change. Deleting never removes the feature itself:

- A line keeps at least two points
- A polygon ring keeps at least four positions (a closed triangle). The
  test is per ring, and the closing position follows the first one
- In a `MultiPoint` a vertex is a part, and the last part stays
- In the other Multi types the test is per part and ring, so one part at
  its minimum does not block deletion in another

Snapping applies to vertex drags, and vertices shared with neighboring
features can move together; see
[Snapping and geometry](snapping-geometry.md).

### Multiple selection

| Input | Result |
| --- | --- |
| Shift+click on a feature | adds it to the selection, or removes it |
| Shift+drag on the map | box selection |
| Click on a selected feature | selects only that feature |
| Click on another feature | selects it instead |
| Click on empty map | clears the selection |

A box selection selects the features whose shape meets the box (a point
counts by its coordinate, an image by its rotated frame). When the
selection existed before, each feature in the box is toggled. Escape during
the drag restores the selection as it was. Locked and hidden features are
not box-selected.

A multiple selection shows one frame with corner and rotation handles
around all of it. Dragging inside the frame moves every feature by the same
amount; a corner scales them all from the opposite corner, each by its own
rule (coordinates for geometries, the scale for images, only the position
for points); the rotation handle turns them around the center of the frame
(points keep their markers upright).

A touch screen has no Shift key, so box selection and Shift+click are not
available there. Offer your own control and call `draw.selection.set` and
`draw.selection.add`.

```ts
draw.selection.set('feature', [featureId]);
draw.selection.add([feature.id]);
const selected = draw.selection.features();
```

The selection holds one type at a time, and it can be a group or a layer
too (`draw.selection.set('group', [groupId])`). `selection.features()`
returns the selected features, or the features inside the selected groups
or layers. `selection.delete()` deletes whatever is selected, and
`selection.changed` reports every change with the selection before it.

## Keyboard

The shortcuts listen on the map canvas. A press on the map gives the canvas
the keyboard focus (without scrolling the page), so they work right after a
click. In `select` mode:

| Key | Action |
| --- | --- |
| Delete / Backspace | delete the selected vertices, or else the selection |
| Escape | cancel a drag, else clear the vertices, else the selection |
| Arrow keys | move the selection by 1 px (10 px with Shift) |
| Cmd/Ctrl+G | group the selection |
| Shift+Cmd/Ctrl+G | ungroup |

An arrow key moves the selected features by that distance on screen, as
one change. Nothing moves while a selected feature is locked or the
instance is read-only or under the interaction lock; then, and without a
selection, the key is left to the map, which pans. A double click on a
feature does not zoom the map.

A drag ends without being written when the window loses the focus, and a
press released outside the page is released where the pointer last was.

## Touch and pen

The supported input is the mouse, the keyboard, one finger and a pen. One
finger does what the left mouse button does: drawing, moving, vertex
editing, rotating, resizing and freehand strokes. A long press is a context
menu event and two quick taps are a double click. Gestures with two or more
fingers belong to the map (pan, zoom, rotate), and a second finger that
lands during a drag cancels the drag.

A pen works through whichever events the browser reports it with. The
pointer events that modes and plugins receive (`DrawPointerEvent`) carry
`pointerType` (`'mouse'`, `'touch'` or `'pen'`).

## Multi geometries and holes

The drawing modes create single geometries, and a polygon is drawn with its
outer ring only. `MultiPoint`, `MultiLineString`, `MultiPolygon` and
polygons with holes come from:

- `draw.document.load` of GeoJSON (Multi geometries are kept;
  `flattenMulti: true` splits them into single features)
- the geometry operations: a union of separate polygons gives a
  `MultiPolygon`, a subtraction from the inside gives a hole
  ([Snapping and geometry](snapping-geometry.md))
- `draw.features.create` with the geometry

They are drawn, hit-tested and edited like single geometries. A click on
any part selects the whole feature, the frame encloses every part, and
every part and ring gets its own vertex and midpoint handles.

| Type | `part` | `ring` | `index` |
| --- | --- | --- | --- |
| `LineString` | 0 | 0 | position in the line |
| `Polygon` | 0 | 0 = outer, 1+ = holes | position in the ring |
| `MultiPoint` | position | 0 | 0 |
| `MultiLineString` | line | 0 | position in the line |
| `MultiPolygon` | polygon | ring in that polygon | position in the ring |

`part` may be left out when it is 0.

## Creating features from code

`draw.features.create` takes a type and a GeoJSON geometry, and returns the
feature as it was stored. Use it for coordinates typed into a form, a
position computed from a distance and a bearing, automation and tests.

```ts
import { destination } from '@sakuzu/maplibre-gl-draw/geometry';

const start = [139.7, 35.68];
const line = draw.features.create({
  type: 'LineString',
  geometry: {
    type: 'LineString',
    coordinates: [start, destination(start, 500, 90)], // 500 m to the east
  },
  properties: { name: 'Survey line' },
});
if (line) draw.selection.set('feature', [line.id]);
```

- The feature goes into the active layer unless `layerId` or `groupId`
  says otherwise. A feature created from code may go into a locked or
  hidden layer, which a user cannot draw into
- `create` returns `null` while the instance is read-only. A wrong input
  throws a `DrawError` and creates nothing
- A circle is a `Point` geometry, the center, with its radius in
  `properties['maplibre-gl-draw:radiusMeters']`
- A feature created from code gets no automatic name and no reference zoom,
  and the mode and the selection do not change
- `createMany` creates several features in one transaction

```ts
draw.features.create({
  type: 'Circle',
  geometry: { type: 'Point', coordinates: [139.7, 35.68] },
  properties: { 'maplibre-gl-draw:radiusMeters': 250 },
});
```

A tool that should draw the way the built-in modes do (the writable layer,
the automatic name and the reference zoom) is a mode of your own, which
creates its features with `commitFeature` ([Plugins](plugins.md)).

### Driving a drawing mode from code

`draw.drawing` drives the shape the current drawing mode is drawing, for
coordinates typed one by one, another input device or an automated run.
The shape is made by the mode, so it gets the writable layer, the
automatic name and the reference zoom, and it is selected when it is
finished, as a shape drawn with the pointer.

```ts
draw.setMode('draw_line');
draw.drawing.addVertex([139.7, 35.68]); // as a click there
draw.drawing.moveTo([139.71, 35.69]); // the preview follows
draw.drawing.addVertex([139.71, 35.69]);
draw.drawing.finish(); // as Enter; the mode goes back to select
```

- `addVertex`, `moveTo` and `finish` are made into the pointer and key
  events a click, a move and Enter make, at the point of the screen the
  position projects to. They go through the `input` receivers of the
  plugins before the mode, as the map's own input does. The position is
  used as it is: nothing snaps it, and the events carry
  `programmatic: true`
- The position is exact, so the click tolerance of the pointer (10 px)
  does not apply: a vertex a few pixels from the last one is placed, and
  one near the first vertex of an area does not close it. Only a
  position exactly equal to the closing vertex finishes the shape
- `addVertex` returns `false` when no drawing mode is active or nothing
  took the click. What it does is up to the mode: in `draw_point` it
  creates the point, and on the closing vertex of a line or an area it
  finishes the shape
- `finish` completes the shape as soon as it has enough vertices,
  wherever the last one is, and returns `false` when no shape is in
  progress or the mode did not complete it (too few vertices)
- `cancel`, `undoVertex` and `redoVertex` drop the shape in progress,
  remove its last vertex and put it back
- `isActive` tells whether a drawing mode is drawing or ready to place its
  first vertex, and `isDrawing` whether a shape is in progress

## Automatic names

New features, layers and groups get a name with a serial number per type:
`Point 1`, `LineString 1`, `Polygon 1`, `Circle 1`, `Freehand 1`,
`Image 1`, `Layer 1`, `Group 1`. A custom feature type uses its type name
as the word.

A number is never reused: after `Point 1` and `Point 2`, deleting
`Point 2` and drawing again gives `Point 3`. Names that arrive in the
document, by a load or from code, count as well.

```ts
const draw = createDraw(map, {
  autoName: {
    typeNames: { Point: 'Pin', Layer: 'Sheet' },
    formatter: (typeName, n) => `${typeName} #${n}`,
  },
});
```

`autoName: false` turns the names off; new features then have no `name`.
A layer or a group always has a name, so one created without a name then
gets the word of its type alone (`Layer`, or your `typeNames.Layer`). The
option can change while the instance runs, with `draw.options.update`.

### Names in another language

The words of every generated name come from this one option, and the
defaults are English. The library does not translate them, and they are
not part of the `messages` option ([Styles](styles.md)). An application
that shows another language passes a word for each type it uses in
`typeNames`, keyed by the type name: `Point`, `LineString`, `Polygon`,
`Circle`, `Freehand`, `Image`, `Layer`, `Group`, and the name of each
custom feature type it draws.

```ts
const draw = createDraw(map, {
  autoName: {
    typeNames: {
      Point: 'Punkt',
      LineString: 'Linie',
      Polygon: 'Polygon',
      Circle: 'Kreis',
      Freehand: 'Freihand',
      Image: 'Bild',
      Layer: 'Ebene',
      Group: 'Gruppe',
    },
  },
});
```

A name is written into the document when the item is created, so it stays
in the language it was created in.

## Near the antimeridian

Longitudes are expected in [-180, 180]. Near the antimeridian the features
on the other side are drawn next to the line. At low zoom, when the view
is 360 degrees wide or more, a feature is drawn once rather than on every
copy of the world, and box selection does not reach across the line.

## Accessibility

Drawing and editing are driven by pointer input on the map canvas, and the
library adds no ARIA roles or labels. The keyboard covers deleting, moving
by arrow keys, grouping and cancelling. `draw.features.create` lets an
application offer another way to enter coordinates, such as a form.

## Examples

- [Get started](../examples/get-started.md) draws with the tools of the
  standard UI and listens to `document.changed`
- [Build your own UI](../examples/custom-ui.md) calls `setMode` from
  buttons of its own and follows `mode.changed` and the selection
- [Editing shapes](../examples/editing-shapes.md) shows the frame, the
  vertex and midpoint handles, an area with a hole, a `MultiPolygon` and
  shared vertices that move together

## Reference

- [`Draw`](../api/maplibre-gl-draw/interfaces/Draw.md) (`setMode`,
  `getMode`)
- [`Mode`](../api/maplibre-gl-draw/type-aliases/Mode.md) and
  [`MODES`](../api/maplibre-gl-draw/variables/MODES.md)
- [`FeaturesCollection`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md)
  and [`FeatureInput`](../api/maplibre-gl-draw/interfaces/FeatureInput.md)
- [`SelectionResource`](../api/maplibre-gl-draw/interfaces/SelectionResource.md)
  and
  [`VertexSelectionResource`](../api/maplibre-gl-draw/interfaces/VertexSelectionResource.md)
- [`VertexRef`](../api/maplibre-gl-draw/interfaces/VertexRef.md)
- [`DrawingResource`](../api/maplibre-gl-draw/interfaces/DrawingResource.md)
- [`AutoNameOptions`](../api/maplibre-gl-draw/interfaces/AutoNameOptions.md)
- [`SelectionStyleOptions`](../api/maplibre-gl-draw/interfaces/SelectionStyleOptions.md)
  and [`RuntimeOptions`](../api/maplibre-gl-draw/interfaces/RuntimeOptions.md)
  (the colors and sizes of the handles and of the shape being drawn)
- [Events](../reference/events.md)
