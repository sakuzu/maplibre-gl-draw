# @sakuzu/maplibre-gl-draw

A library for drawing and editing shapes on a [MapLibre GL JS][maplibre]
map. It draws with its own WebGL2 renderer, so a drawing of 200,000
features stays editable, and it draws on 3D terrain and on the globe as
it does on a flat map.

[Demos][demo] | [Documentation](docs/README.md) | [API reference][api] |
[日本語](README.ja.md)

![The playground over central Tokyo: overlapping translucent circles, lines from thin to thick, dashed and dotted lines, areas with a solid, a dashed and a dotted outline, a polygon with a hole selected with its frame and vertex handles, a multipolygon, circle, square, triangle and star markers, a freehand loop around an image, a faded layer, parcels colored by a categorical rule, a fine hexagon grid colored by a graduated rule, the Layers tab listing the layers, the groups and the hexagon dataset (the Legend tab beside it lists both rules), and the inspector of the selected polygon](docs/images/overview.jpg)

## Features

### Drawing

Draw points, lines, polygons, circles and freehand lines with the mouse,
touch, a pen or the keyboard. An image you provide can be placed on the
map ([drawing](docs/guides/drawing.md)).

### Selecting and transforming

Select features one by one with a click, or several at once with a box,
then move, resize and rotate them.

### Editing vertices

Add, delete and move vertices. Features made of several parts, such as a
MultiPolygon, and the holes of a polygon are edited the same way.

### Snapping

While drawing, the point under the pointer snaps to nearby vertices,
edges, the intersections of edges, and angle guides such as horizontal
and vertical. To draw a neighboring parcel, click two points on an
existing boundary and the vertices along that boundary are inserted
between them ([snapping and geometry](docs/guides/snapping-geometry.md)).

### Geometry operations

Combine selected polygons with union, subtract and intersect, split them
with a line, and buffer them by a distance. Distance, length and area can
be computed too. These computations are plain functions that do not need
the map, collected in `@sakuzu/maplibre-gl-draw/geometry`, and give the
same results outside the browser (Node, Bun).

### Styles

Set colors, opacity, line widths, dashed and dotted lines, and point
shapes. A style rule colors features by the value of a property they
carry, such as land use or population ([styles](docs/guides/styles.md)).

### Layers and groups

Group features in layers and groups. Layers can be reordered, hidden,
locked and faded. MapLibre's own layers, such as the roads and buildings
of the basemap, can be placed between the layers of the drawing
([layers](docs/guides/layers.md)).

### Tilted maps, the globe and 3D terrain

Drawing works as on a flat map when the map is tilted or rotated, shown
as a globe, or has 3D terrain enabled. Features can cross the
antimeridian ([terrain](docs/guides/terrain.md)).

The drawing of the first picture, seen with the map tilted and turned.

![The drawing of the first picture seen with the map tilted and rotated so that north is not at the top](docs/images/tilted.jpg)

On the globe, great-circle routes and areas crossing the antimeridian
can be drawn.

![The earth as a sphere: great-circle routes between continents, a box between two meridians and two parallels, a circle around Tokyo, an image and city markers](docs/images/globe.jpg)

On 3D terrain, features follow the slopes and a ridge hides what is
behind it.

![Mountains above Innsbruck in 3D: a translucent area and a gridded image draped over the slopes, a trail zigzagging up to a star on the summit, and a straight dashed line crossing the valley and disappearing over a ridge](docs/images/terrain.jpg)

### Many features

A drawing of 200,000 features stays editable. Every one of the 208,073
features in the next picture can be edited
([performance](docs/guides/performance.md)).

![A made-up city seen from a tilted camera: small houses, streets, parks and place markers, all editable features, reaching far into the distance, with a park in the foreground selected](docs/images/large-data.jpg)

### Datasets

Large data such as tens of thousands of parcels or a million points is
shown fast, in exchange for not being editable. Pass it all at once, or
fetch from a server only what is in view each time the map moves. A
table from GeoParquet or Arrow is passed as columns, even when its rows
mix points, lines and polygons, so no time goes into converting every
row. It can be read in a Worker, so the page does not stop while a
large file opens. It is styled by the same style rules as drawn
features, and a click reads its properties
([large data](docs/guides/large-data.md)).

### Save and load

Write the document in the native format to keep layers, groups, styles
and images, and load it to get the same state back. Write it as GeoJSON
to exchange features with other tools: a feature holds a GeoJSON
geometry and GeoJSON properties, so the file has the shape of the
features you read in code. Features kept outside a drawing are written
with the same rules by `featuresToGeoJSON`.
Every change arrives as one event per transaction, with where it came
from, and the store that holds the document can be replaced
([save and load](docs/guides/save-load.md)).

### Read-only

A read-only mode and an interaction lock make pages that only show a
drawing ([read-only](docs/guides/read-only.md)).

### Extending

Add plugins, modes of your own, feature types with their own drawing,
overlays, and providers of snapping candidates and handles. Every kind
is added the same way and removed with the function that adding
returns ([plugins](docs/guides/plugins.md),
[custom types](docs/guides/custom-types.md)).

## Demos

Try them in the browser, with nothing to install.

- [Playground][demo]
  - Every feature in one editor, with the standard UI
- [Examples][examples]
  - Twenty examples, each on a page that runs it beside its code

Among the examples:

- [Get started][ex-get-started]
  - Drawing, selecting and changing features in the panel
- [Save and load][ex-save-and-load]
  - GeoJSON and the native format, files dropped on the map, the
    features a load leaves out
- [Style rules and legend][ex-style-rules-and-legend]
  - The four kinds of style rule that color features by a property, with
    a legend
- [Snapping and tracing][ex-snapping-and-tracing] and
  [geometry operations][ex-geometry-operations]
  - Snapping, tracing a boundary, union, intersection, difference, split
    and buffer
- [Terrain][ex-terrain]
  - Drawing and editing on 3D terrain
- [Read-only viewer][ex-read-only-viewer]
  - A drawing to look at: read-only, the interaction lock, the attributes
    of the feature clicked
- [Plugins][ex-plugins]
  - A plugin with a mode of its own, and its tool in the standard UI
- [Custom feature types][ex-custom-feature-types]
  - A kind of feature with its own drawing, hit test and box selection
- [Datasets][ex-datasets]
  - The buildings and places of central Tokyo from Overture Maps, under
    and over the drawing, with places fetched for the part in view
- [Columnar data in a Worker][ex-columnar-data-in-a-worker]
  - The same buildings read from GeoParquet in a Worker and drawn from
    their columns
- [Build your own UI][ex-custom-ui]
  - A toolbar and a panel of your own, without the standard UI

## Installation

```sh
npm install @sakuzu/maplibre-gl-draw
```

maplibre-gl is a peer dependency: the library uses the maplibre-gl
(`~6.11.1`) your application already has. If it is not installed yet,
npm 7 and later install it along.

## Usage

```ts
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { createDraw } from '@sakuzu/maplibre-gl-draw';

// maplibre-gl v6 needs its worker URL once per page (Vite shown here)
maplibregl.setWorkerUrl(workerUrl);

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [139.767, 35.681],
  zoom: 12,
});

const draw = createDraw(map);

// Your own button starts drawing. Click to add vertices; click the first
// vertex or press Enter to finish
document.querySelector('#polygon')?.addEventListener('click', () => {
  draw.setMode('draw_polygon');
});

draw.on('feature.created', ({ feature }) => {
  console.log(feature.id, feature.type, feature.geometry);
});

// Every feature as a GeoJSON FeatureCollection
document.querySelector('#save')?.addEventListener('click', () => {
  console.log(JSON.stringify(draw.document.toGeoJSON()));
});
```

[Getting started](docs/getting-started.md) builds this page step by
step, and the [Get started][ex-get-started] example lays the standard UI
over the map in place of your own buttons.

## Entry points

Import from the main entry unless you need one of the others.

- `@sakuzu/maplibre-gl-draw`: the draw instance (`createDraw`), its
  features, layers, groups and datasets, the events, the options and the
  extension contract
- `@sakuzu/maplibre-gl-draw/geometry`: geometry that needs no map:
  measure lengths and areas, build circles and buffers, combine and split
  polygons. It also runs in Node and in Workers
- `@sakuzu/maplibre-gl-draw/table`: read a large table in a Worker and
  pass it to a dataset
- `@sakuzu/maplibre-gl-draw/webgl`: the building blocks for writing your
  own shaders. It may change in a minor release; the other three follow
  semantic versioning

## Compatibility

- maplibre-gl `~6.11.1` and WebGL2 are required.
- ES modules only, with TypeScript types. No framework is required
  ([frameworks](docs/guides/frameworks.md)).

## Limitations

- Features are drawn by this library's renderer inside a MapLibre GL JS
  [custom layer][custom-layer]. They are not layers of the MapLibre style,
  so MapLibre's `queryRenderedFeatures` and style expressions do not see
  them. To look up features or change their colors, use this library's API
  and events.
- Longitudes are handled in [-180, 180].
- Geometry operations are not available near the antimeridian or the
  poles.

## Documentation

[docs/README.md](docs/README.md) lists every document in reading order:
getting started, the guides, the reference and the internals. Moving from
1.0, mapbox-gl-draw or terra-draw? See [migrating](docs/guides/migrating.md).
The page of the main entry in the [API reference][api] opens with a list
of the resources of the instance and the methods each one has.

## Contributing

Development is described in [CONTRIBUTING.md](CONTRIBUTING.md). Pull
requests are welcome under the contributor license agreement in
[CLA.md](CLA.md); you keep the copyright in your contribution.

## License

Copyright (C) 2026 SAKAIDA Atsushi.

Licensed under the GNU Affero General Public License version 3
(`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full text.

If the AGPL does not fit your product, a commercial license is available
from Kasika, Inc. (可視化技研株式会社): <https://www.kasika.xyz/>.

The notices of the third-party code this package contains are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

[maplibre]: https://maplibre.org/maplibre-gl-js/docs/
[custom-layer]: https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/
[demo]: https://sakuzu.github.io/maplibre-gl-draw/playground/
[api]: https://sakuzu.github.io/maplibre-gl-draw/api/
[examples]: https://sakuzu.github.io/maplibre-gl-draw/examples/
[ex-get-started]: https://sakuzu.github.io/maplibre-gl-draw/examples/get-started.html
[ex-save-and-load]: https://sakuzu.github.io/maplibre-gl-draw/examples/save-and-load.html
[ex-style-rules-and-legend]: https://sakuzu.github.io/maplibre-gl-draw/examples/style-rules-and-legend.html
[ex-snapping-and-tracing]: https://sakuzu.github.io/maplibre-gl-draw/examples/snapping-and-tracing.html
[ex-geometry-operations]: https://sakuzu.github.io/maplibre-gl-draw/examples/geometry-operations.html
[ex-terrain]: https://sakuzu.github.io/maplibre-gl-draw/examples/terrain.html
[ex-read-only-viewer]: https://sakuzu.github.io/maplibre-gl-draw/examples/read-only-viewer.html
[ex-plugins]: https://sakuzu.github.io/maplibre-gl-draw/examples/plugins.html
[ex-custom-feature-types]: https://sakuzu.github.io/maplibre-gl-draw/examples/custom-feature-types.html
[ex-datasets]: https://sakuzu.github.io/maplibre-gl-draw/examples/datasets.html
[ex-columnar-data-in-a-worker]: https://sakuzu.github.io/maplibre-gl-draw/examples/columnar-data-in-a-worker.html
[ex-custom-ui]: https://sakuzu.github.io/maplibre-gl-draw/examples/custom-ui.html
