# Documentation

Read the documents in this order. Getting started and the guides are for
people who use the library in an application; they also have a Japanese
version (`*.ja.md`), and the English version is authoritative. The
reference and the internals are in English only.

## Getting started

- [getting-started.md](getting-started.md) — install the package, draw a
  polygon, listen to changes, and save and load the drawing
- [examples/index.md](examples/index.md) — the gallery of the examples,
  each a page that runs it beside its code, and the playground
- [../examples/README.md](../examples/README.md) — the code of the
  examples, and how to run them on your machine

## Guides

Each guide covers one task. Read the ones you need, in any order.

- [guides/drawing.md](guides/drawing.md) — the drawing modes, selection,
  moving, resizing, rotating, vertex editing, keyboard and touch
- [guides/layers.md](guides/layers.md) — layers, groups, the active layer,
  locking, draw order, and placing native layers between them
- [guides/save-load.md](guides/save-load.md) — GeoJSON and the native
  format, images, and connecting your own storage
- [guides/styles.md](guides/styles.md) — feature styles, style rules,
  legends and messages
- [guides/snapping-geometry.md](guides/snapping-geometry.md) — snapping,
  tracing, shared vertices, geometry operations and the geometry subpath
- [guides/terrain.md](guides/terrain.md) — what changes when the map has
  terrain
- [guides/read-only.md](guides/read-only.md) — read-only mode, the
  interaction lock and hiding on one client
- [guides/large-data.md](guides/large-data.md) — datasets: data drawn
  beside the document and not edited, from rows, tables or a server
- [guides/plugins.md](guides/plugins.md) — extensions: writing a plugin
  and a mode of your own
- [guides/custom-types.md](guides/custom-types.md) — adding a feature type
  with its own drawing and hit testing, overlays and providers
- [guides/frameworks.md](guides/frameworks.md) — using the library with
  React, Svelte and Vue, and with server-side rendering
- [guides/performance.md](guides/performance.md) — the rough scale the
  library handles and how to measure your case
- [guides/migrating.md](guides/migrating.md) — moving from 1.0 to 2.0,
  and from mapbox-gl-draw or terra-draw

## Reference

- [API reference](https://sakuzu.github.io/maplibre-gl-draw/api/) — the
  generated reference of every public symbol, published on the
  [documentation site](https://sakuzu.github.io/maplibre-gl-draw/) with
  the guides and the examples
- [reference/README.md](reference/README.md) — the four entry points,
  the two layers of the public API, the versioning guarantee, and how to
  build the generated API reference
- [reference/data-format.md](reference/data-format.md) — the native format
  and GeoJSON, per feature type
- [reference/events.md](reference/events.md) — every event and its payload

## Internals

For people who work on the library itself. They explain how it is built
and may describe types that are not public.

Start with the architecture; the others go deeper into one part each.

- [internals/README.md](internals/README.md) — the reading order of the
  documents below
- [internals/architecture.md](internals/architecture.md) — the layers of
  the code, the store as the source of truth, input, modes and plugins
- [internals/rendering.md](internals/rendering.md) — the WebGL2 pipeline,
  the renderers, retained batches, terrain and display order
- [internals/hit-testing.md](internals/hit-testing.md) — the two-stage
  hit test and the order in which hits are decided
- [internals/coordinate-precision.md](internals/coordinate-precision.md)
  — offset coordinates, globe and the antimeridian
- [internals/maplibre-coupling.md](internals/maplibre-coupling.md) — every
  reliance on maplibre-gl internals and what to check when upgrading
- [internals/test-design.md](internals/test-design.md) — what each group
  of tests protects
- [internals/releasing.md](internals/releasing.md) — versions, supported
  maplibre-gl and Node, and the release steps

The rules for changing the library are in
[../CONTRIBUTING.md](../CONTRIBUTING.md).
