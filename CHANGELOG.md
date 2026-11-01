# Changelog

All notable changes to `@sakuzu/maplibre-gl-draw` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows semantic versioning.

## [Unreleased]

3.0.0 lets a store hold the features of a layer as rows of columns, so
that a layer of a million features is drawn, hit tested and edited
without a million objects: a row is made a feature only while it is
selected or edited. The layers and groups of such a store are a kind of
their own (`kind: 'table'`), the stacking order is told by the moves of
its items, and the parts in the words of the rows are in a new entry,
`@sakuzu/maplibre-gl-draw/kasane`, which is experimental. An app over
the default store changes in a few places: the
[migration guide](docs/guides/migrating.md#from-2x-to-30) lists them.

2.3.0 comes before 3.0.0: an application can make the IDs itself, and
can read a source into new features, groups, files and layers without
writing it. Its changes are listed after those of 3.0.0.

### Added in 3.0.0

- The entry `@sakuzu/maplibre-gl-draw/kasane`, experimental (it may
  change in a minor release): `createTableStore`, an in-memory store that
  holds its features as rows, and `createFeatureTables`, the tables for a
  store of your own; the reading and writing sides of the tables
  (`FeatureTables`, `LayerTableView`, `FeatureTablesWriter`); the values
  of rows (`RowValues`, `createRowValues`, `rowValuesOf`); and the builder
  and the merge of row blocks for a Worker (`createRowBlockBuilder`,
  `mergeRowBlock`, `RowBlock`, `transferList`). It loads neither
  maplibre-gl nor the drawing, and its errors are `DrawError`s.
- `TableLayer` and `TableGroup`, the layers and groups of a store that
  holds its features as rows (`kind: 'table'`), with `ObjectLayer` and
  `ObjectGroup`.
- Reads of a layer of any size: `features.list(filter, { limit, after })`
  lists the features up to a limit and reads on after the feature read
  last (`FeatureListOptions`); `layers.listItems(id, { offset, limit })`,
  `layers.countItems(id)` and `groups.listMembers(id, { offset, limit })`
  read the items of a layer and the features of a group by position
  (`ItemListOptions`), in every kind of layer; `features.bbox(filter)`
  reads the extent of the features that match, as `features.count`
  counts them, without making them (`null` when none matches).
- What an undo over a store of rows writes back:
  `DocumentChange.previousValues` (`FeatureValues`) and
  `DocumentChange.restoreToken` (`RestoreToken`), written back with
  `features.restore(values)` and `groups.restore(id)`, and let go of with
  `features.releaseRestore(token)`. A lock refuses them unless the
  transaction ignores the locks.
- `MoveTarget` names a place by the items around it (`ItemPlacement`:
  `{ layerId, groupId?, below }` or `{ ..., above }`), in every kind of
  layer.
- `DocumentChange.order`: the items put in another place of the stacking
  order, each with where it was and where it is (`ItemMove`,
  `ItemPosition`), and many rows put in another place at once. For a
  store of your own, `diffItemOrder(lists, isGroup)` makes them from the
  lists of items before and after (`ItemListChange`).
- The event `group.moved`.
- Optional members of `Store`: `moveItem` and `moveItems`;
  `createFeatures`, which creates many features at once, so that a store
  that holds its features as rows writes them in one write of its tables,
  with the keys of their order made together and short
  (`features.createMany` uses it, and gives the features one at a time to
  a store without it); `createGroups` and `deleteGroups`, the same for
  groups (`groups.createMany` and `groups.deleteMany`), each group put at
  the place of its frontmost feature as `groups.create` puts it; and for
  a store that holds its features as rows, `tables` and `applyRows`. The
  fields of a store of rows
  (`StoreView.tables`, `Store.applyRows`, `DocumentChange.rows` and
  `DocumentChange.opened`) are experimental, and their types are in
  `/kasane`.
- `GroupInput.layerId`, which must be the layer of the features.
- `draw.debug.gpu()` (`GpuMemoryDiagnostics`): the bytes of GPU memory the
  drawing holds.
- `CoordinateDimensions` in `/table`.
- Many features selected at once, in a store that holds its features as
  rows: past 2,000 features (a box, every feature, a group or a layer of
  many features), the selection has no list of IDs and tells their
  number, layers and extent (`Selection.bulk`, `SelectionBulk`, and
  `bulk` and `previousBulk` in `DocumentChange.selection` and
  `selection.changed`). The verbs of `draw.selection` act on them, the
  select mode moves, rotates and resizes them by the state of their rows
  and writes them once let go, over several draws of the map (each draw
  writes the rows that fit in its time, the others drawn moved until then, and
  `drag.ended` comes after the last), and the arrow keys write the moves
  of a key held once.
- `selection.setAll(filter)`, `selection.count(filter)`,
  `selection.update(patch | make, filter)` (a patch made once per kind of
  feature, `FeatureStyleSample`) and `selection.restore(selection)`;
  `selection.features(filter, { limit, after })` reads the selection a
  page at a time.
- `drag.started` and `drag.ended` carry `bulk` for features selected in
  bulk.
- Experimental: what an extension answers and draws from the rows of a
  layer held as rows, without making their features, in one member `rows`
  of each of its types, whose types are in `/kasane`:
  `FeatureTypeDefinition.rows.appliesTo` (`FeatureTypeRows`),
  `CompanionProvider.rows.has` (`CompanionProviderRows`), and
  `FeatureRenderer.rows` (`FeatureRendererRows`) with `draw`, which draws
  the rows, and `sprites`, the pictures of the points a renderer draws,
  drawn with the rows of their layer. In `/kasane` too,
  `listSelectedRows`, `DraggedRows` (read with
  `draw.rendered.getDraggedRows()`) and the types of the
  pictures (`RowSpriteSource`, `RowSprite`, `RowSpriteDistanceScale`).
  `LayerTableView.getRowStyle` reads the style of a row, shared and
  frozen, without a copy.
- Features selected in bulk and turned or resized are drawn during the drag
  as they are written once let go: an image, a type resized by its scale
  and a feature with a rotation or a scale keep their shape and change
  those values, as features dragged one by one do. `DraggedRows.rotation`
  and `scale` give the change of those values for such features (and the
  factor of the radius of a Circle), 0 and 1 for the others.
- A group hidden on this client (`draw.hidden`) hides its features in a
  layer held as rows too, as in a layer of objects.
- `draw.document.setShown(store)` and `getShown()`: another document held
  as rows (a past version, say) shown in place of the document on the
  same map, for this client only. The instance is read-only meanwhile and
  the pointer and the keys move the map only; the changes from elsewhere
  are still taken.
- `draw.memory` (`MemoryResource`): what the documents drawn on the page
  take (`get`, `MemoryUsage`: the GPU memory every instance allocated and
  an estimate of the heap from the features and their positions) against
  the limit of the device (400 MiB on an iPhone, 500 MiB on an iPad,
  1 GiB elsewhere, or the one of `setLimit`), and what a document of a
  size would take (`estimate`, `DocumentSize`, `MemoryBytes`), so that a
  page stops what would pass the limit before it starts.
- `draw.captureImage(options)` (`CaptureImageOptions`): an image of the map
  as it is drawn, taken in its next draw without the selection and the
  shape being drawn.
- In `/kasane`: `FeatureTables.showInPlace(owner, features)`, features
  drawn in the places of rows for this client only, without writing them
  (the edits of others in their middle); `FeatureTablesWriter.clear()`,
  every row taken out of the tables to come back, the rows opened, the
  features selected in bulk and the work under way let go of, the ids
  keeping their handles; and `copyTableStore` (`TableStoreCopy`), a copy
  of a document held as rows into a new store of rows a block at a time,
  to draw it apart without making its features.

- The values of the attributes (`Value`), from the main entry and from
  `/kasane`: the classes of the kinds JSON has not (`BigInteger`,
  `Decimal`, `Bytes`, `CalendarDate`, `TimeOfDay`, `DateTime` local, UTC
  or with an offset and to the nanosecond, `Duration` and `Reference`),
  each frozen and written by `JSON.stringify` as its JSON form;
  `sameValue`, `isValue`, `valueToJSON`, `valueFromJSON`,
  `parseValueJSON` and `stringifyValueJSON`, which reads an integer
  outside the range of a number as a big integer; and
  `rewriteReferences`, which makes the references of a copy name the
  copies. The tables and Tabane hold every kind, NaN, the infinities and
  -0 included.
- `rowsOfGeoJSON` in `/kasane` (`GeoJSONRow`, `GeoJSONRows`): features
  of GeoJSON read as the values of rows of a layer, by the rules of
  `document.load` (the type, the style, `visible` and `locked` from the
  prefixed keys, the style of simplestyle-spec, the values of the
  library, a GeometryCollection folded by type), with the ID the input
  gives each feature, so that rows written without a load hold what a
  load would make of the same features. A load reads a feature by the
  same code.
- `debug.checks` of `createDraw`, experimental (`DebugOptions`,
  `ConsistencyCheck`, `ConsistencyCheckOptions`, `ConsistencyFailure`):
  for development and tests, the instance checks that its state agrees
  with itself (the ids of the rows and the places they are read at, the
  selection, and what the drawing keeps), once each notification of the
  store has gone out and once each draw of the map is done. A check that fails
  throws `DrawError` with the code `invalid-state`, unless it is allowed
  to fail; each failure is given to `onFailure`.
- `ScreenContext.metersPerPixel(lngLat)`: the meters a CSS pixel spans on
  the ground at a position, in the view drawn last, as the engine lays
  the margin of the selection box and the distance of the rotate handle
  on the map with it, so that an extension can lay what it draws around a
  feature for the current view the same way.
- `draw.rendered` (`RenderedResource`), the features as this client draws
  them: `get` and `getMany` read them with the sketches applied over the
  document, `getSelectionBox` gives the selection box of a feature (its
  footprint with the margin) in the view drawn last, `getFootprint` its
  footprint without the margin (the four corners of an image as it is
  drawn, the footprint a custom type declares), and `getDraggedRows`,
  experimental, the rows dragged in bulk. The event
  `rendered.changed` tells the features whose shapes changed (a write of
  features or of rows, or a sketch), once the draw of the map that draws
  them is done, at most once a draw; the look and the selection box,
  which follows the view, are read at each draw. What is drawn around a
  feature reads it there.
- `FeatureTypeDefinition.footprint(feature, ctx)`: what a feature of a
  type covers, from which the library makes its selection box (draws it,
  hits it and places the handles on it), as four corners laid on the map
  (`GroundFootprint`) or a box of a fixed size on the screen around a
  position (`ScreenFootprint`), the two kinds of `Footprint`. The kind,
  not the geometry, decides whether the box is drawn and hit on the map,
  with the resize and rotate handles, or on the screen, without them. A
  type without it has the footprint of its geometry. Its context is a
  `FootprintContext`, the screen alone (`ctx.screen`).
- `FeatureTypeDefinition.transformFields` (`TransformFields`): the keys of
  `properties` a custom type keeps the rotation and the factor of the
  size of its features under (`angleDegreesKey`, `scaleKey`), and whether
  a scaling keeps their shape (`uniformScale`). Every `rotate` and
  `scale` edit writes them, from 0 and 1 for a feature without them: the
  resize and rotate handles of a footprint laid on the map, drawn and hit
  as those of a built-in shape, for one feature or many, and the edits a
  store applies (`Store.applyEdits`); a rotation of a single feature of a
  `Point` turns it around its position. A store of your own reads them
  with `draw.extensions.featureTypes.get`. A definition given to
  `override` cannot have them (`invalid-input`).
- `HandleContext`: what the `handles` of a feature type and of a handle
  provider, and `globalHandles`, receive: the screen, the selection box
  the library draws (`selectionBox`, as `draw.rendered.getSelectionBox`
  answers it, `null` for the handles of no feature) and the look of the
  selection (`selectionStyle`), so that a handle on the box sits where
  the library draws it.
- `drawHandles(feature, handles, ctx)` of a feature type and of a handle
  provider: the extension draws its custom handles there, with the render
  context of the draw. The library calls it exactly when it shows them
  (one feature selected, the document editable, the feature not locked,
  no other handle dragged), so an extension tests none of it.
- `FeatureTypeDefinition.defaultStyle`: the look of the features of a
  custom type, in place of the defaults of their geometry (the `style`
  option, which still fills the keys it leaves out).
  `features.getAppliedStyle` answers it with the color of the layer rule
  (in the channel of the type) and the style of the feature over it. It
  is checked as the style of a feature is, and a definition given to
  `override` cannot have it (`invalid-input`).
- `FeatureTypeDefinition.styleRuleChannel` (`'fill'`, `'stroke'` or
  `'point'`): the key of the look the color of a layer rule goes to for
  the features of a custom type. A definition given to `override` cannot
  have it (`invalid-input`).
- `RenderContext.appliedStyle(feature)`: the look a feature is drawn
  with (the feature drawn, the sketches applied), put together as
  `features.getAppliedStyle` puts the look of the values of the document,
  by the library in one place, so that the renderer of a custom type draws what
  the library answers, the color of the layer rule included. Reading it
  again gives the same object until the feature, the rule of its layer or
  the `style` option changes.
- `PluginContext.emit(event, payload)`: a plugin sends events of its
  own, which it declares in `DrawEvents` by declaration merging, to the
  subscribers of `draw.on` and `ctx.on`, so that every event is in the
  one list. The events of the library are refused with `invalid-input`.
- `pixelsToMeters(pixels, zoom, latitude)` in `/geometry`: a size in
  pixels at a zoom of its own (the zoom a shape was made at) as a length
  on the ground, by the scale of Web Mercator on the sphere of
  `EARTH_RADIUS_METERS`, which the library draws a size kept with a zoom
  by. With `metersToDegrees`, an extension draws and hit tests such a
  size by the same formula as the library.
- `defineMessages(defaults)` and `ExtensionContext.messages`: an
  extension declares message keys of its own in `Messages` by
  declaration merging and gives their English defaults to
  `defineMessages`; the `messages` option of every instance then takes
  them as it takes the keys of the library (a key nothing defines is
  still refused), and the extension reads them from `ctx.messages`, the
  table of its instance.
- `parseCssColor(value)`: a CSS color read as the library reads every
  color it takes, as `[red, green, blue, alpha]` from 0 to 1, or `null`
  for a value it does not take, so that an extension checks the colors of
  its own style keys, and reads the colors it draws with its own shader,
  as the library does.
- `Store.acceptsId(id)`, optional: whether the store takes a feature, a
  group or a layer with an ID. A load gives one whose ID the store does
  not take a new ID, as it does to an ID that is taken, and the
  references to it name the new one; a feature, a group or a layer
  created with an ID given (`create` and `createMany` of the features,
  the groups and the layers, a sketch that creates a feature, the new
  layer and group of a load) that it does not take is refused with
  `invalid-input` before anything is written.

### Changed in 3.0.0

- While a selected feature is dragged as a whole, its handles follow it:
  the resize, rotate and vertex handles of the library and the handles of
  an extension (`resize` drawn by the library, `custom` drawn by
  `drawHandles`) are shown with its selection box where it is drawn as it
  moves, and none of them is grabbed until the drag ends. They were
  hidden during the move. A drag of several features keeps its handles
  hidden.

- What the library does not take is told, as a handle of a wrong shape
  is: a footprint or a bbox of a feature type that is not one, which
  falls back to that of the geometry, and a color a shared renderer
  cannot read, which is drawn transparent, give a warning in the console
  once (for the type, or for each part of each renderer). The parts of
  `/webgl` that draw on the terrain (`setTerrain`,
  `terrainTessellationStep`, `drawQuadSurfaceOnTerrain`) throw a
  `DrawError` with the code `invalid-input` for an object the instance did
  not give a renderer, as `viewUniforms` does (`null` still draws without
  terrain); they drew without terrain.

- The color of a layer rule goes to the key a custom type declares in
  `styleRuleChannel`, or else to the key of the geometry of the feature,
  as for a built-in type: `pointColor` for a Point or a MultiPoint,
  `strokeColor` for a LineString or a MultiLineString, and `fillColor`
  for a Polygon or any other geometry. It went to `fillColor` for every
  custom type: the rule color of a custom type of points or of lines that
  declares no channel changes, and a type drawn as a card or a box on a
  Point with its paper in `fillColor` declares `styleRuleChannel: 'fill'`
  to keep it.

- `FeatureStyleResolved` has every key of the style the library defines,
  each required, and no more: a style key an extension adds to
  `FeatureStyle` by declaration merging stays optional in it, as the look
  has it only when the type or the feature gives it (it was required).

- A key a plugin or a mode of an extension consumes (`onKeyDown` returns
  true) has its default action prevented, so the map no longer also acts
  on it (an arrow key consumed does not pan). Return true only for a key
  that did something.
- The values of `properties` are `Value`s (`DrawProperties`). A bigint
  is held as a number or a `BigInteger`, a `Uint8Array` as `Bytes`, and
  a `Date`, a `Map`, an instance of another class, a function or a
  string with a lone surrogate is refused with `invalid-input`.
- `document.load` of a text keeps an integer outside the range of a
  number as a `BigInteger`, the values of a document of the library are
  read from their JSON form, and a `Reference` to a feature that takes a
  new ID on a load or a parse names the new ID.

- `Layer` and `Group` are unions told apart by `kind`. A layer held as
  rows has no `items`, and a group of it no `featureIds`: narrow by
  `kind` before reading them, or read them with `layers.listItems` and
  `groups.listMembers`. A document (`DrawDocument`) holds the layers and
  groups that list their items (`ObjectLayer[]` and `ObjectGroup[]`): a
  layer held as rows is written with the items its rows list, so
  `layer.items` and `group.featureIds` of a document are read as before.
- `feature.moved` carries `from` and `to` as `ItemPosition`s (the layer,
  the group and the items just below and above) instead of `MoveTarget`s,
  and fires for a move in the same layer or group as well, once per
  transaction. It fires after the events of the groups, with
  `group.moved`.
- A change of the order is told by `feature.moved`, `group.moved` and
  `DocumentChange.order` only: an update of a layer that changed nothing
  but its `items`, or of a group nothing but its `featureIds` (a feature
  created, deleted or moved), is no longer in `layer.updated`,
  `group.updated` nor `DocumentChange.layers.updated` and
  `groups.updated`. An update of another field carries the lists as they
  are.
- A store that holds its features as rows refuses what would make or
  place every feature at once: `features.list` without a `limit`, and a
  place by `index`, throw a `DrawError` with the code `invalid-state`.
- `TableGeometry.dimensions` takes the names of GeoArrow (`'xy'`,
  `'xyz'`, `'xym'` or `'xyzm'`, `CoordinateDimensions`) instead of `2` or
  `3`.
- The rotate handle stands `selectionStyle.rotateHandle.distance` CSS
  pixels above the selection box on a flat map, closer to the box than
  before:
  it stood twice that distance away at the equator and more toward the
  poles (about 2.5 times at a latitude of 35 degrees), as its distance
  was turned into degrees with tiles of 256 pixels and with the scale of
  the longitude for the latitude too.
- The margin of the selection box of a feature with an extent and the
  distance of the rotate handle are laid on the ground: they are turned into meters
  at the feature with the scale of the view (`ScreenContext.metersPerPixel`:
  that of Web Mercator at the latitude of the feature, that of the center
  of the view on the globe, and the mix of the two in the transition
  between them) and tilt and turn with the map. On a flat Web Mercator
  map without terrain they are the pixels given, as before; tilted they
  are foreshortened as the map is, on the globe they are the pixels given
  at the center of the view and shorter toward its edge, and over terrain
  they follow the ground. The selection box of a point stays on the
  screen around its marker.
- The arrow keys move the selection by a length on the ground: the
  pixels of the press turned into meters with the scale of the view,
  along the direction of the key on the screen turned by the bearing of
  the map. On a flat Web Mercator map, untilted, it moves by those pixels
  on the screen as before; tilted, by the same length on the ground.
- Every length on the ground is measured on the sphere maplibre draws,
  of a radius of 6,371,008.8 m, instead of a circumference of
  40,075,016.686 m: a width given in meters is drawn 0.11 % wider.
- The extents in degrees are named `bbox`, as `features.bbox` and the
  `bbox` of a filter are: `PreparedTable.bbox` of `/table` (was
  `bounds`) and `Dataset.getRowBBox` (was `getRowBounds`), as
  `SelectionBulk.bbox` and `LayerTableView.getRowBBox` are. The main
  entry exports `BBox`, the type `features.bbox` returns.
- The box of `FeatureTypeDefinition.boxSelect` is named `boxPx`, as a
  value in pixels is.
- `selectionStyle.boundingBox` is `selectionStyle.box`, the look of the
  selection box, so that `bbox` and the box of the selection are not one
  word in two lengths.
- `selectionStyle.boxSelection` is `selectionStyle.selectionRectangle`,
  the look of the rectangle a box selection drags, so that `box` names
  the selection box alone.
- A `Hit` of a feature names it by `id` alone, as `ModeContext.hitTest`
  and `map.clicked` give it: `featureId` is the feature a companion
  belongs to. The kind `handle` is gone, as the library makes none.
- The `hitTest` of a feature type returns the distance only
  (`{ distancePx }`), and the `hitTest` of a companion provider its ID and
  the distance (`{ id, distancePx }`): the library fills in the `Hit` it
  gives out (`map.clicked`, `ModeContext.hitTest`, the `onClick` of the
  provider) with the kind, the ID of the feature and `featureId`.
- `Plugin.interaction` is split by what each part does: `onFeatureCommit`
  (was `onDrawCommit`, named as `ModeContext.commitFeature`) is a member
  of the plugin, the hooks of the clicks of the select mode are
  `selectMode` (`onSelectedFeatureClick`, was `onFeatureClick`, called for
  a click on the feature selected alone only, and
  `onFeatureDoubleClick`), and an exclusive interaction is `exclusive`,
  whose `isActive()` (was `isBusy`) it requires, with `finish`, `cancel`
  and `container`.
- The values of the screen are those of the view drawn last:
  `ScreenContext.project`, `unproject`, `zoom` and `metersPerPixel`, the
  heights of `ctx.terrain`, and the position of a pointer event, which is
  the position drawn under the pointer (the inverse of the projection of
  that view, found from the position maplibre gives with its current
  camera). While a view is drawn, they are those of that view. What is
  grabbed is what was drawn, also when the camera moved after the draw;
  the positions `draw.drawing` is given are used as they are.
- `RenderContext.screen`, the screen of the view being drawn (the same
  object as `ctx.screen` of an extension), in place of
  `RenderContext.zoom` and `RenderContext.pixelRatio`, which it has.
- The values of the GPU of a view are out of the main entry: the render
  context no longer has `shader`, `offset` and `projection`, and
  `viewUniforms(ctx)` of `/webgl` gives them (`ViewUniforms`), with
  `offsetUniformsAt(ctx, position)`, the offsets from a position in the
  view of a render context. `ShaderData` and `OffsetUniforms` are types
  of `/webgl`.
- `ProjectionUniformManager.setUniforms(projection, offset, originShift?)`
  of `/webgl` no longer takes the zoom, which it did not read.
- `TerrainAnchors` is `TerrainSurface`, the surface of the terrain:
  `occlusionOpacity` (was `ghostOpacity`), `elevation` and `generation`.
  Its `project` is gone: `ScreenContext.project` answers where a position
  is drawn, on the terrain when it is on, as the shared renderers lay it,
  and on the map without terrain (where `TerrainAnchors.project` gave
  `null`).
- The zoom a width in pixels is given at is `referenceZoom` in the
  options of `LineRenderer.draw` (was `createdZoom`, the name of the key
  a feature keeps it under), and `PointRenderer.draw` takes it too: the
  size and the outline width of the marker are drawn
  `2 ** (zoom - referenceZoom)` times as large, as the width of a line
  is.

- A handle of an extension says how it is shown (`Handle` is
  `ResizeHandle | CustomHandle`): `kind: 'resize'` is drawn as the resize
  handles are and hit at their size (its drag still goes to the
  extension), and `kind: 'custom'` is drawn by the extension in
  `drawHandles` and hit within the `sizePx` it gives, a finite number
  above 0, the diameter of its mark. `kind` was a name the extension gave
  the handle, which `id` already tells; the library drew every handle as
  a white circle, the look of a vertex handle, over the mark an extension
  drew. A handle of another kind, or of a wrong size, is left out with a
  warning in the console once a reason.
- `FeatureTypeDefinition.handles`, `HandleProvider.handles` and
  `HandleProvider.globalHandles` receive a `HandleContext` in place of the
  `ScreenContext`, which is its `screen`.
- The drag of a handle of a `HandleProvider` goes to `onHandleDrag`,
  `onHandleDragStart` and `onHandleDragEnd` (were `onDrag`, `onDragStart`
  and `onDragEnd`), the names a feature type has.
- A custom type has the fields its `transformFields` declares and no
  other: the resize and the rotation no longer write
  `maplibre-gl-draw:rotation` and `maplibre-gl-draw:scale` of its
  features because they have them.

### Removed in 3.0.0

- `DocumentChange.layerReorder` and `DocumentChange.groupReorder`: the
  order inside a layer or a group is told by `DocumentChange.order`.
- `HitTestContext` and `SnapContext`: a hit test and the snapping
  candidates receive one context, `PointContext`, whose `excludeIds`
  (absent when none) tells what the reading leaves out, for a hit test
  the features this client drags as a whole.
- `FeatureTypeDefinition.bounds` and `outline`, and
  `ScreenContext.bounds` and `outline`, which gave the selection box in
  pixels of the screen: a type declares its `footprint` on the map or on
  the screen, and the library makes the selection box from it. A
  selection box of the screen is a box around a position, upright as the
  box of a point is.
- `ExtensionContext.drawing`: an extension reaches the same object as
  `ctx.draw.drawing`.

### Fixed in 3.0.0

- A key the library uses has its default action prevented, in every mode
  and whoever uses it: the select mode, the drawing modes, a plugin or a
  mode of an extension that consumes it, and the Escape that cancels a
  drag. Delete and Backspace deleting a vertex or the selection, Escape
  clearing a selection, and Enter, Backspace and Escape of the drawing
  modes did not prevent it, so a page that also listens for the keys on
  `document` and skips those with `defaultPrevented` handled them a
  second time (a vertex deleted with Delete was followed by the deletion
  of its whole feature). A key that does nothing (Delete with nothing
  selected, Escape with nothing to clear, Enter with too few vertices,
  Backspace with none, Cmd/Ctrl+G with nothing to group) is left to the
  map and the page.
- A rotation, a resize, a drag of the radius of a circle and a drag of a
  handle of an extension on a feature no longer snap to the features they
  change, as a move did not already: the pointer was pulled to an edge or
  a vertex of the feature it was turning or resizing, which moves with it.
- The start of a drag no longer snaps to what the drag changes, as the
  rest of the drag does not: a move, a resize, a vertex and a midpoint
  could snap to their own feature as they started, and a handle of an
  extension on a feature was given a start pulled to a vertex of that
  feature, so the feature did not follow the pointer from where it was
  grabbed.
- The handles of the selection are grabbed where they are drawn when
  `selectionStyle` gives them other sizes, another margin of the box or
  another distance of the rotate handle: the select mode tested them at
  the sizes and distances by default, so a handle drawn larger, or farther
  out, could not be grabbed where it was drawn.
- The selection box and its handles are grabbed where they are drawn on
  a tilted map, on the globe and over terrain: the drawing laid the
  margin on the map at the scale of Web Mercator while the hit test went
  through the screen and back, which with terrain or tilt lands
  elsewhere. Both now make the box with the same function, and the box
  of a point is tested on the screen around its marker, as it is drawn.
  A press inside the boxes drawn around several features (the box of all
  of them and the box of each) moves them, and a press outside them does
  not.

### Migration to 3.0.0

| 2.x | 3.0 |
| --- | --- |
| `DocumentChange.layerReorder` | `DocumentChange.order` |
| `DocumentChange.groupReorder` | `DocumentChange.order` |
| `feature.moved` `from`, `to` (`MoveTarget`) | `ItemPosition` |
| `TableGeometry.dimensions: 2` | `'xy'` |
| `TableGeometry.dimensions: 3` | `'xyz'` |
| `layer.items` of any layer | `layers.listItems(layer.id)` |
| `group.featureIds` of any group | `groups.listMembers(group.id)` |
| `Handle.kind`, a name the extension gives | `Handle.id` |
| `kind: 'vertex'` | `kind: 'custom'` with `sizePx` |
| The white circle the library drew | `drawHandles`, `ctx.point.draw` |
| `handles(feature, screen)` | `handles(feature, ctx)`, `ctx.screen` |
| `globalHandles(screen)` | `globalHandles(ctx)`, `ctx.screen` |
| `PreparedTable.bounds`, `SelectionBulk.bounds` | `bbox` |
| `Dataset.getRowBounds`, `LayerTableView.getRowBounds` | `getRowBBox` |
| `selectionStyle.boundingBox` | `selectionStyle.box` |
| `selectionStyle.boxSelection` | `selectionStyle.selectionRectangle` |
| `boxSelect(feature, box, ctx)` | `boxSelect(feature, boxPx, ctx)` |
| `FeatureTypeDefinition.bounds`, `outline` | `footprint(feature, ctx)` |
| `ScreenContext.bounds`, `outline` | `draw.rendered.getSelectionBox(id)` |
| `HitTestContext`, `SnapContext` | `PointContext` |
| `Hit` of a type, of a companion | `{ distancePx }`, `{ id, distancePx }` |
| `Hit` kind `'handle'` | (removed) |
| `features.get(id, { applySketches })` | `draw.rendered.get(id)` |
| `draggedRowsOf(tables)` of `/kasane` | `draw.rendered.getDraggedRows()` |
| `ExtensionContext.drawing` | `ctx.draw.drawing` |
| `interaction.onDrawCommit` | `Plugin.onFeatureCommit` |
| `interaction.onFeatureClick` | `selectMode.onSelectedFeatureClick` |
| `interaction.onFeatureDoubleClick` | `selectMode.onFeatureDoubleClick` |
| `interaction.isBusy` | `exclusive.isActive` |
| `HandleProvider.onDrag` | `onHandleDrag` |
| `HandleProvider.onDragStart` | `onHandleDragStart` |
| `HandleProvider.onDragEnd` | `onHandleDragEnd` |
| `TerrainAnchors` | `TerrainSurface` |
| `TerrainAnchors.ghostOpacity` | `TerrainSurface.occlusionOpacity` |
| `TerrainAnchors.project` | `ScreenContext.project` |
| `RenderContext.zoom`, `pixelRatio` | `ctx.screen.zoom`, `pixelRatio` |
| `RenderContext.shader`, `offset`, `projection` | `viewUniforms(ctx)` |
| `ShaderData`, `OffsetUniforms` of the main entry | the same of `/webgl` |
| `ctx.line.draw(..., { createdZoom })` | `{ referenceZoom }` |
| `setUniforms(projection, zoom, offset)` | `setUniforms(projection, offset)` |

### Added in 2.3.0

- `DrawOptions.generateId`, given only when the instance is created,
  makes the ID of everything the library creates instead of the built-in
  ULIDs: features drawn or created without an ID, groups, layers, the
  files of images, the results of the geometry operations, and the
  features and files a GeoJSON load gives new IDs
  ([#36](https://github.com/sakuzu/maplibre-gl-draw/issues/36)).
- `parseGeoJSON(input, options)` and `parseNative(input, options)` read
  GeoJSON or a document of the library as `document.load` reads it and
  write nothing, the counterpart of `featuresToGeoJSON`. They return a
  `ParsedDocument`: the features, groups, files and layers with new IDs
  from `ParseOptions.generateId`, the references between them rewritten,
  and the features left out in `skipped` with a `DrawErrorCode`.
  `ParsedDocument.idMap` gives the new ID of each ID of the input, one map
  per kind, so that an application or an extension rewrites the references
  it keeps in `properties`, which the library leaves as they are
  ([#36](https://github.com/sakuzu/maplibre-gl-draw/issues/36)).

### Fixed in 2.3.0

- An embedded image that has to be scaled down and that the browser
  cannot decode rejects a GeoJSON load or a load of a document of the
  library with a `DrawError` (`invalid-input`) instead of the error of
  the decoding
  ([#33](https://github.com/sakuzu/maplibre-gl-draw/issues/33)).
- An embedded image that the browser cannot encode in an accepted type
  rejects a load with `unsupported-format`, as an image file does,
  instead of `invalid-input`
  ([#35](https://github.com/sakuzu/maplibre-gl-draw/issues/35)).

## [2.2.0] - 2026-10-10

Features can be written as GeoJSON without a drawing, a store that holds
only part of the document can keep the numbers of the automatic names,
and an image keeps a small format on a browser that cannot encode WebP.

### Added in 2.2.0

- `featuresToGeoJSON(features, options)` and `featureToGeoJSON(feature,
  options)` write features that need not be in a drawing with the rules of
  `document.toGeoJSON`: rounding, ring orientation, the antimeridian, the
  prefixed keys and the bbox. `ToGeoJSONOptions.getFile` reads the file of
  an Image by its ID, and an Image whose file it does not find is written
  without its pixels.
- `Store` gets two optional members, `getMaxNameNumber(type)` and
  `recordNameNumber(type, number)`. A store that holds only part of the
  document implements them so that a number used in the part it does not
  hold is not used again for an automatic name. A store without them is
  numbered as before.

### Changed in 2.2.0

- `FileData.mimeType` of an image that was converted is the type the
  browser returned, not the one requested
  ([#31](https://github.com/sakuzu/maplibre-gl-draw/issues/31)).
- When the browser cannot encode WebP, an image with no transparent pixel
  is encoded as JPEG (quality 0.92) instead of being kept as PNG, so a
  photo stays small. An image with a transparent pixel keeps the format
  the browser returns
  ([#34](https://github.com/sakuzu/maplibre-gl-draw/issues/34)).

## [2.1.4] - 2026-10-07

Two fixes to how sizes follow the zoom: the paths of a dataset that drew
at a fixed size, and sizes below one pixel that never disappeared.

### Fixed in 2.1.4

- A dataset applies the draw factors of its `zoomScale` (size and
  opacity) on every path it draws through. The selection highlight and
  the selected feature drawn on top of it, dashed and dotted lines and
  polygon outlines, and shapes that go through immediate mode used to be
  drawn at their stored size, so a selected point or a dashed line did
  not change with the zoom. The dash pattern is now made from the scaled
  width. `BatchManager.beginFrame` and `DisplayBatchTarget.beginFrame`
  take an optional `factors` that is combined with the layer factors
  ([#28](https://github.com/sakuzu/maplibre-gl-draw/issues/28)).
- Sizes below one pixel are drawn so that the ink on screen follows the
  real size and fades out smoothly. A point whose diameter is below
  1 px is drawn at 1 px with its alpha multiplied by the ratio of the
  areas, and a line or a polygon outline thinner than 1 px is drawn at
  1 px with its alpha multiplied by the width, on the flat map and on
  the terrain drape alike. Before, a shrinking point kept a faint blob
  of about the antialiasing width until its size was exactly 0. This
  applies to datasets and hand-drawn features. Nothing changes at 1 px
  and above, and no minimum or maximum size is added
  ([#28](https://github.com/sakuzu/maplibre-gl-draw/issues/28)).

## [2.1.3] - 2026-10-04

Two fixes: the snap indicator that stayed after its input, and the
selection frame of a point on the globe and on the terrain at a high
pitch.

### Fixed in 2.1.3

- The snap indicator stayed after the input that made it: after leaving
  the drawing mode, turning snapping off, Escape, or a pan, it went on
  showing the last result, and `snap.changed` did not report the end of
  the snap. The engine now clears the snap result when the mode changes,
  when snapping (or a kind of it) is turned off, when a mode declines to
  snap an input, and on cancel, and `snap.changed` reports `null` once
  ([#22](https://github.com/sakuzu/maplibre-gl-draw/issues/22)).
- The select mode snapped every input, so hovering near a vertex drew
  the indicator, against the guide ("only while drawing and while moving
  a vertex"). It now snaps its drags only. A select-mode plugin that
  read `event.snapped` on a hover or a click receives the raw position
  ([#22](https://github.com/sakuzu/maplibre-gl-draw/issues/22)).
- The selection frame of a point is drawn as a figure of the screen,
  like the mark: it keeps the size of the mark and the margin on the
  terrain at any pitch and at the edge of the globe, and a point on the
  far side of the globe gets no frame. The frame of a selection of
  several features is drawn on the box of its handles
  ([#12](https://github.com/sakuzu/maplibre-gl-draw/issues/12)).

## [2.1.2] - 2026-10-02

Three fixes: a plugin's fill, the click that finishes a plugin's
exclusive interaction, and the selection frame of a point on the
terrain. Nothing else changes.

### Fixed

- A plugin's `fill.draw` drew nothing: the fill shared with the render
  context of custom feature renderers was never given its shader, so a
  renderer that filled an area with it left the area empty. It is now
  prepared each frame with the other renderers.
- A click outside the element of a plugin's exclusive interaction
  finished the interaction and did nothing else, so it took a second
  click to select a feature. It now goes on as an ordinary click after
  `finish()`: it selects the feature under it, or clears the selection
  on the empty map. A click on the feature already selected does not
  call `onFeatureClick`, so it does not start another interaction.
- With the terrain on and the camera pitched, the selection frame of a
  point was stretched into a tall rectangle. It now lies flat at the
  elevation of the point and keeps the size of the marker and the margin
  ([#12](https://github.com/sakuzu/maplibre-gl-draw/issues/12)).

## [2.1.1] - 2026-10-02

Three fixes to the lines drawn on the terrain: their thickness on a
high-DPI display, their thickness between the vertices, and dashed lines
that sank into the ground. Nothing else changes.

### Fixed in 2.1.1

- With the terrain on, a solid line or the outline of a polygon was drawn
  half as thick on a high-DPI display (a device pixel ratio of 2) as
  without the terrain, when its width follows the zoom. It is now as
  thick with the terrain as without it.
- With the terrain on and the camera pitched, a solid line looked like a
  string of beads: it was thinner between its vertices than at them, and
  the outline of a polygon was thinner along its edges. Its thickness is
  now the same all along.
- With the terrain on and the camera pitched, a dashed or dotted line,
  and the dashed outline of a polygon, sank into the ground on the side
  towards the camera and showed a jagged edge. They are now painted on
  the ground like solid lines, with the same dashes as without the
  terrain.

## [2.1.0] - 2026-10-01

The standard UI package, the documentation site with twenty examples and
the playground on it, the event `options.changed`,
`Dataset.getStyleRule()`, and fixes to the order of the layers after a
diffed `setStyle`, to a drag across the antimeridian on the globe, to the
`/geometry` functions given a feature, and to `scaleWithZoom` changed at
runtime. Nothing changes incompatibly.

### Added in 2.1.0

- The event `options.changed`, with `{ options, previous }`: what
  `draw.options.get()` returns after and before a `draw.options.update`
  that changed a value. An update that changes nothing fires nothing,
  and the event is not a change of the document, so it fires no
  `document.changed`.
- Twenty examples built with the standard UI, each with its page
  on the site: `get-started`, `style-features`, `feature-properties`,
  `layers-and-groups`, `style-rules-and-legend`, `snapping-and-tracing`,
  `geometry-operations`, `images`, `editing-shapes`, `zoom-and-scale`,
  `save-and-load`, `terrain`, `globe`, `200000-features`, `datasets`,
  `columnar-data-in-a-worker`, `read-only-viewer`, `plugins`,
  `custom-feature-types` and `custom-ui`. Their basemap menu offers the
  OpenFreeMap styles.
- A sample of Overture Maps data for the examples, in
  `examples/public/data/` (not in the package): the 10,477 buildings and
  the 17,558 places of central Tokyo east of the station, as GeoJSON and
  GeoParquet. `npm run data:overture` (`scripts/fetch-overture-sample.mjs`)
  writes them again. The buildings are under the ODbL and the places
  under the CDLA Permissive 2.0;
  `THIRD_PARTY_NOTICES.md` and `examples/public/data/README.md` record
  the attribution and the licenses of every source. The `datasets`,
  `columnar-data-in-a-worker` and `style-rules-and-legend` examples show
  them.
- `Dataset.getStyleRule()`, the style rule of a dataset: the
  one last given to `setStyleRule`, or the one given to `datasets.add`,
  or `undefined` when there is none. A legend of the datasets reads it.

### Changed in 2.1.0

- The site (<https://sakuzu.github.io/maplibre-gl-draw/>) is
  the documentation site: getting started and the guides in English and
  Japanese, a gallery of the examples, each on a page that runs it
  beside its code, the playground under `/playground/` and the API
  reference under `/api/`, which opens with where each resource of
  `Draw` is. The examples with buttons of their own (`basic`,
  `save-load`, `style-rules`, `snapping-and-geometry`, `read-only`,
  `plugin`, `custom-feature-type`, `large-data` and `table-worker`) are
  replaced by the examples of the gallery, and their addresses, like
  those of the HTML pages of the API reference of 1.0 and 2.0, redirect
  to the pages that took their place. `npm run site:dev` serves the site
  with the examples and the playground for a local check.
- The playground is built on the standard UI, with the tools
  and the inspector sections of a plugin and of a custom feature type,
  and the switches that are not tools on Shift and a letter. It opens on
  an overview of every look one layer can hold; `?plain` opens it empty.
- The dev server of the examples (`npm run dev`) moves from
  port 3000 to 3200, and that of the playground
  (`npm run dev:playground`) from 3001 to 3300. They and
  `npm run test:e2e` need the standard UI built first
  (`npm run ui:build`).
- No sample geometry of the examples, the scenes of the
  playground or the development page of the standard UI lies over the
  Imperial Palace, its East Gardens or Kitanomaru Park. Each page keeps
  its data in a `data.ts` of its own, and a test walks all of it and
  fails when anything reaches into that area.

### Fixed in 2.1.0

- After `map.setStyle` in its default diff mode, the drawing is
  on top of the map again. maplibre leaves custom layers out of the
  style it diffs, so the layers of the new style were added above the
  drawing and hid it. The layers of the instance now move back on top on
  every `style.load`, in their order, with the map layers placed between
  them; a full `setStyle` (`diff: false`) works as before.
- `draw.options.update({ scaleWithZoom })` reaches the drawing
  modes at once. They kept the value given to `createDraw`, so a feature
  drawn after the option was turned off still got a reference zoom
  (`maplibre-gl-draw:createdZoom`), and one drawn after it was turned on
  got none.
- The functions of `/geometry` take a feature of the drawing as it
  is, as documented. A feature whose `type` names a geometry type
  (`Polygon`, `LineString` and so on) was read as a geometry and threw a
  `GeometryError` (`invalid-input`); an object with a `geometry` member
  that is a geometry is now read as a feature first, whatever its own
  `type`.
- On the globe, a freehand stroke drawn across the antimeridian is
  drawn as the stroke alone. The globe gives the pointer longitudes in
  [-180, 180], so where the pointer crossed the line (or slid along the
  edge of the sphere past it) the next point of the stroke was 360
  degrees from the one before, and a line went once round the globe
  along the parallel. The coordinates of a press now run on past 180 as
  they do on the flat map.

## [2.0.0] - 2026-09-30

2.0.0 redesigns the public API around resources and their collections.
Every name of 1.0 changes, and no deprecated alias is kept, so code
written for 1.0 has to be migrated: the
[migration guide](docs/guides/migrating.md) walks through it and the
tables below list every name. The package has four entries: the main
entry `@sakuzu/maplibre-gl-draw` (the instance, the model and the
extension contract, all under semver), `/geometry`, `/table`, and
`/webgl` (the building blocks for custom shaders, which may change in a
minor release). The native file format is 3.0.0, and files of 2.x are
upgraded when they are loaded. The GeoJSON export writes the values of
the library in `properties` under the `maplibre-gl-draw:` prefix.

### Added

- `draw.once` and `draw.transact(fn, { source, ignoreLocks })`; with
  `ignoreLocks` the writes of `fn` change locked features, groups and
  layers (read-only still refuses them).
- `getMany`, `count`, `has`, `createMany`, `updateMany` and
  `deleteMany` on every collection that records, and filters for
  `list` and `count`.
- `features.move`, `features.moveMany`, `groups.move` and
  `groups.moveMany`, which take a `MoveTarget`; `selection.add`,
  `selection.remove` and `selection.move`; `hidden.clear`;
  `features.getAppliedStyle`, which gives the colors of the options and
  of the feature as they were given; `features.isEditable`, which
  answers for read-only and the locks of a feature, its group and its
  layer.
- The events `feature.moved`, `document.loaded`,
  `vertexSelection.changed`, `drag.started`, `drag.ended` and
  `preview.changed`, which carries the shape being drawn and the
  `confirmedVertices` and `highlightVertex` it was shown with.
- `document.loadMany`, which reads several sources and writes all of
  them in one transaction: one `document.changed` for an import of
  several files.
- `LoadOptions.layer` and `LoadOptions.group`, which create a layer for
  the features and a group of them in the transaction of the load, for
  `load` and for each item of `loadMany`, and `LoadResult.layerId` and
  `LoadResult.groupId`, their IDs. An item of `loadMany` may name with
  `layerId` the layer an earlier item creates.
- `DRAW_PROPERTY_PREFIX`, `isDrawProperty`, `DrawProperties` and
  `MODES`.
- `layers.getOrder()`, the stacking order as `layers.reorder` takes it:
  the layers, the `layer-order` datasets and the external entries.
- `FeatureFilter.shown`, which keeps the features whose own `visible`,
  their group's and their layer's are all true; `visible` stays the
  feature's own flag.
- `FeaturePatch`, `LayerInput`, `LayerPatch`, `GroupInput`,
  `GroupPatch`, the filters, `MoveTarget`, `LoadSource`, and the `mode`
  of `LoadOptions` (`replace` or `merge`).
- `FeatureStyle.pointStrokeColor` and `pointStrokeWidth`, the outline of
  a point marker (white and 2 pixels by default). `strokeColor` and
  `strokeWidth` are the lines and the outlines of areas, also in the
  options `style.point` and `previewStyle`.
- `FeatureStyle.pointOpacity`, the option `previewStyle` for the shape
  being drawn, and `selectionStyle.boxSelection` for the selection box.
- `ScreenContext.outline`, the four corners of the selection frame of
  any feature on the screen, turned as the shape is, without the margin
  the frame is drawn with.
- `draw.drawing`, which drives the shape the current drawing mode is
  drawing from code: `addVertex`, `moveTo` and `finish` act as a click,
  a pointer move and Enter would, without snapping and through the
  `input` receivers of the plugins, and `cancel`, `undoVertex`,
  `redoVertex`, `isActive` and `isDrawing` go with them. Their positions
  are exact: the events carry `DrawPointerEvent.programmatic`, and the
  click tolerance of the pointer does not apply to them.
- The contexts of the extensions: `terrain`, `names`, `screen` and
  `invalidate` and `drawing` (the same object as `draw.drawing`) for
  every kind, and
  `hitTest`, `snap`, `commitFeature`, `preview`, `cursor` and
  `listTraceRows` for a mode.
- `FeatureTypeDefinition.outline`, the four corners of the selection
  frame of a type whose shape turns (the engine adds
  `selectionStyle.boundingBox.margin` on every side when it draws the
  frame), and `FeatureTypeDefinition.bbox`,
  the extent on the map the spatial index takes for a type that draws
  beyond its geometry.
- `onDragStart` and `onDragEnd` of `HandleProvider`, and
  `onHandleDragStart` and `onHandleDragEnd` of `FeatureTypeDefinition`,
  around a drag of a handle; `false` from the start refuses the drag.
- `DatasetRow.style`, the look of a row, which the rows read back
  carry.
- `extensions.featureTypes.override`, which puts a definition in the
  place of a built-in type of the same name until the function it
  returns puts the built-in type back, and
  `FeatureTypeDefinition.appliesTo`, which narrows an override to some
  features of the type and leaves the others to the built-in type.
- In `/geometry`: `midpoint`, `along`, `nearestPointOnLine`,
  `perimeter`, `makeValid`, `rewind` and `metersToDegrees`.
- In `/table`: `tableFromFeatures`, `createTableBuilder` and
  `TableBuilder`, which build a table from GeoJSON, and
  `PreparedTable.length` and `PreparedTable.bounds`, the number of rows
  and the extent of a prepared table (`null` when no row has a
  geometry).

### Changed

- `createMapLibreGLDraw(map, options)` is `createDraw(map, options)`,
  and the instance `MapLibreGLDraw` is `Draw`.
- The methods of the instance move under resources: the collections
  `features`, `layers`, `groups`, `datasets` and `hidden`, the single
  resources `selection`, `vertexSelection`, `metadata`, `options` and
  `document`, and the collections of `extensions`. A collection that
  records has the eleven standard methods `get`, `getMany`, `list`,
  `count`, `has`, `create`, `createMany`, `update`, `updateMany`,
  `delete` and `deleteMany`; a collection of things added and removed
  has `get`, `list`, `count`, `has`, `add`, `addMany`, `remove` and
  `removeMany`. What the standard methods cannot express is a verb on
  the collection (`features.move`, `layers.reorder`, `features.union`).
- `create` and `update` return the resource they wrote, not an ID or a
  boolean. `update(id, patch)` changes only the keys given, and merges
  `properties` and `style` key by key; `undefined` removes a key.
- A method that takes several items (`createMany`, `deleteMany` and
  the rest) runs in one transaction: all of them change, or none.
- A wrong argument (an unknown ID, an input of the wrong shape) throws
  `DrawError`, which carries a `code`. A write refused because of the
  state (read-only, a lock) returns `null` or `false`. Nothing is
  ignored without a sign, and nothing changes when either happens.
- Events are named `resource.pastParticiple` (`feature.created`,
  `layer.reordered`) in one list, `DrawEvents`, which apps and plugins
  share. The events of the document carry their `source`, and
  `document.changed` arrives once per transaction that changed the
  document, with every change to features, layers, groups, metadata and
  files.
- A feature holds a GeoJSON `geometry` in place of `coordinates`. Its
  `properties` are the GeoJSON properties: the values of the library
  are under keys with the `maplibre-gl-draw:` prefix, and every other
  key is an attribute of the user. `style` is always present. The size,
  rotation and opacity of an image move from its style to `properties`
  and `imageOpacity`.
- `Layer.order` is `Layer.items`, read-only and changed with
  `features.move` and `groups.move`. A group has the `layerId` of its
  layer.
- The options `snap`, `trace` and `renderingStyle` are `snapping`,
  `tracing` and `rendering`, `pixelRatio` moves into `rendering`, and
  every color is a CSS color string. Every option but `defaultMode`,
  `store` and `initDefaultLayer` can change at run time with
  `draw.options.update`.
- Every kind of extension is registered the same way, with
  `draw.extensions.<kind>.add`, and removed with the function it
  returns or with `remove(name)`. Each kind receives one context with
  only what it needs. A plugin has `onAdd` and `onRemove`, takes its
  input through `input` and its hooks into selection through
  `interaction`, and adds its modes, types, overlays and providers
  through `ctx.extensions`, which removes them with the plugin.
- Modes and plugins receive `DrawPointerEvent` and `DrawKeyEvent`, and
  a receiver consumes an event by returning true. A mode factory
  receives its `ModeContext`.
- A renderer receives one `RenderContext`, with the offset already
  computed, and `onAdd` and `onRemove` take `(map, gl)`.
- The building blocks for custom shaders (layer 2) move from the main
  entry to `@sakuzu/maplibre-gl-draw/webgl`.
- The building blocks of `/webgl` that draw on the terrain take the
  `RenderContext` of the draw call, or its `terrain`, in place of the
  terrain state of the instance: `ProjectionUniformManager.setTerrain`,
  `QuadShader.setTerrain`, `drawQuadSurfaceOnTerrain` and
  `terrainTessellationStep`. The constructors of
  `ProjectionUniformManager` and `QuadShader` no longer take a terrain.
- `@sakuzu/maplibre-gl-draw/geometry` takes and returns GeoJSON, uses
  the names of Turf, measures in meters, and merges the two-argument
  and array forms of a function into one. It goes from 60 exports to
  31. `EARTH_RADIUS_METERS` is 6371008.8, the mean radius of the Earth,
  so measured lengths and areas change slightly.
- `@sakuzu/maplibre-gl-draw/columnar` is `@sakuzu/maplibre-gl-draw/table`,
  and its types are named after the table, not the dataset.
- A dataset takes its rows as GeoJSON features in `rows`, or a table in
  `table`, or starts empty with neither and is filled later with
  `setRows` or `setTable`; `layers.reorder` places a `layer-order`
  dataset as soon as it is added. Its members use the word row, and it
  has its own events, `clicked`, `hovered` and `changed`.
- An extent is the four-number `BBox` of `/geometry`,
  `[west, south, east, north]`, everywhere the main entry takes or
  gives one: `FeatureFilter.bbox`, the argument of `DatasetProvider`,
  the `Dataset` methods, `ModeContext.listTraceRows` and
  `FeatureTypeDefinition.bbox`. GeoJSON's `BBox`, which may carry
  heights in six numbers, is not used.
- The native format is 3.0.0. A file of 2.x is upgraded on load.
- Every load, of any format, is one transaction with the source `load`
  once the source is read: a document of the library is no longer
  loaded with `silent`, nor an image with `local`.
- The GeoJSON export writes the `properties` of a feature as they are
  stored, with their prefix.
- The margin of the selection frame (`selectionStyle.boundingBox.margin`)
  stands outside every edge of the outline of the selection, for every
  type, points included, so a long and thin selection keeps it on its
  long sides too; 1.0 pushed the corners out along the diagonals. The
  resize and rotate handles sit on the corners of that frame.
- A built-in point is hit anywhere on its marker (the radius of
  `pointRadius` and its outline) with the click tolerance around it;
  1.0 hit it only within the tolerance of its position, so a click on
  the rim of the marker went to what was behind it, a companion drawn
  from the point among others. A feature therefore always wins over its
  own companion at the same point.
- A double click never zooms the map while a drawing mode (a mode with
  `writes: true`) is the current mode, whether or not the mode takes
  it; the freehand mode takes it, and a press it releases without a
  drag leaves the pan of the map on.

### Removed

- Every name of 1.0 that changed, with no deprecated alias. The export
  `generateCirclePolygon` of the main entry, deprecated in 1.0, is
  removed; use `circle` from `@sakuzu/maplibre-gl-draw/geometry`.
- `draw.input`, the synthetic input. `draw.drawing` drives a drawing
  mode from code.
- The namespaces `draw.geometry`, `draw.snapping`, `draw.tracing` and
  `draw.topology`: their operations are methods of `features`, options
  of `draw.options` and `extensions.snapProviders`.
- `export(format)`, its options and `getSuggestedFileName`. Use
  `document.toJSON()` and `document.toGeoJSON()`.
- The event `draw.geometry.applied`: the operations return their
  result.
- `Plugin.hooks` and `PluginContext.emit`. Plugins subscribe to
  `DrawEvents` and talk to each other through their `api`.
- From the main entry: the pure math (oriented boxes, conversions
  between pixels, degrees and Mercator, contrast colors), the services
  of the 1.0 contexts (registries, hit test services, the plugin
  manager, the event emitter), `MemoryStore`, the lock predicates, the
  factory of the guide snap provider and the trace graph functions.
- From the Store contract: the state of the input (the shape being
  drawn, the box selection, the drag, the followed vertices).

### Migration table

Every name the tables leave out keeps its name in 2.0; its shape may
still change, as the tables of the model and the extensions say.

#### Instance methods

The 81 members of `MapLibreGLDraw`, by the resource they move to. The
operations of the namespaces follow their namespace. `draw.` is left
out on both sides.

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `getMap` | `getMap` | |
| `getStore` | `getStore` | Returns a `StoreView` |
| `getMode` | `getMode` | |
| `setMode` | `setMode` | An unknown mode throws |
| `isReadOnly` | `isReadOnly` | |
| `setReadOnly` | `setReadOnly` | |
| `isInteractionLocked` | `isInteractionLocked` | |
| `setInteractionLock` | `setInteractionLocked` | |
| `getRenderSlots` | `getLayerStack` | |
| `getTerrainDiagnostics` | `debug.terrain()` | |
| `hasPendingWork` | `hasPendingWork` | |
| `on` | `on` | The names of `DrawEvents` |
| `off` | `off` | |
| `destroy` | `destroy` | |
| `addFeature` | `features.create` | Returns the `Feature` |
| `getFeature` | `features.get` | |
| `getAllFeatures` | `features.list()` | |
| `getVisibleFeatures` | `features.list({ shown: true })` | |
| `updateFeature` | `features.update` | A patch; returns the `Feature` |
| `deleteFeature` | `features.delete` | |
| `deleteAllFeatures` | `features.deleteMany(ids)` | Pass every ID |
| `addFeatureToGroup` | `features.move(id, { groupId, index })` | |
| `removeFeatureFromGroup` | `features.move(id, { groupId: null })` | |
| `reorderInGroup` | `features.move(id, { groupId, index })` | |
| `reorderInLayer` | `features.move`, `groups.move` | `{ layerId, index }` |
| `moveToLayer` | `features.move`, `groups.move` | `{ layerId }` |
| `geometry` | `features` | |
| `geometry.union` | `features.union(ids)` | Returns the `Feature` |
| `geometry.subtract` | `features.difference(id, ids)` | |
| `geometry.intersect` | `features.intersection(ids)` | |
| `geometry.split` | `features.split(id, lineId)` | Returns the features |
| `geometry.buffer` | `features.buffer(ids, options)` | `distanceMeters` |
| `getAllLayers` | `layers.list()` | |
| `getLayer` | `layers.get` | |
| `addLayer(name?)` | `layers.create({ name })` | Returns the `Layer` |
| `updateLayer` | `layers.update` | |
| `deleteLayer` | `layers.delete` | |
| `getLayerOrder` | `layers.list()` | Their `id`, from the back |
| `setLayerOrder` | `layers.reorder` | |
| `getActiveLayer` | `layers.getActive()` | Returns the `Layer` |
| `setActiveLayer` | `layers.setActive` | Returns a boolean |
| `getAllGroups` | `groups.list()` | |
| `getGroup` | `groups.get` | |
| `addGroup(ids, layerId, name?)` | `groups.create({ featureIds, name })` | |
| `updateGroup` | `groups.update` | |
| `deleteGroup` | `groups.delete` | The members stay |
| `ungroupGroup` | `groups.delete` | |
| `addDataset` | `datasets.add` | |
| `getDataset` | `datasets.get` | |
| `getDatasets` | `datasets.list()` | |
| `moveDataset` | `datasets.move` | |
| `removeDataset` | `datasets.remove` | An unknown ID throws |
| `isLocallyHidden` | `hidden.has` | |
| `getLocallyHidden` | `hidden.list()` | An array |
| `setLocallyHidden(id, true)` | `hidden.add(id)` | |
| `setLocallyHidden(id, false)` | `hidden.remove(id)` | |
| `getSelection` | `selection.get()` | |
| `getSelectedIds` | `selection.get().ids` | |
| `select(ids, type?)` | `selection.set(type, ids)` | The type comes first |
| `deselect` | `selection.clear()` | |
| `getSelectedFeatures` | `selection.features()` | |
| `deleteSelection` | `selection.delete()` | |
| `groupSelection` | `selection.group()` | Returns the `Group` |
| `ungroupSelection` | `selection.ungroup()` | Returns a boolean |
| `getSelectedVertices` | `vertexSelection.get()` | |
| `selectVertices` | `vertexSelection.set` | |
| `deselectVertices` | `vertexSelection.clear()` | |
| `deleteVertices` | `vertexSelection.delete()` | The selected ones |
| `getMetadata` | `metadata.get()` | |
| `setMetadata` | `metadata.update` | Returns the `Metadata` |
| `load` | `document.load`, `loadMany` | `null` when read-only |
| `export('native')` | `document.toJSON()` | An object, not a string |
| `export('geojson')` | `document.toGeoJSON()` | An object, not a string |
| `getSuggestedFileName` | (removed) | The app names its files |
| `getRenderScale` | `options.get()` | `rendering.renderScale` |
| `setRenderScale` | `options.update` | `rendering.renderScale` |
| `getPixelRatio` | `options.get()` | `rendering.pixelRatio` |
| `snapping` | `options`, `extensions.snapProviders` | |
| `snapping.register` | `extensions.snapProviders.add` | |
| `snapping.setEnabled` | `options.update` | `snapping.enabled` |
| `snapping.isEnabled` | `options.get()` | `snapping.enabled` |
| `snapping.setKindEnabled` | `options.update` | `snapping.kinds` |
| `snapping.isKindEnabled` | `options.get()` | `snapping.kinds` |
| `snapping.setDatasetsEnabled` | `options.update` | `snapping.datasets` |
| `snapping.isDatasetsEnabled` | `options.get()` | `snapping.datasets` |
| `snapping.setGuideStep` | `options.update` | `snapping.guideStepDegrees` |
| `snapping.getOptions` | `options.get().snapping` | |
| `snapping.getResult` | The event `snap.changed` | Its `result` |
| `snapping.resolve` | `ModeContext.snap(point)` | In a mode |
| `tracing` | `options` | |
| `tracing.setEnabled` | `options.update` | `tracing.enabled` |
| `tracing.isEnabled` | `options.get()` | `tracing.enabled` |
| `topology` | `options` | |
| `topology.setSharedVertexDrag` | `options.update` | See `TopologyOptions` |
| `topology.isSharedVertexDrag` | `options.get()` | See `TopologyOptions` |
| `input` | `drawing` | Drives a drawing mode |
| `input.click` | `drawing.addVertex` | No snapping |
| `input.move` | `drawing.moveTo` | No snapping |
| `input.key` | (removed) | `drawing.finish`, `drawing.cancel` |
| `input.setPointerHold` | (removed) | |
| `input.isPointerHeld` | (removed) | |
| `addPlugin` | `extensions.plugins.add` | |
| `getPluginApi` | `extensions.plugins.getApi` | |
| `registerMode` | `extensions.modes.add` | |
| `registerFeatureHandler` | `extensions.featureTypes.add` | |
| `addOverlayRenderer` | `extensions.overlays.add` | |
| `registerAuxiliaryHandleProvider` | `extensions.handleProviders.add` | |
| `registerFeatureCompanionProvider` | `extensions.companionProviders.add` | |

The operations of `geometry` used the selection when no ID was given;
the methods of `features` take the IDs (`selection.get().ids`). The
`vertexSelection.get()` of 2.0 has `vertices` in place of
`vertexIndices`. `deleteVertices` deletes the selected vertices, so
select them with `vertexSelection.set` first.

#### Events

A plugin of 1.0 subscribed to the same names without `draw.`
(`feature.create`); in 2.0 apps and plugins use the same names.

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `draw.feature.create` | `feature.created` | |
| `draw.feature.update` | `feature.updated` | With `intermediate` |
| `draw.feature.delete` | `feature.deleted` | |
| `draw.features.change` | `document.changed` | Only a change of the document |
| `draw.layer.create` | `layer.created` | |
| `draw.layer.update` | `layer.updated` | |
| `draw.layer.delete` | `layer.deleted` | |
| `draw.layer.reorder` | `layer.reordered` | |
| `draw.group.create` | `group.created` | |
| `draw.group.update` | `group.updated` | |
| `draw.group.delete` | `group.deleted` | |
| `draw.metadata.change` | `metadata.updated` | |
| `draw.selection.change` | `selection.changed` | `{ selection, previous }` |
| `draw.mode.change` | `mode.changed` | `previousMode` is `previous` |
| `draw.image.request` | `image.requested` | `{ lngLat, zoom, layerId }` |
| `draw.geometry.applied` | (removed) | The methods return the result |
| `draw.snap.change` | `snap.changed` | `{ result }` |
| `draw.dataset.click` | `dataset.clicked` | `row` and `rowIndex` |
| `draw.dataset.add` | `dataset.added` | `{ dataset }` |
| `draw.dataset.remove` | `dataset.removed` | |
| `draw.dataset.reorder` | `dataset.reordered` | With `previous` |
| `draw.map.click` | `map.clicked` | `{ lngLat, point, hit }` |
| `draw.renderslots.change` | `layerStack.changed` | `{ entries }` |
| `draw.load.error` | `error` | `{ error, source, featureId? }` |
| (none) | `feature.moved` | Between layers and groups |
| (none) | `document.loaded` | `{ result, source }` |
| (none) | `vertexSelection.changed` | |
| (none) | `hidden.changed` | `{ ids }`, the whole set |
| (none) | `readOnly.changed` | `{ readOnly }` |
| (none) | `interactionLock.changed` | `{ locked }` |
| The hook `drag:start` | `drag.started` | |
| The hook `drag:end` | `drag.ended` | With `cancelled` |

Every event of the document (`feature.*`, `layer.*`, `group.*`,
`metadata.updated`, `document.loaded`) carries `source`. In
`document.changed` the `source` is optional, and an update in progress
is marked by the `isIntermediate` of that update.

#### Options

`Options` is `DrawOptions`, and the options that can change while the
instance runs are `RuntimeOptions`, changed with `draw.options.update`.

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `defaultMode` | `defaultMode` | |
| `clickTolerance` | `clickTolerance` | |
| `dragThreshold` | `dragThreshold` | |
| `style` | `style` | A `FeatureStyle` per type |
| `style.point` | `style.point` | |
| `style.lineString` | `style.line` | |
| `style.polygon` | `style.polygon` | |
| (none) | `style.circle`, `style.image` | |
| `style.tentative` | `previewStyle` | A `Partial<FeatureStyle>` |
| `selectionStyle` | `selectionStyle` | CSS colors |
| `renderingStyle` | `rendering` | |
| `renderingStyle.storeRetained` | `rendering.cacheGeometry` | |
| `renderingStyle.timeSlicing` | `rendering.timeSlicing` | |
| `renderingStyle.boxSelectionStyle` | `selectionStyle.boxSelection` | |
| `pixelRatio` | `rendering.pixelRatio` | A number |
| (none) | `rendering.renderScale` | |
| `autoName` | `autoName` | `AutoNameOptions` or `false` |
| `autoName.enabled` | (removed) | `autoName: false` |
| `scaleWithZoom` | `scaleWithZoom` | |
| `snap` | `snapping` | The same fields |
| `trace` | `tracing` | |
| `topology` | `topology` | |
| `store` | `store` | A `Store` |
| `initDefaultLayer` | `initDefaultLayer` | |
| `isExternalEntry` | `isExternalEntry` | Takes an ID of the stack |
| `messages` | `messages` | |

#### Model

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `Feature.coordinates` | `Feature.geometry` | A GeoJSON geometry |
| `Feature.properties` | `Feature.properties` | Library keys are prefixed |
| `Feature.style?` | `Feature.style` | Always present, `{}` at least |
| `FeatureInput.coordinates` | `FeatureInput.geometry` | |
| (none) | `FeatureInput.groupId` | |
| `Partial<Feature>` | `FeaturePatch` | Without `id`, `type`, `layerId` |
| `Partial<Layer>` | `LayerPatch` | For `layers.update` |
| `Partial<Group>` | `GroupPatch` | For `groups.update` |
| `properties.createdZoom` | `maplibre-gl-draw:createdZoom` | |
| `properties.rotation` | `maplibre-gl-draw:rotation` | |
| `properties.scale` | `maplibre-gl-draw:scale` | |
| `properties.radiusMeters` | `maplibre-gl-draw:radiusMeters` | |
| `properties.radiusHandleAngle` | `maplibre-gl-draw:radiusHandleAngle` | |
| `properties.imageFileId` | `maplibre-gl-draw:imageFileId` | |
| `properties.imageWidth` | `maplibre-gl-draw:imageWidth` | |
| `properties.imageHeight` | `maplibre-gl-draw:imageHeight` | |
| `ImageStyle` | `FeatureStyle` | |
| `ImageStyle.width` | `maplibre-gl-draw:imageWidth` | |
| `ImageStyle.height` | `maplibre-gl-draw:imageHeight` | |
| `ImageStyle.rotation` | `maplibre-gl-draw:rotation` | Added to it |
| `ImageStyle.opacity` | `FeatureStyle.imageOpacity` | |
| (none) | `FeatureStyle.pointOpacity` | |
| `Layer.order` | `Layer.items` | Changed with `move` |
| (none) | `Group.layerId` | |
| `VertexSelection.vertexIndices` | `VertexSelection.vertices` | |
| `Coordinate`, `LngLat` | `Position` | GeoJSON `[lng, lat]` |
| `Data` | `DrawDocument` | |
| `Data.version` `2.0.0` | `3.0.0` | Upgraded on load |
| `LoadOptions.coordinate` | `LoadOptions.coordinate` | A `Position` |
| (none) | `LoadOptions.mode` | `replace` or `merge` |
| Plain `Error` | `DrawError` | `code` |

#### Extensions

The `Plugin`:

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `onInstall(ctx)` | `onAdd(ctx)` | Required |
| `onUninstall` | `onRemove` | |
| `hooks` | `ctx.on` | See the hooks below |
| `modes` | `ctx.extensions.modes.add` | |
| `api` | `api` | `Plugin<Api>` |
| `onKeyDown` | `input.onKeyDown` | `DrawKeyEvent` |
| `onMouseMove` | `input.onPointerMove` | `DrawPointerEvent` |
| `onDragMove` | `input.onDrag` | |
| `onMouseLeave` | `input.onPointerLeave` | |
| `filterSelection` | `interaction.filterSelection` | |
| `onFeatureClick(id)` | `interaction.onFeatureClick` | Takes the `Feature` |
| `onFeatureDoubleClick(id)` | `interaction.onFeatureDoubleClick` | |
| `onFeatureCreated` | `interaction.onDrawCommit` | Takes the `Feature` |
| `isInteracting` | `interaction.isBusy` | |
| `finishInteraction` | `interaction.finish` | |
| `cancelInteraction` | `interaction.cancel` | |
| `getInteractionContainer` | `interaction.container` | |

The hooks of `Plugin.hooks`:

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `feature:afterCreate` | `feature.created` | Or `document.changed` |
| `feature:afterUpdate` | `feature.updated` | |
| `feature:afterDelete` | `feature.deleted` | |
| `group:afterCreate` | `group.created` | |
| `group:afterUpdate` | `group.updated` | |
| `group:afterDelete` | `group.deleted` | |
| `layer:afterCreate` | `layer.created` | |
| `layer:afterUpdate` | `layer.updated` | |
| `layer:afterDelete` | `layer.deleted` | |
| `selection:afterChange` | `selection.changed` | |
| `drag:start` | `drag.started` | |
| `drag:end` | `drag.ended` | |
| `MutationContext.source` | `source` of the payload | |
| `MutationContext.batchId` | `document.changed` | Once per transaction |

The `PluginContext`. Its writes took a `source`; in 2.0 wrap them in
`ctx.draw.transact(fn, { source })`.

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `draw` | `draw` | A `Draw` |
| `getStore()` | `store` | A `StoreView`; write with `draw` |
| `autoNameGenerator` | `names` | `next(type)` |
| `getFeature`, `getAllFeatures` | `draw.features.get`, `list` | |
| `getGroup`, `getAllGroups` | `draw.groups.get`, `list` | |
| `getLayer`, `getAllLayers` | `draw.layers.get`, `list` | |
| `getLayerOrder`, `getLayerIds` | `draw.layers.list()` | Their `id` |
| `getSelection`, `getSelectedIds` | `draw.selection.get()` | |
| `getMode`, `setMode` | `draw.getMode`, `draw.setMode` | |
| `addFeatures(features, source)` | `draw.features.createMany` | |
| `updateFeature` | `draw.features.update` | |
| `deleteFeatures` | `draw.features.deleteMany` | |
| `createGroup` | `draw.groups.create` | |
| `updateGroup`, `deleteGroup` | `draw.groups.update`, `delete` | |
| `createLayer` | `draw.layers.create` | |
| `updateLayer`, `deleteLayer` | `draw.layers.update`, `delete` | |
| `addFeatureToGroup` | `draw.features.move` | `{ groupId, index }` |
| `removeFeatureFromGroup` | `draw.features.move` | `{ groupId: null }` |
| `addToLayer`, `removeFromLayer` | `draw.features.move` | `{ layerId }` |
| `moveItemToLayer` | `features.move`, `groups.move` | |
| `setLayerItemOrder` | `features.move`, `groups.move` | `index` |
| `findGroupForFeature` | `Feature.groupId` | |
| `findLayerForFeature` | `Feature.layerId` | |
| `setSelection` | `draw.selection.set` | |
| `emit` | (removed) | Plugins talk through `api` |
| `on`, `off` | `on`, `off`, `once` | Ended with the plugin |
| `batch(fn)` | `draw.transact(fn, options)` | |
| `notifyStateReset` | (removed) | The Store reports it |
| `undoVertex`, `redoVertex` | `drawing.undoVertex`, `redoVertex` | |
| (none) | `drawing.isDrawing`, `drawing.cancel` | |
| (none) | `drawing.addVertex`, `moveTo`, `finish`, `isActive` | |
| `invalidateFeatures(type)` | `invalidate({ type })` | |
| `projectAnchor(lng, lat)` | `terrain.project([lng, lat])` | |
| `anchorElevationMeters` | `terrain.elevation` | |
| `getAnchorElevationGeneration` | `terrain.generation` | |
| `computeBoundingBox` | `screen.bounds` | `{ min, max }` or `null` |

The `ModeHandler` and the `ModeContext`:

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `ModeFactory` `() => handler` | `(ctx: ModeContext) => handler` | |
| `modeName` | (removed) | The name given to `add` |
| `onStart(context)` | `onEnter()` | The factory has the context |
| `onStop` | `onExit` | |
| `onMouseDown`, `onMouseUp` | `onPointerDown`, `onPointerUp` | |
| `onMouseMove` | `onPointerMove` | |
| `onClick`, `onDoubleClick` | `onClick`, `onDoubleClick` | |
| `onDragMove` | `onDrag` | |
| `onDragStart`, `onDragEnd` | `onDragStart`, `onDragEnd` | |
| `onDragCancel` | `onDragCancel` | |
| `onKeyDown`, `onKeyUp` | `onKeyDown`, `onKeyUp` | `DrawKeyEvent` |
| `onExternalStateChange` | `ctx.on('document.changed')` | |
| `onSelectionChange` | `ctx.on('selection.changed')` | |
| (none) | `onCancel` | Escape |
| `writesFeatures` | `writes` | |
| `undoVertex`, `redoVertex` | `onUndoVertex`, `onRedoVertex` | |
| `getSnapPreference` | `snapPreference` | A `SnapPreference` |
| `isSnapEnabledFor` | `snapPreference` | |
| `ctx.map` | `ctx.draw.getMap()` | |
| `ctx.store` | `ctx.store`, `ctx.draw` | Read and write |
| `ctx.spatialIndex` | `ctx.hitTest` | |
| `ctx.hitTestService` | `ctx.hitTest` | |
| `ctx.hitTestTopmost` | `ctx.hitTest` | |
| `ctx.getDatasetFeature` | `ctx.hitTest` | Rows of datasets are hits |
| `ctx.getDatasetTraceFeatures` | `ctx.listTraceRows(bbox)` | |
| `ctx.featureCompanions` | (removed) | Companions are hits |
| `ctx.boxSelectionRegistry` | (removed) | |
| `ctx.selectionScope` | (removed) | |
| `ctx.eventEmitter` | `ctx.on`, `off`, `once` | |
| `ctx.selectionStyle` | `ctx.selectionStyle` | |
| `ctx.topology`, `trace` | `ctx.draw.options.get()` | |
| `ctx.snapOptions` | `ctx.draw.options.get()` | `snapping` |
| `ctx.autoNameGenerator` | `ctx.names` | |
| `ctx.pluginManager` | `extensions.plugins.getApi` | |
| `ctx.setMode` | `ctx.setMode` | Returns a boolean |
| `ctx.generateFeatureId` | `ctx.commitFeature(input)` | |
| `ctx.getCurrentLayerId` | `ctx.commitFeature(input)` | |
| `ctx.scaleWithZoom` | `ctx.commitFeature(input)` | |
| `ctx.getSnapResult` | `ctx.snap(point)` | |
| `store.setTentative` | `ctx.preview.set`, `clear` | |
| (none) | `ctx.cursor.set`, `reset` | |

`commitFeature` gives the feature its ID, its layer, its automatic name
and its reference zoom by the rules of the built-in modes. The receivers
of a mode and of `Plugin.input` consume the event by returning true.

The renderers and their `RenderContext`:

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `CustomRendererDrawContext` | `RenderContext` | |
| `shaderData` | `shader` | |
| `mainMatrixArray` | `projection` | MapLibre's `ProjectionData` |
| `centerLngLat` | `offset` | Computed `OffsetUniforms` |
| `pixelRatio` | `pixelRatio` | |
| `terrain` | `terrain` | `TerrainAnchors` |
| `opacity` | `opacity` | |
| `sdfLineRenderer` | `line` | `LineRenderer` |
| `fillShaderManager` | `fill` | `FillRenderer` |
| `pointShapeRenderer` | `point` | `PointRenderer` |
| (none) | `gl`, `zoom` | |
| `onAdd(gl, map)` | `onAdd(map, gl)` | The arguments swap |
| `onRemove()` | `onRemove(map, gl)` | |
| Feature `draw(...)` | `draw(feature, ctx)` | |
| Overlay `draw(data, zoom, ctx)` | `draw(ctx)` | |
| `LayerAwareOverlayRenderer` | `OverlayRenderer` | `drawForLayer` |
| Overlay `order` | `order` | A number |
| Overlay `drawVertices` | `drawVertices(ctx)` | |

The custom feature type, `CustomFeatureHandler` in 1.0 and
`FeatureTypeDefinition` in 2.0:

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `type` | `type` | |
| (none) | `geometry` | The kind of GeoJSON geometry |
| `renderer` | `renderer` | A `FeatureRenderer` |
| `hitTest` (a strategy) | `hitTest(feature, ctx)` | |
| `boxSelection` | `boxSelect(feature, box, ctx)` | |
| `getBoundingBox` | `bbox(feature)` | `[west, south, east, north]` |
| `getSelectionBoundingBox` | `bounds` or `outline(feature, ctx)` | |
| `getPointFrameExtent` | `bounds(feature, ctx)` | |
| `getAdditionalResizeHandles` | `handles(feature, ctx)` | |
| `computeCustomResize` | `onHandleDrag` | Returns a `FeaturePatch` |
| `getSnapTargets` | `snapCandidates(feature, ctx)` | |
| `resizeStrategy` | (removed) | `handles` and `onHandleDrag` |
| `candidateReachPx` | `hitPaddingPx` | |

The providers:

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `AuxiliaryHandleProvider` | `HandleProvider` | |
| `id` | `name` | |
| `getHandles` | `handles(feature, ctx)` | |
| `onHandleDragStart` | `onDragStart` | `false` refuses the drag |
| `onHandleDragMove` | `onDrag` | Returns a `FeaturePatch` |
| `onHandleDragEnd` | `onDragEnd` | After the last `onDrag` |
| `getGlobalHandles` | `globalHandles(ctx)` | |
| `FeatureCompanionProvider` | `CompanionProvider` | |
| `id` | `name` | |
| `draw` | `draw(feature, ctx)` | |
| `hitTest(feature, point, ctx)` | `hitTest(feature, ctx)` | |
| `has` | `has(feature)` | |
| `onCompanionClick` | `onClick(feature, hit, event)` | |
| `SnapProvider.candidates` | `candidates(ctx)` | No `bbox` argument |

The registration:

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `addPlugin` | `extensions.plugins.add` | |
| `registerMode` | `extensions.modes.add` | |
| `registerFeatureHandler` | `extensions.featureTypes.add` | |
| `addOverlayRenderer` | `extensions.overlays.add` | |
| `snapping.register` | `extensions.snapProviders.add` | |
| `registerAuxiliaryHandleProvider` | `extensions.handleProviders.add` | |
| `registerFeatureCompanionProvider` | `extensions.companionProviders.add` | |
| `Plugin.modes` | `ctx.extensions.modes.add` | |

The Store contract:

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `DocumentStore`, `UiState` | `Store` | |
| `getAllFeatures` | `listFeatures` | |
| `getOrderedFeatures` | `listFeaturesInOrder` | |
| `getAllLayers` | `listLayers` | |
| `getAllGroups` | `listGroups` | |
| `getAllFiles` | `listFiles` | |
| `getSelectedVertices` | `getVertexSelection` | |
| `isLocallyHidden` | `isHidden` | |
| `getLocallyHidden` | `listHidden` | |
| `subscribe` | `subscribe` | Receives `DocumentChange` |
| `StateChanges` | `DocumentChange` | |
| `getTentative`, `setTentative` | (removed) | |
| `getBoxSelection`, `setBoxSelection` | (removed) | |
| `getDragState`, `setDragState` | (removed) | |
| `getFollowedVertices` | (removed) | |
| `setFollowedVertices` | (removed) | |

#### Main entry

Every export of the main entry of 1.0 that does not keep its name, and
the two types of layer 2 that stay in the main entry. The
building blocks for custom shaders are in
`@sakuzu/maplibre-gl-draw/webgl`, with no promise across minor
releases.

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `createMapLibreGLDraw` | `createDraw` | |
| `MapLibreGLDraw` | `Draw` | |
| `Options` | `DrawOptions` | |
| `EventPayloads` | `DrawEvents` | |
| `EventMap` | `DrawEvents` | The same names as the app |
| `EventListener` | `DrawEventListener` | |
| `FeaturesChangePayload` | `DocumentChange` | |
| `StateChanges` | `DocumentChange` | |
| `Data` | `DrawDocument` | |
| `Coordinate` | `Position` | From GeoJSON |
| `LngLat` | `Position` | |
| `FeatureCoordinates` | `Geometry` of GeoJSON | `Feature.geometry` |
| `RenderSlot` | `LayerStackEntry` | |
| `SnapOptions` | `SnappingOptions` | |
| `TraceOptions` | `TracingOptions` | |
| `TraceConfig` | `TracingOptions` | |
| `TopologyConfig` | `TopologyOptions` | |
| `RenderingConfig` | `RenderingOptions` | |
| `SelectionUIConfig` | `SelectionStyleOptions` | |
| `AutoNameConfig` | `AutoNameOptions` | No `enabled` |
| `FeatureStyleConfig` | `DrawOptions.style` | |
| `PointFeatureStyle` | `FeatureStyle` | |
| `LineStringFeatureStyle` | `FeatureStyle` | |
| `PolygonFeatureStyle` | `FeatureStyle` | |
| `ImageStyle` | `FeatureStyle` | Folded (model table) |
| `ImageProperties` | `DrawProperties` | |
| `Color` | `string` | A CSS color |
| `BoundingBoxStyle` | `SelectionStyleOptions` | `boundingBox` |
| `ResizeHandleStyle` | `SelectionStyleOptions` | `resizeHandle` |
| `RotateHandleStyle` | `SelectionStyleOptions` | `rotateHandle` |
| `VertexHandleStyle` | `SelectionStyleOptions` | `vertexHandle` |
| `MidpointHandleStyle` | `SelectionStyleOptions` | `midpointHandle` |
| `RadiusHandleStyle` | `SelectionStyleOptions` | `radiusHandle` |
| `CenterMarkerStyle` | `SelectionStyleOptions` | `centerMarker` |
| `RadiusLineStyle` | `SelectionStyleOptions` | `radiusLine` |
| `PointStyle`, `StrokeStyle` | `SelectionStyleOptions` | Its fields |
| `SnapDisableKey` | `SnappingOptions` | `disableKey` |
| `SnapTargetKind` | `SnappingOptions` | The keys of `kinds` |
| `ResolvedSnapOptions` | `options.get().snapping` | |
| `AutoNameType` | `AutoNameOptions` | The keys of `typeNames` |
| `PixelRatioInput`, `PixelRatioProvider` | `RenderingOptions` | `pixelRatio` |
| `DocumentStore`, `UiState` | `Store` | |
| `AutoNameGenerator` | `NameGenerator` | `ctx.names` |
| `CustomFeatureHandler` | `FeatureTypeDefinition` | |
| `CustomFeatureRenderer` | `FeatureRenderer` | |
| `CustomOverlayRenderer` | `OverlayRenderer` | |
| `LayerAwareOverlayRenderer` | `OverlayRenderer` | `drawForLayer` |
| `CustomRendererDrawContext` | `RenderContext` | |
| `AuxiliaryHandleProvider` | `HandleProvider` | |
| `AuxiliaryHandle`, `HandleInfo` | `Handle` | |
| `AdditionalHandleInfo` | `Handle` | |
| `HandleType` | `Handle` | `kind` |
| `AuxiliaryHandleContext` | `ScreenContext` | |
| `AuxiliaryHandleHit`, `CompanionHit` | `Hit` | |
| `HitTestResult`, `FeatureCompanionHitResult` | `Hit` | |
| `CompanionHitContext` | `HitTestContext` | |
| `FeatureCompanionProvider` | `CompanionProvider` | |
| `SnapProviderContext` | `SnapContext` | |
| `SnapPointCandidate`, `SnapSegmentCandidate` | `SnapCandidate` | |
| `SnapTarget`, `SnapTargetSegment` | `SnapResult` | `target` |
| `SnapLngLat` | `Position` | |
| `NormalizedEvent`, `MouseNormalizedEvent` | `DrawPointerEvent` | |
| `DragNormalizedEvent`, `HoverEvent` | `DrawPointerEvent` | |
| `PointerType` | `DrawPointerEvent` | `pointerType` |
| `PointerOriginalEvent` | `DrawPointerEvent` | `original` |
| `KeyNormalizedEvent` | `DrawKeyEvent` | |
| `ModifierKeys` | `Modifiers` | |
| `MouseLeaveEvent` | `InputHandlers` | `onPointerLeave` |
| `DatasetFeatureInput` | `DatasetRow` | |
| `DatasetFeatureProvider` | `DatasetProvider` | |
| `DatasetEventMap` | `DatasetEvents` | |
| `DatasetClickPayload` | `DatasetEvents` | `clicked` |
| `DatasetHoverPayload` | `DatasetEvents` | `hovered` |
| `DatasetChangePayload` | `DatasetEvents` | `changed` |
| `DatasetClickEventPayload` | `DrawEvents` | `dataset.clicked` |
| `MapClickEventPayload` | `DrawEvents` | `map.clicked` |
| `LoadErrorPayload` | `DrawEvents` | `error` |
| `DragStartData`, `DragEndData` | `DrawEvents` | `drag.started`, `drag.ended` |
| `Hooks`, `MutationContext` | `DrawEvents` | The payload has `source` |
| `ResolvedCollisionThinning` | `DatasetCollisionThinning` | `Required<>` |
| `DatasetColumn` | `Column` | `/table` |
| `DatasetColumnarGeometry` | `TableGeometry` | `/table` |
| `DatasetColumnarGeometryType` | `GeometryType` | `/table` |
| `DatasetColumnarInput` | `Table` | `/table` |
| `DatasetColumnarMixedGeometry` | `TableMixedGeometry` | `/table` |
| `DatasetColumnarPrepared` | `PreparedTable` | `/table` |
| `DatasetDictionaryColumn` | `DictionaryColumn` | `/table` |
| `DatasetDictionaryCodes` | `DictionaryColumn` | `codes`, `/table` |
| `resolveFeatureStyle` | `features.getAppliedStyle` | |
| `getCreatedZoom`, `setCreatedZoom` | `maplibre-gl-draw:createdZoom` | |
| `getRotation`, `setRotation` | `maplibre-gl-draw:rotation` | |
| `getScale` | `maplibre-gl-draw:scale` | A key of `properties` |
| `HitTestStrategy` | `FeatureTypeDefinition` | `hitTest` |
| `BoxSelectionStrategy` | `FeatureTypeDefinition` | `boxSelect` |
| `CustomBoundingBoxCalculator` | `FeatureTypeDefinition` | `bounds` |
| `PointFrameExtent` | `FeatureTypeDefinition` | `bounds` |
| `PointFrameExtentProvider` | `FeatureTypeDefinition` | `bounds` |
| `AdditionalResizeHandlesCalculator` | `FeatureTypeDefinition` | `handles` |
| `CustomResizeCalculator` | `FeatureTypeDefinition` | `onHandleDrag` |
| `CustomResizeResult` | `FeaturePatch` | What `onHandleDrag` returns |
| `ResizeStrategy` | `FeatureTypeDefinition` | `onHandleDrag` |
| `HitTestOptions` | `ModeContext` | `hitTest` |
| `HitTestService`, `HitTestTopmost` | `ModeContext` | `hitTest` |
| `TopHit`, `TopmostHitTestOptions` | `ModeContext` | `hitTest` |
| `SpatialQuery` | `ModeContext` | `hitTest` |
| `TentativeState` | `ModeContext` | `preview` |
| `EventEmitter` | `ExtensionContext` | `on`, `off`, `once` |
| `PluginManager` | `extensions.plugins` | |
| `AuxiliaryHandleRegistry` | `extensions.handleProviders` | |
| `FeatureCompanionRegistry` | `extensions.companionProviders` | |
| `createFeatureCompanionRegistry` | `extensions.companionProviders` | |
| `SDFLineRenderer` | `LineRenderer` | |
| `FillShaderManager` | `FillRenderer` | |
| `PointShapeRenderer` | `PointRenderer` | |
| `UnprojectFunction` | `ScreenContext` | `unproject` |
| `computeBoundingBox` | `ScreenContext` | `bounds` |
| `BoundingBoxCoords` | `ScreenContext` | What `bounds` returns |
| `resolvePixelRatio` | `ScreenContext` | `pixelRatio` |
| `TerrainRenderDiagnostics` | `TerrainDiagnostics` | Its fields |
| `TerrainDrapeDebug` | `TerrainDiagnostics` | Its fields |
| `anchorElevationMeters` | `TerrainAnchors` | `elevation` |
| `anchorGhostOpacity` | `TerrainAnchors` | `ghostOpacity` |
| `getAnchorElevationGeneration` | `TerrainAnchors` | `generation` |
| `calculateOffsetUniforms` | `RenderContext` | `offset` |
| `getProjectionTransitionUniform` | `RenderContext` | `projection` |
| `GeometryOperations`, `GeometryApi` | `features` | `union` and the rest |
| `GeometryApiDeps`, `createGeometryApi` | `features` | |
| `GeometryBufferOptions` | `features.buffer` | Its options |
| `SnappingOperations` | `options` | `snapping` |
| `TracingOperations` | `options` | `tracing` |
| `TopologyOperations` | `options` | `topology` |
| `ExportFormat`, `ExportResult` | `document` | `toJSON`, `toGeoJSON` |
| `BoundingBox` | `BBox` | `/geometry` |
| `metersToDegreesLat`, `metersToDegreesLng` | `metersToDegrees` | `/geometry` |
| `generateCirclePolygon` | `circle` | `/geometry` |
| `getSelectedFeatureIds` | `selection.get().ids` | |
| `getStrokeDashPattern` | `dashPattern` | `/webgl` |
| `getTerrainTessellationStep` | `terrainTessellationStep` | `/webgl` |
| `ShaderData`, `OffsetUniforms` | Main entry | Now under semver |
| `applyDrawBlendState`, `BlendCapableGL` | `/webgl` | |
| `calculateLngLatOffset`, `computeQuadVertices` | `/webgl` | |
| `createProgram`, `DashSegment` | `/webgl` | |
| `DEFAULT_TILE_SIZE`, `densifyPath` | `/webgl` | |
| `DrapeQuadCorners`, `drawBillboardsWithoutDepth` | `/webgl` | |
| `drawQuadSurfaceOnTerrain`, `MercatorRect` | `/webgl` | |
| `OFFSET_MODE_GLSL`, `PointHitTestStrategy` | `/webgl` | |
| `ProjectionUniformLocations`, `ProjectionUniformManager` | `/webgl` | |
| `QUAD_GLYPH_STRIDE`, `QuadDrapeColor` | `/webgl` | |
| `QuadDrapeFill`, `QuadDrapeGlyphs` | `/webgl` | |
| `QuadDrapeSurface`, `QuadShader` | `/webgl` | |
| `QuadVertices`, `SDFStrokeOptions` | `/webgl` | |
| `SDFStrokeStyle`, `splitIntoDashes` | `/webgl` | |
| `TerrainContext`, `TerrainRenderState` | (removed) | `RenderContext` |
| `TessellationStep`, `TessellationTiling` | `/webgl` | |
| `WidthUnit` | `/webgl` | |
| `ExportOptions` | (removed) | Export every feature |
| `GeometryAppliedPayload` | (removed) | The methods return the result |
| `GeometryOperationName` | (removed) | |
| `InputOperations`, `SyntheticInputOptions` | (removed) | No synthetic input |
| `SyntheticKeyOptions`, `SyntheticLngLat` | (removed) | |
| `SyntheticModifiers`, `SnapInputType` | (removed) | |
| `UpdateFeatureOptions` | (removed) | `isIntermediate` in changes |
| `BoxSelection`, `DragState` | (removed) | Internal state |
| `DragOperationType`, `RotateInfo` | (removed) | |
| `BoundingBoxCoordsSimple`, `ResizeState` | (removed) | |
| `VertexHit`, `SnapExcludeVertex` | (removed) | |
| `HookName` | (removed) | |
| `FeatureLockStore`, `InteractionGateStore` | (removed) | Read `locked` |
| `isFeatureLocked`, `isGroupLocked` | `features.isEditable` | Read-only too |
| `isInteractionBlocked` | (removed) | `isInteractionLocked` |
| `MemoryStore` | (removed) | Leave `store` out |
| `MESSAGES_EN` | (removed) | Pass only your words |
| `createGuideSnapProvider` | (removed) | Guides are built in |
| `GuideSnapProviderDeps`, `GuideSnapProviderOptions` | (removed) | |
| `DEFAULT_SNAP_GUIDE_LINE_STYLE` | `snapping.guideLine` | An option |
| `DEFAULT_SNAP_INDICATOR_STYLES` | `snapping.indicator` | An option |
| `SnapIndicatorStyles` | `snapping.indicator` | |
| `buildTraceGraph`, `findTracePath` | (removed) | Tracing is built in |
| `TraceGraph`, `TraceGraphEdge` | (removed) | |
| `TraceGraphEndpoint`, `TraceGraphNode` | (removed) | |
| `applyRuleColor`, `resolveRuleColor` | (removed) | `evaluateStyleRule` |
| `StyleRuleChannel` | (removed) | |
| `BoxSelectionStrategyRegistry` | (removed) | |
| `SelectionExtensionRegistry`, `SelectionScope` | (removed) | |
| `createSelectionExtensionRegistry` | (removed) | |
| `metersToMercatorScale`, `lngLatToMercator` | (removed) | Keep your own |
| `MercatorCoord`, `OBB`, `OBBCorners` | (removed) | |
| `createOBB`, `distanceToOBB`, `getOBBAABB` | (removed) | |
| `rectangleIntersectsOBB`, `hasZeroArea` | (removed) | |
| `pixelsToDegreesLat`, `pixelsToDegreesLng` | (removed) | |
| `getContrastColor`, `getExpandedViewportBounds` | (removed) | |
| `DEFAULT_VIEWPORT_EXPANSION_FACTOR` | (removed) | |
| `DEFAULT_POINT_FRAME_SIZE` | (removed) | |
| `TentativeStyle` | (removed) | `DrawOptions.previewStyle` |
| `BoxSelectionStyleConfig` | (removed) | `boxSelection` |
| `FillStyle` | (removed) | `boxSelection` |

#### Geometry

`@sakuzu/maplibre-gl-draw/geometry` goes from 60 exports to 31. The
functions take GeoJSON geometries or features and return geometries;
lengths are in meters.

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `haversineDistanceMeters` | `distance` | |
| `initialBearingDegrees` | `bearing` | |
| `destinationPoint` | `destination` | |
| `getPointAtAngle` | `destination` | |
| (none) | `midpoint`, `along` | |
| (none) | `nearestPointOnLine` | |
| `geodesicLength` | `length` | |
| `sphericalArea` | `area` | |
| (none) | `perimeter` | |
| `centroid` | `centroid` | A `Point` or `null` |
| `pointOnSurface` | `pointOnSurface` | A `Point` or `null` |
| `generateCirclePolygon` | `circle` | |
| `buffer` | `buffer` | |
| `BufferOptions` | (removed) | `{ segments }` |
| `DEFAULT_BUFFER_SEGMENTS` | (removed) | |
| `union(a, b)` | `union([a, b])` | |
| `unionAll` | `union` | |
| `intersection(a, b)` | `intersection([a, b])` | |
| `intersectionAll` | `intersection` | |
| `clip` | `intersection` | |
| `difference(a, b)` | `difference(a, [b])` | |
| `differenceAll` | `difference` | |
| `splitArea` | `split` | |
| `pointInPolygon` | `pointInPolygon` | |
| `intersects` | `overlaps` | Touching is false |
| `contains` | `contains` | |
| `within(a, b)` | `contains(b, a)` | |
| `bboxIntersects` | `bboxIntersects` | |
| `bboxContains` | `bboxContains` | |
| `normalizeArea` | `makeValid` | |
| `normalizeRingOrientation` | `rewind` | |
| `normalizePolygonOrientation` | `rewind` | |
| `normalizeMultiPolygonOrientation` | `rewind` | |
| `isRingClockwise` | `rewind` | |
| `simplify` | `simplify` | Tolerance in meters |
| `boundingBox`, `coordinatesBBox` | `bbox` | Throws when empty |
| `metersToDegreesLat` (main) | `metersToDegrees` | |
| `metersToDegreesLng` (main) | `metersToDegrees` | |
| `BBox` | `BBox` | |
| `EARTH_RADIUS_METERS` | `EARTH_RADIUS_METERS` | 6371008.8 |
| `GeometryError` | `GeometryError` | |
| `GeometryErrorCode` | `GeometryErrorCode` | |
| `GeometryOperation` | `GeometryError` | `operation` |
| `closeRing`, `isRingClosed` | (removed) | |
| `flattenAreaCoordinates` | (removed) | |
| `isMultiPolygonCoordinates` | (removed) | |
| `toMultiPolygonCoordinates` | (removed) | |
| `signedRingArea` | (removed) | |
| `segmentIntersection` | (removed) | |
| `toDegrees`, `toRadians` | (removed) | |
| `Coordinate`, `Ring` | GeoJSON `Position` | |
| `AreaCoordinates` | GeoJSON `Polygon` | |
| `PolygonCoordinates` | GeoJSON `Polygon` | |
| `MultiPolygonCoordinates` | GeoJSON `MultiPolygon` | |
| `GeometryInput` | GeoJSON `Geometry` | |
| `PointGeometry` | GeoJSON `Point` | |
| `MultiPointGeometry` | GeoJSON `MultiPoint` | |
| `LineStringGeometry` | GeoJSON `LineString` | |
| `MultiLineStringGeometry` | GeoJSON `MultiLineString` | |
| `PolygonGeometry` | GeoJSON `Polygon` | |
| `MultiPolygonGeometry` | GeoJSON `MultiPolygon` | |

#### Table

`@sakuzu/maplibre-gl-draw/columnar` is `@sakuzu/maplibre-gl-draw/table`.

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `prepareDatasetColumnar` | `prepareTable` | Returns the table with it |
| `columnarTransferables` | `transferList` | |
| `DatasetColumnarInput` | `Table` | |
| `DatasetColumnarPrepared` | `PreparedTable` | |
| `DatasetColumnarGeometry` | `TableGeometry` | |
| `DatasetColumnarMixedGeometry` | `TableMixedGeometry` | |
| `DatasetColumnarGeometryType` | `GeometryType` | |
| `DatasetColumn` | `Column` | |
| `DatasetDictionaryColumn` | `DictionaryColumn` | |
| `DatasetDictionaryCodes` | `DictionaryColumn` | `codes` |
| (none) | `tableFromFeatures` | |
| (none) | `createTableBuilder`, `TableBuilder` | |

The members of a dataset:

| 1.0 | 2.0 | Note |
| --- | --- | --- |
| `DatasetOptions.features` | `DatasetOptions.rows` | |
| `columnar`, `prepared` | `DatasetOptions.table` | Either form |
| `DatasetOptions.provider` | `DatasetOptions.provider` | |
| `setFeatures` | `setRows` | |
| `setColumnar(input, prepared)` | `setTable(table)` | |
| `getFeatures` | `listRows` | |
| `collectVisible` | `listVisibleRows` | |
| `collectDrawnRows` | `listDrawnRows` | |
| `getRowFeature` | `getRow` | |
| `getVisibleFeatureIds` | `listVisibleRowIds` | |
| `getSelectedIds` | `getSelectedRowIds` | |
| `setSelectedIds` | `setSelectedRowIds` | |
| `invalidateProviderCache` | `refresh` | |
| `remove()` | `draw.datasets.remove(id)` | |
| The events `click`, `hover` | `clicked`, `hovered` | |
| The event `change` | `changed` | Reason `features` is `rows` |

## [1.0.0] - 2026-09-27

First public release, under AGPL-3.0-only. A commercial license is
available from Kasika, Inc.

### Added in 1.0.0

- Drawing points, lines, polygons, circles and freehand lines with the
  mouse, touch, a pen or the keyboard, and placing images on the map.
- Selecting features with a click or a box, and moving, resizing and
  rotating them.
- Editing vertices, including the parts of multi-part features and the
  holes of polygons.
- Snapping to vertices, edges, their intersections and angle guides, and
  tracing along an existing boundary.
- Union, subtract, intersect, split and buffer, and distance, length and
  area, as plain functions in `@sakuzu/maplibre-gl-draw/geometry` that
  also run outside the browser.
- Styles, and style rules that color features by the value of a property.
- Layers and groups that can be reordered, hidden, locked and faded, with
  MapLibre's own layers placed between them.
- Drawing and editing on tilted and rotated maps, on the globe, across
  the antimeridian and on 3D terrain.
- A drawing of 200,000 features that stays editable.
- Datasets that show large data fast without making it editable: passed
  at once or fetched by the area in view, from features or from columns
  (GeoParquet and Arrow tables, read in a Worker if needed), styled by
  the same style rules and clickable.
- Export and load in the native format and as GeoJSON, a replaceable
  store, and an event for every change.
- A read-only mode and an interaction lock.
- Plugins, custom modes and custom feature types.

[Unreleased]: https://github.com/sakuzu/maplibre-gl-draw/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/sakuzu/maplibre-gl-draw/compare/v2.1.4...v2.2.0
[2.1.4]: https://github.com/sakuzu/maplibre-gl-draw/compare/v2.1.3...v2.1.4
[2.1.3]: https://github.com/sakuzu/maplibre-gl-draw/compare/v2.1.2...v2.1.3
[2.1.2]: https://github.com/sakuzu/maplibre-gl-draw/compare/v2.1.1...v2.1.2
[2.1.1]: https://github.com/sakuzu/maplibre-gl-draw/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/sakuzu/maplibre-gl-draw/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/sakuzu/maplibre-gl-draw/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/sakuzu/maplibre-gl-draw/releases/tag/v1.0.0
