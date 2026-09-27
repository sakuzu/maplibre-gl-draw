# Changelog

All notable changes to `@sakuzu/maplibre-gl-draw` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows semantic versioning.

## [Unreleased]

- Changed: the subpath `@sakuzu/maplibre-gl-draw/columnar` is replaced by
  `@sakuzu/maplibre-gl-draw/table`. Its types are `Table`, `TableGeometry`,
  `TableMixedGeometry`, `GeometryType`, `Column`, `DictionaryColumn` and
  `PreparedTable`, and they are no longer exported from the main entry.
  `prepareTable(table)` returns the table with what it computed, and
  `transferList(table | prepared)` lists the buffers to transfer.
- Added: `tableFromFeatures` and `createTableBuilder` in
  `@sakuzu/maplibre-gl-draw/table`, which build a table from GeoJSON.
- Changed: a dataset takes its rows as GeoJSON features. `DatasetOptions`
  has `rows` (for `features`) and `table`, which takes a `Table` or a
  `PreparedTable` (for `columnar` and `prepared`). `Dataset.setRows`,
  `Dataset.setTable` and `Dataset.getRow` replace `setFeatures`,
  `setColumnar` and `getRowFeature`, and `DatasetRow` replaces
  `DatasetFeatureInput`. A provider returns `DatasetRow[]`.
- Deprecated: `generateCirclePolygon` from `@sakuzu/maplibre-gl-draw`.
  Import it from `@sakuzu/maplibre-gl-draw/geometry`, where it is the same
  function; the export from the main entry will be removed in the next
  major release.

## [1.0.0] - 2026-09-27

First public release, under AGPL-3.0-only. A commercial license is
available from Kasika, Inc.

### Added

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

[Unreleased]: https://github.com/sakuzu/maplibre-gl-draw/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/sakuzu/maplibre-gl-draw/releases/tag/v1.0.0
