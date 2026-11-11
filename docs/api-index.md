# API reference

The reference of every public symbol of `@sakuzu/maplibre-gl-draw`,
generated from the sources. To learn how to use the library, start with
[Getting started](getting-started.md) and the guides.

## Where to start

- To put a drawing on a map, start from
  {@link maplibre-gl-draw!createDraw | createDraw}
  and its {@link maplibre-gl-draw!DrawOptions | DrawOptions}.
- To read features, layers and groups, use the collections of the
  instance, {@link maplibre-gl-draw!Draw | Draw}; its page is grouped by
  task. To add, change and remove them, use the transaction
  {@link maplibre-gl-draw!Transaction | Transaction} that
  `draw.write` gives its function.
- A {@link maplibre-gl-draw!Feature | Feature} (a GeoJSON Feature, read
  with {@link maplibre-gl-draw!readFeature | readFeature}),
  a {@link maplibre-gl-draw!Layer | Layer} and
  a {@link maplibre-gl-draw!Group | Group} are the data model.
- To react to changes and clicks, see the events of
  {@link maplibre-gl-draw!DrawEvents | DrawEvents}, and to follow a value
  that changes over time, {@link maplibre-gl-draw!Observable | Observable}.
- To style features, see
  {@link maplibre-gl-draw!FeatureStyle | FeatureStyle} and
  {@link maplibre-gl-draw!StyleRule | StyleRule}.
- To show large data that is not edited, see
  {@link maplibre-gl-draw!Dataset | Dataset} and
  {@link maplibre-gl-draw!DatasetOptions | DatasetOptions}.
- To save and open, see
  {@link maplibre-gl-draw!DrawDocument | DrawDocument} and
  {@link maplibre-gl-draw!ImportOptions | ImportOptions}. To read a source
  without writing it, see
  {@link maplibre-gl-draw!parseGeoJSON | parseGeoJSON} and
  {@link maplibre-gl-draw!parseNative | parseNative}.
- To add a plugin, a mode or a feature type, see
  {@link maplibre-gl-draw!Plugin | Plugin},
  {@link maplibre-gl-draw!ModeHandler | ModeHandler} and
  {@link maplibre-gl-draw!FeatureTypeDefinition | FeatureTypeDefinition}.

## Entry points

The package has five entry points. Import from the first one unless
you need the others.

- `@sakuzu/maplibre-gl-draw` ({@link maplibre-gl-draw | the reference}):
  the instance, its options, the data model, the events, datasets and
  the extension contract.
- `@sakuzu/maplibre-gl-draw/geometry` ({@link geometry | the reference}):
  geometry calculations that need no map: measure lengths and areas,
  build circles and buffers, combine polygons, test whether a point lies
  in a polygon, and tidy shapes. They also work in code that does not use
  the drawing engine (workers, servers, tests).
- `@sakuzu/maplibre-gl-draw/table` ({@link table | the reference}):
  the parts for reading a large table in a Worker and putting it on the
  map as a dataset.
- `@sakuzu/maplibre-gl-draw/kasane` ({@link kasane | the reference}):
  the parts that hold the features of a layer as rows of columns, for a
  layer of more features than can be made objects at once. It is
  experimental and may change in a minor release.
- `@sakuzu/maplibre-gl-draw/webgl` ({@link webgl | the reference}):
  building blocks for custom shaders. They may change in a minor
  release, as `/kasane` may; everything else follows semantic
  versioning.
