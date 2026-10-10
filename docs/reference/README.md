# Reference

The reference describes every public symbol of the package. Most of it is
generated from the TSDoc comments of the sources; two documents are
written by hand because they describe data and behavior rather than one
declaration.

- The generated API reference, in `api/` after you build it (see below);
  the page of the main entry opens with a list of the resources of `Draw`
  and the methods each one has
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

- `@sakuzu/maplibre-gl-draw` — the drawing and editing library:
  `createDraw` and the instance it returns (`Draw`, with its
  collections and resources), the options, the document model, the
  events, the errors, the datasets, the Store and the extension contract,
  the functions that write features as GeoJSON without a drawing
  (`featuresToGeoJSON`, `featureToGeoJSON`), and those that read GeoJSON
  or a document of the library without writing it (`parseGeoJSON`,
  `parseNative`)
- `@sakuzu/maplibre-gl-draw/geometry` — geometry that needs no map:
  measure, create circles and buffers, combine and split polygons, test
  and repair shapes. The functions take and return GeoJSON and do not
  depend on maplibre-gl, the DOM or the instance, so they also run in
  Node and in workers
- `@sakuzu/maplibre-gl-draw/table` — the building of a table for a
  dataset from GeoJSON (`tableFromFeatures`, `createTableBuilder`), whose
  rows have one geometry type or several, its preparation
  (`prepareTable`) and the list of its buffers for `postMessage`
  (`transferList`). It depends on neither maplibre-gl nor WebGL nor the
  DOM, so a Worker that reads a file can use it
- `@sakuzu/maplibre-gl-draw/webgl` — building blocks for custom shaders
  (the GLSL snippet and the projection uniforms, the quad shader, the
  blend and billboard helpers, the dash and terrain subdivision rules).
  It may change in a minor release

Import only from these four. Paths inside the package (`dist/...`) are
not public and may change in any release.

## The two layers of the public API

The public symbols fall into two layers.

Layer 1 is the public API, the main entry: what an application needs to
use the library, and what an extension needs to plug in (`Plugin`,
`PluginContext`, `ModeFactory`, `ModeHandler`, `FeatureTypeDefinition`,
`FeatureRenderer` with its `RenderContext`, `OverlayRenderer` and the
providers). It also includes the functions for style rules and the
check for the keys of the library in `properties`. The geometry and
table entries follow the same rules as layer 1.

Layer 2 is the entry `@sakuzu/maplibre-gl-draw/webgl`: building blocks
for people who write their own shaders and want them to draw the way
the library does. Most overlays do not need it, because the context of
a renderer already passes the shared renderers. Prefer an extension
point of layer 1 when one does the job.

The lists are fixed in `src/index.ts` and `src/webgl/index.ts`; whatever
they do not export is internal.

## Versioning

The package follows [semantic versioning](https://semver.org/).

- A major release (`2.x` to `3.0.0`) is needed for any incompatible
  change of layer 1, a change of the stored data format that old data
  cannot be read under, or a higher minimum version of maplibre-gl or
  Node
- A minor release (`2.0.x` to `2.1.0`) carries compatible additions.
  Layer 2 may change incompatibly in a minor release; if you build an
  extension on it, declare the minors you tested (`~2.0.0`)
- A patch release (`2.0.0` to `2.0.1`) carries fixes only

Every change you can notice, in either layer, is recorded in
[CHANGELOG.md](../../CHANGELOG.md), and each release has a GitHub
release with the same notes.

The supported versions of maplibre-gl and Node, and how they move, are
in [releasing](../internals/releasing.md).

## Building the API reference

The generated reference is part of the documentation site, under
[API reference](../api/index.md). It is not committed. To build it from a
clone of the repository and read it with the rest of the site, whose
examples take the standard UI from its build:

```sh
npm install
npm run build && npm run ui:build
npm run site:dev   # then open http://localhost:5173/maplibre-gl-draw/
```

`npm run docs:api` runs typedoc on the four entry points and writes
Markdown to `docs/api/`, sorted by task: the categories come from the
section comments of the entry files (`src/index.ts`,
`src/geometry/index.ts`, `src/table/index.ts` and `src/webgl/index.ts`),
and the groups of the members of `Draw` from the section comments of
its declaration in `src/api/draw.ts` (`scripts/typedoc-categories.mjs`).
A symbol outside any section fails the build. The page of each entry
point opens with what it is for, when to use it, a short example and
what to read next. Each page shows the declaration, its description, the
default values of options, and examples where they help.
