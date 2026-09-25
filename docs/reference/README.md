# Reference

The reference describes every public symbol of the package. Most of it is
generated from the TSDoc comments of the sources; two documents are
written by hand because they describe data and behavior rather than one
declaration.

- The generated API reference, in `api/` after you build it (see below)
- [data-format.md](data-format.md) — the native format and GeoJSON: the
  coordinates and properties of each feature type, versions and
  validation
- [events.md](events.md) — every event, its payload, when it fires (once
  per feature or once per change) and in which order

To learn how to use the library, start with
[getting started](../getting-started.md) and the [guides](../README.md);
they link here for the details.

## Entry points

The package has three entry points.

- `@sakuzu/maplibre-gl-draw` — the drawing and editing library: the
  factory `createMapLibreGLDraw`, the instance, its options, the data
  model, the events, the extension points and the building blocks
- `@sakuzu/maplibre-gl-draw/geometry` — pure geometry functions (boolean
  operations, buffer, splitting, predicates, measurement). They do not
  depend on maplibre-gl, the DOM or the instance, so they also run in
  Node and in workers
- `@sakuzu/maplibre-gl-draw/columnar` — the preparation of a columnar
  table for a dataset (`prepareDatasetColumnar`), whose rows have one
  geometry type or several, and the list of its buffers for
  `postMessage` (`columnarTransferables`). It
  depends on neither maplibre-gl nor WebGL nor the DOM, so a Worker that
  reads a file can use it

Import only from these three. Paths inside the package (`dist/...`) are
not public and may change in any release.

## The two layers of the public API

The symbols of the main entry fall into two layers.

Layer 1 is the public API: what an application needs to use the library,
and what an extension needs to plug into an extension point (`Plugin`,
`PluginContext`, `ModeHandler`, `CustomFeatureHandler`, the snapping
provider, the hit test strategy and so on). It also includes the pure
functions for style rules and property access. The geometry entry
follows the same rules as layer 1.

Layer 2 is building blocks for extension authors: parts that a plugin, a
custom mode or a custom feature type may reuse to draw and hit test the
same way the library does. These are the WebGL helpers, the renderers,
terrain anchoring, projection and bounding box math, selection helpers,
the types of the services that `ModeContext` and
`CustomRendererDrawContext` hand over, and the types of the diagnostics
(`draw.getTerrainDiagnostics()`), whose fields follow the rendering.
Prefer an extension point of
layer 1 when one does the job, and use the service types only for the
instances a context passes you.

The generated reference marks which layer each symbol belongs to. The
list is fixed in `src/index.ts`; whatever it does not export is internal.

## Versioning

The package follows [semantic versioning](https://semver.org/). While the
version is `0.x`, the rules are these.

- A minor release (`0.1.x` to `0.2.0`) is needed for any incompatible
  change of layer 1, a change of the stored data format that old data
  cannot be read under, or a higher minimum version of maplibre-gl or
  Node
- Layer 2 may change incompatibly in a minor release as well
- A patch release (`0.1.0` to `0.1.1`) carries fixes and compatible
  additions only
- A caret range on `0.x` (`^0.1.0`) accepts patch releases only, so
  moving to the next minor is a deliberate upgrade

Every change you can notice, in either layer, is recorded in
[CHANGELOG.md](../../CHANGELOG.md). From `1.0.0` on, the usual rules
apply: an incompatible change of layer 1 needs a major release, and
layer 2 may still change in a minor release.

The supported versions of maplibre-gl and Node, and how they move, are
in [releasing](../internals/releasing.md).

## Building the API reference

The generated reference is published at
<https://sakuzu.github.io/maplibre-gl-draw/api/>, next to the live demo.
It is not committed. To build it from a clone of the repository:

```sh
npm install
npm run docs:api
```

`npm run docs:api` runs typedoc on both entry points and writes HTML to
`docs/reference/api/`. Open `docs/reference/api/index.html` in a
browser. Each page shows the declaration, its description, the default
values of options, and examples where they help.
