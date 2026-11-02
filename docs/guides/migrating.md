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
const visible = draw.features.list({ shown: true });
const inLayer = draw.features.count({ layerId });
```

`getVisibleFeatures()` becomes `list({ shown: true })`: the feature, its
group and its layer are all visible. `{ visible: true }` reads the
feature's own flag only.

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

Every option but `defaultMode`, `store`, `initDefaultLayer` and
`generateId` can change at run time through `draw.options`. The default
styles are keyed `point`, `line`, `polygon`, `circle` and `image`, with
the keys of `FeatureStyle`, and every color is a CSS color string. The look of the
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
- `drawing`, the same object as `draw.drawing`, with `undoVertex()`,
  `redoVertex()` and `isDrawing()` for the vertices of the shape being
  drawn (`undoVertex` and `redoVertex` of the 1.0 `PluginContext`),
  `cancel()`, which cancels the shape, and `addVertex`, `moveTo`,
  `finish` and `isActive`, which drive it from code

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
`boxSelect`, `bounds`, `outline`, `bbox`, `handles`, `onHandleDrag`
and `snapCandidates`.
Handles and snapping candidates of your own type belong there; a
`HandleProvider` or a `SnapProvider` is for adding them to a type that
is not yours. `onHandleDrag` and `HandleProvider.onDrag` return a
`FeaturePatch`. `candidateReachPx` is `hitPaddingPx`, and
`resizeStrategy` is gone: write a resize with `handles` and
`onHandleDrag`. A `HandleProvider` gives handles that belong to no
feature with `globalHandles` (`getGlobalHandles`), and is told of the
start and the end of a drag with `onDragStart` and `onDragEnd`
(`onHandleDragStart` and `onHandleDragEnd`); a definition has
`onHandleDragStart` and `onHandleDragEnd` for the same. A
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
the types of the fields of `RenderContext`, stayed in the main entry in
2.x; in 3.0 they are types of `/webgl`, with `viewUniforms(ctx)` that
gives them ([an extension in 3.0](#an-extension-in-30)).
The parts that draw on the terrain take the `RenderContext` of the draw
call (or its `terrain`) in place of the terrain state
(`FrameDrawContext.terrain`): write `setTerrain(ctx)`,
`terrainTessellationStep(ctx)` and `drawQuadSurfaceOnTerrain(ctx, ...)`,
and construct `ProjectionUniformManager` and `QuadShader` without a
terrain. `TerrainContext` and `TerrainRenderState` are not exported. The
pure math that 1.0 exported (oriented boxes, conversions between pixels
and degrees, contrast colors) is not exported any more: keep your own
copy. From 3.0, a size in pixels kept with a zoom is turned into a
length on the ground with `pixelsToMeters` of `/geometry`, and into
degrees with `metersToDegrees`, the formula the library draws by.

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

## From 2.0 to 2.1

Nothing to change. 2.1 adds the event `options.changed`,
`Dataset.getStyleRule()` and the standard UI package
`@sakuzu/maplibre-gl-draw-ui`, and fixes the order of the layers after a
diffed `map.setStyle` (the drawing stays on top of the new style, as the
documentation always said). An app that called `setStyle` with
`{ diff: false }` to work around that can keep doing so or drop it.

## From 2.x to 3.0

3.0 lets a store hold the features of a layer as rows of columns (see
[the change log](../../CHANGELOG.md#unreleased)). An app over the
default store changes in the places below, and an extension in those of
[an extension](#an-extension-in-30).

`Layer` and `Group` are unions told apart by `kind`. A layer held as rows
(`kind: 'table'`) has no `items`, and a group of it no `featureIds`.
Narrow by `kind` before reading them, or read the items of any layer by
position:

```ts
const layer = draw.layers.get(layerId);
if (layer && layer.kind !== 'table') console.log(layer.items);

// Any kind of layer, the first 50 items from the back
const items = draw.layers.listItems(layerId, { limit: 50 });
const members = draw.groups.listMembers(groupId);
```

The order inside a layer or a group is no longer in
`DocumentChange.layerReorder` and `groupReorder`. Every item put in
another place is in `DocumentChange.order`, with where it was and where
it is, by the items just below and above it (`ItemPosition`). The
`from` and `to` of `feature.moved` are `ItemPosition`s too, and it fires
for a move in the same layer or group as well; `group.moved` is new. A
change of the `items` of a layer or the `featureIds` of a group alone no
longer fires `layer.updated` nor `group.updated`: a view that follows
the order listens to `feature.moved` and `group.moved`, or to
`document.changed`.

```ts
draw.on('document.changed', (change) => {
  for (const move of change.order ?? []) {
    if (move.kind === 'item') console.log(move.itemId, move.from, move.to);
  }
});
```

`TableGeometry.dimensions` of a dataset takes the names of GeoArrow:
`'xy'` for `2` and `'xyz'` for `3`.

The values of `properties` are `Value`s. A date, a time and the id of
another feature are values of their own kinds (`CalendarDate`,
`DateTime`, `TimeOfDay`, `Reference`, ...), which `JSON.stringify`
writes as their JSON form (`{"$date": text}`). A `Date` is
refused with `invalid-input`, since it is an instant and a day given as
one shifts with the time zone: give a date-time or a day of its own. The
values and their kinds come from `@sakuzu/tabane`, which the library
depends on.

```ts
import { CalendarDate, DateTime } from '@sakuzu/tabane';

draw.features.update(featureId, {
  properties: {
    updated: DateTime.fromDate(new Date()), // an instant, UTC
    opened: CalendarDate.of(1998, 4, 1), // a day
  },
});
```

An extent in degrees is named `bbox` wherever it is, as in
`features.bbox`: `prepared.bbox` of a prepared table and
`dataset.getRowBBox(index)` were `bounds` and `getRowBounds`. The main
entry exports its type, `BBox`.

Two keys of `selectionStyle` are renamed, so that "box" names one thing:
the look of the box drawn around a selected feature, the selection box,
is `selectionStyle.box` (was `boundingBox`), and the look of the
rectangle a box selection drags (Shift and a drag) is
`selectionStyle.selectionRectangle` (was `boxSelection`).

```ts
draw.options.update({
  selectionStyle: {
    box: {
      stroke: { width: 1, color: '#ff6f00', opacity: 1, lineStyle: 'dashed' },
      margin: 6,
    },
    selectionRectangle: {
      fillColor: '#ff6f00',
      fillOpacity: 0.1,
      strokeColor: '#ff6f00',
      strokeWidth: 1,
    },
  },
});
```

The handles and markers of `selectionStyle` take the shapes the library
draws, `'circle'`, `'square'`, `'triangle'` and `'star'`. The shape
`'icon'` and its `iconId`, which the library drew as a circle, are gone:
give `'circle'` in their place.

A store of your own needs no change. A store that keeps the items of its
layers as lists makes `DocumentChange.order` from the lists before and
after with `diffItemOrder`.

### An extension in 3.0

The contract of the extensions is reworked so that an extension hands
positions on the map to the library, and the library answers what is
drawn. Each change below names what replaces what is gone.

- `bounds` and `outline` of a feature type, and `ctx.screen.bounds` and
  `ctx.screen.outline`, are gone: a type returns its `footprint`,
  four corners on the map (`{ kind: 'ground', corners }`) for a shape
  drawn on the map, or a box of a fixed size on the screen around a
  position (`{ kind: 'screen', position, halfWidthPx, halfHeightPx }`)
  for a mark that keeps its size, and the library makes the selection
  box from it. The kind, not the geometry, decides whether the box has
  the resize and rotate handles. `selectionStyle.boundingBox` is
  `selectionStyle.box`
- The resize and rotate handles of a footprint laid on the map are those
  of a built-in shape, and their drags, as every `rotate` and `scale`
  edit, write the fields a type declares in `transformFields`
  (`angleDegreesKey`, `scaleKey`, `uniformScale`), from 0 and 1 for a
  feature without them. A custom type has those fields and no other: a
  `maplibre-gl-draw:rotation` or `maplibre-gl-draw:scale` of its features
  is written only when the type names it there. A type that turned and
  grew its features from handles of its own (with `onHandleDrag`)
  declares its fields and leaves the corners and the rotation to the
  library. A definition given to `override` cannot have them
- `Handle.kind` says how a handle is shown, no longer a name the
  extension gives it (tell the handles apart by `id`): `'resize'` is
  drawn by the library as a resize handle and hit at its size, `'custom'`
  is drawn by the extension in `drawHandles` and hit within the `sizePx`
  it gives, the diameter of its mark. Another kind is left out with a
  warning. The library drew every handle as a white circle, the look of
  a vertex handle; a type that wants that look draws it in `drawHandles`
- `handles(feature, ctx)` and `globalHandles(ctx)` receive a
  `HandleContext` in place of the screen: `ctx.screen`, the selection box
  the library draws (`ctx.selectionBox`, the footprint with the margin,
  as `draw.rendered.getSelectionBox` answers; `null` for the handles of
  no feature) and the look of the selection (`ctx.selectionStyle`)
- The drag of a handle of a `HandleProvider` goes to `onHandleDrag`,
  `onHandleDragStart` and `onHandleDragEnd` (were `onDrag`,
  `onDragStart` and `onDragEnd`), the names of a definition

- What is drawn around a feature reads the feature as it is drawn from
  `ctx.draw.rendered` (`get`, `getMany`, `getSelectionBox`, and
  `getDraggedRows` for the rows dragged in bulk, which was
  `draggedRowsOf` of `/kasane`), and follows `rendered.changed`
- `HitTestContext` and `SnapContext` are one type, `PointContext`, whose
  `excludeIds` is absent when the reading leaves out nothing
- `ctx.drawing` is gone: `ctx.draw.drawing` is the same object
- `boxSelect(feature, boxPx, ctx)` names its box in pixels `boxPx`
- A `Hit` of a feature names it by `id` alone; `featureId` is the
  feature a companion belongs to. The kind `handle` is gone, as the
  library makes none
- The `hitTest` of a feature type returns the distance only,
  `{ distancePx }`, and the `hitTest` of a companion provider its ID and
  the distance, `{ id, distancePx }`; the library fills in the `Hit` it
  gives out (the kind, the ID of the feature, `featureId`)
- A plugin sends events of its own with `ctx.emit(event, payload)`,
  having declared them in `DrawEvents` by declaration merging, and they
  are subscribed to with `draw.on` as every event is
- `Plugin.interaction` is split by what each part does:
  `onFeatureCommit(feature)` (was `onDrawCommit`, named as
  `ModeContext.commitFeature`) is a member of the plugin, the clicks of
  the select mode are `selectMode` (`onSelectedFeatureClick`, was
  `onFeatureClick`, as it is called for a click on the feature selected
  alone only, and `onFeatureDoubleClick`), and the exclusive interaction
  is `exclusive`,
  whose `isActive()` (was `isBusy`) it must have, with `finish`, `cancel`
  and `container`
- What a type, its renderer and a companion provider answer and draw
  from the rows of a layer held as rows is in one member `rows` of each
  (experimental): `rows.appliesTo` was `appliesToRow`, `renderer.rows.draw`
  and `renderer.rows.sprites` were `drawRows` and `rowSprites`, and
  `rows.has` of a companion provider was `hasRow`
- The render context has the screen of the view it draws, `ctx.screen` (the
  same object as the `screen` of a plugin), in place of `ctx.zoom` and
  `ctx.pixelRatio`: read `ctx.screen.zoom` and `ctx.screen.pixelRatio`
- `ctx.screen` answers for the view drawn last (`project`, `unproject`,
  `zoom`, `metersPerPixel`), and the position of a pointer event is the
  position drawn under it: what is grabbed is what was drawn, also when
  the camera moved since
- The values of the GPU of the view are read through `/webgl`, not from
  the render context: `viewUniforms(ctx)` gives `shader`, `projection`
  and `offset` (were `ctx.shader`, `ctx.projection` and `ctx.offset`),
  `offsetUniformsAt(ctx, position)` the offsets from a position (in
  place of a copy of `calculateOffsetUniforms`), and `ShaderData` and
  `OffsetUniforms` are types of `/webgl`
- `ctx.terrain` is a `TerrainSurface` (was `TerrainAnchors`):
  `occlusionOpacity(lngLat)` was `ghostOpacity`, and `project` is gone,
  since `ctx.screen.project(lngLat)` answers where a position is drawn,
  on the terrain when it is on (without terrain, where `terrain.project`
  gave `null`, it gives the point on the map)
- The zoom a width in pixels is given at is `referenceZoom` in the
  options of `ctx.line.draw` (was `createdZoom`), and `ctx.point.draw`
  takes it too, for the size and the outline of its marker
- A type declares the look of its features in `defaultStyle`, and its
  renderer draws with `ctx.appliedStyle(feature)`, the look
  `draw.features.getAppliedStyle` answers (the look of the type, the
  color of the layer rule over it and the style of the feature), in
  place of reading `feature.style` with defaults of its own. A type that
  drew so drew no color of a layer rule, and `getAppliedStyle` answered
  the defaults of the geometry for it. A definition given to `override`
  cannot have it
- The rule colors the key a custom type declares in `styleRuleChannel`
  (`'fill'`, `'stroke'` or `'point'`), or else the key of the geometry
  of its definition, as for a built-in type. It colored `fillColor` of
  every custom type: a type of points or of lines that declares none now
  has the rule color in `pointColor` or in `strokeColor`, and a type
  drawn as a card or a box on a Point with its paper in `fillColor`
  declares `styleRuleChannel: 'fill'` to keep it. The function
  `getStyleRuleChannel(type)` of the main entry, which knew the built-in
  types only, is gone: `draw.extensions.featureTypes.getStyleRuleChannel(type)`
  answers for every type, as the library colors
- A style key an extension adds to `FeatureStyle` by declaration merging
  is optional in `FeatureStyleResolved` (it was required, though the look
  has it only when the type or the feature gives it): check it where it
  is read, as the keys of `feature.style` are
- An extension that read the CSS colors it draws with a parser of its
  own reads them with `parseCssColor` of the main entry, the parser the
  library checks and draws them with, so that it takes and draws the
  same colors

A handle on each vertex, as 2.x gave it and as 3.0 gives it, with the
white circle the library drew, now drawn by the type:

<!-- docs-check: skip -->

```ts
// 2.x
handles(feature, screen) {
  return verticesOf(feature).map((position, index) => ({
    id: String(index),
    position,
    kind: 'vertex',
  }));
},
```

<!-- docs-check:
type Feature = import('@sakuzu/maplibre-gl-draw').Feature;
type Position = import('@sakuzu/maplibre-gl-draw').Position;
declare function verticesOf(feature: Feature): Position[];
-->

```ts
import type { FeatureTypeDefinition } from '@sakuzu/maplibre-gl-draw';

// 3.0
const vertexHandles: Pick<FeatureTypeDefinition, 'handles' | 'drawHandles'> = {
  handles(feature) {
    return verticesOf(feature).map((position, index) => ({
      kind: 'custom',
      id: String(index),
      position,
      sizePx: 12,
    }));
  },
  // The white circle with the outline of the selection, 12 pixels wide
  drawHandles(_feature, handles, ctx) {
    for (const handle of handles) {
      ctx.point.draw(handle.position, {
        shape: 'circle',
        size: handle.sizePx,
        fillColor: '#ffffff',
        fillOpacity: 1,
        strokeColor: '#ff2d55',
        strokeWidth: 2,
        strokeOpacity: 1,
      });
    }
  },
};
```

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
