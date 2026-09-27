# API reference

The reference of every public symbol of `@sakuzu/maplibre-gl-draw`,
generated from the sources. To learn how to use the library, start with
[Getting started](getting-started.md) and the guides.

## Where to start

- To put a drawing on a map, start from
  {@link maplibre-gl-draw!createDraw | createDraw}
  and its {@link maplibre-gl-draw!DrawOptions | DrawOptions}.
- To add, change and remove features, layers and groups, use the
  collections of the instance, {@link maplibre-gl-draw!Draw | Draw}. Its
  page is grouped by task.
- A {@link maplibre-gl-draw!Feature | Feature},
  a {@link maplibre-gl-draw!Layer | Layer} and
  a {@link maplibre-gl-draw!Group | Group} are the data model.
- To react to changes and clicks, see the events of
  {@link maplibre-gl-draw!DrawEvents | DrawEvents}.
- To style features, see
  {@link maplibre-gl-draw!FeatureStyle | FeatureStyle} and
  {@link maplibre-gl-draw!StyleRule | StyleRule}.
- To show large data that is not edited, see
  {@link maplibre-gl-draw!Dataset | Dataset} and
  {@link maplibre-gl-draw!DatasetOptions | DatasetOptions}.
- To save and load, see
  {@link maplibre-gl-draw!DrawDocument | DrawDocument} and
  {@link maplibre-gl-draw!LoadOptions | LoadOptions}.
- To add a plugin, a mode or a feature type, see
  {@link maplibre-gl-draw!Plugin | Plugin},
  {@link maplibre-gl-draw!ModeHandler | ModeHandler} and
  {@link maplibre-gl-draw!FeatureTypeDefinition | FeatureTypeDefinition}.

## Entry points

The package has four entry points. Import from the first one unless
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
- `@sakuzu/maplibre-gl-draw/webgl` ({@link webgl | the reference}):
  building blocks for custom shaders. They may change in a minor
  release; everything else follows semantic versioning.
