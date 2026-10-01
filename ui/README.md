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
same copies as the application. Svelte is a dependency, and kata is
compiled into the package.

The package loads in two ways.

- With a bundler, as ES modules: `dist/index.js` imports `svelte`, core
  and `maplibre-gl`, which the bundler resolves, and
  `@sakuzu/maplibre-gl-draw-ui/style.css` is the style sheet.
- Without a bundler: `dist/maplibre-gl-draw-ui.js` is one module with
  Svelte and kata in it. It loads with `<script type="module">` and an
  import map that names `@sakuzu/maplibre-gl-draw` and `maplibre-gl`,
  together with `dist/style.css`.

```html
<link rel="stylesheet" href="/vendor/maplibre-gl.css" />
<link rel="stylesheet" href="/vendor/maplibre-gl-draw-ui/style.css" />
<script type="importmap">
  {
    "imports": {
      "maplibre-gl": "/vendor/maplibre-gl.mjs",
      "@sakuzu/maplibre-gl-draw": "/vendor/maplibre-gl-draw.js"
    }
  }
</script>
<script type="module">
  import { Map } from 'maplibre-gl';
  import { createDraw } from '@sakuzu/maplibre-gl-draw';
  import { createDrawUI } from '/vendor/maplibre-gl-draw-ui/maplibre-gl-draw-ui.js';

  const map = new Map({ container: 'map', style: '/style.json' });
  createDrawUI(createDraw(map));
</script>
```

The paths stand for where the page serves the files: maplibre-gl's
`dist/maplibre-gl.mjs`, the `dist/` of this package, and a module of core
with its own dependencies in it that imports `maplibre-gl` by that name.

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
| `basemaps` | The basemaps of the basemap row's menu | none |
| `basemap` | The ID of the basemap current at the start | the map's |
| `onbasemap` | Called with the basemap after it changed | none |

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
one instead. The map's padding follows the interface, the width of a
panel that stands beside the map and the toolbar's height at the bottom,
so that `fitBounds` and `easeTo` keep clear of them; `padding: false`
leaves the map's padding alone.

On the left, the layer panel and the legend share a panel, in two tabs.
The layer panel is the tree of the layers, their groups and their
features, from the front, with the eye, the lock, renaming in place (F2
or a double click), reordering by dragging and an add menu (a new layer,
a new group from the selected features). A feature is named by its
`properties.name`, or by its type when it has none. The datasets
(`draw.datasets`) are rows of the stack too, in their place among the
layers: those of `above-store` in front of every layer, those of
`layer-order` where `layers.getOrder()` places them, and those of
`below-store` behind every layer. A dataset row shows its ID (core gives
a dataset no name) and the number of its rows, with the eye
(`setVisible`) and no lock; a press on it selects nothing, and it is
dragged among the layers only when its order is `layer-order`. Under
the tree, the last row is the basemap, the back of the stack (see
[Basemaps](#basemaps)). The legend shows the rows of the style rule
(`styleRule`) of each layer that has one.
Shift+L opens and closes the panel, and while it is closed a button at
the top left of the map opens it again.

```ts
const ui = createDrawUI(draw, {
  // or false for none
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
close button. For one feature it shows its name (`properties.name`,
changed where it stands); under it, its measurements and its description
(`properties.description`, changed where it stands); then a Style tab
with the fields its type reads and an Attributes tab with its other
attributes. Several features
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
class `mgd-ui`, and its style sheet reaches nothing outside it. kata's
tokens (the CSS custom properties `--kata-*`) are set on that element;
set them on `.mgd-ui` to change the look. The `theme` option of
`createDrawUI` and of each part put alone is `light`, `dark` or `auto`
(the default, which follows the system's `prefers-color-scheme` as it
changes), and `ui.setTheme` changes it. kata's theme is dark;
`data-color-mode="light"` on the root element, which `light` sets, or on
any element around it, turns it light.

A button at the top right of the map switches the look: a sun while it
is dark, a moon while it is light. It sets the theme to the look that is
not shown, so from `auto` it keeps the one the system does not prefer;
`ui.setTheme('auto')` follows the system again. While the inspector is
open over the map or beside it, the button stands to the left of it.
`themeToggle: false` leaves it out.

Beyond the look, the options above choose the parts and what each shows,
`ui.tools.add` adds a tool for a mode of the application (see
[Use](#use)), and `ui.inspector.sections.add` adds a section to the
inspector (see [Inspector](#inspector)).

## Basemaps

The last row of the layer panel is the basemap. The panel lists the
stack from the front, and the basemap is the back of the stack, so it
comes under the layers, apart from the tree by a line. It is not a node
of the tree: it is not dragged, hidden, locked or selected. The row
shows the name of the basemap the map shows: the label of the current
one of `basemaps`, else the `name` of the map's style, read again on
each `style.load`.

With two or more `basemaps`, pressing the row opens a menu of their
labels with the current one marked. Choosing one replaces the map's
style with its `style` (a URL or a style object) and calls `onbasemap`;
`ui.setBasemap(id)` does the same, and `ui.getBasemap()` returns the
current one. The current one at the start is `basemap`, or else the
first whose `style` is the URL the map's style was loaded from. With
fewer, the row only shows the name.

```ts
const styles = 'https://tiles.openfreemap.org/styles';
const ui = createDrawUI(draw, {
  basemaps: [
    { id: 'bright', label: 'Bright', style: `${styles}/bright` },
    { id: 'dark', label: 'Dark', style: `${styles}/dark` },
  ],
  onbasemap: (basemap) => console.log(basemap.id),
});
```

The layer panel put alone takes the same options
(`LayerPanelOptions`):
`createLayerPanel(draw, { target, basemaps, basemap, onbasemap })`.

The drawing stays: the menu calls `map.setStyle(style, { diff: false })`,
which replaces the style whole, and the draw instance adds its layers
again on top of the new style once it has loaded. Sources, layers and
the terrain that the application added to the map itself go with the old
style, so it adds them again on the map's `style.load` event.

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

A page that adds controls of its own passes `mapControls: false`. Where
the toolbar reaches a bottom corner of the map across, as on a narrow
map, that corner (its controls and the attribution) is lifted above the
toolbar. This is the one rule of the style sheet outside the root
element: it applies to the map's container while the interface is on
it.

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
