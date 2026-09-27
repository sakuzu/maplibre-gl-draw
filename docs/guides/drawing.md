# Drawing and editing

This guide covers what a user can do on the map: the six drawing modes, the
`select` mode that moves, resizes, rotates and edits the vertices of what is
selected, the keyboard and touch input, Multi geometries and holes, drawing
from code (`draw.input`) and the names given to new features.

The examples assume a `draw` instance created as in
[Getting started](../getting-started.md).

## Minimal code

```ts
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map);

// Click to add vertices; Enter or a click on the first vertex finishes
draw.setMode('draw_polygon');

draw.on('draw.feature.create', ({ feature }) => {
  console.log(feature.type, feature.properties.name);
});

draw.on('draw.mode.change', ({ mode }) => {
  console.log('mode', mode); // 'select' once the polygon is finished
});
```

After the polygon is finished, the new feature is selected and the mode is
`select`, so the user can move or reshape it right away.

## Modes

There are seven built-in modes. `select` is the default
(`Options.defaultMode`).

| Mode | Creates | How |
| --- | --- | --- |
| `select` | nothing | select, move, resize, rotate, edit vertices |
| `draw_point` | `Point` | one click |
| `draw_line` | `LineString` | clicks, then finish |
| `draw_polygon` | `Polygon` | clicks, then finish |
| `draw_circle` | `Circle` | click the center, click the radius |
| `draw_freehand` | `Freehand` | drag a stroke |
| `draw_image` | `Image` | the host picks a file (see below) |

`draw.setMode(mode)` returns `true` when the mode is `mode` after the call.
It returns `false`, and nothing changes, for a name with no registered mode,
for a drawing mode while the interaction lock is on, and for a drawing mode
while no layer can be written (every layer is locked or hidden; see
[Layers and groups](layers.md)). Custom modes are added with
`registerMode` ([Plugins](plugins.md)).

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

- A line needs two vertices and a polygon three before Enter or a click on
  the last (line) or first (polygon) vertex finishes it. The cursor turns
  into a pointer over that vertex
- Backspace and Delete remove the last placed vertex of a line or polygon
- A circle takes its radius from the distance between the center and the
  pointer, and a second click finishes it once the radius is at least 1 m
- Switching to another mode while a line, polygon or circle is in progress
  discards it
- A double click while drawing counts as two clicks and does not zoom the
  map
- A drawing mode clears the selection when it starts

### After finishing

A point, line, polygon or circle is created in one transaction with its
selection, and the mode returns to `select` with the new feature selected.
`draw.feature.create` and `draw.selection.change` fire for it.

Freehand is different: every stroke (press, drag, release) becomes its own
feature, the mode stays `draw_freehand` so that strokes can follow one
another, and the new features are not selected. A second finger landing
during a stroke, or the browser cancelling the touch, discards the stroke.

Every drawn feature gets `properties.createdZoom`, the zoom when it was
drawn, and its line widths then follow the map (see [Styles](styles.md)).
An application that wants the widths to stay the same on the screen
creates the instance with `scaleWithZoom: false`; a drawn feature then gets
no `createdZoom`, like a feature added through the API. When automatic
names are on, every drawn feature also gets `properties.name`. The new
feature
goes into the active layer, or into the first writable layer when the active
one is locked or hidden.

### Images

The library does not open a file dialog. Entering `draw_image` emits
`draw.image.request` with the map center, the zoom and the target layer,
and returns to `select` at once. The host shows its own file picker and
passes the file to `draw.load`:

```ts
draw.on('draw.image.request', ({ coordinate, zoom, layerId }) => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) await draw.load(file, { coordinate, zoom, layerId });
  });
  input.click();
});

draw.setMode('draw_image');
```

The image is centered on `coordinate`, converted to WebP (scaled down when
a side exceeds 4096 px), stored once in the document's files and referenced
by the feature, and the new feature is selected. Several Image features can
share one stored file.

The library does not take files dropped on the map. To place a dropped
image where it was dropped, the application listens to the drop and calls
`draw.load` with that position; see
[Files dropped on the map](save-load.md#files-dropped-on-the-map).

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

- A drag with a corner changes a circle's radius and center together; the
  radius handle keeps the center and remembers its angle
  (`radiusHandleAngle`)
- An image is scaled as a whole (its `scale` property), not per axis
- A point keeps a constant size on screen, so it has only a frame
- A midpoint handle sits on the edge as it is drawn, halfway across in
  longitude
- On the globe projection an edge between two vertices follows the path it
  takes on the Mercator map (a parallel stays a parallel), as maplibre's own
  layers do. The fill, the outline, the frame, the handles and the hit test
  all follow that path
- A single-coordinate feature (a one-point `MultiPoint`) shows its vertex
  handles but no corners or rotation handle
- Every drag is one change: the intermediate states are written with
  `isIntermediate` and the release commits
- A locked feature can be selected but shows no handles and does not move
  ([Layers and groups](layers.md))

For a line or polygon with very many vertices the handles are thinned on
screen; see [Performance](performance.md).

### Vertices

A click on a vertex handle selects that vertex, and Shift+click adds or
removes another vertex of the same feature. Delete or Backspace removes the
selected vertices. The same can be done from code:

```ts
draw.selectVertices(featureId, [{ ring: 0, index: 2 }]);
draw.getSelectedVertices(); // { featureId, vertices: [...] }
const removed = draw.deleteVertices(featureId, [{ ring: 0, index: 2 }]);
```

A vertex is named by a `VertexRef` (`{ part?, ring, index }`); see
[Multi geometries and holes](#multi-geometries-and-holes). Deleting never
removes the feature itself:

- A line keeps at least two points
- A polygon ring keeps at least four positions (a closed triangle). The
  test is per ring, and the closing position follows the first one
- In a `MultiPoint` a vertex is a part, and the last part stays
- In the other Multi types the test is per part and ring, so one part at
  its minimum does not block deletion in another

Snapping applies to vertex drags, and vertices shared with neighbouring
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

A box selection selects the features whose shape intersects the box (a
point counts by its coordinate, an image by its rotated frame). When the
selection existed before, each feature in the box is toggled. Escape during
the drag restores the selection as it was. Locked and hidden features are
not box-selected.

A multiple selection shows one frame with corner and rotation handles
around all of it. Dragging inside the frame moves every feature by the same
amount; a corner scales them all from the opposite corner, each by its own
rule (coordinates for geometries, `scale` for images, only the position for
points); the rotation handle turns them around the center of the frame
(points keep their icons upright).

A touch screen has no Shift key, so box selection and Shift+click are not
available there. Offer your own control and call `draw.select(ids)`.

The selection can also be a group or a layer (`draw.select(id, 'group')`).
`draw.getSelectedFeatures()` returns features only for a feature selection,
and `draw.deleteSelection()` deletes whatever is selected, the same as the
Delete key.

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

A drag ends without committing when the window loses the focus, and a
press released outside the page is released where the pointer last was.

## Touch and pen

The supported input is the mouse, the keyboard, one finger and a pen. One
finger does what the left mouse button does: drawing, moving, vertex
editing, rotating, resizing and freehand strokes. A long press is a context
menu event and two quick taps are a double click. Gestures with two or more
fingers belong to the map (pan, zoom, rotate), and a second finger that
lands during a drag cancels the drag.

A pen works through whichever events the browser reports it with. The
normalized events that modes and plugins receive carry `pointerType`
(`'mouse'`, `'touch'` or `'pen'`).

## Multi geometries and holes

The drawing modes create single geometries, and a polygon is drawn with its
outer ring only. `MultiPoint`, `MultiLineString`, `MultiPolygon` and
polygons with holes come from:

- `draw.load` of GeoJSON (Multi geometries are kept; `flattenMulti: true`
  splits them into single features)
- the geometry operations: a union of separate polygons gives a
  `MultiPolygon`, a subtraction from the inside gives a hole
  ([Snapping and geometry](snapping-geometry.md))
- `draw.addFeature` with the coordinates

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

## Drawing from code

`draw.input` sends synthetic clicks, moves and keys into the same entry
point as the pointer. A drawing mode cannot tell them from real input, so
snapping and plugins work the same way. Use it for numeric input (a
distance and bearing, typed coordinates), for automation and for tests.

```ts
draw.setMode('draw_line');
draw.input.click([139.7, 35.68]);
draw.input.click([139.71, 35.68]);
draw.input.click([139.71, 35.69]);
draw.input.key('Enter');

// The mode is back to select with the new line selected
const [line] = draw.getSelectedFeatures();
```

- A coordinate is `[lng, lat]` or `{ lng, lat }`; the screen position is
  computed for you
- `click` sends a move to the same place first, as a real cursor would, so
  a circle needs only two clicks: the center, then a point on the edge
- A polygon also finishes with a click on its first vertex
- `key('Escape')` cancels and `key('Backspace')` removes the last vertex
- `move` moves only the preview of the drawing
- A synthetic input snaps like a real one. Pass `{ snap: false }` to place
  a typed coordinate exactly

```ts
draw.input.click([139.7, 35.68], { snap: false });
```

While a panel of your own decides the coordinates, call
`draw.input.setPointerHold(true)`: clicks and moves from the real pointer
then stop reaching the mode (the map still pans and zooms). Set it back to
`false` when the panel closes. The library does not include the input
panel itself.

## Automatic names

New features, layers and groups get a name with a serial number per type:
`Point 1`, `LineString 1`, `Polygon 1`, `Circle 1`, `Freehand 1`,
`Image 1`, `Layer 1`, `Group 1`. A custom feature type that an extension
draws uses its type id as the word.

A number is never reused: after `Point 1` and `Point 2`, deleting
`Point 2` and drawing again gives `Point 3`. Names that arrive from a load
or from `addFeature` count as well.

```ts
const draw = createMapLibreGLDraw(map, {
  autoName: {
    enabled: true,
    typeNames: { Point: 'Pin', Layer: 'Sheet' },
    formatter: (typeName, n) => `${typeName} #${n}`,
  },
});
```

`autoName: false` turns the names off; new features then have no `name`.
A layer or a group always has a name, so one created without a name then
gets the word of its type alone (`Layer`, or your `typeNames.Layer`).

### Names in another language

The words of every generated name come from this one configuration, and
the defaults are English. The library does not translate them, and they
are not part of `Options.messages` ([Messages](styles.md#messages)). A host
that shows another language passes a word for each type it uses in
`typeNames`, keyed by the type id: `Point`, `LineString`, `Polygon`,
`Circle`, `Freehand`, `Image`, `Layer`, `Group`, and the type id of each
custom feature type it draws.

```ts
const draw = createMapLibreGLDraw(map, {
  autoName: {
    enabled: true,
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
by arrow keys, grouping and cancelling. `draw.input` lets a host offer
another way to enter coordinates, such as a form.

## Examples

- [basic](../../examples/basic/) draws a polygon, listens to
  `draw.feature.create` and `draw.features.change`, and exports GeoJSON

## Reference

- [`MapLibreGLDraw`](../api/maplibre-gl-draw/interfaces/MapLibreGLDraw.md)
  (`setMode`, the selection and vertex methods)
- [`Mode`](../api/maplibre-gl-draw/type-aliases/Mode.md)
- [`InputOperations`](../api/maplibre-gl-draw/interfaces/InputOperations.md)
- [`VertexRef`](../api/maplibre-gl-draw/interfaces/VertexRef.md)
- [`AutoNameConfig`](../api/maplibre-gl-draw/interfaces/AutoNameConfig.md)
- [`SelectionUIConfig`](../api/maplibre-gl-draw/interfaces/SelectionUIConfig.md)
  and
  [`FeatureStyleConfig`](../api/maplibre-gl-draw/interfaces/FeatureStyleConfig.md)
  (the colors and sizes of the handles and of the drawing preview)
- [Events](../reference/events.md)
