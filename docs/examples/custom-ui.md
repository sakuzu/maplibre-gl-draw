---
aside: false
---

# Build your own UI

No standard UI: a toolbar and a panel of the selected feature built with
the public API of the library alone, in plain TypeScript and a few rules
of CSS. Everything the standard UI does is reachable this way.

```example
custom-ui
```

Draw with the buttons at the bottom. Select one feature: the panel at
the top right shows its name and its color, and a change there applies
at once. Delete removes the selection.

## Code

A button asks for its mode with `draw.setMode` (1), and the toolbar
follows `mode.changed` (2), so it shows the mode whoever changed it: a
button, a key, or the end of a drawing. The panel follows
`selection.changed` and `document.changed` (4) and shows the color the
feature is drawn with, from `features.getAppliedStyle`. A field writes
its value with `features.update` (5), the same call the inspector of the
standard UI makes, and `features.isEditable` disables the fields while
the feature cannot be changed. The page has its own `style.css`.

::: code-group
<<< @/../examples/custom-ui/main.ts
<<< @/../examples/custom-ui/style.css
<<< @/../examples/custom-ui/index.html
:::

## Related

- [Getting started](../getting-started.md): the same calls one by one
- [Drawing and editing](../guides/drawing.md): the modes, the selection
  and the keys
- [`Draw`](../api/maplibre-gl-draw/interfaces/Draw.md) and
  [`FeaturesCollection`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md)
- [The events](../reference/events.md), `mode.changed` and
  `selection.changed` among them
- [Each part of the standard UI alone](../../ui/README.md#use), for a page
  that keeps some of it
