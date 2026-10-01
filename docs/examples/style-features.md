---
aside: false
---

# Style features

The look of each feature, side by side: the colors of the fill and of
the outline, solid, dashed and dotted lines of several widths, and the
four shapes of a point in four sizes.

```example
style-features
```

The top row has three areas, each filled in one color and outlined in
another, with outlines solid at 1 px, dashed at 3 px and dotted at
6 px. The lines under them are 1, 4 and 10 px wide, then come a circle,
a square, a triangle and a star with radii of 6, 9, 12 and 15 px, and
at the bottom a circle of 80 m on the ground. The page opens with the
middle area selected, so the panel on the right shows the fields of its
style. Change one and the area takes it at once. Select another feature
to see the fields of its type: a point has its shape and its size, a
line its width and its dash, and an area its fill and its outline.

## Code

Each feature gets a `style` of its own when it is created (1). The
defaults of a type, which the features without a style take, change with
`draw.options.update` (2): draw an area with the tools to see them. The
panel writes a change with `draw.features.update` (`updateMany` for
several features), the call that the page makes once at the end (5) to
dash the outline of the middle area.

::: code-group
<<< @/../examples/style-features/main.ts
<<< @/../examples/style-features/data.ts
<<< @/../examples/style-features/index.html
:::

## Related

- [Styles](../guides/styles.md): the keys of a style, the defaults, the
  style rules of a layer and which color wins
- [`FeatureStyle`](../api/maplibre-gl-draw/interfaces/FeatureStyle.md):
  the keys and their values
- [`features.update`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md#update),
  which merges a style key by key
- [`options.update`](../api/maplibre-gl-draw/interfaces/OptionsResource.md#update)
  and the `style` of
  [`RuntimeOptions`](../api/maplibre-gl-draw/interfaces/RuntimeOptions.md)
- [The inspector](../../ui/README.md#inspector) of the standard UI
