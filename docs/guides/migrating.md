# Migrating to 2.0

This guide moves an app and an extension written for 1.0 to 2.0. The
[migration table](../../CHANGELOG.md#migration-table) in the change log
lists every name; this page shows the patterns behind them.

## What changed and why

In 1.0 the instance had 81 methods side by side, named in several
styles, and each kind of extension was registered its own way. 2.0
groups the methods under the things they act on (features, layers,
groups, the selection, the document), and every collection has the
same standard methods. Writes return what they wrote, a wrong argument
throws a `DrawError`, and a refusal for the state returns `null` or
`false`. A feature holds GeoJSON, so what you pass in is what you get
back and what the GeoJSON export writes. Every 1.0 name changes and
none is kept as an alias, so an app is migrated in one step.

## The shape of 2.0

`createDraw(map, options)` returns a `Draw`. Its methods live on
resources:

- The collections are plural: `draw.features`, `draw.layers`,
  `draw.groups`, `draw.datasets`, `draw.hidden`, and the collections of
  `draw.extensions`
- A collection that records (features, layers, groups) has the eleven
  standard methods `get`, `getMany`, `list`, `count`, `has`, `create`,
  `createMany`, `update`, `updateMany`, `delete` and `deleteMany`. A
  collection of things added and removed (datasets, hidden items,
  extensions) has `get`, `list`, `count`, `has`, `add`, `addMany`,
  `remove` and `removeMany`
- The single resources are singular: `draw.selection`,
  `draw.vertexSelection`, `draw.metadata`, `draw.options` and
  `draw.document`
- What the standard methods cannot say is a verb on the collection:
  `features.move`, `layers.reorder`, `features.union`, `features.split`.
  `get` and `set` in a verb are only for the state of the resource
  (`layers.getActive`, `layers.setActive`)
- What is not a resource stays on `draw`: `getMap`, `getMode`,
  `setMode`, `setReadOnly`, `transact`, `on`, `off`, `once`, `destroy`

Four rules hold everywhere:

- `create` and `update` return the resource they wrote. `update(id,
  patch)` changes only the keys given; `properties` and `style` merge
  key by key, and `undefined` removes a key
- A method on several items (`createMany`, `deleteMany`, `moveMany`)
  is one transaction: all of them change, or none
- A wrong argument (an unknown ID, an input of the wrong shape) throws
  a `DrawError` with a `code` (`not-found`, `already-exists`,
  `invalid-input`, `unsupported-format`, `invalid-state`). A write
  refused because of the state (read-only, a lock) returns `null` or
  `false`. In both cases nothing changes
- Events are named `resource.pastParticiple`: `feature.created`,
  `layer.reordered`, `selection.changed`. Apps and plugins subscribe to
  the same list, `DrawEvents`. `document.changed` arrives once per
  transaction with every change to the document, and the events of
  features, layers, groups and metadata carry the `source` of the
  write

A feature is `{ id, type, geometry, layerId, groupId, properties,
style, visible, locked }`. `geometry` is a GeoJSON geometry, and
`properties` are the GeoJSON properties. The library keeps its own
values there under keys that start with `maplibre-gl-draw:`
(`maplibre-gl-draw:rotation`); every other key is yours.
`isDrawProperty(key)` tells them apart.

## Migrating an app

### Install

Update the package, then let the type checker list the calls to
change:

```sh
npm install @sakuzu/maplibre-gl-draw@^2.0.0
```

A file saved by 1.0 (native format 2.x) loads as it is: it is upgraded
to the format 3.0.0 on load.

### Create the instance

<!-- docs-check: skip -->

```ts
// 1.0
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map, { defaultMode: 'select' });
```

```ts
// 2.0
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map, { defaultMode: 'select' });
```

The mode names (`select`, `draw_point`, `draw_line`, `draw_polygon`,
`draw_circle`, `draw_freehand`, `draw_image`) do not change. `setMode`
throws a `DrawError` for a mode it does not know.

### Features

<!-- docs-check: skip -->

```ts
// 1.0
const id = draw.addFeature({
  type: 'Point',
  coordinates: [139.767, 35.681],
  properties: { name: 'Station' },
});
if (id) {
  const point = draw.getFeature(id);
  draw.updateFeature(id, {
    properties: { ...point?.properties, visited: true },
  });
  draw.deleteFeature(id);
}
```

```ts
// 2.0
const point = draw.features.create({
  type: 'Point',
  geometry: { type: 'Point', coordinates: [139.767, 35.681] },
  properties: { name: 'Station' },
});
if (point) {
  draw.features.update(point.id, { properties: { visited: true } });
  draw.features.delete(point.id);
}
```

`create` returns the `Feature`, or `null` when the instance is
read-only. `update` merges the patch, so `name` stays. A patch cannot
change the ID, the type or the layer; `features.move` moves a feature.

The lists take a filter in place of separate methods:

```ts
const all = draw.features.list();
const visible = draw.features.list({ visible: true });
const inLayer = draw.features.count({ layerId });
```

`deleteAllFeatures()` becomes `deleteMany` with every ID:

```ts
draw.features.deleteMany(draw.features.list().map((f) => f.id));
```

An unknown ID throws, where 1.0 threw a plain `Error` or did nothing:

```ts
import { DrawError } from '@sakuzu/maplibre-gl-draw';

try {
  draw.features.update(featureId, { visible: false });
} catch (error) {
  if (error instanceof DrawError && error.code === 'not-found') {
    console.warn('the feature is gone');
  } else {
    throw error;
  }
}
```

### Layers and groups

<!-- docs-check: skip -->

```ts
// 1.0
const roadsId = draw.addLayer('Roads');
if (roadsId) {
  draw.setActiveLayer(roadsId);
  draw.moveToLayer(featureId, roadsId);
  draw.setLayerOrder([...draw.getLayerOrder()].reverse());
}
const groupId = draw.addGroup([featureId], layerId, 'Block');
draw.removeFeatureFromGroup(featureId);
```

```ts
// 2.0
const roads = draw.layers.create({ name: 'Roads' });
if (roads) {
  draw.layers.setActive(roads.id);
  draw.features.move(featureId, { layerId: roads.id });
  draw.layers.reorder(draw.layers.list().map((l) => l.id).reverse());
}
const block = draw.groups.create({ featureIds: [featureId], name: 'Block' });
draw.features.move(featureId, { groupId: null });
```

`features.move` and `groups.move` take a `MoveTarget`: `{ layerId,
index? }` or `{ groupId, index? }`, where `index` 0 is the back and a
missing `index` is the front. `{ groupId: null }` takes a feature out of
its group and puts it just in front of the group. `Layer.order` is
`Layer.items` and is read-only: change it with `move`. A group has the
`layerId` of its layer. `groups.delete` dissolves a group and keeps its
features, as `ungroupGroup` did. `layers.getActive()` returns the
`Layer`, not its ID.

### Selection and hidden items

<!-- docs-check: skip -->

```ts
// 1.0
draw.select([featureId]);
const ids = draw.getSelectedIds();
draw.deselect();
draw.setLocallyHidden(layerId, true);
```

```ts
// 2.0
draw.selection.set('feature', [featureId]);
const ids = draw.selection.get().ids;
draw.selection.clear();
draw.hidden.add(layerId);
```

`selection.set` takes the type first. `selection.group()` returns the
new `Group`, and `selection.delete()` deletes what is selected.

### Load and export

<!-- docs-check: skip -->

```ts
// 1.0
await draw.load(file);
const native = draw.export('native').data; // a string
const geojson = JSON.parse(draw.export('geojson').data);
```

<!-- docs-check:
declare const file: File;
-->

```ts
// 2.0
const result = await draw.document.load(file); // null when read-only
const native = JSON.stringify(draw.document.toJSON());
const geojson = draw.document.toGeoJSON();
```

`toJSON()` returns the document object (`DrawDocument`) and
`toGeoJSON()` a FeatureCollection; serialize them yourself, and name
the file in the app. `load` takes a `File`, a string, the native
document or GeoJSON (a FeatureCollection, a Feature or a geometry).
`options.mode` chooses between replacing the document (`replace`, the
default for the native format) and adding to it (`merge`, the default
for GeoJSON).

The GeoJSON export writes `properties` as they are stored, so the
values of the library appear under the `maplibre-gl-draw:` prefix. A
reader that wants only your attributes drops the keys for which
`isDrawProperty(key)` is true.

### Events

<!-- docs-check: skip -->

```ts
// 1.0
draw.on('draw.feature.create', ({ feature }) => console.log(feature.id));
draw.on('draw.features.change', () => save());
```

<!-- docs-check:
declare function save(): void;
-->

```ts
// 2.0
draw.on('feature.created', ({ feature, source }) => {
  console.log(feature.id, source);
});
const stop = draw.on('document.changed', () => save());
```

`on` returns the function that unsubscribes, and `once` subscribes to
one occurrence. `document.changed` covers layers, groups and metadata
too. To make several writes one change, wrap them in `transact`:

```ts
draw.transact(
  () => {
    draw.features.update(featureId, { visible: false });
    draw.layers.update(layerId, { opacity: 0.5 });
  },
  { source: 'toolbar' },
);
```

`draw.geometry.applied` is gone: `features.union` and the other
operations return their result.

### Options

<!-- docs-check: skip -->

```ts
// 1.0
const draw = createMapLibreGLDraw(map, {
  snap: { enabled: true },
  trace: { enabled: false },
  pixelRatio: 2,
});
draw.snapping.setEnabled(false);
draw.setRenderScale(0.5);
```

```ts
// 2.0
const draw = createDraw(map, {
  snapping: { enabled: true },
  tracing: { enabled: false },
  rendering: { pixelRatio: 2 },
  style: { polygon: { fillColor: '#3b82f6', fillOpacity: 0.3 } },
});
draw.options.update({ snapping: { enabled: false } });
draw.options.update({ rendering: { renderScale: 0.5 } });
```

Every option but `defaultMode`, `store` and `initDefaultLayer` can
change at run time through `draw.options`. The default styles are keyed
`point`, `line`, `polygon`, `circle` and `image`, with the keys of
`FeatureStyle`, and every color is a CSS color string. The look of the
shape being drawn is `previewStyle` (`style.tentative` in 1.0), and the
look of the selection box is `selectionStyle.boxSelection`
(`renderingStyle.boxSelectionStyle` in 1.0).

### Datasets

<!-- docs-check: skip -->

```ts
// 1.0
const places = draw.addDataset({ id: 'places', features });
places.on('click', ({ feature }) => console.log(feature.properties));
```

<!-- docs-check:
declare const rows: import('@sakuzu/maplibre-gl-draw').DatasetRow[];
-->

```ts
// 2.0
const places = draw.datasets.add({ id: 'places', rows });
places.on('clicked', ({ row }) => console.log(row.properties));
```

A dataset takes GeoJSON features in `rows`, a table in `table`, or a
`provider`. Its members use the word row: `setRows`, `setTable`,
`getRow`, `listRows`, `getSelectedRowIds`. `draw.datasets.remove(id)`
removes it. For a large table read in a Worker, the subpath
`@sakuzu/maplibre-gl-draw/columnar` is `@sakuzu/maplibre-gl-draw/table`:

<!-- docs-check:
declare const features: import('geojson').Feature[];
-->

```ts
import { prepareTable, tableFromFeatures } from '@sakuzu/maplibre-gl-draw/table';

const prepared = prepareTable(tableFromFeatures(features));
draw.datasets.add({ id: 'parcels', table: prepared });
```

### Geometry

`@sakuzu/maplibre-gl-draw/geometry` takes and returns GeoJSON, uses the
names of Turf, and measures in meters:

<!-- docs-check: skip -->

```ts
// 1.0
import {
  haversineDistanceMeters,
  sphericalArea,
  unionAll,
} from '@sakuzu/maplibre-gl-draw/geometry';
```

```ts
// 2.0
import { area, distance, union } from '@sakuzu/maplibre-gl-draw/geometry';

const meters = distance([139.7, 35.6], [139.8, 35.7]);
const polygons = draw.document
  .toGeoJSON()
  .features.filter((f) => f.geometry?.type === 'Polygon');
const merged = union(polygons);
if (merged) console.log(area(merged), 'm²');
```

Where 1.0 had a two-argument form and an `All` form, 2.0 has one
function that takes an array (`union`, `intersection`, `difference`).
`circle` replaces `generateCirclePolygon`, which is no longer exported
from the main entry. `EARTH_RADIUS_METERS` is 6371008.8, so lengths
and areas differ slightly from 1.0.

The operations that change the document are methods of `features`:
`features.union(ids)`, `features.difference(id, ids)`,
`features.intersection(ids)`, `features.split(id, lineId)` and
`features.buffer(ids, { distanceMeters })`. They take the IDs (pass
`draw.selection.get().ids` for the selection) and return the features
they made.

## Migrating an extension

### Plugins

<!-- docs-check: skip -->

```ts
// 1.0
const plugin: Plugin = {
  name: 'logger',
  onInstall(ctx) {
    ctx.on('feature.create', ({ feature }) => console.log(feature.id));
  },
  hooks: {
    'drag:end': ({ featureIds }) => console.log(featureIds),
  },
  onKeyDown(event) {
    return event.key === 'l';
  },
};
draw.addPlugin(plugin);
```

```ts
// 2.0
import type { Plugin } from '@sakuzu/maplibre-gl-draw';

const logger: Plugin = {
  name: 'logger',
  onAdd(ctx) {
    ctx.on('feature.created', ({ feature }) => console.log(feature.id));
    ctx.on('drag.ended', ({ featureIds }) => console.log(featureIds));
  },
  input: {
    onKeyDown: (event) => event.key === 'l',
  },
};
const removeLogger = draw.extensions.plugins.add(logger);
```

- `onInstall` and `onUninstall` are `onAdd` and `onRemove`
- `hooks` are events: `ctx.on` takes the names of `DrawEvents`, and
  the subscriptions end when the plugin is removed. `drag:start` and
  `drag:end` are `drag.started` and `drag.ended`
- The input receivers move to `input` (`onKeyDown`, `onPointerMove`,
  `onDrag`, `onPointerLeave`), and returning true consumes the event
- `filterSelection`, `onFeatureClick`, `onFeatureDoubleClick`,
  `onFeatureCreated` and the exclusive interaction (`isInteracting`,
  `finishInteraction`, `cancelInteraction`, `getInteractionContainer`)
  move to `interaction` as `filterSelection`, `onFeatureClick`,
  `onFeatureDoubleClick`, `onDrawCommit`, `isBusy`, `finish`, `cancel`
  and `container`. The click receivers get the `Feature` and the event
- `Plugin.modes` goes: add modes with `ctx.extensions.modes.add`
- Plugins talk to each other through `api`, read with
  `draw.extensions.plugins.getApi(name)`. `emit` is gone

### Contexts

Every kind of extension gets one context. They share
`ExtensionContext`:

- `draw`, the whole public API. Read and write the document through
  it; `ctx.draw.features.update` replaces `ctx.updateFeature`, and
  `ctx.draw.transact(fn, { source })` replaces `ctx.batch` and the
  `source` argument of each write
- `store`, a `StoreView` to read and subscribe to
- `on`, `off` and `once`, ended with the extension
- `terrain`, with `project`, `elevation`, `ghostOpacity` and
  `generation` (`projectAnchor`, `anchorElevationMeters` and
  `getAnchorElevationGeneration` in 1.0)
- `names`, whose `next(type)` gives the automatic name
- `screen`, with `project`, `unproject`, `bounds(feature)`, `zoom` and
  `pixelRatio` (`bounds` replaces `computeBoundingBox`)
- `invalidate({ type, ids })`, which redraws (`invalidateFeatures`)
- `drawing`, with `undoVertex()`, `redoVertex()` and `isDrawing()`,
  for the vertices of the shape being drawn (`undoVertex` and
  `redoVertex` of the 1.0 `PluginContext`), and `cancel()`, which
  cancels the shape

A `PluginContext` adds `extensions`, the collections of
`draw.extensions`. What a plugin adds there is removed with the
plugin.

### Modes, feature types, overlays and providers

Every kind is added with `draw.extensions.<kind>.add` (or
`ctx.extensions` in a plugin), which returns the function that removes
it:

| 1.0 | 2.0 |
| --- | --- |
| `registerMode(name, factory)` | `extensions.modes.add(name, factory)` |
| `registerFeatureHandler` | `extensions.featureTypes.add` |
| `addOverlayRenderer` | `extensions.overlays.add` |
| `snapping.register` | `extensions.snapProviders.add` |
| `registerAuxiliaryHandleProvider` | `extensions.handleProviders.add` |
| `registerFeatureCompanionProvider` | `extensions.companionProviders.add` |

A mode factory receives its `ModeContext`, and its handler has
`onEnter` and `onExit` in place of `onStart` and `onStop`. Pointer
input arrives as `DrawPointerEvent` (`point`, `lngLat`, `snapped`,
`modifiers`, `pointerType`, `original`) in `onPointerDown`,
`onPointerMove`, `onPointerUp`, `onClick`, `onDoubleClick`,
`onDragStart`, `onDrag`, `onDragEnd` and `onDragCancel`, and keys as
`DrawKeyEvent`. The context gives a mode `hitTest(point)` and
`snap(point)` in place of the hit test services, and
`commitFeature(input)`, which gives a new feature its ID, layer,
automatic name and reference zoom the way the built-in modes do.
`preview.set` shows the shape being drawn, `cursor.set` changes the
cursor, and `listTraceRows(bbox)` gives the rows of datasets to trace
along (`getDatasetTraceFeatures`). On the handler, `writesFeatures` is
`writes`, `getSnapPreference` and `isSnapEnabledFor` are one
`snapPreference`, and `undoVertex` and `redoVertex` are `onUndoVertex`
and `onRedoVertex`.

<!-- docs-check: skip -->

```ts
// 1.0
draw.registerMode('draw_marker', () => ({
  modeName: 'draw_marker',
  onStart(context) {},
  onClick(event) {
    context.store.createFeature({ /* ... */ });
  },
}));
```

```ts
// 2.0
import type { ModeFactory } from '@sakuzu/maplibre-gl-draw';

const drawMarker: ModeFactory = (ctx) => ({
  onClick(event) {
    ctx.commitFeature({
      type: 'Point',
      geometry: { type: 'Point', coordinates: event.snapped.lngLat },
    });
    return true;
  },
});
draw.extensions.modes.add('draw_marker', drawMarker);
```

A custom feature type is a `FeatureTypeDefinition`: its `type`, the
`geometry` kind it holds, its `renderer`, and optional `hitTest`,
`boxSelect`, `bounds`, `outline`, `handles`, `onHandleDrag` and
`snapCandidates`.
Handles and snapping candidates of your own type belong there; a
`HandleProvider` or a `SnapProvider` is for adding them to a type that
is not yours. `onHandleDrag` and `HandleProvider.onDrag` return a
`FeaturePatch`. `candidateReachPx` is `hitPaddingPx`, and
`resizeStrategy` is gone: write a resize with `handles` and
`onHandleDrag`. A `HandleProvider` gives handles that belong to no
feature with `globalHandles` (`getGlobalHandles`), and a
`CompanionProvider` keeps `has` and takes clicks with `onClick`
(`onCompanionClick`).

### RenderContext

A renderer receives one `RenderContext` in place of
`CustomRendererDrawContext`. `onAdd` and `onRemove` take `(map, gl)`,
the order of a MapLibre custom layer.

| `CustomRendererDrawContext` | `RenderContext` |
| --- | --- |
| `shaderData` | `shader` |
| `mainMatrixArray` | `projection` |
| `centerLngLat` | `offset`, already computed |
| `sdfLineRenderer` | `line` |
| `fillShaderManager` | `fill` |
| `pointShapeRenderer` | `point` |
| `terrain`, `opacity`, `pixelRatio` | the same names |

An overlay draws with `draw(ctx)` (with `ctx.projection` and
`ctx.zoom`), between layers with `drawForLayer(layerId, ctx)` and at
the level of the vertices with `drawVertices(ctx)`; `order` sets its
place among the overlays. The
`offset` is computed for you, so a call to `calculateOffsetUniforms` is
no longer needed. The shared renderers draw with `draw(geometry,
style, options)`.

### The webgl entry

The building blocks for custom shaders move from the main entry to
`@sakuzu/maplibre-gl-draw/webgl`: `OFFSET_MODE_GLSL`,
`ProjectionUniformManager`, `createProgram`, `applyDrawBlendState`,
`QuadShader` and the rest. That entry may change in a minor release;
the main entry follows semver. `getStrokeDashPattern` and
`getTerrainTessellationStep` are `dashPattern` and
`terrainTessellationStep` there. `ShaderData` and `OffsetUniforms`,
the types of the fields of `RenderContext`, stay in the main entry.
The parts that draw on the terrain take the `RenderContext` of the draw
call (or its `terrain`) in place of the terrain state
(`FrameDrawContext.terrain`): write `setTerrain(ctx)`,
`terrainTessellationStep(ctx)` and `drawQuadSurfaceOnTerrain(ctx, ...)`,
and construct `ProjectionUniformManager` and `QuadShader` without a
terrain. `TerrainContext` and `TerrainRenderState` are not exported. The
pure math that 1.0 exported
(oriented boxes, conversions between pixels and degrees, contrast
colors) is not exported any more: keep your own copy.

### The Store

A replacement Store is still passed as `options.store`, and implements
`Store`. Its reads use the words of the instance: `listFeatures`,
`listFeaturesInOrder`, `listLayers`, `listGroups`, `listFiles`,
`getVertexSelection`, `isHidden` and `listHidden` in place of
`getAllFeatures`, `getOrderedFeatures`, `getAllLayers`,
`getAllGroups`, `getAllFiles`, `getSelectedVertices`,
`isLocallyHidden` and `getLocallyHidden`. `subscribe` delivers a
`DocumentChange`, the same type as `document.changed`, and replacing
the whole document is reported that way too. The state of the input
(the shape being drawn, the box selection, the drag) is no longer part
of the contract.

## The full table

The [migration table](../../CHANGELOG.md#migration-table) of the
change log maps every 1.0 name to 2.0: the instance methods, the
events, the options, the model, the extensions, the exports of the main
entry, `/geometry` and `/table`.

## From mapbox-gl-draw or terra-draw

The concepts carry over: modes, a store of features, events and custom
modes. There is no built-in toolbar; your UI calls `setMode`. Events
are subscribed on the draw instance, and they fire for writes made
through the API as well.

| mapbox-gl-draw | This library |
| --- | --- |
| `new MapboxDraw()`, `map.addControl(draw)` | `createDraw(map)` |
| `changeMode('simple_select')` | `setMode('select')` |
| `changeMode('direct_select', ...)` | `setMode('select')` |
| `changeMode('draw_line_string')` | `setMode('draw_line')` |
| `add(featureCollection)` | `document.load(featureCollection)` |
| `get(id)` | `features.get(id)` |
| `getAll()` | `document.toGeoJSON()` |
| `getSelectedIds()` | `selection.get().ids` |
| `delete(ids)` | `features.deleteMany(ids)` |
| `trash()` | `selection.delete()` |
| `setFeatureProperty(id, key, value)` | `features.update(id, patch)` |
| `draw.create`, `draw.update` | `feature.created`, `feature.updated` |
| `draw.delete` | `feature.deleted` |
| `draw.selectionchange` | `selection.changed` |
| `draw.modechange` | `mode.changed` |

| terra-draw | This library |
| --- | --- |
| `new TerraDraw({ adapter, modes })` | `createDraw(map)` |
| `setMode('linestring')` | `setMode('draw_line')` |
| `getSnapshot()` | `document.toGeoJSON()` |
| `addFeatures(features)` | `document.load(featureCollection)` |
| `removeFeatures(ids)` | `features.deleteMany(ids)` |
| `clear()` | `features.deleteMany(ids)` with every ID |
| `selectFeature(id)` | `selection.set('feature', [id])` |
| `on('change', ...)` | `on('document.changed', ...)` |

The select mode does the jobs of `simple_select` and `direct_select`:
the vertices of a selected feature can be dragged there. A feature
needs no `mode` property; its type decides. There is no built-in undo:
the events carry the previous state of every change (see
[save and load](save-load.md)).
