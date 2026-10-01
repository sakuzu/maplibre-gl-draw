---
aside: false
---

# Style rules and legend

Colors from the attributes of the features: a style rule on a layer
colors its features from one attribute, and the legend shows what each
color means. Edit the attribute, and the color follows.

```example
style-rules-and-legend
```

The 400 buildings are features of the drawing, taken from the Overture
Maps sample: those nearest the center among the buildings with a
height. They open on the light grey Positron basemap, so that the colors
read, colored by their height, in classes cut at 10, 20, 40 and 80 m.
Open the Legend tab of the panel on the left to see the rows
of the rule. The button Next rule, in the card of actions at the bottom
left (or its key `R`), switches the layer to the next kind of rule: by
the class of the building, a gradient of the height, and one color. Most
buildings have no class, and take the color for a value the rule cannot
read. Select the layer in the panel on the left to see its rule and the
attribute it reads in the panel on the right.

The rule reads the attribute, so the drawing stays editable: select a
building, change its `height` in the Attributes tab of the panel on the
right, and its color changes at once.

## Code

The page creates its own layer, and a stronger fill than the default
with a white outline lets the colors of the rule read well: a rule sets
the color of the fill, and the style keeps the opacity and the outline.
The four kinds of rule are plain objects (1). The page fetches the
buildings of the sample data and keeps the nearest 400 with a height and
the attributes the rules read (2). `draw.document.load` creates the layer
with its rule and puts the buildings in it, in one step (3), and
`draw.layers.update` changes the rule (4), from a button the page adds
to the standard UI with `ui.actions.add` (7); the map and the legend
follow at once. The Attributes tab keeps what is typed as text, and a graduated
or continuous rule reads numbers only, so the page turns a number typed
into `height` or `floors` into a number (5). The legend of the standard
UI derives its rows with `deriveLegend`, which a page of your own can
call to draw a legend itself.

::: code-group
<<< @/../examples/style-rules-and-legend/main.ts
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

Data: [Overture Maps Foundation](https://overturemaps.org), ODbL / CDLA
([the sample data](../../examples/public/data/README.md))
