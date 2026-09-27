# API reference

The reference of every public symbol of `@sakuzu/maplibre-gl-draw`,
generated from the sources. To learn how to use the library, start with
[Getting started](getting-started.md) and the guides.

## Where to start

- To put a drawing on a map, start from
  {@link maplibre-gl-draw!createMapLibreGLDraw | createMapLibreGLDraw}
  and its {@link maplibre-gl-draw!Options | Options}.
- To add, change and remove features, layers and groups, use the
  instance, {@link maplibre-gl-draw!MapLibreGLDraw | MapLibreGLDraw}. Its
  page is grouped by task.
- A {@link maplibre-gl-draw!Feature | Feature},
  a {@link maplibre-gl-draw!Layer | Layer} and
  a {@link maplibre-gl-draw!Group | Group} are the data model.
- To react to changes and clicks, see the events of
  {@link maplibre-gl-draw!EventMap | EventMap}.
- To style features, see
  {@link maplibre-gl-draw!FeatureStyle | FeatureStyle} and
  {@link maplibre-gl-draw!StyleRule | StyleRule}.
- To show large data that is not edited, see
  {@link maplibre-gl-draw!Dataset | Dataset} and
  {@link maplibre-gl-draw!DatasetOptions | DatasetOptions}.
- To save and load, see
  {@link maplibre-gl-draw!ExportFormat | ExportFormat} and
  {@link maplibre-gl-draw!LoadOptions | LoadOptions}.
- To add a plugin, a mode or a feature type, see
  {@link maplibre-gl-draw!Plugin | Plugin},
  {@link maplibre-gl-draw!ModeHandler | ModeHandler} and
  {@link maplibre-gl-draw!CustomFeatureHandler | CustomFeatureHandler}.

## Entry points

The package has three entry points. Import from the first one unless
you need the other two.

- `@sakuzu/maplibre-gl-draw` ({@link maplibre-gl-draw | the reference}):
  the instance, its options, the data model, the events, datasets and
  the extension points.
- `@sakuzu/maplibre-gl-draw/geometry` ({@link geometry | the reference}):
  geometry calculations that need no map: measure lengths and areas,
  build circles and buffers, combine polygons, test whether a point lies
  in a polygon, and tidy shapes. They also work in code that does not use
  the drawing engine (workers, servers, tests).
- `@sakuzu/maplibre-gl-draw/table` ({@link table | the reference}):
  the parts for reading a large table in a Worker and putting it on the
  map as a dataset.

The symbols under Building blocks are for people who write plugins,
modes and feature types. They may change in a minor release; everything
else follows semantic versioning.
