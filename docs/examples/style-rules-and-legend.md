---
aside: false
---

# Style rules and legend

Colors from the attributes of the features: a style rule on a layer
colors its features from one attribute, and the legend shows what each
color means.

```example
style-rules-and-legend
```

The blocks are colored by their land use. Open the Legend tab of the
panel on the left to see the rows of the rule. Press `R` to switch the
layer to the next kind of rule: one color, by category, by class of the
population, and a gradient of the population. The block without a
population takes the color for a value the rule cannot read. Select
the layer in the panel on the left to see its rule and the attribute it
reads in the panel on the right.

## Code

The page creates its own layer, and a stronger fill than the default
lets the colors of the rule read well: a rule sets the color, and the
style keeps the opacity. The four kinds of rule are plain objects (1).
The rule is a key of the layer, given when the layer is created (2)
and changed with `draw.layers.update` (3); the map and the legend follow
at once. The legend of the standard UI derives its rows with
`deriveLegend`, which a page of your own can call to draw a legend
itself.

::: code-group
<<< @/../examples/style-rules-and-legend/main.ts
<<< @/../examples/style-rules-and-legend/data.ts
<<< @/../examples/style-rules-and-legend/index.html
:::

## Related

- [Style rules](../guides/styles.md#style-rules) and
  [legends](../guides/styles.md#legends) in the guide to styles, and
  [which color wins](../guides/styles.md#which-color-wins) between a rule
  and the style of a feature
- [`StyleRule`](../api/maplibre-gl-draw/type-aliases/StyleRule.md) and
  [`deriveLegend`](../api/maplibre-gl-draw/functions/deriveLegend.md)
- [`layers.update`](../api/maplibre-gl-draw/interfaces/LayersCollection.md#update)
- [The legend](../../ui/README.md#use) of the standard UI
