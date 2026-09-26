# @sakuzu/maplibre-gl-draw API reference

A library for drawing and editing shapes on a
[MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) map. It
draws with its own WebGL2 renderer, so a drawing of 200,000 features
stays editable, and it draws on 3D terrain and on the globe as it does
on a flat map. Large data that is shown but not edited goes into a
dataset, which draws tens of thousands of parcels or a million points
fast.

This is the reference of every public symbol, generated from the
sources. To learn how to use the library, start with the guides.

- [Playground](https://sakuzu.github.io/maplibre-gl-draw/): every
  feature in one editor
- [Examples](https://sakuzu.github.io/maplibre-gl-draw/examples/): small
  pages, one part of the library each
- [Getting started](https://github.com/sakuzu/maplibre-gl-draw/blob/main/docs/getting-started.md)
  and the
  [guides](https://github.com/sakuzu/maplibre-gl-draw/blob/main/docs/README.md)
- [Source on GitHub](https://github.com/sakuzu/maplibre-gl-draw)

## Modules

The package has three entry points, one module each.

- {@link index} (`@sakuzu/maplibre-gl-draw`): the factory, the instance
  and its options, the data model, the events, datasets and the
  extension points
- {@link geometry} (`@sakuzu/maplibre-gl-draw/geometry`): pure geometry
  functions that need no map, so they also run in Node and in workers
- {@link columnar} (`@sakuzu/maplibre-gl-draw/columnar`): the
  preparation of a columnar table for a dataset, importable in a Worker
