# Getting started

This page builds a small map on which the user draws polygons, and whose
drawing is saved in the browser and restored on the next visit. It takes
about ten minutes. You should know how to create a map with maplibre-gl;
nothing about this library is assumed. A Japanese version is
[getting-started.ja.md](getting-started.ja.md).

Every step matches a part of [examples/basic/](../examples/basic/),
a complete page you can run. The parts of `examples/basic/main.ts`
are marked with the same step numbers as the headings below.

To run the example, clone the repository and start the examples.

```sh
npm install
npm run dev    # then open the basic page it lists
```

## 1. Install

```sh
npm install @sakuzu/maplibre-gl-draw maplibre-gl
```

The package is ESM only. maplibre-gl is a peer dependency, and version
`~6.11.1` (a patch release of 6.11) is required; 6.12 and later are
supported once their coupling points are checked, and v5 is not
supported. The published code is ES2020, and the browser needs WebGL2:
the browsers that maplibre-gl v6 supports with WebGL2.

maplibre-gl v6 ships its worker as a separate file and finds it relative
to its main module at run time. Bundlers break that lookup: with Vite
the worker fails to load without an error, the style still loads, but no
tiles are requested and the base map stays blank. Set the worker URL
once, before the first map is created. With Vite, it looks like this.

```ts
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);
```

Use `?worker&url`, not plain `?url`. The worker imports a shared chunk of
maplibre-gl, and only `?worker&url` bundles it with the worker in a
production build. With another bundler, pass `setWorkerUrl` the URL at
which your build serves `maplibre-gl-worker.mjs`.

In `examples/basic/main.ts` this is the import of
`../maplibre-setup.ts`, which all the examples share.

## 2. Create the map and draw

The page needs a container for the map and two buttons.

```html
<div id="map"></div>
<button id="draw-polygon">Draw a polygon</button>
<button id="save">Save</button>
```

```css
#map {
  position: absolute;
  inset: 0;
}
```

Create the map as usual, then pass it to `createMapLibreGLDraw`.

```ts
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [139.767, 35.681],
  zoom: 12,
});

const draw = createMapLibreGLDraw(map);
```

The instance adds its custom layer to the map, creates one layer for the
features (the default layer), and starts in `select` mode. It can be
created before the map has finished loading; the drawing appears as soon
as the style is ready.

When the page or component that owns the map goes away, call
`draw.destroy()` before `map.remove()`. It removes the layers and
listeners the instance added.

In `examples/basic/main.ts` this is step 2.

## 3. Draw a polygon

Drawing is a mode. The library has no toolbar, so connect your own button
to `setMode`.

```ts
document.querySelector('#draw-polygon')?.addEventListener('click', () => {
  draw.setMode('draw_polygon');
});
```

In `draw_polygon` mode the user draws like this.

| Action | Result |
| --- | --- |
| Click | Adds a vertex |
| Click the first vertex (with 3 or more vertices) | Finishes the polygon |
| Enter | Finishes the polygon |
| Backspace or Delete | Removes the last vertex |
| Escape | Discards the vertices; a second Escape returns to `select` |

A double click adds two vertices; it does not zoom the map while drawing.
When the polygon is finished, the mode returns to `select` and the new
polygon is selected, so the user can move it or drag its vertices right
away.

The instance tells you when a feature is created.

```ts
draw.on('draw.feature.create', ({ feature }) => {
  console.log('created', feature.id, feature.type);
});
```

`feature` is the library's own record, not a GeoJSON Feature. Its
`coordinates` for a polygon are the rings, `[[[lng, lat], ...]]`, with
the first point repeated at the end.

To keep a toolbar in step with the mode (including the automatic return
to `select`), listen to `draw.mode.change`.

```ts
draw.on('draw.mode.change', ({ mode }) => {
  document
    .querySelector('#draw-polygon')
    ?.classList.toggle('active', mode === 'draw_polygon');
});
```

`draw_point`, `draw_line`, `draw_circle` and `draw_freehand` are used
the same way; `draw_image` also asks your application for the image. The
[drawing guide](guides/drawing.md) has the actions of every mode.

In `examples/basic/main.ts` this is step 3.

## 4. Subscribe to changes

`draw.feature.create` fires once per feature. To react to every change
at once (creating, moving, editing vertices, deleting, loading), listen
to `draw.features.change`. It fires once per change of the data and
carries everything that changed together.

```ts
draw.on('draw.features.change', ({ created, updated, deleted, source }) => {
  console.log(
    `${created.length} created, ${updated.length} updated,`,
    `${deleted.length} deleted (${source})`,
  );
});
```

`updated` holds pairs of `{ feature, previous }`. `source` says where the
change came from, for example `'local'` for the user's edits and
`'batch'` for a GeoJSON load.

A few rules make the API easy to reason about.

- Methods are synchronous. After `draw.setMode(...)` or
  `draw.deleteFeature(id)` returns, reading the instance gives the new
  state. Only `load` returns a Promise
- Events fire after the change is complete, so a handler sees the new
  state
- `draw.on` returns a function that removes the handler

Update your UI from the events, not from the methods you called: the
user changes the data too, and the events cover both.

In `examples/basic/main.ts` this is step 4. The
[event reference](reference/events.md) lists every event and its
payload.

## 5. Save and load

`export('geojson')` returns every feature as a GeoJSON
FeatureCollection, serialized as a string.

```ts
const STORAGE_KEY = 'maplibre-gl-draw:basic';

document.querySelector('#save')?.addEventListener('click', () => {
  const { data } = draw.export('geojson');
  localStorage.setItem(STORAGE_KEY, data);
});
```

The result also carries `mimeType` (`application/geo+json`) and a
suggested `fileName`, for when you offer the data as a download or send
it to a server.

`load` reads it back. It detects the format of what you give it: a
GeoJSON FeatureCollection, the native format, or a `File`.

<!-- docs-check: continue -->

```ts
const saved = localStorage.getItem(STORAGE_KEY);
if (saved !== null) {
  const result = await draw.load(JSON.parse(saved));
  console.log(`loaded ${result.featureIds.length} features`);
  for (const { index, reason } of result.skipped ?? []) {
    console.warn(`feature ${index} was skipped: ${reason}`);
  }
}
```

Loading GeoJSON adds the features to the ones already there. They go
into the active layer, unless they name a layer that exists (a GeoJSON
exported by this library does). A feature that cannot be read (an
unknown geometry type, invalid coordinates) is left out and listed in
`skipped`, and the rest are loaded. All the loaded features arrive in
one `draw.features.change`.

GeoJSON keeps each feature with its properties and style, but not the
layers and groups themselves or their order. To keep those as well, use
the native format, with `draw.export('native')` and `draw.load(...)` in
the same way. Loading the native format replaces the current data
instead of adding to it. Both formats are specified in the
[data format reference](reference/data-format.md).

In `examples/basic/main.ts` this is step 5.

## 6. Next steps

You now have a map on which features are drawn, observed, saved and
restored. From here, read the guide for what you need next.

- [Drawing](guides/drawing.md) for every mode, selection, moving,
  resizing, rotating, vertex editing and the keyboard
- [Layers](guides/layers.md) for organizing features and their draw
  order
- [Save and load](guides/save-load.md) for files, images and connecting
  your own storage
- [Styles](guides/styles.md) for colors and style rules
- [Frameworks](guides/frameworks.md) for React, Svelte and Vue

The [documentation index](README.md) lists all guides, the reference and
the internals.

To try every feature without installing anything, open the
[live demo](https://sakuzu.github.io/maplibre-gl-draw/); the
[API reference](https://sakuzu.github.io/maplibre-gl-draw/api/) is
published next to it.
