# Changelog

All notable changes to `@sakuzu/maplibre-gl-draw` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows semantic versioning.

## Unreleased

- First public release under AGPL-3.0-only.
- Added: the columnar input of a dataset takes a table whose rows have
  different geometry types, as the mixed geometry column of GeoArrow
  (`DatasetColumnarMixedGeometry`).
- Added: a dataset can be read by row number without building features.
  `Dataset.collectDrawnRows(bounds)` returns the rows in an extent that are
  drawn now (with a geometry, not hidden, kept by the collision thinning),
  in draw order, through the spatial index. `getRowFeature`, `getRowId`,
  `getRowType`, `getRowBounds` and `getRowPoint` read one row, so code that
  walks only what is drawn builds features only for the rows it keeps.
- Changed: `DatasetColumnarInput.geometry` is a union of
  `DatasetColumnarGeometry` and `DatasetColumnarMixedGeometry`, so code
  that reads `geometry.coords` or `geometry.offsets` must narrow on
  `geometry.type` first.
- Fixed: the collision thinning of a dataset follows the integer zoom in
  the middle of a zoom or pitch gesture, instead of keeping the points
  chosen for the zoom the gesture started at. After a fast zoom out those
  points piled up into a solid patch until the gesture ended. The points
  chosen for nearby zooms are kept and picked ahead while the page is idle,
  and the points drawn before stay on screen until the new ones are ready.
- Fixed: polygons and lines follow the terrain's vertical exaggeration
  instead of always drawing at 1.0, so they stay on the map's ground.
- Fixed: on terrain, dashed lines, polygons with a dashed outline, the
  geometry being drawn and the features of extensions are hidden behind a
  mountain like solid lines, instead of showing through it whenever solid
  lines or polygons were on the map.
- Fixed: on the globe projection an edge between two vertices follows the
  path maplibre's own layers take (the straight line of the Mercator plane
  carried onto the sphere, so a parallel stays a parallel) instead of a
  chord through the sphere. Fills, outlines, dashes, images (their picture
  pasted as on the Mercator map), the selection frame, the line being
  drawn and the hit test (click and hover) all follow it,
  cut as finely as maplibre cuts its own layers at the zoom. On a Mercator
  map nothing is cut.
- Fixed: on the globe, points within a few degrees of the edge of the
  sphere are drawn; the view culling kept only the bounds maplibre
  reports, which fall short of the edge.
- Changed: a midpoint handle, and the anchor of the rotation handle on the
  top edge of the frame, sit on the edge as drawn, halfway across in
  longitude; on a long slanted edge the plain average of the latitudes lay
  off the edge.
- Fixed: a drag whose feature is deleted mid-drag no longer throws on
  release or leaves map panning disabled; the remaining features commit.
- Fixed: the render layers are added when the draw instance is created
  while the map is loading tiles, and again after any `setStyle`.
- Fixed: loading validates the data before changing the store, so a bad
  native file no longer wipes the existing data; GeoJSON exported from a
  store loads back into it (colliding ids get new ones); embedded images
  must be PNG/JPEG/WebP/GIF data URLs and are never fetched from a URL;
  a `__proto__` property stays an ordinary key.
- Fixed: a feature whose layer or group does not exist is rejected instead
  of being stored undrawn, and changing `layerId` / `groupId` or deleting a
  group keeps every feature listed in exactly one layer or group.
- Fixed: feature, layer and group events are emitted for every change of a
  silent or batch operation instead of only the first; the new
  `draw.features.change` event carries all feature changes of a flush once.
- Fixed: the README, API reference and plugin guide match the current
  exports and signatures, the English docs contain no Japanese, and no
  file name contains `:`.
- Fixed: a drawing mode is not entered while no layer can be written
  (missing, locked, hidden or locally hidden), drawing falls back to the
  first writable layer, and losing the layer while drawing discards the
  drawing and returns to select instead of throwing. A plugin mode gets
  the same gate by declaring the new `ModeHandler.writesFeatures`.
- Fixed: the published files carry `.js` extensions on relative imports and
  are built with `NodeNext`, so the package loads under Node ESM and strict
  bundlers; tests, examples and declaration maps are no longer packed.
- Fixed: the click tolerance is the same screen distance at any bearing and
  latitude; built-in hit tests divide latitude differences by cos φ, and
  `toleranceLngLat` is documented as degrees of longitude at the click
  latitude.
- Fixed: one finger on a touch screen draws and edits like the left mouse
  button (long press is the context menu, two taps a double click), slow
  taps and pen taps are no longer dropped as clicks, and pinch and rotate
  stay with the map; a second finger during a press cancels it.
- Changed: `MouseNormalizedEvent` and `DragNormalizedEvent` gain an optional
  `pointerType` (`'mouse' | 'touch' | 'pen'`, synthetic input counts as
  mouse), their `originalEvent` is `MouseEvent | TouchEvent`, and
  `DragNormalizedEvent` gains the type `dragcancel`, delivered to a mode's
  `onDragCancel`.
- Fixed: the spatial index is derived from the store by one subscriber, so
  every write path and a replaced store's changes from outside keep it in step,
  writes refused while read-only leave no phantom hits, and a property
  change such as a Circle's radius re-measures the feature.
- Removed: `insertToSpatialIndex`, `updateInSpatialIndex` and
  `removeFromSpatialIndex` from the public API and `PluginContext`; a plugin
  whose custom type changes extent outside the store calls the new
  `ctx.invalidateFeatures(type)`.
- Removed: the plugin hooks `feature:` / `group:` / `layer:` `beforeCreate`,
  `beforeUpdate` and `beforeDelete`, and `selection:beforeChange`. The
  after hooks now fire from the store's change notification for every
  write, not only for `PluginContext` mutations, and `PluginContext`
  mutations pass their `source` to the store notification.
- Fixed: the drawing recovers from a lost WebGL context: every GPU resource
  is dropped on the loss and created again on the restore (or when the map
  adds the layer back), and overlay renderers are no longer lost when the
  layer is removed and added again, e.g. after `setStyle`.
- Fixed: a view across the antimeridian draws the features on the other
  side of the line next to it (a second copy, 360 degrees away) instead of
  dropping them or drawing them across the world, hit testing, handles and
  snapping reach that copy, and the terrain atlas keeps its resolution
  there; world copies at low zoom are still drawn once.
- Changed: `ModeContext.spatialIndex` only answers queries (`findNear`,
  `findInBounds`); the index follows the store, and its remaining manual
  writes in the geometry, selection, layer and image import paths are gone.
- Fixed: a second finger during a select-mode drag, a box selection or a
  freehand stroke no longer leaves the press hanging or the map pan off
  (`ModeHandler.onDragCancel`), the `dragThreshold` option reaches the
  input, a touch press is no longer `preventDefault`ed, and `PointerType`
  and `PointerOriginalEvent` are exported.
- Fixed: a GeoJSON load checks every geometry before writing anything; a
  feature with unusable coordinates (empty, non-finite, a short line, an
  open or short ring) or an unsupported geometry is left out and reported
  in `LoadResult.skipped`, `featureType` can no longer pair a type with
  coordinates of another shape, and a native load rejects short lines and
  open rings.
- Fixed: two draw instances on one page no longer share extension
  registrations, triangulation and style caches, handle thinning, terrain
  state or the depth-test record; every registry and cache belongs to its
  instance and is cleared by `destroy()`.
- Added: `PluginContext.projectAnchor`, `anchorElevationMeters`,
  `getAnchorElevationGeneration` and `computeBoundingBox`, bound to the
  plugin's draw instance, and `CustomRendererDrawContext.terrain`.
- Changed: the terrain functions (`projectAnchor`, `anchorElevationMeters`,
  `anchorGhostOpacity`, `isAnchorOccluded`, `getAnchorElevationGeneration`,
  `isAnchorActive`, `getTerrainRenderState`, `getTerrainTessellationStep`,
  `isTerrainElevationActive`, `isTerrainTessellationActive`,
  `getTerrainDrapeDebug`, `withoutTerrainElevation`,
  `drawQuadSurfaceOnTerrain`) take the draw instance's `TerrainContext` as
  their first argument; `ProjectionUniformManager` and `QuadShader` take it
  with `setTerrain()`; `computeBoundingBox`, `computeCombinedBoundingBox`,
  `computeSelectionBoundingBox`, `startResize`, `computeResize` and
  `startRotation` take an optional `SelectionExtensionRegistry`;
  `hitTestHandles` takes the instance's `SelectionScope` after `zoom`, and
  `SelectionUIRenderer` takes the registry in its constructor.
- Removed: the module-level registries and caches `globalStyleRuleCache`,
  `setGlobalTileSize`, `registerCustomBoundingBoxCalculator`,
  `registerAdditionalResizeHandlesCalculator`,
  `registerCustomResizeCalculator`, `registerResizeStrategy`,
  `registerPointFrameExtentProvider`, `getCustomResizeCalculator`,
  `getResizeStrategy`, `resolvePointFrameExtent`,
  `registerAuxiliaryHandleProvider` (the free function; the method on the
  draw instance stays), `getAuxiliaryHandleProvider(s)`,
  `clearAuxiliaryHandleProviders`, `registerSnapTargetsProvider`,
  `getSnapTargetsProvider`, `clearSnapTargetsProviders` and
  `registerRotationFeatureType`; register through the draw instance.
- Added: `draw.getTerrainDiagnostics()` returns the terrain state and the
  drape diagnostics of the instance's last frame.
- Changed: the root entry names every export in two layers, the public API
  and the building blocks for extension authors (described in docs/reference/README.md,
  may change in a minor release); declarations marked `@internal` are
  stripped from `dist/`. `BoxSelectionStrategyRegistry`,
  `FillShaderManager`, `PointShapeRenderer`, `SDFLineRenderer` are exported
  as types only.
- Added: exports for the types that public signatures refer to:
  `AutoNameConfig`, `AutoNameGenerator`, `AutoNameType`,
  `BoundingBoxCoordsSimple`, `BoundingBoxStyle`, `BoxSelectionStyleConfig`,
  `CenterMarkerStyle`, `DashSegment`, `DatasetClickEventPayload`,
  `EventEmitter`, `ExportFormat`, `ExportOptions`, `ExportResult`,
  `FeatureLockStore`, `FeatureStyleConfig`, `FillStyle`, `HookName`,
  `LineStringFeatureStyle`, `MercatorCoord`, `MercatorRect`,
  `MidpointHandleStyle`, `OBBCorners`, `PolygonFeatureStyle`,
  `ProjectionUniformLocations`, `RadiusHandleStyle`, `RadiusLineStyle`,
  `RenderingConfig`, `ResizeHandleStyle`, `RotateHandleStyle`, `RotateInfo`,
  `SDFStrokeOptions`, `SelectionUIConfig`, `SkippedFeature`, `SpatialQuery`,
  `TentativeStyle`, `TerrainContext`, `TerrainDiagnostics`,
  `TessellationTiling`, `TopologyConfig`, `TraceConfig`, `TraceOptions`,
  `VertexHandleStyle`.
- Removed: internal values are no longer exported from the root:
  `addFeatureToGroup`, `addVertex`, `ASYNC_TRIANGULATION_VERTEX_THRESHOLD`,
  `BatchManager`, `boundsIntersect`, `BoxSelectionRenderer`, `BufferCache`,
  `buildChunkBatches`, `CHUNK_TARGET_SIZE`, `chunkTargetSizeFor`,
  `CircleHitTestStrategy`, `circumferenceAtLatitude`,
  `collectFeatureSegments`, `collectSharedVertexMoves`,
  `computeCombinedBoundingBox`, `computeMidpointHandles`, `computeResize`,
  `computeResizeHandles`, `computeRotateHandle`, `computeRotation`,
  `computeSelectionBoundingBox`, `computeVertexHandles`,
  `computeVertexMove`, `createAuxiliaryHandleRegistry`,
  `createBuiltInSnapProviders`, `createChunkTriangulator`, `createContext`,
  `createCoreBoxSelectionStrategies`, `createCustomLayer`,
  `createDisplayApi`, `createDatasetManager`,
  `createDisplayInteractions`, `createDrawAPI`, `createGeometryApi`,
  `createImportExportAPI`, `createInputApi`, `createInputNormalizer`,
  `createInputRouter`, `createMutationContext`, `createPluginContext`,
  `createPluginManager`, `createProjectionState`, `createRenderCoordinator`,
  `createSelectionScope`, `createSnappingApi`, `createSnapService`,
  `createSnapTargetsRegistry`, `createStoreEdgeSnapProvider`,
  `createStoreIntersectionSnapProvider`, `createStoreVertexSnapProvider`,
  `createTopmostHitTester`, `createTopologyApi`, `createTracingApi`,
  `CursorManager`, `DEFAULT_FULL_DISPLAY_ZOOM`, `DEFAULT_HIT_TEST_OPTIONS`,
  `DEFAULT_OPTIONS`, `DEFAULT_PROVIDER_DEBOUNCE_MS`, `DEFAULT_SNAP_KINDS`,
  `DEFAULT_SNAP_OPTIONS`, `DEFAULT_THINNING_MARGIN_PX`,
  `DEFAULT_TILE_CACHE_SIZE`, `degreesPerPixel`, `deleteVertex`,
  `densifyRings`, `DatasetImpl`, `DatasetManager`,
  `DisplaySpatialIndex`, `disposeChunkBatches`, `distanceInPixels`,
  `drawChunkBatches`, `DrawCircleMode`, `drawFeatureCompanionsInFrame`,
  `DrawFreehandMode`, `DrawImageMode`, `DrawLineMode`, `DrawPointMode`,
  `DrawPolygonMode`, `EarcutCache`, `effectiveZoomForCamera`,
  `effectiveZoomForPitch`, `euclideanDistance`, `EventBridgeImpl`,
  `expandBounds`, `FeatureDrawer`, `findVertexRefsAt`,
  `getConfirmedTentativeVertices`, `getCursorForHandle`,
  `getDisplayFeatures`, `getMetersPerPixel`, `getModifiers`,
  `getOBBCorners`, `getRotationDelta`, `getSelectedFeatures`,
  `getTerrainDrapeDebug`, `getTerrainRenderState`, `getTileSize`,
  `globalTriangulationScheduler`, `groupSelection`, `hasVertexRef`,
  `hitTestFeatureCompanions`, `hitTestGlobalAuxiliaryHandles`,
  `hitTestHandles`, `HitTestServiceImpl`, `HitTestStrategyRegistry`,
  `ImageBoxSelectionStrategy`, `ImageHitTestStrategy`, `ImageRenderer`,
  `isAnchorActive`, `isAnchorOccluded`, `isEmptyChunkBatches`,
  `isLocallyHidden`, `isSameVertexRef`, `isSegmentCandidate`,
  `isTerrainElevationActive`, `isTerrainTessellationActive`,
  `LARGE_CHUNK_TARGET_SIZE`, `LARGE_DATASET_THRESHOLD`, `latToTileY`,
  `latToWorldY`, `LineHitTestStrategy`, `LineStringBoxSelectionStrategy`,
  `lngToTileX`, `lngToWorldX`, `MAX_PITCH_ZOOM_DROP`, `mergeChanges`,
  `midpoint`, `ModeManagerImpl`, `moveToLayer`,
  `MultiLineStringBoxSelectionStrategy`, `MultiLineStringHitTestStrategy`,
  `MultiPointBoxSelectionStrategy`, `MultiPointHitTestStrategy`,
  `MultiPolygonBoxSelectionStrategy`, `MultiPolygonHitTestStrategy`,
  `nearestPointOnSegment`, `normalizeDisplayFeature`,
  `notifyFeatureCompanionClick`, `partitionIntoChunks`,
  `PointBoxSelectionStrategy`, `pointFootprintPx`, `pointInOBB`,
  `PointInstanceRenderer`, `pointMarkerRadiusPx`, `PolygonBatchRenderer`,
  `PolygonBoxSelectionStrategy`, `PolygonHitTestStrategy`,
  `polygonSignature`, `projectAnchor`, `ProjectionStateImpl`,
  `removeFeatureFromGroup`, `resolveCollisionThinning`,
  `resolveContentPixelRatio`, `resolveSnapKinds`,
  `resolveVertexCoordinates`, `rotateBoundingBox`, `sameCollisionThinning`,
  `SDFPolygonRenderer`, `selectCollisionWinners`,
  `SelectionHandlesRenderer`, `SelectionUIRenderer`, `SelectMode`,
  `SelectModeDragHandler`, `ShaderInitializer`, `SNAP_KIND_PRIORITY`,
  `SnapIndicatorRenderer`, `sortVertexRefsForDeletion`, `startResize`,
  `startRotation`, `startVertexMove`, `StrokeRenderer`,
  `STYLE_RULE_OTHER_LABEL`, `StyleRuleCache`, `subdivideTriangles`,
  `SYNTHETIC_EVENT_MARKER`, `TentativeRenderer`,
  `TERRAIN_ATLAS_TEXTURE_UNIT`, `TERRAIN_GHOST_OPACITY`,
  `terrainLiftMeters`, `terrainMeshSpacingMeters`, `TextureCache`,
  `TileFeatureCache`, `tileRangeBounds`, `tileRangeKey`, `tileXToLng`,
  `tileYToLat`, `toLineInstanceColor`, `toTileRange`, `toZoomStage`,
  `TRIANGULATION_SLICE_MS`, `TriangulationScheduler`, `ungroupGroup`,
  `ungroupSelection`, `ViewportFilter`, `withoutTerrainElevation`,
  `worldUnitsPerPixel`, `zoomBandFor`.
- Removed: internal types are no longer exported from the root:
  `AuxiliaryHandleCandidate`, `AuxiliaryHandlesCallback`,
  `BuiltInSnapProvidersOptions`, `ChunkTriangulator`,
  `CollisionThinningInput`, `CompanionBatchFrame`, `Context`,
  `CustomLayerDeps`, `CustomLayerInterface`, `CustomModeFactory`,
  `DegreesPerPixel`, `DisplayApi`, `DisplayApiDeps`, `DisplayBatchTarget`,
  `DisplayChunk`, `DisplayChunkBatches`, `DatasetDeps`,
  `DatasetManagerDeps`, `DisplayHitResult`, `DisplayHitTestFn`,
  `DisplayInteractions`, `DisplayInteractionsDeps`, `EventBridge`,
  `FeatureDrawerDeps`, `GeometryApi`, `GeometryApiDeps`, `GetFileDataFn`,
  `HandleHitResult`, `ImportExportAPI`, `InputApi`, `InputApiDeps`,
  `InputNormalizer`, `InputNormalizerOptions`, `InputRouter`,
  `InputRouterDeps`, `LineBatchItem`, `LineBatchItemBase`, `LineBatchShape`,
  `ModeManager`, `NormalizedEventMap`, `PluginContextDependencies`,
  `ProjectionState`, `RenderCoordinator`, `RotateState`,
  `SDFPolygonBatchData`, `SegmentVisitor`, `SharedVertexMoves`,
  `SharedVertexStore`, `SnapIndicatorRendererDeps`, `SnappingApi`,
  `SnappingApiDeps`, `SnapService`, `SnapServiceDeps`,
  `SnapTargetsProvider`, `SnapTargetsRegistry`, `StoreSnapProviderDeps`,
  `StrokeOptions`, `TentativeRendererDeps`, `TextRenderOptions`,
  `TextureInfo`, `ThinningCamera`, `TileRange`, `TopmostHitTestDeps`,
  `TopologyApi`, `TopologyApiDeps`, `TracingApi`, `TracingApiDeps`,
  `TriangulationSchedulerDeps`, `VertexState`.
- Changed: v5 of `maplibre-gl` is no longer declared, and `engines.node` is
  `>=22`.
- Changed: tested against maplibre-gl 6.11.1.
- Fixed: the package depends on `@types/geojson`, which its declarations
  refer to, and no longer on the unused `gl-matrix`; `exports` gains a
  `default` condition and `./package.json`, and `CHANGELOG.md` is shipped.
- Fixed: `destroy()` releases every resource in the reverse order of its
  acquisition, gives boxZoom and the canvas `tabIndex` and `outline` back as
  it found them, ignores a second call, and ignores the registrations made
  on a destroyed instance instead of installing them; the extension
  contracts (`CustomFeatureHandler`, the renderers) moved to
  `src/extension/`, so the lower layers no longer import `api/`.
- Fixed: the geometry functions check their input: a ring with a
  non-finite coordinate or fewer than 3 positions is dropped before
  polygon-clipping, `segments` is clamped to an integer from 3 to 1024
  (NaN gives 64, Infinity no longer hangs), a NaN tolerance simplifies
  nothing, `generateCirclePolygon` returns `[]` for an unusable center or
  radius, the bounding boxes skip non-finite coordinates, `buffer` returns
  `null` for a distance reaching a pole or an edge spanning more than 180
  degrees of longitude, `sphericalArea` normalizes its input (never
  negative), and a MultiPolygon whose first part is empty is recognized.
- Fixed: the docs no longer claim that circles and buffers are geodesic
  without latitude error; `getPointAtAngle` is documented as an
  approximation at the center's latitude, with its measured error.
- Changed: the GeoJSON export follows RFC 7946 (right-hand rule rings,
  positions rounded to 7 decimal places, a `bbox` on the FeatureCollection),
  writes `name` and `description` as plain properties and the
  `featureType` marker with the type name as it is; the import also reads
  the standard Feature `id` and the prefixed name of earlier exports.
- Fixed: imported styles are checked key by key and a key of the wrong
  type or form (such as a color that is not `#rgb` / `#rrggbb`) is
  dropped, and native data of another major version is rejected (a newer
  minor version loads with a warning).
- Fixed: `setMode` with a name that has no registered mode is refused
  before the store changes (with a warning), like the interaction lock and
  a mode that cannot write, so the mode, `draw.mode.change` and the running
  mode never disagree.
- Fixed: a cancelled or aborted drag (Escape, the window losing the focus,
  a mode switch, a change from outside) puts the moved features back where it started
  and still sends `drag:end` with the dragged features; a release outside
  the page ends the drag; a drag frame is one store change; a box
  selection frame that selects the same features changes nothing.
- Fixed: the Delete key no longer removes locked members of a selected
  group or a layer that holds a locked feature or group, and a box
  selection across the antimeridian finds the features on both sides.
- Fixed: a double click while drawing or on a feature no longer zooms the
  map, the canvas takes the keyboard focus when pressed and keeps the
  page's focus outline, and the arrow keys move the selection (Shift for
  10 pixels) instead of also panning.
- Changed: the store is split into the document and the local state. A
  replaceable store implements the new `DocumentStore` contract (features,
  layers, groups, orders, files, metadata) and `Options.store` accepts
  one; core keeps the `UiState` (selection, mode, read-only, interaction
  lock, local visibility and the rest) and the read-only gate around it,
  and drops a deleted id from the selection, editing and local hiding
  whatever deleted it. `draw.getStore()` returns a `StoreView` (reads,
  `subscribe`, `transact`), and `PluginContext.getStore()` gives a plugin
  the `Store` with its writes. `Store`, `StoreView`, `DocumentStore` and
  `UiState` are exported.
- Changed: a write refused while read-only returns `false` instead of
  returning nothing (the `Store` writes and `updateFeature`,
  `deleteFeature`, `deleteAllFeatures`, `updateLayer`, `deleteLayer`,
  `setLayerOrder`, `reorderInLayer`, `updateGroup`, `deleteGroup`,
  `reorderInGroup` and `setMetadata`, which also return `false` for a
  locked target); `updateFeature` and `deleteGroup` with an id that does
  not exist throw like the other methods; a store listener that throws is
  reported and no longer keeps the notification from the listeners after
  it; `transact` is documented as not atomic.
- Fixed: `MemoryStore` keeps its own frozen copy of every feature, layer
  and group, so a caller's arrays are not shared, a write into a returned
  object throws instead of changing the store behind its notifications,
  and a reorder no longer changes a layer already returned or notified.
- Changed: `draw.getAllFeatures()` returns every feature in draw order,
  hidden ones included, like `deleteAllFeatures`; the new
  `draw.getVisibleFeatures()` returns what it used to. `draw.on` and
  `PluginContext.on` return the function that removes the handler.
- Fixed: a click, a move or a drag on a copy of the world east of the
  antimeridian (or on a world copy at low zoom) reaches the modes with the
  stored longitude in [-180, 180], a shape being drawn continues on the copy
  next to its first vertex so a line across the antimeridian stays
  continuous, and a drag never jumps by 360 degrees.
- Fixed: images are uploaded while rendering with the pixel store set
  explicitly and given back, scaled down to `MAX_TEXTURE_SIZE` and given
  mipmaps, decoded once per data URL, and dropped when they arrive after the
  layer is removed; the polygon renderer is released with the others (a
  missing release is now a type error), and the coordinate textures of lines
  and the tables of the terrain drape no longer exceed `MAX_TEXTURE_SIZE`
  (the frame falls back to vertex displacement instead).
- Fixed: with terrain on, the DEM atlas is baked before the main pass and
  only when the tiles or their DEM changed, the immediate path takes the
  features in view in draw order without walking the whole store every
  frame, lines drawn one by one reuse their arrays, and the sections of the
  terrain drape around images stop at their range.
- Fixed: a retained batch seen at high zoom far from its origin is built
  again around the view (the origin is the center of the chunk, and the
  Float32 error on screen stays within 0.1 px), every shader reads its
  textures with highp samplers, and the point renderers convert sizes with
  the drawing buffer instead of the canvas attributes.
- Changed: the strings the library returns as values (legend labels from
  `deriveLegend` and the `description` of the built-in snapping candidates)
  come from a typed messages table and default to English (`MESSAGES_EN`)
  instead of Japanese. `Options.messages`, the second argument of
  `deriveLegend` and `GuideSnapProviderOptions.messages` override entries.
- Fixed: circles and buffers are laid out along great circles with the new
  `destinationPoint` of the geometry entry, so a radius holds at any
  latitude up to floating-point rounding instead of drifting by about 0.5%
  at latitude 60 degrees for 100 km; `getPointAtAngle` keeps its planar
  meaning.
- Changed: resize and rotate compute in Web Mercator, so a large feature
  keeps its shape on the map and a pole no longer gives NaN, and a box is
  stretched along an axis unless it is thinner than the new optional
  `ResizeState.minAxisExtent` (1 pixel at the current zoom in the select
  mode) instead of 0.0001 degrees.
- Fixed: the GeoJSON export brings every longitude into [-180, 180]; a
  feature drawn across the antimeridian is written with its positions
  brought back by a turn and is not cut at the line.
- Changed: `registerFeatureHandler`, `registerMode`, `addOverlayRenderer`
  and `addPlugin` return the function that cancels the registration, like
  the other registrations; cancelling a feature handler undoes all of its
  parts (a built-in strategy it replaced comes back), a removed mode that is
  running falls back to select, and unregistering a plugin removes its
  modes.
- Changed: `draw.setMode` and `PluginContext.setMode` return whether the
  mode is the requested one after the call (`false` when refused).
- Added: the `draw.load.error` event (`LoadErrorPayload`) reports a file
  dropped on the map that could not be loaded.
- Fixed: the selection drops what becomes invisible (its own, its group's
  or its layer's shared visible flag, or local hiding, also from a change
  applied from outside), and the vertex selection ends when its feature is
  deleted or its coordinates change other than by a drag.
- Fixed: the render scale defaults to the map's `getPixelRatio()` instead
  of `window.devicePixelRatio`, and the click tolerance of the hit test is
  the documented 6 px default (it was 5 px in one of the two paths).
- Fixed: `addDataset` on a destroyed instance throws instead of
  creating a dataset that is never released.
- Fixed: the examples load the maplibre-gl stylesheet from the installed
  dependency instead of a CDN, serve their sample data from `public/` so it
  is in the build, build all three pages, and no longer carry about 11 MB
  of unreferenced generated JSON.
- Fixed: `Options.messages.snapIntersection` reaches the intersection
  candidates of both the Store and the datasets (they kept
  the English default).
- Fixed: `draw.load.error` is emitted with `source: 'image'` and the
  `featureId` when the image of an Image feature fails to load.
- Fixed: the radius handle of a circle sits on the drawn outline, and the
  spatial index and the selection frame use the extent of the geodesic
  circle, so both contain the whole circle at any latitude; the frame
  drawn during a rotation turns in Web Mercator like the feature.
- Added: the boolean operations of the geometry entry throw a
  `GeometryError` with a reason `code` (`invalid-input`, `unclosed-ring`,
  `too-complex`, `internal`), the failed `operation` and the original
  error as `cause` instead of the internal error of polygon-clipping.
- Removed: the terrain performance probe and debug switches read from
  `localStorage` at import time, the `[terrain-perf]` console output and
  the unused internal barrel modules; importing the package has no side
  effects (use `draw.getTerrainDiagnostics()` for terrain diagnostics).
- Added: `draw.deleteSelection()` deletes what is selected as one change,
  exactly like the Delete key of the select mode, and returns whether
  something was deleted.
- Added: end-to-end tests (`npm run test:e2e`) that drive the engine on a
  real maplibre map in headless Chromium with the real mouse and keyboard,
  pitched and rotated included, and unit tests of the drag threshold of
  the input normalizer.
- Changed: the sample plugin and the plugin development guide moved from
  `src/plugins/examples/` to `examples/sample-plugin/`, and the demo
  registers the sample plugin.
- Fixed: dragging the radius handle of a circle, and setting the radius
  while drawing one, record the great-circle bearing, so the handle stays
  under the pointer at high latitudes (it drifted about 1.5 km at latitude
  60 degrees for a 100 km radius).
- Fixed: the layer rules are checked by `npm run check:layers` (run by
  `npm run lint`), and no runtime import breaks them or forms a cycle; the
  basic types move to `shared/types` and the shared helpers move down,
  re-exported from their old paths.
- Changed: the select mode drag handler and the `draw.geometry` operations
  are split into one file per drag kind (`modes/select/drag/`) and per
  operation group (`api/geometry/`); internal only, no change for users.
- Changed: the SDF line renderer is split by responsibility into types,
  vertex data, shader sources, uniforms, and GL resources beside
  `sdf-line.ts`; an internal change with no effect on users.
- Changed: the retained cache of Store rendering is split into its parts
  (`view/layer/store-retained-*.ts`: classification, chunk, batch data,
  bbox, vertex patches, immediate chunks, invalidation); internal only, no
  change for users.
- Changed: the dataset is split by responsibility into the
  chunk set, the provider loader, the collision thinning state, the
  selection and hit test helpers and the styler, with `Dataset`
  as the thin surface that ties them together; this is an internal change
  with no effect on users.
- Changed: the CustomLayer is split by responsibility into the slot
  manager, the terrain resolver, the drape planner, the frame state, the
  drawing stages of a frame and the GL state of a slot, with
  `custom-layer.ts` implementing the interface of maplibre and tying them
  together; this is an internal change with no effect on users.
- Changed: the documentation describes extension points in general terms
  and no longer names any particular extension.
- Changed: the drape surface types are named by what they draw: `QuadDrapePaper`
  is `QuadDrapeFill`, `QuadDrapeText` is `QuadDrapeGlyphs`, and the field
  `paper` of `QuadDrapeSurface` is `fill`.
- Changed: a custom feature type without `getBoundingBox` is indexed by the
  extent of its coordinates instead of an empty box at the origin, so it
  can be clicked without a calculator.
- Fixed: the group shortcut (Cmd/Ctrl+G) places the new group where
  `draw.groupSelection()` does; the key and the API share one
  implementation.
- Removed: the unused internal projection state service (`ProjectionStateImpl`,
  `createProjectionState`); this is an internal change with no effect on users.
- Changed: `addFeature`, `addLayer` and `addGroup` return `string | null`,
  and null when the write was refused because the Store is read-only (they
  returned an ID that named nothing); `PluginContext.addFeatures` returns an
  empty list then.
- Changed: `PluginContext.setLayerOrder(order, source?)` is
  `setLayerItemOrder(layerId, order, source?)`: it replaces the item order of
  the layer it names instead of the active layer, and does nothing for a
  layer that does not exist.
- Added: the step angle of the built-in north-based snapping guides is set
  with `Options.snap.guideStepDegrees` (default 45) and changed at runtime
  with `draw.snapping.setGuideStep(degrees)`.
- Fixed: the point shapes `triangle` and `star` were drawn as circles; they
  are drawn as an upward triangle and a five-pointed star, inscribed in the
  circle of the same size (`icon` stays a circle for extensions to draw).
- Fixed: the dashes of the lines drawn directly with `SDFLineRenderer.draw()`
  (the line being drawn, the snapping guides, the radius of a circle) were
  measured on 256 px tiles without the latitude or the pixel ratio; their
  `dashArray` is now in CSS px at any zoom and latitude.
- Fixed: `Layer.opacity` had no effect on drawing; it is multiplied into the
  alpha of everything drawn for the layer (fills, lines, points, images), on
  terrain too, without rebuilding anything, and hit testing ignores it.
- Fixed: points of the shapes `triangle` and `star` were drawn one by one
  outside the batches; they are batched and instanced like `circle` and
  `square`.
- Added: `CustomRendererDrawContext.opacity`, the opacity of the layer being
  drawn, for custom feature renderers and feature companions to multiply
  into their own alpha (1 for overlays).
- Added: `FeatureStyle.pointShape` (`circle`, `square`, `triangle` or
  `star`) chooses the shape of a point per feature over the instance's
  default; it is validated on import and round-trips through GeoJSON and
  the native format.
- Changed: the peer range of `maplibre-gl` is `~6.11.1`; a new minor is
  supported only after its coupling points are checked.
- Fixed: on terrain, fills and lines read the DEM half a pixel off since
  maplibre 6.8 (it moved to a 2-texel border and cell-centred pixels), and
  symbols took the elevation of the `floor(zoom)` DEM tile rather than of
  the drawn surface; both now match `map.queryTerrainElevation`.
- Removed: the library no longer takes files dropped on the map. The
  application receives the drop on the map's container and calls
  `draw.load(file, { coordinate, zoom, layerId })` (see "Files dropped on
  the map" in the saving and loading guide). `FileDropNormalizedEvent`,
  `ModeHandler.onFileDrop`, `ModeContext.loadFile` and the `'drop'` source
  of `draw.load.error` are gone; `LoadErrorPayload` is `{ source: 'image',
  featureId, error }`.
- Added: the option `scaleWithZoom` (default `true`). The default
  behavior is unchanged: the drawing modes write `properties.createdZoom`
  and the line widths follow the zoom. With `false` a drawn feature gets
  no created zoom and keeps its line widths on the screen, like a feature
  added through the API. `ModeContext.scaleWithZoom` carries it to custom
  modes.
- Removed: `Metadata.basemap`. `Metadata` declares `title` and
  `description`; an application adds keys of its own with declaration
  merging, and they are stored and exported as before.
- Removed: the style keys `labelPlacement`, `pointIcon` and
  `pointIconDirection` from `FeatureStyle` and from the import checks. A
  style key core does not define is kept, saved and loaded unchanged
  without a check; the extension that uses it declares it with
  declaration merging and checks its value where it reads it.
- Changed: the GeoJSON export writes the properties `content`,
  `textWidth` and `textHeight` as plain keys; only core's own properties
  get the `maplibre-gl-draw:` prefix.
- Removed: the GeoJSON import no longer reads a prefixed
  `maplibre-gl-draw:name` or `maplibre-gl-draw:description`, and reads the
  `maplibre-gl-draw:featureType` marker as the exact type name (a
  lower-cased built-in name is no longer taken for that type).
- Removed: `setPinnedIds`, `getPinnedIds` and `isFeatureVisible` of a
  dataset; `getVisibleFeatureIds` tells which features are
  drawn.
- Changed: `draw.getTerrainDiagnostics()` returns plain numbers:
  `render` is a `TerrainRenderDiagnostics` without the DEM atlas texture.
  `TerrainDiagnostics`, `TerrainRenderDiagnostics`, `TerrainDrapeDebug` and
  `TerrainRenderState` moved to layer 2.
- Added: `'remote'` is a declared value of `UpdateSource`, the source a
  replaced `DocumentStore` gives the changes it applies from outside the
  instance; the descriptions of the sources say that a source only labels a
  change and that a transaction makes one notification.
- Removed: the unused text path of the texture cache and the deprecated
  renderer methods `PointInstanceRenderer.drawInstanced` and
  `SDFLineRenderer.drawBatch`.
- Changed: the stacking order is a formal part of the document. The
  native format is version `2.0.0` and carries the whole order as the
  required `layerOrder`, entries of the application that are not layers
  included; a native load replaces the order as a whole, and data of
  version 1 is rejected. `setLayerOrder` drops empty strings and keeps a
  repeated entry at its first position, and `createLayer` keeps the
  position of an id already on the order.
- Added: a dataset takes its rows as columns of typed
  arrays in the layout of GeoArrow (`columnar` of `addDataset`,
  `Dataset.setColumnar`, `DatasetColumnarInput` and its types).
  The rows are packed straight into the GPU arrays and become features
  only when asked for.
- Added: the subpath `@sakuzu/maplibre-gl-draw/columnar` with
  `prepareDatasetColumnar`, which computes the bboxes, the chunks and the
  spatial index of a columnar table in a Worker, and
  `columnarTransferables`, the buffers to move with `postMessage`.
- Added: `row` in the `click` and `hover` payloads of a
  dataset and in `draw.dataset.click`.
- Added: the events `draw.dataset.add` and `draw.dataset.remove` (`dataset.add`
  and `dataset.remove` for a plugin), emitted when a
  dataset is added or removed, with its `datasetId`, and
  `draw.dataset.reorder` (`dataset.reorder`), emitted when
  `moveDataset` changes the order or the side, with the ids from
  the back to the front.
- Changed: the spatial index of a dataset is a static
  R-tree packed into typed arrays, built in one pass.
- Fixed: the frame budget of a dataset covers the walk of
  the rows and the resolution of their styles, not only the upload, so
  the first frame of a large dataset no longer stalls.
- Changed: the ids that core generates take their random bytes in
  batches; the form of the ids is unchanged.
