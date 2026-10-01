# Changelog

All notable changes to `@sakuzu/maplibre-gl-draw-ui` are recorded here.
The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package
follows semantic versioning.

## [Unreleased]

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
