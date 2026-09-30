# Examples

Ten small pages, each showing one part of the library. Every example is
an `index.html` and a `main.ts` of about a hundred lines, with a comment
at the top saying what it shows. The guides quote their code from here.

| Example | What it shows | Guide |
| --- | --- | --- |
| [basic](basic/) | Drawing polygons, the change events, saving and restoring | [Getting started](../docs/getting-started.md) |
| [save-load](save-load/) | GeoJSON and the native format, files and drops on the map, skipped features | [Save and load](../docs/guides/save-load.md) |
| [style-rules](style-rules/) | Default styles, the four kinds of style rule, a legend | [Styles](../docs/guides/styles.md) |
| [snapping-and-geometry](snapping-and-geometry/) | Snapping, tracing, shared vertices, union, subtract, buffer, split | [Snapping and geometry](../docs/guides/snapping-geometry.md) |
| [terrain](terrain/) | Drawing and selecting on the 3D terrain of the map | [Terrain](../docs/guides/terrain.md) |
| [read-only](read-only/) | Read-only, the interaction lock, locked layers, local hiding | [Read-only](../docs/guides/read-only.md) |
| [plugin](plugin/) | A plugin with an event, an api and a mode of its own | [Plugins](../docs/guides/plugins.md) |
| [custom-feature-type](custom-feature-type/) | A feature type with its own renderer, hit test and box selection | [Custom types](../docs/guides/custom-types.md) |
| [large-data](large-data/) | Datasets, static and fetched for the view | [Large data](../docs/guides/large-data.md) |
| [table-worker](table-worker/) | A table of typed arrays read in a Worker and drawn from its columns | [Large data](../docs/guides/large-data.md) |

## Running them

From the root of the repository:

```sh
npm install
npm run dev
```

The list of the examples opens at <http://localhost:3000>. The examples
import `@sakuzu/maplibre-gl-draw` from the sources in `src/`, so a change
to the library shows on reload without a build.

To build them as static pages, which can be served from any directory
(GitHub Pages, for example):

```sh
npm run build -w examples   # writes examples/dist
```

## Basemap and elevation data

The examples use public data that needs no key: the
[OpenFreeMap](https://openfreemap.org/) styles for the basemap, and the
MapLibre demo tiles for the elevation of terrain. Both are set in
[basemap.ts](basemap.ts). The address of a page can replace them, for
example `terrain/?style=<style URL>&dem=<TileJSON URL>`; the end-to-end
tests use this to run every example without the network.

## Shared files

- [maplibre-setup.ts](maplibre-setup.ts) sets the worker URL of
  maplibre-gl v6 for Vite, once, before the first map is created
- [basemap.ts](basemap.ts) holds the basemap and the elevation data
- [example.css](example.css) lays out the map and the bar of buttons
- [public/sample-gis.geojson](public/sample-gis.geojson) is the sample
  data of 02 and 03

## Other pages

- [playground/](../playground/) has every feature in one editor, with
  layer and property panels (`npm run dev:playground`)
- [bench/](../bench/) has the performance measurements for contributors
  (`npm run dev:bench`)
