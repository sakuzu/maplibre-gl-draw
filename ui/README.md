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

## Install

```sh
npm install @sakuzu/maplibre-gl-draw @sakuzu/maplibre-gl-draw-ui maplibre-gl
```

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

The interface is laid over the map's container. The toolbar alone goes
into any positioned element with `createToolbar(draw, { target })`.
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
`properties.name`, or by its type when it has none. The legend shows
the rows of the style rule (`styleRule`) of each layer that has one.
Shift+L opens and closes the panel, and while it is closed a button at
the top left of the map opens it again.

```ts
const ui = createDrawUI(draw, {
  layers: { features: true, add: true, reorder: true }, // or false for none
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

## Look

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

## Without a bundler

`dist/maplibre-gl-draw-ui.js` is one module with Svelte and kata in it.
It loads with `<script type="module">` and an import map that names
`@sakuzu/maplibre-gl-draw` and `maplibre-gl`, together with
`dist/style.css`.

## Development

The interface takes core from the root of this repository as an
application takes it from npm, through core's build. Build core first,
then work on the interface:

```sh
npm run build          # core, at the root
npm run ui:typecheck   # tsc and svelte-check
npm run ui:test
npm run ui:build       # dist/index.js, dist/maplibre-gl-draw-ui.js, dist/style.css
npm run ui:dev         # the development page on http://localhost:3100
```

## License

GNU Affero General Public License version 3 (AGPL-3.0-only). See
`LICENSE`, and `THIRD_PARTY_NOTICES.md` for the software included in the
build.
