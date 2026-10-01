---
aside: false
---

# Zoom and scale

Widths in pixels at the reference zoom of each feature, which grow and
shrink with the map like paint on the ground, beside the same widths
fixed on the screen.

```example
zoom-and-scale
```

The two rows hold the same features: a wide line, an area with a thick
outline and a big point. The page opens at zoom 15, the reference zoom
of the top row, so both rows look alike. Zoom in and out: the lines and
the outline of the top row grow and shrink with the map, as if they were
painted on the ground, and those of the bottom row stay as wide on the
screen. The point keeps its size in both rows, as every point does. The
thin line beside the wide one is 2 px at its reference zoom of 13, so at
zoom 15 it is as wide as the 8 px line. The switch Scale with zoom, in
the card of actions at the bottom left (or its key `Z`), switches the
option `scaleWithZoom`: draw a line with the tools before and after. The
arrow in the panel on the left shows the layer the tools draw into, and
the browser console logs the state.

## Code

The two layers get the same features, those of the first with the
property `maplibre-gl-draw:createdZoom` and those of the second without
it (2). The reference zoom belongs to each feature, so
`draw.features.update` changes it for one (3). The option
`scaleWithZoom` decides whether the drawing tools write the zoom they
draw at into what they draw, and it changes with
`draw.options.update`, from a switch the page adds to the standard UI
with `ui.actions.add` (5).

::: code-group
<<< @/../examples/zoom-and-scale/main.ts
<<< @/../examples/zoom-and-scale/index.html
:::

## Related

- [Styles](../guides/styles.md): the width of a line at its reference
  zoom, and `scaleWithZoom` among the options that change while the
  instance runs
- [Scaling the drawing](../guides/performance.md#scaling-the-drawing)
  in the guide to performance, for a map shown larger or smaller than it
  is drawn
- [`DrawProperties`](../api/maplibre-gl-draw/type-aliases/DrawProperties.md)
  for `maplibre-gl-draw:createdZoom`
- [`RuntimeOptions`](../api/maplibre-gl-draw/interfaces/RuntimeOptions.md)
  for `scaleWithZoom`, and
  [`options.update`](../api/maplibre-gl-draw/interfaces/OptionsResource.md#update)
