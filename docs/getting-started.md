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
npm install @sakuzu/maplibre-gl-draw
```

The package is ESM only. maplibre-gl is a peer dependency: the library
uses the maplibre-gl your application already has, and npm 7 and later
install it along if it is not there yet. Version
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

Create the map as usual, then pass it to `createDraw`.

```ts
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [139.767, 35.681],
  zoom: 12,
});

const draw = createDraw(map);
```

The instance draws on the map, creates one empty layer for the features,
and starts in `select` mode. It can be created before the map has
finished loading; the drawing appears as soon as the style is ready.

Everything the instance holds is reached through a few names:
`draw.features`, `draw.layers` and `draw.groups` for the document,
`draw.selection` for what the user has selected, and `draw.document` to
save and load the whole of it.

When the page or component that owns the map goes away, call
`draw.destroy()` before `map.remove()`. It removes everything the
instance added to the map.

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
| Double click (with 3 or more vertices) | Finishes the polygon |
| Enter | Finishes the polygon |
| Backspace or Delete | Removes the last vertex |
| Escape | Discards the vertices; a second Escape returns to `select` |

A double click on a new position adds that vertex before it finishes; it
does not zoom the map while drawing.
When the polygon is finished, the mode returns to `select` and the new
polygon is selected, so the user can move it or drag its vertices right
away.

The instance tells you when a feature is created.

```ts
draw.on('feature.created', ({ feature }) => {
  console.log('created', feature.id, feature.type);
});
```

`feature.geometry` is a GeoJSON geometry. For a polygon its
`coordinates` are the rings, `[[[lng, lat], ...]]`, with the first point
repeated at the end. `feature.properties` are GeoJSON properties too:
your attributes, and the few values the library keeps under keys that
start with `maplibre-gl-draw:`.

To keep a toolbar in step with the mode (including the automatic return
to `select`), listen to `mode.changed`.

```ts
draw.on('mode.changed', ({ mode }) => {
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

`feature.created` fires once per feature. To react to every change at
once (creating, moving, editing vertices, deleting, loading), listen to
`document.changed`. It arrives once per transaction and carries
everything that changed together.

```ts
draw.on('document.changed', ({ features, source }) => {
  if (!features) return;
  const { created = [], updated = [], deleted = [] } = features;
  console.log(
    `${created.length} created, ${updated.length} updated,`,
    `${deleted.length} deleted (${source})`,
  );
});
```

Each entry of `updated` holds the `feature` and its `previous` state.
`source` says where the change came from, for example `'local'` for the
user's edits and calls of the API, and `'load'` for a GeoJSON load.
The same event covers layers, groups and the title of the document.

A few rules make the API easy to reason about.

- Methods are synchronous. After `draw.setMode(...)` or
  `draw.features.delete(id)` returns, reading the instance gives the new
  state. Only `draw.document.load` returns a Promise
- `create` and `update` return what they wrote. A wrong argument, such as
  an ID that does not exist, throws a `DrawError`; a write refused
  because the drawing is read-only returns `null` or `false`
- Events fire after the change is complete, so a listener sees the new
  state
- `draw.on` returns a function that unsubscribes

Update your UI from the events, not from the methods you called: the
user changes the drawing too, and the events cover both.

In `examples/basic/main.ts` this is step 4. The
[event reference](reference/events.md) lists every event and its
payload.

## 5. Save and load

`draw.document.toGeoJSON()` returns every feature as a GeoJSON
FeatureCollection. Serialize it and keep it where you like.

```ts
const STORAGE_KEY = 'maplibre-gl-draw:basic';

document.querySelector('#save')?.addEventListener('click', () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(draw.document.toGeoJSON()));
});
```

`draw.document.load` reads it back. It detects the format of what you
give it: GeoJSON, the native format, a JSON string or a `File`.

<!-- docs-check: continue -->

```ts
const saved = localStorage.getItem(STORAGE_KEY);
if (saved !== null) {
  const result = await draw.document.load(JSON.parse(saved));
  console.log(`loaded ${result?.featureIds.length ?? 0} features`);
  for (const { index, reason } of result?.skipped ?? []) {
    console.warn(`feature ${index} was skipped: ${reason}`);
  }
}
```

`load` returns `null` when the drawing is read-only. Loading GeoJSON adds
the features to the ones already there. They go into the active layer,
unless they name a layer that exists (a GeoJSON written by this library
does). A feature that cannot be read (an unknown geometry type, invalid
coordinates) is left out and listed in `skipped`, and the rest are
loaded. All the loaded features arrive in one `document.changed`.

GeoJSON keeps each feature with its properties and style, but not the
layers and groups themselves or their order. To keep those as well, use
the native format: `draw.document.toJSON()` returns the whole document,
and `draw.document.load` reads it back in the same way. Loading the
native format replaces the current document instead of adding to it.
Both formats are specified in the
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
