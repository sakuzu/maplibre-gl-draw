---
aside: false
---

# Plugins

A plugin adds a mode of its own to the drawing, and the page adds a tool
for that mode to the toolbar and a section for its features to the panel
on the right.

```example
plugins
```

The star at the end of the toolbar, or the key `S`, enters the mode of
the plugin: each click on the map puts a star there, until `Escape` or
another tool. Select a star: under its style, the Stamp section shows
whether it is planned or done, and a change there also changes its
color. The console logs the count the plugin keeps after each change of
tool.

## Code

The plugin (`stamp.ts`) registers the mode `stamp` through its context,
listens to `feature.created` to count the stars, and offers the count as
its `api`. Everything it adds goes away with it, through the function
that `plugins.add` returns (1).

The standard UI has two openings for an extension (3, 4).
`ui.tools.add` puts a button for a registered mode on the toolbar, with
its label, its icon (SVG markup drawn with `currentColor`) and its key.
`ui.inspector.sections.add` adds a section to the inspector for the
features that `appliesTo` accepts: the UI draws the fields that `fields`
lists, and gives each change to `onchange`, which writes it with
`features.updateMany`. The page asks the plugin for its count by name
with `plugins.getApi` (6).

::: code-group
<<< @/../examples/plugins/main.ts
<<< @/../examples/plugins/stamp.ts
<<< @/../examples/plugins/data.ts
<<< @/../examples/plugins/index.html
:::

## Related

- [Plugins](../guides/plugins.md): the context of a plugin, its events,
  its api and the modes it adds
- [`Plugin`](../api/maplibre-gl-draw/interfaces/Plugin.md) and
  [`ModeContext`](../api/maplibre-gl-draw/interfaces/ModeContext.md),
  `commitFeature` among them
- [A tool for a mode of your own](../../ui/README.md#use) and
  [a section of the inspector](../../ui/README.md#inspector), the two
  openings of the standard UI
