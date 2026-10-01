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
