# Changelog

All notable changes to `@sakuzu/maplibre-gl-draw-ui` are recorded here.
The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package
follows semantic versioning.

## [Unreleased]

These changes will be released as 1.1.0: they add the basemaps, the
datasets in the layer panel, the limit on the features it lists and the
snapping settings, and change the layer panel and the inspector.

- Added: the datasets are rows of the layer panel, in their place in
  the stack: those of `above-store` in front of every layer, those of
  `layer-order` where `layers.getOrder()` places them among the layers,
  and those of `below-store` behind every layer. A row shows the ID of
  the dataset with a database mark and the number of its rows, and the
  eye shows and hides it with `setVisible`. It has no lock, and a press
  on it leaves the selection as it is. A
  `layer-order` dataset is dragged among the layers (`layers.reorder`
  with its ID); the others stay. The rows follow `dataset.added`,
  `dataset.removed`, `dataset.reordered` and the `changed` event of each
  dataset. The option `datasets: false` (`LayerPanelOptions`) leaves
  them out. New words: `datasets` and `rows` (with `{count}`).
- Added: the basemaps of the layer panel, `basemaps` (`{ id, label,
  style, preview }`), `basemap` and `onbasemap`, in the options of
  `createDrawUI` and of `createLayerPanel` (`LayerPanelOptions`). With
  two or more, the basemap row opens them on the right, in the place of
  the inspector: a list of their labels, each with its `preview` (a
  value of CSS `background`; a neutral square without one) and a check
  on the current one. Opening it clears the selection; a selection made
  on the map or in the tree, its close button and Escape close it.
  Choosing one replaces the map's style, calls `onbasemap` and leaves
  the list open; `basemap` names the current one at the start, and
  `ui.setBasemap(id)` and `ui.getBasemap()` change and read it. The
  drawing is drawn again on top of the new style. The layer panel put
  alone opens the list in the place of its sections.
- Changed: the layer panel lists up to 1,000 features in a layer, those
  of its groups included. A layer that holds more lists none of them and
  none of its groups: its one child is a row with their number and a
  hint, "12,345 features. Select them on the map.", which is not
  pressed, hidden, locked or dragged. The row of the layer works as
  before. Each row of the panel costs about a third of a millisecond to
  draw, so a layer of 20,000 features took seconds. `features`
  (`LayerPanelOptions`) is now `boolean | number`: `true` (the default)
  for the limit of 1,000, a number for another limit, `false` for no
  features; a number less than 0 throws. New word: `manyFeatures` (with
  `{count}`).
- Changed: the layer panel is a stack of two sections, as in the
  reference layout. The first, Stack (the new word `stack`), is the
  tree with the add menu in its head; the second, Basemap, holds one
  row with a globe mark and the name of the basemap the map shows: the
  label of the current one of `basemaps`, else the `name` of the map's
  style, else the word `basemap`. The panel lists the stack from the
  front, and the basemap is its back. The row is not a node of the tree:
  it is not dragged, hidden, locked or selected. Before the release, the
  menu of the basemaps was a button at the top right of the map, beside
  the theme button, and then a menu under the tree; both are gone.
- Changed: the inspector of a feature opens on the first tab of
  `inspector.tabs`, so `['attributes', 'style']` opens on Attributes.
  The default stays `['style', 'attributes']`, which opens on Style. Once
  a tab is chosen, it is kept from one feature to the next as before.
- Changed: the magnet of the toolbar opens the snapping settings above
  the toolbar instead of switching snapping: snapping, the kinds of
  target under it (vertices, edges, intersections and guides, off while
  snapping is off), snapping to datasets, tracing edges and moving shared
  vertices together, and the key that pauses snapping. Each switch writes
  `draw.options.update` and follows `options.changed`. The magnet stays
  pressed while snapping is on. New words: `snapVertex`, `snapEdge`,
  `snapIntersection`, `snapGuide`, `snapDatasets`, `traceEdges`,
  `sharedVertexDrag` and `snapPauseKey` (with `{key}`).
- Removed: renaming in place in the layer panel (F2 or a double click on
  a row), as in the reference layout. The names of layers, groups and
  features are changed in the head of the inspector, which also ends a
  defect: a locked row could still be renamed in the tree.
- Removed: the pencil that marked the active layer (the layer drawn
  features go into) in the layer panel, as in the reference layout: the
  row of a layer looks the same whether it is active or not. Pressing a
  layer still makes it active (`layers.setActive`). The word
  `activeLayer` is gone with it; at run time a locale that still gives
  it is accepted and the word is ignored.
- Fixed: in the inspector of a feature, what a tab shows first is spaced
  from the line of the tabs as the content of a panel is from its head
  (pad-md to the first field, pad-lg to a section title). The panel of
  the tab is now a Stack of its own under the tabs, so kata's spacing of
  a first group applies; before, the title of the first section touched
  the line.
- Fixed: the fields of the style have no "Style" title any more: they
  sit straight under the Style tab, and the sections of the application
  and Operations keep their titles. The reset of the style, which was an
  icon button in that title, is a "Reset the style" text action after
  the fields. In the same way, the shared fields of a selection, the
  fields of a group and the fields of a layer have no title repeating
  what the head says; the style rule of a layer keeps its title.
- Fixed: the page without a bundler in the README names
  `@sakuzu/maplibre-gl-draw/geometry` in its import map, which the
  single-file build imports. The README also shows the package from
  React and from Vue, and a page that loads it from a CDN.

## [1.0.0] - 2026-10-01

The first release of the standard user interface of
`@sakuzu/maplibre-gl-draw`: the toolbar, the layer panel and the legend,
and the inspector, laid over the map with `createDrawUI` or put alone in
an element, built with kata and driven through a plain JavaScript API.
It works with `@sakuzu/maplibre-gl-draw` 2.x.

### Added

- `createDrawUI(draw, options)` lays kata's Shell over the map, with the
  toolbar at the bottom and the keyboard shortcuts.
- `createToolbar(draw, { target })` puts the toolbar alone in an element.
- The toolbar has the seven built-in tools (select, point, line,
  polygon, circle, freehand and image), the delete button and the
  snapping switch, and follows the mode and the selection of the draw
  instance.
- `ui.tools.add`, `ui.tools.remove` and `ui.tools.list` change the tools
  of the toolbar.
- The words come in English and Japanese, and any of them can be
  replaced (`locale`, `ui.setLocale`).
- `style.css` keeps kata's tokens on the root element `.mgd-ui`.
- The left region of `createDrawUI` holds the layer panel and the
  legend in two tabs (`layers`, `legend`), and Shift+L opens and closes
  it. `ui.layers` and `ui.legend` remove them.
- `createLayerPanel(draw, { target })` puts the tree of the layers,
  groups and features alone in an element: the eye, the lock, renaming,
  reordering by dragging, and the add menu.
- `createLegend(draw, { target })` puts the legend of the style rules of
  the layers alone in an element.
- The inspector on the right of `createDrawUI` (`inspector`, `units`):
  the name, the style, the measurements and the attributes of a
  feature; the shared fields and the operations of several features;
  the settings of a layer and of a group. `createInspector(draw,
  { target })` puts it alone in an element, and
  `ui.inspector.sections.add` adds a section of the application.
- `createDrawUI` keeps the map's padding to the interface: the width of
  a panel that stands beside the map on its side, and the toolbar's
  height with its gap at the bottom, so that `fitBounds` and `easeTo`
  keep clear of them. Floating panels and sheets leave the sides at 0,
  and `destroy()` gives the map its padding back. `padding: false`
  turns it off.
- The root element of the interface is kata's root in the page
  (`data-kata-root`): the tooltips and the probes kata appends go into
  it, where kata's tokens, the language and the theme apply.
- Built with kata 1.1.0. The Shell of `createDrawUI` lies over the map
  with kata's `overlay`: the map takes the pointer everywhere but the
  regions of the shell (the panels beside it, the toolbar, the scrim
  and the floating panels, and the sheets).
- The `theme` option (`light`, `dark`, or `auto` to follow the system's
  `prefers-color-scheme` as it changes; `auto` by default) of
  `createDrawUI`, `createToolbar`, `createLayerPanel`, `createLegend`
  and `createInspector`, and `ui.setTheme`. Light switches every token
  of kata's light theme on the root element.
- While the left region of `createDrawUI` is closed, a button at the top
  left of the map opens it again.
- The inspector of one feature shows its measurements and its
  description (changed where it stands) under its name, before the
  tabs; the Style tab has the fields of the style, the sections of the
  application and the operations, and the Attributes tab the list of
  the attributes. The line style and the shape of a point are selects.
- A button at the top right of `createDrawUI` switches between the
  light and the dark look (`themeToggle: false` leaves it out). It
  stands to the left of the inspector while the inspector is open.
- `createDrawUI` adds maplibre-gl's own controls to the map: the globe,
  the compass and the zoom at the bottom right, the scale at the bottom
  left (`mapControls`, true by default; false for none, or an object for
  some of them). `destroy()` removes them. A bottom corner the toolbar
  reaches across is lifted above the toolbar.
