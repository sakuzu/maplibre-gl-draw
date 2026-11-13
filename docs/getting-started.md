# Getting started

This page builds a small map on which the user draws polygons, and whose
drawing is saved in the browser and restored on the next visit. It takes
about ten minutes. You should know how to create a map with maplibre-gl;
nothing about this library is assumed. A Japanese version is
[getting-started.ja.md](getting-started.ja.md).

The code of every step is on this page, and together the steps make
the complete page. The [Get started](examples/get-started.md) example is
the same page with the standard UI over the map in place of your own
buttons, running in the browser with its code.

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

The examples of the repository share this setting in
`examples/maplibre-setup.ts`.

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

## 3. Draw a polygon

Drawing is a mode. The library has no toolbar, so connect your own button
to `setMode`.

```ts
document.querySelector('#draw-polygon')?.addEventListener('click', () => {
  draw.setMode('drawPolygon');
});
```

In `drawPolygon` mode the user draws like this.

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

The instance tells you when a feature is created: `change` lists the IDs
of what a change created, and `draw.features.get` reads each feature.

```ts
draw.on('change', ({ features }) => {
  for (const id of features.created) {
    const feature = draw.features.get(id);
    console.log('created', id, feature?.geometry.type);
  }
});
```

A feature is a GeoJSON Feature, `{ type: 'Feature', id, geometry,
properties }`. For a polygon the `coordinates` of its geometry are the
rings, `[[[lng, lat], ...]]`, with the first point repeated at the end.
`feature.properties` holds your attributes, and the few values the
library keeps (its layer, group, style, and whether it is visible and
locked) under keys that start with `maplibre-gl-draw:`. A key whose value
is the default is left out; `readFeature(feature)` reads those values
under short names with the defaults filled in.

To keep a toolbar in step with the mode (including the automatic return
to `select`), subscribe to `draw.mode`. A value that changes over time,
such as the mode or the selection, is not an event: `subscribe` calls the
function with the value now at once, and again each time it changes.

```ts
draw.mode.subscribe((mode) => {
  document
    .querySelector('#draw-polygon')
    ?.classList.toggle('active', mode === 'drawPolygon');
});
```

`drawPoint`, `drawLine`, `drawCircle` and `drawFreehand` are used
the same way; `drawImage` also asks your application for the image. The
[drawing guide](guides/drawing.md) has the actions of every mode.

## 4. Subscribe to changes

`change` covers every change (creating, moving, editing vertices,
deleting, opening a document). It arrives once per commit, however many
features it changed, and lists the IDs of everything that changed
together.

```ts
draw.on('change', ({ features, source }) => {
  const { created, updated, deleted } = features;
  console.log(
    `${created.length} created, ${updated.length} updated,`,
    `${deleted.length} deleted (${source})`,
  );
});
```

`draw.features.get(id)` reads a feature as it is now, and
`change.previous(id)`, in the listener, a feature updated or deleted as it
was before. `source` says where the change came from, for example
`'local'` for the user's edits and the writes of your code, `'undo'` and
`'redo'` for `draw.undo()` and `draw.redo()`, and `'open'` for a document
opened. The same event covers layers and groups (`layers` and `groups`),
and the title of the document (`document`).

A few rules make the API easy to reason about.

- Reads are synchronous: `draw.features.get(id)` and the other reads of
  `draw` return at once. So do the changes of this client alone, such as
  `draw.setMode(...)` and the selection
- The document is written in one place, `draw.write`. Its function is
  given a transaction, `tx`, which holds the writes; when the function
  ends they are committed at once, as one `change` and one step of undo.
  The promise settles once the commit is made, so a read after `await`
  gives the new state, and a read before it the state before
- A write that fails rejects with a `DrawError`: a wrong argument, such as
  an ID that does not exist (`notFound`), or a write the state refuses,
  such as one while the drawing is read-only (`notEditable`) or of a
  locked feature (`locked`). Nothing of the transaction is committed then
- Events fire after the commit is made, so a listener sees the new state
- `draw.on` returns a function that unsubscribes

<!-- docs-check: continue -->

```ts
// One transaction: both writes are one change and one step of undo
const [first, second] = draw.selection.value.ids ?? [];
if (first !== undefined && second !== undefined) {
  await draw.write(async (tx) => {
    await tx.features.update(first, {
      properties: { 'maplibre-gl-draw:style': { fillColor: '#e74c3c' } },
    });
    await tx.features.delete(second);
  });
}
// Takes it back
await draw.undo();
```

Update your UI from the events, not from the methods you called: the
user changes the drawing too, and the events cover both.

The [event reference](reference/events.md) lists every event and its
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

`draw.open` reads it back in place of the document. It detects the
format of what you give it: GeoJSON, the native format, a JSON string or
a `File`.

<!-- docs-check: continue -->

```ts
const saved = localStorage.getItem(STORAGE_KEY);
if (saved !== null) {
  const result = await draw.open(saved);
  console.log(`opened ${result.features} features`);
  for (const { index, error } of result.skipped) {
    console.warn(`feature ${index} was skipped: ${error.message}`);
  }
}
```

`open` rejects with a `DrawError` (`notEditable`) when the drawing is
read-only. Opening GeoJSON replaces the features and the groups and keeps
the layers. A feature goes into the layer it names in
`maplibre-gl-draw:layerId` when that layer exists (a GeoJSON written by
this library names it), and into the active layer otherwise. A feature
that cannot be read (an unknown geometry type, invalid coordinates) is
left out and listed in `skipped`, and the rest are read. The document
opened arrives in one `change` with the source `'open'`, and the steps of
undo are dropped. To add a file to the features already there, give it
to `tx.import` in a `draw.write`.

GeoJSON keeps each feature with its properties and style, but not the
layers and groups themselves or their order. To keep those as well, use
the native format: `draw.document.toJSON()` returns the whole document,
and `draw.open` reads it back in the same way, replacing everything.
Both formats are specified in the
[data format reference](reference/data-format.md).

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
[playground](https://sakuzu.github.io/maplibre-gl-draw/playground/) or
the [examples](https://sakuzu.github.io/maplibre-gl-draw/examples/); the
[API reference](https://sakuzu.github.io/maplibre-gl-draw/api/) is
published next to them.
