# @sakuzu/maplibre-gl-draw-ui

The standard user interface of
[`@sakuzu/maplibre-gl-draw`](https://github.com/sakuzu/maplibre-gl-draw):
a toolbar of the drawing tools at the bottom of the map, with keyboard
shortcuts. It is built with the components of
[kata](https://github.com/sakuzu/kata) and used through a plain
JavaScript API, from any framework or none.

The interface keeps nothing of the drawing. The current tool is
`draw.getMode()`, the selection is `draw.selection.get()`, and every
button calls the public API of the draw instance, so the interface can be
mixed with controls of your own.

The documentation of core, its guides and its API reference, is at
<https://sakuzu.github.io/maplibre-gl-draw/>.

## Install

```sh
npm install @sakuzu/maplibre-gl-draw @sakuzu/maplibre-gl-draw-ui maplibre-gl
```

`@sakuzu/maplibre-gl-draw` (2.x) and `maplibre-gl` are peer
dependencies: the application installs them, and the interface uses the
same copies as the application.

The package is used from any framework or none: React, Vue, Svelte,
another framework, or a plain page. It ships compiled JavaScript, and
the page needs no Svelte of its own. The interface is written in
Svelte, but Svelte is inside the package: its components are compiled
before they are published, the Svelte runtime they use comes as a
dependency of the package, and kata is compiled into it.

The package loads in two ways.

- With a bundler, as ES modules: `dist/index.js` imports `svelte`, core
  and `maplibre-gl`, which the bundler resolves, and
  `@sakuzu/maplibre-gl-draw-ui/style.css` is the style sheet.
- Without a bundler: `dist/maplibre-gl-draw-ui.js` is one module with
  Svelte and kata in it. It loads with `<script type="module">` and an
  import map that names `@sakuzu/maplibre-gl-draw`,
  `@sakuzu/maplibre-gl-draw/geometry` and `maplibre-gl`, together with
  `dist/style.css`.

In every case the interface is created after the draw instance and
destroyed before it: `createDrawUI(draw)` after `createDraw(map)`, and
`ui.destroy()`, then `draw.destroy()`, then `map.remove()`.

### From React

```tsx
import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';

const style = 'https://tiles.openfreemap.org/styles/liberty';

export function DrawMap() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({ container: container.current, style });
    const draw = createDraw(map);
    const ui = createDrawUI(draw);
    return () => {
      ui.destroy();
      draw.destroy();
      map.remove();
    };
  }, []);

  return <div ref={container} style={{ height: 400 }} />;
}
```

The interface lies over the map's container, so the component renders
the container alone. In development, Strict Mode runs the effect twice;
the cleanup destroys the first set, so this is safe.

### From Vue

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createDraw, type Draw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI, type DrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';

const style = 'https://tiles.openfreemap.org/styles/liberty';
const container = ref<HTMLDivElement>();
let map: maplibregl.Map | undefined;
let draw: Draw | undefined;
let ui: DrawUI | undefined;

onMounted(() => {
  map = new maplibregl.Map({ container: container.value!, style });
  draw = createDraw(map);
  ui = createDrawUI(draw);
});

onBeforeUnmount(() => {
  ui?.destroy();
  draw?.destroy();
  map?.remove();
});
</script>

<template>
  <div ref="container" style="height: 400px"></div>
</template>
```

`map`, `draw` and `ui` are plain variables, not `ref`s, which would wrap
them in proxies. The guide to
[using core with a framework](https://sakuzu.github.io/maplibre-gl-draw/guides/frameworks.html)
shows the same patterns for Svelte, and how to keep the map out of
server-side rendering. Under some bundlers, maplibre-gl 6 needs its
worker URL set once per page, as the
[README of core](https://github.com/sakuzu/maplibre-gl-draw#usage) shows
for Vite.

### Without a bundler

A plain HTML page loads every module from a CDN through an import map.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Draw</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@6.11.1/dist/maplibre-gl.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@sakuzu/maplibre-gl-draw-ui@1/dist/style.css">
    <script type="importmap">
      {
        "imports": {
          "maplibre-gl": "https://cdn.jsdelivr.net/npm/maplibre-gl@6.11.1/dist/maplibre-gl.mjs",
          "@sakuzu/maplibre-gl-draw": "https://esm.sh/@sakuzu/maplibre-gl-draw@2?external=maplibre-gl",
          "@sakuzu/maplibre-gl-draw/geometry": "https://esm.sh/@sakuzu/maplibre-gl-draw@2/geometry",
          "@sakuzu/maplibre-gl-draw-ui": "https://cdn.jsdelivr.net/npm/@sakuzu/maplibre-gl-draw-ui@1/dist/maplibre-gl-draw-ui.js"
        }
      }
    </script>
    <style>
      html, body, #map { height: 100%; margin: 0; }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <script type="module">
      import * as maplibregl from 'maplibre-gl';
      import { createDraw } from '@sakuzu/maplibre-gl-draw';
      import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';

      const map = new maplibregl.Map({
        container: 'map',
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: [139.767, 35.681],
        zoom: 14,
      });
      createDrawUI(createDraw(map));
    </script>
  </body>
</html>
```

The import map names four modules.

- `maplibre-gl` is maplibre-gl's own ES module build, at a version that
  the peer of core accepts (`~6.11.1`). It starts its worker from the
  same address by itself.
- `@sakuzu/maplibre-gl-draw` comes from esm.sh, which puts core's own
  dependencies in it. `?external=maplibre-gl` leaves maplibre-gl to the
  import map, so the page and the library share one copy.
- `@sakuzu/maplibre-gl-draw/geometry` is imported by the interface for
  its measurements.
- `@sakuzu/maplibre-gl-draw-ui` is the single-file build of this
  package, with Svelte and kata in it.

The same page works with files served by the application: put the
addresses of its own copies (maplibre-gl's `dist/maplibre-gl.mjs`, this
package's `dist/`, and a build of core with its dependencies in it that
imports `maplibre-gl` by that name) in the import map and the two
`<link>` elements. Pin exact versions in production.

## Use

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { createDrawUI } from '@sakuzu/maplibre-gl-draw-ui';
import '@sakuzu/maplibre-gl-draw-ui/style.css';

const draw = createDraw(map);
const ui = createDrawUI(draw, {
  toolbar: { tools: ['select', 'point', 'line', 'polygon', 'circle'] },
  locale: 'ja', // 'en' (the default), 'ja', or words laid over English
  shortcuts: true, // V P L A C F I, Delete, and ? for the list
});

ui.setLocale('en');
ui.destroy();
```

The options of `createDrawUI`, all optional:

| Option | What it sets | Default |
| --- | --- | --- |
| `container` | The positioned element it lies over | the map's container |
| `toolbar` | `false`, or the `tools`, `delete` and `snapping` | `true` |
| `inspector` | `false`, or `tabs` (the first opens) and `operations` | `true` |
| `layers` | `false`, or `features`, `datasets`, `add`, `reorder` | `true` |
| `legend` | The legend beside the layer panel | `true` |
| `locale` | `en`, `ja`, or words laid over English | `en` |
| `theme` | `light`, `dark` or `auto` (follows the system) | `auto` |
| `units` | The measurements in `metric` or `imperial` | `metric` |
| `shortcuts` | The keyboard shortcuts | `true` |
| `padding` | Whether the map's padding follows the interface | `true` |
| `side` | The side panels `floating` over the map or `beside` it | `floating` |
| `themeToggle` | The button that switches the look | `true` |
| `mapControls` | maplibre-gl's globe, compass, zoom and scale | `true` |
| `basemaps` | The basemaps the basemap row opens | none |
| `basemap` | The ID of the basemap current at the start | the map's |
| `onbasemap` | Called with the basemap after it changed | none |
| `actions` | The actions of the application, in a card at the left | none |
| `actionsTitle` | The title of the card of the actions | `Actions` |
| `actionsOpen` | Whether the card of the actions starts unfolded | `true` |

Each part also goes alone into an element of the page, with its own
options and `target`, `locale` and `theme`: `createToolbar`,
`createLayerPanel`, `createLegend` and `createInspector`.

The interface is laid over the map's container. The toolbar alone goes
into any positioned element with `createToolbar(draw, { target })`.
The magnet at the end of the toolbar is pressed while snapping is on,
and opens the snapping settings above the toolbar: snapping itself and,
under it, the kinds of target (vertices, edges, intersections and
guides), then snapping to datasets, tracing edges and moving shared
vertices together, with the key that pauses snapping while it is held.
Each switch writes `draw.options.update`, and the settings follow
`options.changed`, so a change made by code shows too.
The side panels float over the map, gap-md from its edges and as tall
as their content; `side: 'beside'` docks them beside the map on a wide
one instead. The map's padding follows the interface: at the left, the
room the left panel takes (beside the map, or floating over it with its
gap), and at the bottom, the height of the sheets of a narrow map, as
kata's Shell reports them (`onlayout`'s inset), so that `fitBounds` and
`easeTo` keep clear of them. The right panel opens and closes with the
selection and leaves the padding alone, so that the view does not jump;
the controls of the bottom right move out of its way instead (see
[Map controls](#map-controls)). `padding: false` leaves the map's
padding alone.

On the left, the layer panel and the legend share a panel, in two tabs.
The layer panel has two sections, Stack and Basemap. Stack is the tree
of the layers, their groups and their features, from the front, with
the eye, the lock, reordering by dragging and an add menu (a new layer,
a new group from the selected features). A feature is named by its
`properties.name`, or by its type when it has none; names are changed
in the head of the inspector, not in the tree. Each row costs its
drawing, so a layer lists up to 1,000 features, those of its groups
included: a layer that holds more lists none of them and shows their
number instead, with a hint to select them on the map, and its own row
works as before (the eye, the lock, the active layer). `features` sets
the limit as a number, and `false` lists no features, only the groups.
The datasets (`draw.datasets`) are rows of the stack too, in their place
among the layers: those of `above-store` in front of every layer, those
of `layer-order` where `layers.getOrder()` places them, and those of
`below-store` behind every layer. A dataset row shows its ID (core gives
a dataset no name), with the eye (`setVisible`) and no lock; a press on
it leaves the selection as it is. Every dataset is dragged among the
layers: one of `above-store` or `below-store` dropped there is moved to
`layer-order` (`draw.datasets.move`) and placed where it was dropped
(`draw.layers.reorder`), and goes back to its own order when the reorder
is refused. Basemap, under it, is the back of the stack (see
[Basemaps](#basemaps)). The legend shows the rows of the style rule
(`styleRule`) of each layer and of each dataset that has one, in the
order of the stack.
Shift+L opens and closes the panel, and while it is closed a button at
the top left of the map opens it again.

```ts
const ui = createDrawUI(draw, {
  // or false for none; features: true lists up to 1,000 in a layer, a number
  // sets that limit, and false lists none
  layers: { features: true, datasets: true, add: true, reorder: true },
  legend: true,
});
```

Each goes alone into an element with
`createLayerPanel(draw, { target })` and `createLegend(draw, { target })`.

A tool for a mode of your own (added with `draw.extensions.modes.add`):

```ts
ui.tools.add({
  id: 'ring',
  mode: 'draw_ring',
  label: 'Ring',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">…</svg>',
  shortcut: 'R',
});
```

## Inspector

The inspector is the panel on the right of `createDrawUI`. It opens
while something is selected and closes, clearing the selection, with its
close button. On a narrow map it is a sheet from the bottom, as wide as
the map. For one feature it shows its name (`properties.name`, changed
where it stands); under it, its measurements, and the tabs, which stay
while the content scrolls: a Style tab with the fields its type reads
and an Attributes tab with its other attributes. The content of each tab
starts with its description (`properties.description`, changed where it
stands). Several features
show the fields they share, a field whose values differ being mixed, and
the operations that apply to them (union, intersection, difference,
split and buffer). A layer and a group show their name, whether they are
visible and whether they are locked.

```ts
const ui = createDrawUI(draw, {
  inspector: { tabs: ['style', 'attributes'], operations: true },
  units: 'imperial', // ft, mi, ac; metric by default
});
```

The tabs open on the first of `tabs`: `['attributes', 'style']` opens
on Attributes. A tab chosen stays open from one feature to the next.

A value typed into an attribute is kept as the string typed. The
inspector alone goes into any element with
`createInspector(draw, { target })`, and an application adds a section
of its own for the features it applies to:

```ts
ui.inspector?.sections.add({
  id: 'survey',
  title: 'Survey',
  appliesTo: (features) => features.every((f) => f.type === 'Point'),
  fields: ([first]) => [
    {
      key: 'checked',
      kind: 'toggle',
      label: 'Checked',
      value: first.properties.checked === true,
    },
  ],
  onchange: (key, value, features) => {
    const patch = { properties: { [key]: value } };
    draw.features.updateMany(features.map((f) => ({ id: f.id, patch })));
  },
});
```

## Customize

Everything the interface draws is inside its root element, which has the
class `mgd-ui`, and its style sheet reaches nothing outside it but
maplibre-gl's controls of the map (see [Map controls](#map-controls)).
kata's tokens (the CSS custom properties `--kata-*`) are set on that
element; set them on `.mgd-ui` to change the look. The `theme` option of
`createDrawUI` and of each part put alone is `light`, `dark` or `auto`
(the default, which follows the system's `prefers-color-scheme` as it
changes), and `ui.setTheme` changes it. kata's theme is dark;
`data-color-mode="light"` on the root element, which `light` sets, or on
any element around it, turns it light.

maplibre-gl's controls in the map's container, those of the application
too, follow the theme of `createDrawUI`: while it is on the map,
maplibre-gl's control container (`.maplibregl-control-container`) has
`data-mgd-ui-controls`, which takes kata's tokens, and the
`data-color-mode` of the root. The groups of buttons, the lines between
them, the attribution and the scale are painted with the tokens, and
maplibre-gl's icons, which are dark images, are inverted in the dark
look (`filter: invert(1)`). Set the tokens on
`[data-mgd-ui-controls]` to change their look. `destroy()` removes both
attributes.

A button at the top right of the map switches the look: a sun while it
is dark, a moon while it is light. It sets the theme to the look that is
not shown, so from `auto` it keeps the one the system does not prefer;
`ui.setTheme('auto')` follows the system again. While the inspector is
open over the map or beside it, the button stands to the left of it.
`themeToggle: false` leaves it out.

Beyond the look, the options above choose the parts and what each shows,
`ui.tools.add` adds a tool for a mode of the application (see
[Use](#use)), `ui.inspector.sections.add` adds a section to the
inspector (see [Inspector](#inspector)), and `ui.actions.add` adds an
action of the application (see [Actions](#actions)).

### Actions

An action of the application, such as saving the drawing or turning a
setting on and off, is a row of a card at the bottom left of the map,
above maplibre-gl's scale and, where its box reaches the card across, the
attribution: a switch (`kind: 'toggle'`) or a button
(`kind: 'action'`), with its key at the end. A press on the row and its
key both call `run`; a switch shows what `checked` returns, read again
after each run and on `ui.actions.refresh()`, so the state stays with
the application. `disabled` dims the row and turns its key off, and
`hint` is a caption under it. The keys are listed with `?` under the
title of the card, and do nothing while a field has the focus. A key the
interface uses (the keys of the tools, Delete, Backspace, Escape, `?`
and Shift+L) or another action uses is refused with an error. The card
shows while there is an action, its head folds it into one button, and
on a map narrower than 48rem it starts folded; where it would reach the
toolbar across, it stands above the toolbar, and the layer panel
floating at the left ends above it. The card is no taller than the map
above its place, less gap-md at the top and the button that opens the
layer panel again while it shows; the whole card scrolls when its rows
do not fit. Its title is `actionsTitle`, or the
word for actions of the locale.

```ts
const ui = createDrawUI(draw, {
  actions: [
    {
      id: 'read-only',
      label: 'Read-only',
      kind: 'toggle',
      shortcut: 'R',
      run: () => draw.setReadOnly(!draw.isReadOnly()),
      checked: () => draw.isReadOnly(),
    },
  ],
});

const remove = ui.actions.add({
  id: 'save',
  label: 'Save',
  kind: 'action',
  shortcut: 'S',
  run: () => localStorage.setItem('drawing', JSON.stringify(draw.document.toJSON())),
});
```

## Basemaps

The last section of the layer panel, Basemap, is the back of the stack:
one row under the tree of the layers, apart from it as the basemap is no
layer, so it is not dragged, hidden, locked or selected. The row shows
the name of the basemap the map shows: the label of the current one of
`basemaps`, else the `name` of the map's style, read again on each
`style.load`, else the word for a basemap.

With two or more `basemaps`, pressing the row opens them on the right,
in the place of the inspector: a list of their labels, each with its
`preview` (a value of CSS `background`, such as a gradient in the colors
of the style; a neutral square without one), and a check on the current
one. Opening it clears the selection, and selecting a feature on the map
or in the tree closes it, as do its close button and Escape. Choosing a
basemap replaces the map's style with its `style` (a URL or a style
object) and calls `onbasemap`, and the list stays open.
`ui.setBasemap(id)` does the same, and `ui.getBasemap()` returns the
current one. The current one at the start is `basemap`, or else the
first whose `style` is the URL the map's style was loaded from. With
fewer, the row only shows the name.

```ts
const styles = 'https://tiles.openfreemap.org/styles';
const ui = createDrawUI(draw, {
  basemaps: [
    {
      id: 'bright',
      label: 'Bright',
      style: `${styles}/bright`,
      preview: 'linear-gradient(135deg, #f4f1ea, #dfe7d5)',
    },
    { id: 'dark', label: 'Dark', style: `${styles}/dark` },
  ],
  onbasemap: (basemap) => console.log(basemap.id),
});
```

The layer panel put alone takes the same options
(`LayerPanelOptions`):
`createLayerPanel(draw, { target, basemaps, basemap, onbasemap })`.
There, the row opens the list in the place of the panel's sections,
until its close button or Escape closes it.

The drawing stays: choosing a basemap calls
`map.setStyle(style, { diff: false })`, which replaces the style whole,
and the draw instance adds its layers again on top of the new style once
it has loaded. Sources, layers and the terrain that the application
added to the map itself go with the old style, so it adds them again on
the map's `style.load` event.

## Map controls

`createDrawUI` adds maplibre-gl's own controls to the map, as
maplibre-gl draws them: at the bottom right, from the top, the globe
(`GlobeControl`), the compass (`NavigationControl` without zoom, which
also resets the pitch) and the zoom; at the bottom left, the scale
(`ScaleControl`). `destroy()` removes them. Their look comes from
maplibre-gl's style sheet, which the page imports itself
(`import 'maplibre-gl/dist/maplibre-gl.css'`).

```ts
const ui = createDrawUI(draw, {
  mapControls: { globe: false, scale: true }, // or false for none
});
```

A page that adds controls of its own passes `mapControls: false`. The
bottom corners of the map are kept clear of the interface:

- where the toolbar reaches a bottom corner across, as on a narrow map,
  that corner (its controls and the attribution) is lifted above the
  toolbar
- while the right panel covers the bottom right of the map, the controls
  there (not the attribution) move to the left of it, gap-md apart
- where the attribution's box reaches the scale across, as the two-line
  attribution of a narrow map does, the bottom left corner is lifted
  above it. The attribution is only read; its compact form is
  maplibre-gl's own

These are the rules of the style sheet outside the root element: they
apply to the map's container while the interface is on it.

## Development

The interface takes core from the root of this repository as an
application takes it from npm, through core's build. Build core first,
then work on the interface:

```sh
npm run build          # core, at the root
npm run ui:typecheck   # tsc and svelte-check
npm run ui:test
npm run ui:test:e2e    # on a real map in headless Chromium
npm run ui:build       # dist/index.js, dist/maplibre-gl-draw-ui.js, dist/style.css
npm run ui:dev         # the development page on http://localhost:3100
```

## License

Copyright (C) 2026 SAKAIDA Atsushi.

Licensed under the GNU Affero General Public License version 3
(`AGPL-3.0-only`), the same terms as `@sakuzu/maplibre-gl-draw`. See
`LICENSE` in the package, the same text as the
[LICENSE](https://github.com/sakuzu/maplibre-gl-draw/blob/main/LICENSE)
of the repository.

If the AGPL does not fit your product, a commercial license is available
from Kasika, Inc. (可視化技研株式会社): <https://www.kasika.xyz/>.

The notices of the software included in the build (Svelte, kata and its
icons) are in `THIRD_PARTY_NOTICES.md`.
