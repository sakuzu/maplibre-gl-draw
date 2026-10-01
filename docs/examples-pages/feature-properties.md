---
aside: false
---

# Feature properties

The attributes of features: the keys and the values of their
`properties`, loaded from GeoJSON, changed in the panel and from code.

```example
feature-properties
```

The page opens with the market hall selected. Open the Attributes tab
of the panel on the right to see its attributes: a value can be changed
where it stands, removed, or added with a new key. A value typed there
is kept as the string typed. Select the library or the avenue to see
theirs. Each change, from the panel or from code, is logged in the
browser console.

## Code

`draw.document.load` reads the GeoJSON, and each feature keeps its
properties (2). `draw.features.update` merges `properties` key by key,
and a key given as `undefined` is removed (3); the panel writes its
changes with the same call. `feature.updated` carries the feature before
and after each change (1). The keys of the library, which begin with
`maplibre-gl-draw:`, live in the same properties, and `isDrawProperty`
tells them apart.

::: code-group
<<< @/../examples/feature-properties/main.ts
<<< @/../examples/feature-properties/data.ts
<<< @/../examples/feature-properties/index.html
:::

## Related

- [Properties](../reference/data-format.md#properties) in the data
  format: the keys of the library and how GeoJSON properties are read
- [`features.update`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md#update),
  which merges `properties` key by key
- [`document.load`](../api/maplibre-gl-draw/interfaces/DocumentResource.md#load)
- [The events of features](../reference/events.md#features),
  `feature.updated` among them
- [The inspector](../../ui/README.md#inspector) of the standard UI
