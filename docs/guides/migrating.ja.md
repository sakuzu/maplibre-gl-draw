# 2.0 への移行

この手引きでは、1.0 向けに書いたアプリケーションと拡張を 2.0 に
移す方法を説明します。すべての名前の対応は、変更履歴の
[移行の表](../../CHANGELOG.md#migration-table) にあります。この
ページでは、その背後にある型を示します。

## 何が変わったのか、なぜか

1.0 のインスタンスには 81 のメソッドが平らに並び、名前の付け方も
いくつかの流儀が混ざっていて、拡張は種類ごとに違う作法で登録して
いました。2.0 はメソッドを、それが扱うもの (地物、レイヤー、
グループ、選択、文書) の下にまとめ、どのコレクションにも同じ標準の
メソッドを持たせます。書き込みは書いたものを返し、引数の誤りは
`DrawError` を投げ、状態のために拒むときは `null` か `false` を
返します。地物は GeoJSON を持つので、渡したものがそのまま返り、
GeoJSON の書き出しにもそのまま出ます。1.0 の名前はすべて変わり、
別名は 1 つも残さないので、アプリケーションは一度に移行します。

## 2.0 の形

`createDraw(map, options)` が `Draw` を返します。メソッドは資源の
下にあります。

- コレクションは複数形です。`draw.features`、`draw.layers`、
  `draw.groups`、`draw.datasets`、`draw.hidden`、それに
  `draw.extensions` の中のコレクションです
- 記録するコレクション (地物、レイヤー、グループ) は、標準の 11 の
  メソッド `get`、`getMany`、`list`、`count`、`has`、`create`、
  `createMany`、`update`、`updateMany`、`delete`、`deleteMany` を
  持ちます。付け外しするコレクション (データセット、非表示、拡張)
  は `get`、`list`、`count`、`has`、`add`、`addMany`、`remove`、
  `removeMany` を持ちます
- 1 つしかない資源は単数形です。`draw.selection`、
  `draw.vertexSelection`、`draw.metadata`、`draw.options`、
  `draw.document` です
- 標準のメソッドで表せない操作は、コレクションの下の動詞です。
  `features.move`、`layers.reorder`、`features.union`、
  `features.split` などです。名前に `get` や `set` を含む動詞は、
  その資源の状態にだけ使います (`layers.getActive`、
  `layers.setActive`)
- 資源に属さないものは `draw` に残ります。`getMap`、`getMode`、
  `setMode`、`setReadOnly`、`transact`、`on`、`off`、`once`、
  `destroy` です

次の 4 つの規則は、どこでも同じです。

- `create` と `update` は、書いた資源を返します。`update(id,
  patch)` は渡した鍵だけを変えます。`properties` と `style` は鍵
  ごとに合わせ、`undefined` を渡した鍵は消えます
- 複数を扱うメソッド (`createMany`、`deleteMany`、`moveMany`) は
  1 つの取引です。全部が変わるか、何も変わらないかのどちらかです
- 引数の誤り (無い ID、形の合わない入力) は、`code` (`not-found`、
  `already-exists`、`invalid-input`、`unsupported-format`、
  `invalid-state`) を持つ `DrawError` を投げます。状態のために拒む
  書き込み (読み取り専用、ロック) は `null` か `false` を返します。
  どちらのときも何も変わりません
- イベントの名前は `資源.過去分詞` の形です。`feature.created`、
  `layer.reordered`、`selection.changed` などです。アプリケーション
  もプラグインも、同じ一覧 `DrawEvents` を購読します。
  `document.changed` は取引ごとに 1 回、文書の変化の全部を届けます。
  地物、レイヤー、グループ、メタデータのイベントは、書き込みの
  出どころ `source` を運びます

地物は `{ id, type, geometry, layerId, groupId, properties, style,
visible, locked }` です。`geometry` は GeoJSON の geometry で、
`properties` は GeoJSON の properties です。ライブラリーは自分の値を
`maplibre-gl-draw:` で始まる鍵 (`maplibre-gl-draw:rotation` など)
に置き、それ以外の鍵はすべて利用者のものです。見分けるには
`isDrawProperty(key)` を使います。

## アプリケーションの移行

### インストール

パッケージを更新し、直す呼び出しを型検査に挙げさせます。

```sh
npm install @sakuzu/maplibre-gl-draw@^2.0.0
```

1.0 で保存したファイル (独自の形式の 2.x) は、そのまま読み込め
ます。読み込むときに 3.0.0 の形式に上げます。

### インスタンスを作る

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

モードの名前 (`select`、`draw_point`、`draw_line`、`draw_polygon`、
`draw_circle`、`draw_freehand`、`draw_image`) は変わりません。
知らないモードを `setMode` に渡すと `DrawError` を投げます。

### 地物

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

`create` は `Feature` を返し、読み取り専用のときは `null` を返し
ます。`update` は差分を合わせるので、`name` は残ります。差分で
ID、型、レイヤーは変えられません。地物を動かすのは `features.move`
です。

一覧は、別々のメソッドの代わりに絞り込みを受け取ります。

```ts
const all = draw.features.list();
const visible = draw.features.list({ visible: true });
const inLayer = draw.features.count({ layerId });
```

`deleteAllFeatures()` は、すべての ID を渡す `deleteMany` になり
ます。

```ts
draw.features.deleteMany(draw.features.list().map((f) => f.id));
```

無い ID は例外を投げます。1.0 では素の `Error` を投げるか、何も
しないかでした。

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

### レイヤーとグループ

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

`features.move` と `groups.move` は `MoveTarget` を受け取ります。
`{ layerId, index? }` か `{ groupId, index? }` で、`index` の 0 が
最も奥、省くと最も手前です。`{ groupId: null }` は地物をグループ
から出し、グループのすぐ手前に置きます。`Layer.order` は
`Layer.items` になり、読み取り専用です。並びは `move` で変えます。
グループは自分のレイヤーの `layerId` を持ちます。`groups.delete`
は、`ungroupGroup` と同じく、地物を残してグループを解きます。
`layers.getActive()` は ID でなく `Layer` を返します。

### 選択と非表示

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

`selection.set` は種類を先に受け取ります。`selection.group()` は
新しい `Group` を返し、`selection.delete()` は選んでいるものを
消します。

### 読み込みと書き出し

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

`toJSON()` は文書のオブジェクト (`DrawDocument`) を、`toGeoJSON()`
は FeatureCollection を返します。文字列にするのも、ファイルに名前を
付けるのも、アプリケーションの仕事です。`load` は `File`、文字列、
独自の形式の文書、GeoJSON (FeatureCollection、Feature、geometry)
を受け取ります。`options.mode` で、文書を置き換える (`replace`。
独自の形式の既定) か、足す (`merge`。GeoJSON の既定) かを選び
ます。

GeoJSON の書き出しは `properties` を持っているとおりに書くので、
ライブラリーの値は `maplibre-gl-draw:` の前置きの付いた鍵に出ます。
利用者の属性だけが欲しい読み手は、`isDrawProperty(key)` が true の
鍵を除いてください。

### イベント

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

`on` は購読を解く関数を返し、`once` は 1 回だけ購読します。
`document.changed` はレイヤー、グループ、メタデータの変化も運び
ます。いくつかの書き込みを 1 つの変化にするには、`transact` で
包みます。

```ts
draw.transact(
  () => {
    draw.features.update(featureId, { visible: false });
    draw.layers.update(layerId, { opacity: 0.5 });
  },
  { source: 'toolbar' },
);
```

`draw.geometry.applied` は無くなりました。`features.union` などの
操作は結果を返します。

### 設定

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

`defaultMode`、`store`、`initDefaultLayer` 以外の設定は、実行中に
`draw.options` で変えられます。既定の見た目の鍵は `point`、`line`、
`polygon`、`circle`、`image` で、中身は `FeatureStyle` の鍵です。
色はすべて CSS の色の文字列です。描いている途中の形の見た目は
`previewStyle` (1.0 の `style.tentative`)、範囲選択の枠の見た目は
`selectionStyle.boxSelection` (1.0 の
`renderingStyle.boxSelectionStyle`) です。

### データセット

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

データセットは、`rows` に GeoJSON の Feature を、`table` に表を、
または `provider` を受け取ります。メンバーは行の語で呼びます。
`setRows`、`setTable`、`getRow`、`listRows`、`getSelectedRowIds`
などです。外すのは `draw.datasets.remove(id)` です。大きな表を
Worker で読むための入口 `@sakuzu/maplibre-gl-draw/columnar` は
`@sakuzu/maplibre-gl-draw/table` になりました。

<!-- docs-check:
declare const features: import('geojson').Feature[];
-->

```ts
import { prepareTable, tableFromFeatures } from '@sakuzu/maplibre-gl-draw/table';

const prepared = prepareTable(tableFromFeatures(features));
draw.datasets.add({ id: 'parcels', table: prepared });
```

### 図形の計算

`@sakuzu/maplibre-gl-draw/geometry` は GeoJSON を受け取って
GeoJSON を返し、Turf と同じ名前を使い、メートルで測ります。

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

1.0 で 2 引数の形と `All` の形があった関数は、2.0 では配列を受け
取る 1 つの関数です (`union`、`intersection`、`difference`)。
`generateCirclePolygon` は `circle` になり、main の入口からは出し
ません。`EARTH_RADIUS_METERS` は 6371008.8 なので、長さと面積は
1.0 とわずかに違います。

文書を変える操作は `features` のメソッドです。
`features.union(ids)`、`features.difference(id, ids)`、
`features.intersection(ids)`、`features.split(id, lineId)`、
`features.buffer(ids, { distanceMeters })` です。ID を受け取り
(選択に対して行うときは `draw.selection.get().ids` を渡します)、
できた地物を返します。

## 拡張の移行

### プラグイン

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

- `onInstall` と `onUninstall` は `onAdd` と `onRemove` になり
  ます
- `hooks` はイベントになります。`ctx.on` は `DrawEvents` の名前を
  受け取り、購読はプラグインを外すと解けます。`drag:start` と
  `drag:end` は `drag.started` と `drag.ended` です
- 入力の受け手は `input` に移ります (`onKeyDown`、`onPointerMove`、
  `onDrag`、`onPointerLeave`)。true を返すと入力を食べます
- `filterSelection`、`onFeatureClick`、`onFeatureDoubleClick`、
  `onFeatureCreated` と、独占の操作 (`isInteracting`、
  `finishInteraction`、`cancelInteraction`、
  `getInteractionContainer`) は `interaction` に移り、
  `filterSelection`、`onFeatureClick`、`onFeatureDoubleClick`、
  `onDrawCommit`、`isBusy`、`finish`、`cancel`、`container` になり
  ます。クリックの受け手は `Feature` とイベントを受け取ります
- `Plugin.modes` は無くなります。モードは
  `ctx.extensions.modes.add` で足します
- プラグインどうしは `api` で話し、`api` は
  `draw.extensions.plugins.getApi(name)` で得ます。`emit` は無く
  なります

### 窓口

拡張は、種類ごとに 1 つの窓口 (context) を受け取ります。共通の
部分が `ExtensionContext` です。

- `draw` は公開 API のすべてです。文書の読み書きはここで行います。
  `ctx.updateFeature` は `ctx.draw.features.update` に、
  `ctx.batch` と書き込みごとの `source` の引数は
  `ctx.draw.transact(fn, { source })` になります
- `store` は、読み取りと購読のための `StoreView` です
- `on`、`off`、`once` の購読は、拡張を外すと解けます
- `terrain` は `project`、`elevation`、`ghostOpacity`、
  `generation` を持ちます (1.0 の `projectAnchor`、
  `anchorElevationMeters`、`getAnchorElevationGeneration`)
- `names` の `next(type)` が自動の名前を返します
- `screen` は `project`、`unproject`、`bounds(feature)`、`zoom`、
  `pixelRatio` を持ちます (`bounds` が `computeBoundingBox` の
  代わりです)
- `invalidate({ type, ids })` で描き直させます
  (`invalidateFeatures` の代わりです)
- `drawing` は、描いている途中の形の頂点のための `undoVertex()`、
  `redoVertex()`、`isDrawing()` を持ちます (1.0 の `PluginContext`
  の `undoVertex` と `redoVertex` の代わりです)。`cancel()` はその形を
  取り消します

`PluginContext` には、さらに `extensions` (`draw.extensions` と同じ
コレクション) があります。プラグインがここで足したものは、プラグイン
を外すと一緒に外れます。

### モード、地物の型、重ね描き、提供者

どの種類も `draw.extensions.<種類>.add` (プラグインの中では
`ctx.extensions`) で足し、返る関数で外します。

| 1.0 | 2.0 |
| --- | --- |
| `registerMode(name, factory)` | `extensions.modes.add(name, factory)` |
| `registerFeatureHandler` | `extensions.featureTypes.add` |
| `addOverlayRenderer` | `extensions.overlays.add` |
| `snapping.register` | `extensions.snapProviders.add` |
| `registerAuxiliaryHandleProvider` | `extensions.handleProviders.add` |
| `registerFeatureCompanionProvider` | `extensions.companionProviders.add` |

モードを作る関数は `ModeContext` を受け取り、ハンドラーは
`onStart` と `onStop` の代わりに `onEnter` と `onExit` を持ちます。
ポインターの入力は `DrawPointerEvent` (`point`、`lngLat`、
`snapped`、`modifiers`、`pointerType`、`original`) として
`onPointerDown`、`onPointerMove`、`onPointerUp`、`onClick`、
`onDoubleClick`、`onDragStart`、`onDrag`、`onDragEnd`、
`onDragCancel` に届き、キーは `DrawKeyEvent` として届きます。窓口は
当たり判定の部品の代わりに `hitTest(point)` と `snap(point)` を、
さらに `commitFeature(input)` を渡します。`commitFeature` は、新しい
地物の ID、レイヤー、自動の名前、基準のズームを、組み込みのモードと
同じ規則で決めます。描いている途中の形は `preview.set` で見せ、
カーソルは `cursor.set` で変え、なぞる対象のデータセットの行は
`listTraceRows(bbox)` で得ます (`getDatasetTraceFeatures` の代わり
です)。ハンドラーでは、`writesFeatures` が `writes` に、
`getSnapPreference` と `isSnapEnabledFor` が 1 つの
`snapPreference` に、`undoVertex` と `redoVertex` が
`onUndoVertex` と `onRedoVertex` になります。

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

独自の地物の型は `FeatureTypeDefinition` です。`type`、持つ
geometry の種類 `geometry`、描き方 `renderer` と、任意の
`hitTest`、`boxSelect`、`bounds`、`outline`、`bbox`、`handles`、
`onHandleDrag`、`snapCandidates` を持ちます。自分の型のハンドルやスナップの候補は
ここに書きます。`HandleProvider` や `SnapProvider` は、自分のもので
ない型に足すときに使います。`onHandleDrag` と
`HandleProvider.onDrag` は `FeaturePatch` を返します。
`candidateReachPx` は `hitPaddingPx` になり、`resizeStrategy` は
無くなりました。大きさの変え方は `handles` と `onHandleDrag` で
書きます。`HandleProvider` は、地物に付かないハンドルを
`globalHandles` (`getGlobalHandles` の代わり) で出します。
`CompanionProvider` は `has` をそのまま持ち、クリックを `onClick`
(`onCompanionClick` の代わり) で受けます。

### RenderContext

描画器は、`CustomRendererDrawContext` の代わりに `RenderContext`
を 1 つ受け取ります。`onAdd` と `onRemove` は、MapLibre の
カスタムレイヤーと同じ順の `(map, gl)` を受け取ります。

| `CustomRendererDrawContext` | `RenderContext` |
| --- | --- |
| `shaderData` | `shader` |
| `mainMatrixArray` | `projection` |
| `centerLngLat` | `offset` (計算済み) |
| `sdfLineRenderer` | `line` |
| `fillShaderManager` | `fill` |
| `pointShapeRenderer` | `point` |
| `terrain`、`opacity`、`pixelRatio` | 同じ名前 |

重ね描きは `draw(ctx)` で描き (`ctx.projection` と `ctx.zoom` を
使います)、レイヤーの間には `drawForLayer(layerId, ctx)` で、
頂点の段には `drawVertices(ctx)` で描きます。重ね描きどうしの順は
`order` で決めます。`offset` は計算済みで届くので、`calculateOffsetUniforms` を
呼ぶ必要はありません。共有の描画器は `draw(geometry, style,
options)` で描きます。

### webgl の入口

独自のシェーダーを書くための部品は、main の入口から
`@sakuzu/maplibre-gl-draw/webgl` に移ります。`OFFSET_MODE_GLSL`、
`ProjectionUniformManager`、`createProgram`、
`applyDrawBlendState`、`QuadShader` などです。この入口は小さい版
でも変わることがあります。main の入口は semver に従います。
`getStrokeDashPattern` と `getTerrainTessellationStep` は、そこでは
`dashPattern` と `terrainTessellationStep` です。`RenderContext`
の欄の型である `ShaderData` と `OffsetUniforms` は main の入口に
残ります。地形の上に描く部品は、地形の状態 (`FrameDrawContext.terrain`)
の代わりに、描画の呼び出しの `RenderContext` (かその `terrain`) を
受け取ります。`setTerrain(ctx)`、`terrainTessellationStep(ctx)`、
`drawQuadSurfaceOnTerrain(ctx, ...)` と書き、
`ProjectionUniformManager` と `QuadShader` は地形を渡さずに作ります。
`TerrainContext` と `TerrainRenderState` は出さなくなりました。1.0 が出していた
純粋な計算 (向きのある矩形、ピクセルと度の換算、コントラストの色)
は出さなくなりました。必要なら手元に写してください。

### Store

Store を差し替えるときは、これまでどおり `options.store` に渡し、
`Store` を実装します。読み取りはインスタンスと同じ語にそろえました。
`getAllFeatures`、`getOrderedFeatures`、`getAllLayers`、
`getAllGroups`、`getAllFiles`、`getSelectedVertices`、
`isLocallyHidden`、`getLocallyHidden` は、`listFeatures`、
`listFeaturesInOrder`、`listLayers`、`listGroups`、`listFiles`、
`getVertexSelection`、`isHidden`、`listHidden` になります。
`subscribe` は `document.changed` と同じ型の `DocumentChange` を
届け、文書の全部の置き換えも同じ形で知らせます。入力の状態 (描いて
いる途中の形、範囲選択、ドラッグ) は契約に含めません。

## すべての対応

変更履歴の [移行の表](../../CHANGELOG.md#migration-table) は、
1.0 のすべての名前を 2.0 に対応させています。インスタンスの
メソッド、イベント、設定、モデル、拡張、main の入口の記号、
`/geometry`、`/table` の表があります。

## mapbox-gl-draw や terra-draw から

モード、地物の store、イベント、独自のモードといった考え方は、
そのまま引き継げます。組み込みのツールバーは無いので、自分の UI
から `setMode` を呼びます。イベントは draw のインスタンスで購読し、
API で行った書き込みでも発火します。

| mapbox-gl-draw | このライブラリー |
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

| terra-draw | このライブラリー |
| --- | --- |
| `new TerraDraw({ adapter, modes })` | `createDraw(map)` |
| `setMode('linestring')` | `setMode('draw_line')` |
| `getSnapshot()` | `document.toGeoJSON()` |
| `addFeatures(features)` | `document.load(featureCollection)` |
| `removeFeatures(ids)` | `features.deleteMany(ids)` |
| `clear()` | すべての ID で `features.deleteMany(ids)` |
| `selectFeature(id)` | `selection.set('feature', [id])` |
| `on('change', ...)` | `on('document.changed', ...)` |

選択モードは `simple_select` と `direct_select` の両方の役目を
果たします。選んだ地物の頂点は、選択モードのままドラッグできます。
地物に `mode` のプロパティーは要らず、地物の型が決めます。組み込みの
取り消しはありません。イベントがすべての変化の前の状態を運びます
([保存と読み込み](save-load.ja.md) を参照)。
