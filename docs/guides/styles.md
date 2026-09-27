# Styles

A feature's look comes from three places: its own `style`, the style rule
of its layer, and the defaults of the instance. This guide covers each of
them, the order in which they apply, the legend a rule gives, and the
strings the library returns, which a host can replace for its language.

## Minimal code

```ts
// Color the features of a layer by an attribute
draw.updateLayer(layerId, {
  styleRule: {
    kind: 'categorical',
    property: 'landuse',
    map: { park: '#4caf50', water: '#2196f3' },
    other: '#9e9e9e',
  },
});

// One feature keeps its own color whatever the rule says
draw.updateFeature(featureId, { style: { fillColor: '#ff9800' } });
```

The rule is evaluated when the layer is drawn, so a feature whose
`landuse` changes takes its new color at once, without touching `style`.

## A feature's own style

`Feature.style` is a `FeatureStyle`. Every key is optional; a key left out
takes the rule color or the default.

| Types | Keys |
| --- | --- |
| points | `pointColor`, `pointRadius`, `pointShape` |
| lines | `strokeColor`, `strokeOpacity`, `strokeWidth`, `lineStyle` |
| areas | the line keys, `fillColor`, `fillOpacity` |
| `Image` | `imageOpacity` |

Points are `Point` and `MultiPoint`; lines are `LineString`,
`MultiLineString` and `Freehand`; areas are `Polygon`, `MultiPolygon` and
`Circle`.

```ts
draw.addFeature({
  type: 'LineString',
  coordinates: [
    [139.7, 35.68],
    [139.71, 35.69],
  ],
  style: { strokeColor: '#1e88e5', strokeWidth: 4, lineStyle: 'dashed' },
});
```

- Colors are `#rgb` or `#rrggbb`; opacities run from 0 to 1
- `lineStyle` is `solid`, `dashed` or `dotted`
- `strokeWidth` is in pixels at the zoom the feature was drawn at
  (`properties.createdZoom`), and the line then grows and shrinks with the
  map like its geometry, like a line drawn on paper. The drawing modes
  write `createdZoom` unless the instance is created with
  `scaleWithZoom: false`. A feature without `createdZoom` (one added
  through the API, or drawn with that option) keeps its width in pixels on
  the screen at every zoom
- A point keeps its size on screen at every zoom
- `pointShape` is `circle`, `square`, `triangle` or `star`, and wins over
  the `shape` of the defaults, so the points of one instance can mix
  shapes. Whatever the shape, a point is hit like the circle that encloses
  it
- A locked feature refuses a style change ([Layers and groups](layers.md))
- A key that `FeatureStyle` does not define is kept, saved and loaded
  unchanged without a check, so an extension can store its own keys; the
  code that reads such a key checks its value

## Defaults

The look of a feature with no style of its own, and of the preview while
drawing, is set once for the instance with `Options.style`. Colors here
are RGBA arrays with components from 0 to 1.

```ts
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map, {
  style: {
    lineString: {
      stroke: {
        width: 3,
        color: [0.12, 0.53, 0.9, 1],
        opacity: 1,
        lineStyle: 'solid',
      },
    },
  },
});
```

The groups are `point`, `lineString`, `polygon` (with `stroke` and `fill`)
and `tentative` (the drawing preview). The selection frame and handles are
set with `Options.selectionStyle`, and the box of a box selection with
`Options.renderingStyle`. The default values are listed on the types
([`FeatureStyleConfig`](../api/maplibre-gl-draw/interfaces/FeatureStyleConfig.md),
[`SelectionUIConfig`](../api/maplibre-gl-draw/interfaces/SelectionUIConfig.md)).

The `shape` of `point` (the shape of a point whose style names no
`pointShape`) and of the handles is `circle`, `square`, `triangle`
(a vertex pointing up) or `star` (five points, a tip pointing up). The
triangle and the star fit inside the circle of the same `size` and stroke,
their stroke is drawn inside that outline, and they are hit like that
circle. `icon` is a name for an extension renderer to draw; the built-in
renderers draw it as a circle.

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
draw.updateLayer(layerId, {
  styleRule: {
    kind: 'graduated',
    property: 'population',
    breaks: [1000, 5000, 10000],
    colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#2171b5'],
    other: '#cccccc',
  },
});

draw.updateLayer(otherLayerId, {
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
draw.updateLayer(layerId, { styleRule: undefined });
```

- `categorical` matches strings, numbers and booleans by their text
  (`String(value)`) against the keys of `map`
- `graduated` takes n ascending `breaks` and n + 1 `colors`: a value below
  `breaks[i]` gets `colors[i]`, and a value below none of them gets the
  last color
- `continuous` interpolates the two colors of `ramp` from `min` to `max`
  in the OKLab color space, so the middle does not turn muddy; values out
  of range are clamped
- `styleRule` is an ordinary field of the layer: it is saved, exported in
  the native format, and notified by `draw.layer.update` like any other
  change

A dataset takes the same rule type; see
[Large data](large-data.md).

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

The evaluation is exposed as pure functions for other uses, such as
coloring a table row the same way as the map:

<!-- docs-check:
declare const rule: import('@sakuzu/maplibre-gl-draw').StyleRule;
-->

```ts
import {
  evaluateStyleRule,
  getStyleRuleChannel,
  resolveFeatureStyle,
} from '@sakuzu/maplibre-gl-draw';

const color = evaluateStyleRule(rule, feature.properties); // '#RRGGBB'
const style = resolveFeatureStyle(
  feature,
  rule,
  getStyleRuleChannel(feature.type),
);
```

## Legends

`deriveLegend(rule)` turns a rule into label and color pairs. The library
draws no legend; the host builds it.

```ts
import { deriveLegend } from '@sakuzu/maplibre-gl-draw';

const layer = draw.getLayer(layerId);
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
default is `MESSAGES_EN`, in English, the only language the library ships.
Replace entries for an instance with `Options.messages`; the entries left
out keep the English default.

<!-- docs-check:
declare const rule: import('@sakuzu/maplibre-gl-draw').StyleRule;
-->

```ts
const draw = createMapLibreGLDraw(map, {
  messages: {
    legendOther: 'Autres',
    legendBelow: (upper) => `Moins de ${upper}`,
  },
});

// deriveLegend has no instance, so it takes the table as an argument
deriveLegend(rule, { legendOther: 'Autres' });
```

A value is a string or a function that formats one from numbers already
turned into strings. The table belongs to the instance, so two maps on a
page can use different languages. There is no locale detection.

The words of the names the library gives new features, layers and groups
(`Layer 1`) are not in this table. Translate them with `Options.autoName`
([Automatic names](drawing.md#names-in-another-language)).

## Examples

- [style-rules](../../examples/style-rules/) gives layers each kind
  of rule, builds a legend with `deriveLegend`, and sets `Options.style`
  and `Options.messages`

## Reference

- [`FeatureStyle`](../api/maplibre-gl-draw/interfaces/FeatureStyle.md)
- [`StyleRule`](../api/maplibre-gl-draw/type-aliases/StyleRule.md)
- [`deriveLegend`](../api/maplibre-gl-draw/functions/deriveLegend.md)
  and [`LegendEntry`](../api/maplibre-gl-draw/interfaces/LegendEntry.md)
- [`evaluateStyleRule`](../api/maplibre-gl-draw/functions/evaluateStyleRule.md)
  and
  [`resolveFeatureStyle`](../api/maplibre-gl-draw/functions/resolveFeatureStyle.md)
- [`FeatureStyleConfig`](../api/maplibre-gl-draw/interfaces/FeatureStyleConfig.md)
- [`Messages`](../api/maplibre-gl-draw/interfaces/Messages.md) and
  [`MESSAGES_EN`](../api/maplibre-gl-draw/variables/MESSAGES_EN.md)
