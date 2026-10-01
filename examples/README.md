# Examples

Pages that each show one part of the library. Every example lays the
standard UI (`@sakuzu/maplibre-gl-draw-ui`, in [ui/](../ui/)) over the
map: a layer panel on the left, the panel of the selected feature on the
right and a toolbar at the bottom. Its code holds only the calls of its
topic and the placing of the UI. The last one, custom-ui, builds a
toolbar and a panel of its own on the public API instead, for an
application that wants its own UI.

Each example is an `index.html` and a `main.ts`, with a comment at the
top saying what it shows. The documentation site shows each one live on
a page of its own, beside its code: the
[gallery](https://sakuzu.github.io/maplibre-gl-draw/examples/) lists
them in this order.

| Example | What it shows | Guide |
| --- | --- | --- |
| [get-started](get-started/) | Drawing, selecting and changing a feature in the panel on the right, the change events | [Getting started](../docs/getting-started.md) |
| [style-features](style-features/) | The style of each feature side by side (colors, widths, dashes, point shapes and sizes), the defaults of a type, a style set from code and in the panel | [Styles](../docs/guides/styles.md) |
| [feature-properties](feature-properties/) | Attributes loaded from GeoJSON, changed in the Attributes tab and with `features.update` | [Data format](../docs/reference/data-format.md) |
| [zoom-and-scale](zoom-and-scale/) | Widths at the reference zoom of each feature that grow and shrink with the map, widths fixed on the screen, `scaleWithZoom` switched with a key | [Styles](../docs/guides/styles.md) |
| [editing-shapes](editing-shapes/) | The frame, the vertex and midpoint handles, an area with a hole, a `MultiPolygon`, shared vertices moved together and switched with a key | [Drawing and editing](../docs/guides/drawing.md#selecting-and-editing) |
| [layers-and-groups](layers-and-groups/) | Two layers and a group made from code, the order, the active layer, visibility, locks and opacity in the layer panel | [Layers and groups](../docs/guides/layers.md) |
| [style-rules-and-legend](style-rules-and-legend/) | The four kinds of style rule on a layer and the Legend tab | [Styles](../docs/guides/styles.md) |
| [snapping-and-tracing](snapping-and-tracing/) | The snapping options, the guide lines, tracing a boundary, the snapping switch of the toolbar | [Snapping and geometry](../docs/guides/snapping-geometry.md) |
| [geometry-operations](geometry-operations/) | Union, intersection, difference, split and buffer from the panel, length and area | [Snapping and geometry](../docs/guides/snapping-geometry.md) |
| [images](images/) | The Image tool, `image.requested`, an image placed from code and its opacity | [Drawing and editing](../docs/guides/drawing.md#images) |
| [save-and-load](save-and-load/) | GeoJSON and the native format, keys to save and load, files dropped on the map, skipped features | [Save and load](../docs/guides/save-load.md) |
| [terrain](terrain/) | Drawing and editing on the 3D terrain of the map | [Terrain](../docs/guides/terrain.md) |
| [globe](globe/) | The globe projection, routes along great circles, a box, a circle, an image and cities on the sphere, an area across the antimeridian | [Drawing](../docs/guides/drawing.md#near-the-antimeridian) |
| [200000-features](200000-features/) | 200,000 editable features loaded in one transaction | [Performance](../docs/guides/performance.md) |
| [datasets](datasets/) | 1,000,000 points fetched for the view and thinned, 250,000 cells given at once, the buildings and places of Tokyo, clicks on their rows | [Large data](../docs/guides/large-data.md) |
| [columnar-data-in-a-worker](columnar-data-in-a-worker/) | A table read in a Worker and handed to a dataset as columns, and 1,000,000 points made there on a key | [Large data](../docs/guides/large-data.md) |
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

The examples are served on port 3200, each under its folder:
<http://localhost:3200/get-started/> opens first, and
<http://localhost:3200/terrain/> is the terrain example. They import
`@sakuzu/maplibre-gl-draw` from the sources in `src/`, so a change to the
library shows on reload without a build.

The standard UI is taken from its build in `ui/dist/`, the files that
users install, so it is built first, and again after a change to it:

```sh
npm run build      # core, which the UI is built against
npm run ui:build   # ui/dist
```

To see them as the documentation site shows them, with the gallery, the
pages and the playground, serve the whole site:

```sh
npm run site:dev   # then open http://localhost:5173/maplibre-gl-draw/
```

It runs the dev servers of the examples (port 3200) and of the
playground (port 3300) beside VitePress, and stops all three on Ctrl-C.

## Basemap and elevation data

The examples use public data that needs no key: the
[OpenFreeMap](https://openfreemap.org/) styles for the basemap, and the
MapLibre demo tiles for the elevation of terrain. Both are set in
[basemap.ts](basemap.ts). The address of a page can replace them, for
example `terrain/?style=<style URL>&dem=<TileJSON URL>`; the end-to-end
tests and the pictures of the gallery (`npm run site:thumbnails`) use
this to run every example without the network.

The examples with the standard UI offer four OpenFreeMap styles and a
white sheet (`BASEMAPS` in basemap.ts), each with a preview: the
basemap row, at the bottom of the layer panel, opens them on the right.
The white sheet is a style of one background layer written in
basemap.ts, so it loads nothing. The default is Bright, and
`?basemap=<id>` (`liberty`, `bright`, `positron`, `dark` or `blank`)
opens a page on another one.

## Shared files

- [maplibre-setup.ts](maplibre-setup.ts) sets the worker URL of
  maplibre-gl v6 for Vite, once, before the first map is created
- [basemap.ts](basemap.ts) holds the basemap and the elevation data
- [example.css](example.css) lays out the full-page map

## Adding an example

An example is a folder with an `index.html` and a `main.ts`. Add its
name to `PAGES` in [vite.config.ts](vite.config.ts), its entry (title,
sentence and order, in English and Japanese) to
[docs/examples/catalog.json](../docs/examples/catalog.json), its page
to `docs/examples/` (`<name>.md` and `<name>.ja.md`), and its picture
with `npm run site:thumbnails -- <name>`. The end-to-end tests check that
the examples and the catalog list the same names.

## Other pages

- [playground/](../playground/) has every feature in one editor, with
  the standard UI (`npm run dev:playground`, on port 3300)
- [bench/](../bench/) has the performance measurements for contributors
  (`npm run dev:bench`)
