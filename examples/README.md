# Examples

Small pages, each showing one part of the library. Every example is
an `index.html` and a `main.ts` of about a hundred lines, with a comment
at the top saying what it shows. The guides quote their code from here.

The first two lay the standard UI (`@sakuzu/maplibre-gl-draw-ui`, in
[ui/](../ui/)) over the map, and their code holds only the calls of their
topic and the placing of the UI. The other ten have buttons of their own.

| Example | What it shows | Guide |
| --- | --- | --- |
| [get-started](get-started/) | Drawing, selecting and changing a feature in the panel on the right, the change events | [Getting started](../docs/getting-started.md) |
| [style-features](style-features/) | The style of each feature, the defaults of a type, a style set from code and in the panel | [Styles](../docs/guides/styles.md) |
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
| [read-only-viewer](read-only-viewer/) | A drawing loaded and made read-only, its attributes in the inspector, the standard UI without the toolbar | [Read-only](../docs/guides/read-only.md) |
| [plugins](plugins/) | A plugin with a mode, an event and an api, its tool on the toolbar and a section of the inspector | [Plugins](../docs/guides/plugins.md) |
| [custom-feature-types](custom-feature-types/) | A feature type with its own renderer, hit test, box selection and style keys, and a section of the inspector for them | [Custom types](../docs/guides/custom-types.md) |
| [custom-ui](custom-ui/) | A toolbar and a panel of your own on the public API, without the standard UI | [Drawing and editing](../docs/guides/drawing.md) |

## Running them

From the root of the repository:

```sh
npm install
npm run dev
```

The list of the examples opens at <http://localhost:3200>. The examples
import `@sakuzu/maplibre-gl-draw` from the sources in `src/`, so a change
to the library shows on reload without a build.

The standard UI is taken from its build in `ui/dist/`, the files that
users install, so it is built first, and again after a change to it:

```sh
npm run build      # core, which the UI is built against
npm run ui:build   # ui/dist
```

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
  the standard UI (`npm run dev:playground`, on port 3300)
- [bench/](../bench/) has the performance measurements for contributors
  (`npm run dev:bench`)
