# Styles

A feature's look comes from three places: its own `style`, the style rule
of its layer, and the defaults of the instance. This guide covers each of
them, the order in which they apply, the legend a rule gives, and the
strings the library returns, which a host can replace for its language.

## Minimal code

```ts
// Color the features of a layer by an attribute
draw.layers.update(layerId, {
  styleRule: {
    kind: 'categorical',
    property: 'landuse',
    map: { park: '#4caf50', water: '#2196f3' },
    other: '#9e9e9e',
  },
});

// One feature keeps its own color whatever the rule says
draw.features.update(featureId, { style: { fillColor: '#ff9800' } });
```

The rule is evaluated when the layer is drawn, so a feature whose
`landuse` changes takes its new color at once, without touching `style`.

## A feature's own style

`Feature.style` is a `FeatureStyle`. Every key is optional; a key left out
takes the rule color or the default.

| Types | Keys |
| --- | --- |
| points | `pointColor`, `pointRadius`, `pointShape`, `pointOpacity` |
| lines | `strokeColor`, `strokeOpacity`, `strokeWidth`, `lineStyle` |
| areas | the line keys, `fillColor`, `fillOpacity` |
| `Image` | `imageOpacity` |

Points are `Point` and `MultiPoint`; lines are `LineString`,
`MultiLineString` and `Freehand`; areas are `Polygon`, `MultiPolygon` and
`Circle`.

```ts
draw.features.create({
  type: 'LineString',
  geometry: {
    type: 'LineString',
    coordinates: [
      [139.7, 35.68],
      [139.71, 35.69],
    ],
  },
  style: { strokeColor: '#1e88e5', strokeWidth: 4, lineStyle: 'dashed' },
});
```

`features.update` merges the style key by key: the keys you give change,
the others stay, and a key given as `undefined` is removed, so the
feature takes the rule color or the default again.

```ts
// Thicker, and back to the color of the rule
draw.features.update(featureId, {
  style: { strokeWidth: 6, strokeColor: undefined },
});
```

- Colors are CSS colors (`#1e88e5`, `rgb(30 136 229)`, `hsl(...)`,
  `tomato`); opacities run from 0 to 1. A value of the wrong type or
  form throws a `DrawError` with the code `invalid-input`
- `lineStyle` is `solid`, `dashed` or `dotted`
- `strokeWidth` is in pixels at the zoom the feature was drawn at, its
  reference zoom (the property `maplibre-gl-draw:createdZoom`). The line
  then grows and shrinks with the map like its geometry, like a line
  drawn on paper
- The drawing modes write the reference zoom unless the option
  `scaleWithZoom` is `false`. A feature without it (one created with
  `features.create`, or drawn with that option off) keeps its width in
  pixels on the screen at every zoom
- A point keeps its size on screen at every zoom
- `pointShape` is `circle`, `square`, `triangle` or `star`, and wins over
  the shape of the defaults, so the points of one instance can mix
  shapes. Whatever the shape, a point is hit like the circle that encloses
  it
- A locked feature refuses a style change ([Layers and groups](layers.md))
- A key that `FeatureStyle` does not define is kept, saved and loaded
  unchanged without a check, so an extension can store its own keys; the
  code that reads such a key checks its value

## Defaults

The look of a feature with no style of its own is set for the instance
with the option `style`, one `FeatureStyle` per kind: `point`, `line`,
`polygon`, `circle` and `image`. A key left out keeps the built-in
default.

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map, {
  style: {
    point: { pointColor: 'tomato', pointRadius: 6, pointShape: 'square' },
    line: { strokeColor: '#1e88e5', strokeWidth: 3 },
    polygon: { strokeColor: '#1a3380', fillColor: '#1a3380', fillOpacity: 0.15 },
  },
  previewStyle: { strokeColor: '#ff6f00' },
  selectionStyle: {
    boxSelection: {
      fillColor: '#ff6f00',
      fillOpacity: 0.1,
      strokeColor: '#ff6f00',
      strokeWidth: 1,
    },
  },
});
```

- `previewStyle` is the look of the shape being drawn: its stroke keys
  give its lines and the outlines of its vertices, its point keys its
  vertices
- `selectionStyle` is the look of the box around the selection and of its
  handles (resize, rotate, vertex, midpoint and radius handles, the center
  of a circle and the box of a box selection). Each part you give
  replaces the default of that part, so give it whole. Its colors are CSS
  colors and its sizes CSS pixels
- `circle` falls back to `polygon` when it is left out, and `image` takes
  only `imageOpacity`

Every one of them can change while the instance runs. `options.update`
merges what you give into the values already set:

```ts
draw.options.update({ style: { polygon: { fillOpacity: 0.4 } } });
draw.options.update({ scaleWithZoom: false });
```

## Style rules

A layer's `styleRule` derives a color from the properties of each feature.
There are four kinds:

| `kind` | Use | Fields besides `property` and `other` |
| --- | --- | --- |
| `single` | one color for every feature | `color` only |
| `categorical` | a color per value | `map` |
| `graduated` | classes by breaks | `breaks`, `colors` |
| `continuous` | a ramp between two colors | `min`, `max`, `ramp` |

<!-- docs-check:
declare const otherLayerId: string;
-->

```ts
draw.layers.update(layerId, {
  styleRule: {
    kind: 'graduated',
    property: 'population',
    breaks: [1000, 5000, 10000],
    colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#2171b5'],
    other: '#cccccc',
  },
});

draw.layers.update(otherLayerId, {
  styleRule: {
    kind: 'continuous',
    property: 'height',
    min: 0,
    max: 300,
    ramp: ['#fff5eb', '#7f2704'],
    other: '#cccccc',
  },
});

// Remove the rule
draw.layers.update(layerId, { styleRule: undefined });
```

- Write the colors of a rule as `#rrggbb`
- `categorical` matches strings, numbers and booleans by their text
  (`String(value)`) against the keys of `map`
- `graduated` takes n ascending `breaks` and n + 1 `colors`: a value below
  `breaks[i]` gets `colors[i]`, and a value below none of them gets the
  last color
- `continuous` blends the two colors of `ramp` from `min` to `max` in the
  OKLab color space, so the middle does not turn muddy; values out of
  range take the color of the nearer end
- `styleRule` is an ordinary field of the layer: it is saved with the
  document, and a change of it arrives as `layer.updated` like any other
  change

A dataset takes the same rule type; see
[Showing large data](large-data.md).

## Which color wins

1. The feature's own color for its channel: `pointColor` for points,
   `strokeColor` for lines, `fillColor` for areas and other types
2. The layer's rule
3. The default of the instance

- The rule colors one channel only. An area gets its fill from the rule
  and keeps the default outline unless its style sets `strokeColor`
- Style keys other than the color (width, opacity, line style) apply
  together with the rule color
- A feature that lacks the property, or whose value does not fit the rule,
  gets `other`, not the default, so "no value" can be told from "no rule"
- `graduated` and `continuous` accept numbers only; a numeric string gets
  `other`

`features.getAppliedStyle(id)` returns the look a feature is drawn with,
every key filled in, which an inspector panel can show:

```ts
const look = draw.features.getAppliedStyle(featureId);
if (look) console.log(look.fillColor, look.strokeWidth, look.lineStyle);
```

The evaluation is also exposed as pure functions for other uses, such as
coloring a table row the same way as the map:

<!-- docs-check:
declare const rule: import('@sakuzu/maplibre-gl-draw').StyleRule;
-->

```ts
import { evaluateStyleRule, getStyleRuleChannel } from '@sakuzu/maplibre-gl-draw';

const color = evaluateStyleRule(rule, feature.properties);
const channel = getStyleRuleChannel(feature.type); // 'point', 'stroke' or 'fill'
```

## Legends

`deriveLegend(rule)` turns a rule into label and color pairs. The library
draws no legend; the host builds it.

```ts
import { deriveLegend } from '@sakuzu/maplibre-gl-draw';

const layer = draw.layers.get(layerId);
const entries = layer?.styleRule ? deriveLegend(layer.styleRule) : [];

const list = document.querySelector('#legend');
list?.replaceChildren(
  ...entries.map(({ label, color }) => {
    const item = document.createElement('li');
    item.style.setProperty('--swatch', color);
    item.textContent = label;
    return item;
  }),
);
```

| `kind` | Entries (English defaults) |
| --- | --- |
| `single` | `All` |
| `categorical` | the keys of `map` in order, then `Other` |
| `graduated` | `Below 1000`, `1000 to below 5000`, ..., `Other` |
| `continuous` | `min`, `max`, then `Other` |

Numbers are written with `String()`; digit separators and units are left
to the host.

## Messages

Every string the library returns as a value (the legend labels, the
descriptions of the snapping guides) comes from a table of messages. The
defaults are in English, the only language the library ships. Replace
entries for an instance with the option `messages`; the entries left out
keep the English default.

<!-- docs-check:
declare const rule: import('@sakuzu/maplibre-gl-draw').StyleRule;
-->

```ts
import { createDraw, deriveLegend } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map, {
  messages: {
    legendOther: 'Autres',
    legendBelow: (upper) => `Moins de ${upper}`,
  },
});

// The table can change later
draw.options.update({ messages: { legendAll: 'Tout' } });

// deriveLegend has no instance, so it takes the table as an argument
deriveLegend(rule, { legendOther: 'Autres' });
```

A value is a string or a function that formats one from numbers already
turned into strings. The table belongs to the instance, so two maps on a
page can use different languages. There is no locale detection.

The words of the names the library gives new features, layers and groups
(`Layer 1`) are not in this table. Translate them with the option
`autoName` ([Drawing and editing](drawing.md)).

## Examples

- [style-rules](../../examples/style-rules/) gives a layer each kind
  of rule, builds a legend with `deriveLegend`, and sets the options
  `style` and `messages`

## Reference

- [`FeatureStyle`](../api/maplibre-gl-draw/interfaces/FeatureStyle.md)
  and
  [`FeatureStyleResolved`](../api/maplibre-gl-draw/type-aliases/FeatureStyleResolved.md)
- [`StyleRule`](../api/maplibre-gl-draw/type-aliases/StyleRule.md)
- [`deriveLegend`](../api/maplibre-gl-draw/functions/deriveLegend.md)
  and [`LegendEntry`](../api/maplibre-gl-draw/interfaces/LegendEntry.md)
- [`evaluateStyleRule`](../api/maplibre-gl-draw/functions/evaluateStyleRule.md)
  and
  [`getStyleRuleChannel`](../api/maplibre-gl-draw/functions/getStyleRuleChannel.md)
- [`RuntimeOptions`](../api/maplibre-gl-draw/interfaces/RuntimeOptions.md)
  (`style`, `previewStyle`, `selectionStyle`, `scaleWithZoom`,
  `messages`) and
  [`SelectionStyleOptions`](../api/maplibre-gl-draw/interfaces/SelectionStyleOptions.md)
- [`Messages`](../api/maplibre-gl-draw/interfaces/Messages.md)
