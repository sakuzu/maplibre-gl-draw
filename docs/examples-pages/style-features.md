---
aside: false
---

# Style features

The look of each feature: its colors, the width and the opacity of its
lines, dashed and dotted lines, and the shape and the size of points.

```example
style-features
```

The page opens with the block selected, so the panel on the right shows
the fields of its style. Change one and the block takes it at once.
Select another feature to see the fields of its type: a point has its
shape and its size, a line its width and its dash, and an area its fill
and its outline.

## Code

Each feature gets a `style` of its own when it is created (1). The
defaults of a type, which the features without a style take, change with
`draw.options.update` (2): draw an area with the tools to see them. The
panel writes a change with `draw.features.update` (`updateMany` for
several features), the call that the page makes once at the end (5).

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
