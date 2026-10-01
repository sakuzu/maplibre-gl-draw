# Changelog

All notable changes to `@sakuzu/maplibre-gl-draw` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows semantic versioning.

## [Unreleased]

- Added: the event `options.changed`, with `{ options, previous }`: what
  `draw.options.get()` returns after and before a `draw.options.update`
  that changed a value. An update that changes nothing fires nothing,
  and the event is not a change of the document, so it fires no
  `document.changed`.
- Fixed: the site keeps the 1.0 API page URLs working through redirects
  to the current pages.
- Fixed: the functions of `/geometry` take a feature of the drawing as it
  is, as documented. A feature whose `type` names a geometry type
  (`Polygon`, `LineString` and so on) was read as a geometry and threw a
  `GeometryError` (`invalid-input`); an object with a `geometry` member
  that is a geometry is now read as a feature first, whatever its own
  `type`.
- Added: two examples with the standard UI, `get-started` and
  `style-features`, and their pages on the site. The examples' dev server
  (`npm run dev`) moves to port 3200, and it and `npm run test:e2e` need
  the standard UI built first (`npm run ui:build`).
- Changed: the site (<https://sakuzu.github.io/maplibre-gl-draw/>) is
  the documentation site: getting started and the guides in English and
  Japanese, a gallery of eighteen examples with the standard UI, each on
  a page that runs it beside its code, the playground under
  `/playground/` and the API reference under `/api/`. The examples with
  buttons of their own (`basic`, `save-load`, `style-rules`,
  `snapping-and-geometry`, `read-only`, `plugin`, `custom-feature-type`,
  `large-data` and `table-worker`) are replaced by the examples of the
  gallery, and their addresses, like those of the HTML pages of the
  earlier API reference, redirect to the pages that took their place.
  `npm run site:dev` serves the site with the examples and the
  playground for a local check.

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

[Unreleased]: https://github.com/sakuzu/maplibre-gl-draw/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/sakuzu/maplibre-gl-draw/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/sakuzu/maplibre-gl-draw/releases/tag/v1.0.0
