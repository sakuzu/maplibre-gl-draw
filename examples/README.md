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
| [feature-properties](feature-properties/) | Attributes loaded from GeoJSON, changed in the Attributes tab and with `features.update` | [Data format](../docs/reference/data-format.md) |
| [layers-and-groups](layers-and-groups/) | Two layers and a group made from code, the order, the active layer, visibility, locks and opacity in the layer panel | [Layers and groups](../docs/guides/layers.md) |
| [style-rules-and-legend](style-rules-and-legend/) | The four kinds of style rule on a layer and the Legend tab | [Styles](../docs/guides/styles.md) |
| [snapping-and-tracing](snapping-and-tracing/) | The snapping options, the guide lines, tracing a boundary, the snapping switch of the toolbar | [Snapping and geometry](../docs/guides/snapping-geometry.md) |
| [geometry-operations](geometry-operations/) | Union, intersection, difference, split and buffer from the panel, length and area | [Snapping and geometry](../docs/guides/snapping-geometry.md) |
| [images](images/) | The Image tool, `image.requested`, an image placed from code and its opacity | [Drawing and editing](../docs/guides/drawing.md#images) |
| [basic](basic/) | Drawing polygons, the change events, saving and restoring | [Getting started](../docs/getting-started.md) |
| [save-load](save-load/) | GeoJSON and the native format, files and drops on the map, skipped features | [Save and load](../docs/guides/save-load.md) |
| [style-rules](style-rules/) | Default styles, the four kinds of style rule, a legend | [Styles](../docs/guides/styles.md) |
| [snapping-and-geometry](snapping-and-geometry/) | Snapping, tracing, shared vertices, union, subtract, buffer, split | [Snapping and geometry](../docs/guides/snapping-geometry.md) |
| [terrain](terrain/) | Drawing and editing on the 3D terrain of the map, with the standard UI | [Terrain](../docs/guides/terrain.md) |
| [read-only](read-only/) | Read-only, the interaction lock, locked layers, local hiding | [Read-only](../docs/guides/read-only.md) |
| [plugin](plugin/) | A plugin with an event, an api and a mode of its own | [Plugins](../docs/guides/plugins.md) |
| [custom-feature-type](custom-feature-type/) | A feature type with its own renderer, hit test and box selection | [Custom types](../docs/guides/custom-types.md) |
| [large-data](large-data/) | Datasets, static and fetched for the view | [Large data](../docs/guides/large-data.md) |
| [table-worker](table-worker/) | A table of typed arrays read in a Worker and drawn from its columns | [Large data](../docs/guides/large-data.md) |
| [save-and-load](save-and-load/) | GeoJSON and the native format, keys to save and load, files dropped on the map, skipped features | [Save and load](../docs/guides/save-load.md) |
| [globe](globe/) | The globe projection, a great circle, an area across the antimeridian | [Drawing](../docs/guides/drawing.md#near-the-antimeridian) |
| [200000-features](200000-features/) | 200,000 editable features loaded in one transaction | [Performance](../docs/guides/performance.md) |
| [datasets](datasets/) | Datasets given at once and fetched for the view, clicks on their rows | [Large data](../docs/guides/large-data.md) |
| [columnar-data-in-a-worker](columnar-data-in-a-worker/) | A table read in a Worker and handed to a dataset as columns | [Large data](../docs/guides/large-data.md) |

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
  layer and property panels (`npm run dev:playground`)
- [bench/](../bench/) has the performance measurements for contributors
  (`npm run dev:bench`)
