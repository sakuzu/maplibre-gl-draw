# Migrating from mapbox-gl-draw or terra-draw

The concepts carry over: modes, a store of features, events, and custom
modes. Three differences shape a migration:

- A feature is the library's own record
  (`{ id, type, coordinates, layerId, properties, style, locked,
  visible }`), not a GeoJSON Feature. Convert at the boundary with
  `load` (GeoJSON in) and `export('geojson')` (GeoJSON out)
- There is no built-in toolbar. Your UI calls `setMode`
- Events are subscribed on the draw instance with `draw.on`, not on the
  map, and they fire for changes made through the API as well

## The smallest example

<!-- docs-check:
declare const featureCollection: import('geojson').FeatureCollection;
-->

```ts
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map);

await draw.load(featureCollection); // GeoJSON in
draw.setMode('draw_polygon');

draw.on('draw.feature.create', ({ feature }) => {
  console.log(feature.id);
});

const { data } = draw.export('geojson'); // GeoJSON out, as a string
```

`load` returns a Promise. GeoJSON is added to what is already there;
the library's native format replaces it. `load` takes a
FeatureCollection; wrap a single Feature in one.

## From mapbox-gl-draw

| mapbox-gl-draw | This library |
| --- | --- |
| `new MapboxDraw()`, `map.addControl(draw)` | `createMapLibreGLDraw(map)` |
| `changeMode('simple_select')` | `setMode('select')` |
| `changeMode('direct_select', ...)` | `setMode('select')` (see below) |
| `changeMode('draw_point')` | `setMode('draw_point')` |
| `changeMode('draw_line_string')` | `setMode('draw_line')` |
| `changeMode('draw_polygon')` | `setMode('draw_polygon')` |
| `getMode()` | `getMode()` |
| `add(featureCollection)` | `load(featureCollection)` |
| `get(id)` | `getFeature(id)` (a record, not GeoJSON) |
| `getAll()` | `export('geojson')`, or `getAllFeatures()` |
| `getSelectedIds()` | `getSelectedIds()` |
| `getSelected()` | `getSelectedFeatures()` (records) |
| `delete(ids)` | `deleteFeature(id)` for each id |
| `deleteAll()` | `deleteAllFeatures()` |
| `trash()` in a select mode | `deleteSelection()` |
| `setFeatureProperty(id, key, value)` | `updateFeature` (below) |
| Custom mode objects | `registerMode(name, factory)` |
| The `styles` array of style layers | `style`, and `styleRule` per layer |

The select mode does both jobs of `simple_select` and `direct_select`:
the vertices of a selected line or polygon can be dragged there, so
there is no mode to switch into for vertices.

`updateFeature` replaces `properties` as a whole, so merge the old ones
in:

<!-- docs-check:
declare const id: string;
declare const key: string;
declare const value: unknown;
-->

```ts
const feature = draw.getFeature(id);
if (feature) {
  draw.updateFeature(id, {
    properties: { ...feature.properties, [key]: value },
  });
}
```

| mapbox-gl-draw event | This library |
| --- | --- |
| `draw.create` | `draw.feature.create` |
| `draw.update` | `draw.feature.update` |
| `draw.delete` | `draw.feature.delete` |
| `draw.selectionchange` | `draw.selection.change` |
| `draw.modechange` | `draw.mode.change` |

mapbox-gl-draw fires its events on the map with an array of features
and leaves out changes made through its API. Here, `draw.feature.*`
fires once per feature for every change, including `load` (1,000 loaded
features fire `draw.feature.create` 1,000 times).
`draw.features.change` reports all the changes of one transaction at
once, with the source of the change; use it when you only need to know
that something changed.

## From terra-draw

| terra-draw | This library |
| --- | --- |
| `new TerraDraw({ adapter, modes })`, `start()` | `createMapLibreGLDraw(map)` |
| `setMode('point')` | `setMode('draw_point')` |
| `setMode('linestring')` | `setMode('draw_line')` |
| `setMode('polygon')` | `setMode('draw_polygon')` |
| `setMode('circle')` | `setMode('draw_circle')` |
| `setMode('freehand')` | `setMode('draw_freehand')` |
| `setMode('select')` | `setMode('select')` |
| `getSnapshot()` | `export('geojson')`, or `getAllFeatures()` |
| `getSnapshotFeature(id)` | `getFeature(id)` (a record, not GeoJSON) |
| `addFeatures(features)` | `load({ type: 'FeatureCollection', features })` |
| `removeFeatures(ids)` | `deleteFeature(id)` for each id |
| `clear()` | `deleteAllFeatures()` |
| `selectFeature(id)` | `select(id)` |
| `on('change', ...)` | `on('draw.features.change', ...)` |
| `on('select', ...)` | `on('draw.selection.change', ...)` |

terra-draw needs a `mode` property on each added feature to know which
mode owns it. This library does not: the type of the feature decides,
and `properties` are kept as they are. All the built-in modes are
available without listing them; there is nothing to start.

terra-draw's `finish` event covers both the end of a drawing and the end
of a drag. Here the end of a drawing is `draw.feature.create`, and the
end of a drag is `draw.feature.update` (or the `drag:end` hook of a
[plugin](plugins.md)).

## What has no counterpart

- A built-in undo. The change notifications carry the previous state of
  every change (see [save and load](save-load.md))
- A toolbar or any other DOM control
- Styling through map style layers. Features are drawn in a WebGL custom
  layer; style them with `FeatureStyle` and style rules
  (see [styles](styles.md))

## Related examples

- [examples/basic/](../../examples/basic/) creates the instance,
  draws and subscribes to events
- [examples/save-load/](../../examples/save-load/) loads GeoJSON
  and exports it

## Reference

- [MapLibreGLDraw](../api/maplibre-gl-draw/interfaces/MapLibreGLDraw.md)
- [Feature](../api/maplibre-gl-draw/interfaces/Feature.md)
- [events](../reference/events.md)
