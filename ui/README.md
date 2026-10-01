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

## Look

Everything the interface draws is inside its root element, which has the
class `mgd-ui`, and its style sheet reaches nothing outside it. kata's
tokens (the CSS custom properties `--kata-*`) are set on that element;
set them on `.mgd-ui` to change the look. kata's theme is dark;
`data-color-mode="light"` on the root element, or on any element around
it, turns it light.

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
