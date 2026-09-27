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

The package has four entry points.

- `@sakuzu/maplibre-gl-draw` — the drawing and editing library: the
  factory `createMapLibreGLDraw`, the instance, its options, the data
  model, the events and the extension points
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
- `@sakuzu/maplibre-gl-draw/webgl` — building blocks for custom shaders
  (the GLSL snippet and the projection uniforms, the quad shader, the
  blend and billboard helpers, the dash and terrain subdivision rules).
  It may change in a minor release

Import only from these four. Paths inside the package (`dist/...`) are
not public and may change in any release.

## The two layers of the public API

The public symbols fall into two layers.

Layer 1 is the public API, the main entry: what an application needs to
use the library, and what an extension needs to plug into an extension
point (`Plugin`, `PluginContext`, `ModeHandler`, `CustomFeatureHandler`,
the snapping provider, the hit test strategy and so on). It also
includes the pure functions for style rules and property access. The
geometry and columnar entries follow the same rules as layer 1.

Layer 2 is the entry `@sakuzu/maplibre-gl-draw/webgl`: building blocks
for people who write their own shaders and want them to draw the way
the library does. Most overlays do not need it, because the context of
a renderer already passes the shared renderers. Prefer an extension
point of layer 1 when one does the job.

The lists are fixed in `src/index.ts` and `src/webgl/index.ts`; whatever
they do not export is internal.

## Versioning

The package follows [semantic versioning](https://semver.org/).

- A major release (`1.x` to `2.0.0`) is needed for any incompatible
  change of layer 1, a change of the stored data format that old data
  cannot be read under, or a higher minimum version of maplibre-gl or
  Node
- A minor release (`1.0.x` to `1.1.0`) carries compatible additions.
  Layer 2 may change incompatibly in a minor release; if you build an
  extension on it, declare the minors you tested (`~1.0.0`)
- A patch release (`1.0.0` to `1.0.1`) carries fixes only

Every change you can notice, in either layer, is recorded in
[CHANGELOG.md](../../CHANGELOG.md), and each release has a GitHub
release with the same notes.

The supported versions of maplibre-gl and Node, and how they move, are
in [releasing](../internals/releasing.md).

## Building the API reference

The generated reference is part of the documentation site, under
[API reference](../api/index.md). It is not committed. To build it from a
clone of the repository and read it with the rest of the site:

```sh
npm install
npm run site:dev
```

`npm run docs:api` runs typedoc on the three entry points and writes
Markdown to `docs/api/`, sorted by task: the categories come from the
section comments of `src/index.ts` and `src/geometry/index.ts`, and the
groups of `MapLibreGLDraw` from the section comments of its declaration
(`scripts/typedoc-categories.mjs`). A symbol outside any section fails
the build. Each page shows the declaration, its description, the default
values of options, and examples where they help.
