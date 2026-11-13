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

この先の `2.0` と書いたコードは 2.x の API です。3.0 は文書を
`draw.write` で書き、地物を 1 つの GeoJSON の Feature にし、読み込みの
代わりにファイルを開いて取り込みます。1.0 から 3.0 へ移るアプリケーション
は [2.x から 3.0 へ](#2x-から-30-へ) も読んでください。

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
- 引数の誤り (無い ID、形の合わない入力) は、`code` (`notFound`、
  `alreadyExists`、`invalidInput`、`unsupportedFormat`、
  `invalidState`) を持つ `DrawError` を投げます。状態のために拒む
  書き込み (読み取り専用、ロック) は `null` か `false` を返します。
  どちらのときも何も変わりません
- イベントの名前は `資源.過去分詞` の形です。`feature.created`、
  `layer.reordered`、`selection.changed` などです。アプリケーション
  もプラグインも、同じ一覧 `DrawEvents` を購読します。
  `document.changed` は取引ごとに 1 回、文書の変化の全部を届けます。
  地物、レイヤー、グループ、メタデータのイベントは、書き込みの
  出どころ `source` を運びます。3.0 ではこれらが替わります
  ([2.x から 3.0 へ](#2x-から-30-へ))

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

2.x は、1.0 で保存したファイル (独自の形式の 2.x) を、読み込むときに
3.0.0 の形式に上げて読みます。3.0 が読むのは 4.0.0 の形式だけです
([2.x から 3.0 へ](#2x-から-30-へ))。

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

モードの名前 (`select`、`drawPoint`、`drawLine`、`drawPolygon`、
`drawCircle`、`drawFreehand`、`drawImage`) は変わりません。
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

<!-- docs-check: skip -->

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
const visible = draw.features.list({ shown: true });
const inLayer = draw.features.count({ layerId });
```

`getVisibleFeatures()` は `list({ shown: true })` になります。地物、
そのグループ、そのレイヤーがすべて表示のものです。`{ visible: true }` は
地物自身の印だけを見ます。

`deleteAllFeatures()` は、すべての ID を渡す `deleteMany` になり
ます。

<!-- docs-check: skip -->

```ts
draw.features.deleteMany(draw.features.list().map((f) => f.id));
```

無い ID は例外を投げます。1.0 では素の `Error` を投げるか、何も
しないかでした。

<!-- docs-check: skip -->

```ts
import { DrawError } from '@sakuzu/maplibre-gl-draw';

try {
  draw.features.update(featureId, { visible: false });
} catch (error) {
  if (error instanceof DrawError && error.code === 'notFound') {
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

<!-- docs-check: skip -->

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
const ids = draw.selection.value.ids;
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

<!-- docs-check: skip -->

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
draw.on('change', ({ features, source }) => {
  console.log(features.created, source);
});
const stop = draw.on('change', () => save());
```

`on` は購読を解く関数を返し、`once` は 1 回だけ購読します。
`change` はレイヤー、グループ、メタデータの変化も運びます。いくつかの
書き込みを 1 つの変化にするには、`transact` で包みます。

<!-- docs-check: skip -->

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

`defaultMode`、`store`、`initDefaultLayer`、`generateId` 以外の設定は、
実行中に `draw.options` で変えられます。既定の見た目の鍵は `point`、
`line`、`polygon`、`circle`、`image` で、中身は `FeatureStyle` の鍵です。
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
(選択に対して行うときは `draw.selection.value.ids` を渡します)、
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
    ctx.on('change', ({ features }) => console.log(features.created));
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
- `drawing` は `draw.drawing` と同じもので、描いている途中の形の頂点の
  ための `undoVertex()`、`redoVertex()`、`isDrawing()` を持ちます
  (1.0 の `PluginContext` の `undoVertex` と `redoVertex` の代わり
  です)。`cancel()` はその形を取り消し、`addVertex`、`moveTo`、
  `finish`、`isActive` はその形をコードから動かします

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
draw.registerMode('drawMarker', () => ({
  modeName: 'drawMarker',
  onStart(context) {},
  onClick(event) {
    context.store.createFeature({ /* ... */ });
  },
}));
```

<!-- docs-check: skip -->

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
draw.extensions.modes.add('drawMarker', drawMarker);
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
`globalHandles` (`getGlobalHandles` の代わり) で出します。ドラッグの
始まりと終わりは `onDragStart` と `onDragEnd` で受けます
(`onHandleDragStart` と `onHandleDragEnd` の代わり)。定義にも同じ
ための `onHandleDragStart` と `onHandleDragEnd` があります。
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
の欄の型である `ShaderData` と `OffsetUniforms` は、2.x では main の
入口に残りました。3.0 では、それらを渡す `viewUniforms(ctx)` と一緒に
`/webgl` の型になります ([3.0 の拡張](#30-の拡張))。地形の上に描く部品は、地形の状態 (`FrameDrawContext.terrain`)
の代わりに、描画の呼び出しの `RenderContext` (かその `terrain`) を
受け取ります。`setTerrain(ctx)`、`terrainTessellationStep(ctx)`、
`drawQuadSurfaceOnTerrain(ctx, ...)` と書き、
`ProjectionUniformManager` と `QuadShader` は地形を渡さずに作ります。
`TerrainContext` と `TerrainRenderState` は出さなくなりました。1.0 が
出していた純粋な計算 (向きのある矩形、ピクセルと度の換算、コントラストの
色) は出さなくなりました。必要なら手元に写してください。3.0 からは、
ズームと一緒に持つピクセルの大きさを、`/geometry` の `pixelsToMeters` で
地面の長さに、`metersToDegrees` で度に直せます。ライブラリーが描くのと
同じ式です。

### Store

Store を差し替えるときは、これまでどおり `options.store` に渡し、
`Store` を実装します。読み取りはインスタンスと同じ語にそろえました。
`getAllFeatures`、`getOrderedFeatures`、`getAllLayers`、
`getAllGroups`、`getAllFiles`、`getSelectedVertices`、
`isLocallyHidden`、`getLocallyHidden` は、`listFeatures`、
`listFeaturesInOrder`、`listLayers`、`listGroups`、`listFiles`、
`getVertexSelection`、`isHidden`、`listHidden` になります。
`subscribe` は (2.0 では `document.changed` と同じ型の) `DocumentChange` を
届け、文書の全部の置き換えも同じ形で知らせます。入力の状態 (描いて
いる途中の形、範囲選択、ドラッグ) は契約に含めません。

## すべての対応

変更履歴の [移行の表](../../CHANGELOG.md#migration-table) は、
1.0 のすべての名前を 2.0 に対応させています。インスタンスの
メソッド、イベント、設定、モデル、拡張、main の入口の記号、
`/geometry`、`/table` の表があります。

## 2.0 から 2.1 へ

変えるところはありません。2.1 ではイベント `options.changed` (3.0 では
Observable の `draw.options` で読みます) と
`Dataset.getStyleRule()` と標準の UI のパッケージ
`@sakuzu/maplibre-gl-draw-ui` が加わり、差分の `map.setStyle` の後の
レイヤーの順が直りました (描画は新しいスタイルの上に残ります。文書に
書いてあったとおりの振る舞いです)。回避のために `{ diff: false }` で
`setStyle` を呼んでいたアプリは、そのままでも外しても構いません。

## 2.x から 3.0 へ

3.0 では、ストアがレイヤーの地物を列の行で持てるようになりました
([変更履歴](../../CHANGELOG.md#unreleased))。標準のストアを使う
アプリで変わるところは次のとおりです。拡張で変わるところは
[3.0 の拡張](#30-の拡張)にあります。

文書の確定は、地物、レイヤー、グループごとのイベントと
`metadata.updated`、`document.changed` に替わって、1 つのイベント
`change` で届きます。確定が作った、変えた、消した、置き場を変えた物の ID
を並べ、`previous(id)` は地物の確定の前の姿を返します。時間で変わる値は、
イベントに替わって資源の `Observable` で読みます。`draw.selection`、
`draw.vertexSelection`、`draw.mode`、`draw.hidden.hiddenIds`、
`draw.options`、`draw.sketches`、`draw.datasets`、
`draw.rendered.changed` です。プラグインは自分のイベントを送らなくなり
(`PluginContext.emit` は無くなりました)、自分の値を API の Observable
で渡します ([イベント](../reference/events.md))。

<!-- docs-check: skip -->

```ts
// 2.x
draw.on('feature.updated', ({ feature }) => redraw(feature.id));
draw.on('selection.changed', ({ selection }) => show(selection));
```

<!-- docs-check:
declare function redraw(id: string): void;
declare function show(selection: unknown): void;
-->

```ts
// 3.0
draw.on('change', ({ features }) => {
  for (const id of features.updated) redraw(id);
});
draw.selection.subscribe((selection) => show(selection));
```

`Layer` と `Group` は、`kind` で見分ける共用体になりました。行で持つ
レイヤー (`kind: 'table'`) は `items` を持たず、そのグループは
`featureIds` を持ちません。読む前に `kind` で絞るか、どの種類の
レイヤーでも項目を位置で読みます。

```ts
const layer = draw.layers.get(layerId);
if (layer && layer.kind !== 'table') console.log(layer.items);

// どの種類のレイヤーでも、奥から 50 個の項目
const items = draw.layers.listItems(layerId, { limit: 50 });
const members = draw.groups.listMembers(groupId);
```

レイヤーやグループの中の並びは、`DocumentChange.layerReorder` と
`groupReorder` に入らなくなりました。別の場所に置いた項目は、すべて
`DocumentChange.order` に入ります。元の場所と今の場所を、すぐ下と
すぐ上の項目 (`ItemPosition`) で持ちます。レイヤーの `items` や
グループの `featureIds` だけの変化は、そのレイヤーやグループの変更では
ありません。並びを追う画面は、`change` の `features.placed` と
`groups.placed`、または Store の通知の `order` を読みます。

```ts
draw.getStore().subscribe((change) => {
  for (const move of change.order ?? []) {
    if (move.kind === 'item') console.log(move.itemId, move.from, move.to);
  }
});
```

データセットの `TableGeometry.dimensions` は GeoArrow の名前を取り
ます。`2` は `'xy'`、`3` は `'xyz'` です。

`properties` の値は `Value` になりました。日付、時刻、ほかの地物の
id は、それぞれの種類の値 (`CalendarDate`、`DateTime`、`TimeOfDay`、
`Reference` など) です。`JSON.stringify` は、これらを JSON の形
(`{"$date": text}`) で書きます。`Date` は `invalidInput` で
断ります。`Date` は瞬間なので、日付を `Date` で渡すと時差で日が
ずれるためです。日時か日付の値で渡します。値とその種類は、このライブラリーが
使う `@sakuzu/tabane` から読みます。

```ts
import { CalendarDate, DateTime } from '@sakuzu/tabane';

await draw.write((tx) =>
  tx.features.update(featureId, {
    properties: {
      updated: DateTime.fromDate(new Date()), // 瞬間 (UTC)
      opened: CalendarDate.of(1998, 4, 1), // 日付
    },
  }),
);
```

度の範囲は、`features.bbox` と同じく、どこでも `bbox` と呼びます。
下ごしらえ済みの表の `prepared.bbox` と `dataset.getRowBBox(index)` は、
`bounds` と `getRowBounds` でした。その型 `BBox` は main の入口からも
読めます。

「box」の語が 1 つの物を指すように、`selectionStyle` の鍵を 2 つ改め
ました。選択した地物の周りに描く箱、つまり選択の枠の見た目は
`selectionStyle.box` (前は `boundingBox`) です。範囲選択 (Shift を押し
ながらのドラッグ) で引く四角の見た目は
`selectionStyle.selectionRectangle` (前は `boxSelection`) です。

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

`selectionStyle` のハンドルと印の形は、ライブラリーが描く `'circle'`、
`'square'`、`'triangle'`、`'star'` のどれかです。ライブラリーが円で
描いていた形 `'icon'` と、その `iconId` は無くなりました。代わりに
`'circle'` を渡してください。

選択は `selection.get()` の代わりに、1 つの値 `draw.selection.value` で
読みます。種類、地物の数、地物のレイヤーと範囲、ID を伝えます。何も選んで
いない時は種類が `feature` で数が 0 です。地物を行で持つストアで 2,000 件を
超えると、ID は `null` です。選択が変わるたびに `draw.selection` が値を
また知らせます (`draw.selection.subscribe`)。
`draw.selection.target` は今の選択を指し、`draw.selection.set(target)` で
もう一度選べます。

```ts
const { type, count, ids } = draw.selection.value;
if (count > 0 && ids) console.log(type, ids);

const kept = draw.selection.target;
draw.selection.clear();
draw.selection.set(kept);
```

API の文字列の値は、すべて camelCase になりました。エラーの符号、
モードの名前、データセットの順は、新しい名前と比べてください。
`'invalid-input'` は `'invalidInput'`、`'draw_point'` は `'drawPoint'`、
`'below-store'` は `'belowStore'` です。スケッチが終わった理由、頂点の
編集の種類 (`'vertexMove'`)、`debug.checks` の確かめの名前も同じ書き方です。

自前のストアは変えなくて構いません。レイヤーの項目をリストで持つ
ストアは、変更の前と後のリストから `diffItemOrder` で
`DocumentChange.order` を作ります。

### 3.0 での文書の書き込み

文書を書く入口は `draw.write(fn)` の 1 つです。関数は書き込みを持つ取引
`tx` を受け取り、関数が終わると書き込みをまとめて確定します。確定は
1 回の `change` と undo の 1 段になり、Promise は確定してから解けます。
`draw` には読みだけが残ります。

<!-- docs-check: skip -->

```ts
// 2.x
draw.transact(
  () => {
    const point = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [139.767, 35.681] },
      layerId,
      style: { pointColor: '#e74c3c' },
    });
    if (point) draw.features.move(point.id, { layerId, index: 0 });
  },
  { source: 'toolbar' },
);
```

```ts
// 3.0
await draw.write(
  async (tx) => {
    const point = await tx.features.create({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.767, 35.681] },
      properties: {
        'maplibre-gl-draw:layerId': layerId,
        'maplibre-gl-draw:style': { pointColor: '#e74c3c' },
      },
    });
    const [back] = draw.layers.listItems(layerId, { limit: 1 });
    if (back !== undefined) await tx.features.place(point.id, { above: back });
  },
  { label: 'toolbar' },
);
```

- 資源の書き込みは `tx` へ移ります。`features.create`、`update`、
  `delete`、`union`、`difference`、`intersection`、`split`、`buffer`、
  `layers.create`、`update`、`delete`、`groups.create`、`update`、
  `delete` です。1 つのメソッドが 1 件もたくさんも受けます。`create` は
  地物の配列を受け取り (`Many` のメソッドは無くなりました)、`update`、
  `delete`、`translate`、`rotate`、`scale`、`place` は ID、複数の ID、
  絞り込み、`draw.selection.target`、`{ all: true }` を受け取ります
- `features.move` と `groups.move` は `tx.features.place` と
  `tx.groups.place` になり、`Placement` を受け取ります。すぐ下
  (`{ below }`) かすぐ上 (`{ above }`) の項目と、入る先のレイヤーか
  グループです。`index` はありません。`layers.reorder` は
  `tx.layers.place(id, { below })` か `{ above }` です
- `groups.delete(id)` は、メンバーをどうするかを言います。
  `tx.groups.delete(id, { members: 'keep' })` がグループを解きます
- 選択の書き込みは無くなりました。`draw.selection.target` を `tx` に
  渡し (`selection.delete()` は
  `tx.features.delete(draw.selection.target)`)、グループは
  `tx.groups.create({ members })` で作り、`tx.groups.delete` で解きます
- `buffer(ids, { distanceMeters, segments })` は、1 件ずつの
  `tx.features.buffer(id, distanceMeters)` です
- `transact(fn, { source })` は `draw.write(fn, { label })` です。
  `ignoreLocks` は無くなりました。`draw.undo()` と `draw.redo()` が
  この端末の確定を取り消し、やり直します。`features.restore`、
  `features.releaseRestore`、`groups.restore` は無くなりました
- 状態のために拒まれた書き込みは、`null` や `false` の代わりに
  `DrawError` で reject します。読み取り専用のときは `notEditable`、
  ロックされたものには `locked` です。引数の誤りも reject します。その
  とき取引は何も確定しません
- `draw.metadata` は `draw.document.title`、`description`、`metadata`
  になり、`tx.document.update({ title, description, metadata })` で
  書きます。文書とレイヤーに置くアプリケーションの値は自分の前置きの
  鍵 (`app:key`) に置き、`unset` に書いて消します
- `image.requested` は無くなりました。画像のモードはオプション
  `requestImage` でファイルを求めて置きます
  ([描画と編集](drawing.ja.md#画像))

地物は 1 つの GeoJSON の Feature `{ type: 'Feature', id, geometry,
properties }` で、渡す形、読む形、書き出す形が同じです。レイヤー、
グループ、型、スタイル、表示、ロックは `properties` の鍵
(`maplibre-gl-draw:layerId`、`groupId`、`featureType`、`style`、
`visible`、`locked`) で、既定の値のときは置きません。
`readFeature(feature)` は、それらを既定の値を埋めた短い名前で読みます。
差分は `{ geometry?, properties?, unset? }` です。鍵は `unset` に書いて
消し (スタイルの鍵は `unset.style`)、`undefined` を渡した鍵は
`invalidInput` で断ります。地物がもともと GeoJSON なので、
`featuresToGeoJSON` と `featureToGeoJSON` は無くなりました。

<!-- docs-check: skip -->

```ts
// 2.x
const f = draw.features.get(featureId);
if (f && !f.locked) console.log(f.type, f.layerId, f.style.fillColor);
draw.features.update(featureId, { style: { fillColor: undefined } });
```

```ts
// 3.0
import { readFeature } from '@sakuzu/maplibre-gl-draw';

const f = draw.features.get(featureId);
if (f) {
  const { featureType, layerId, locked, style } = readFeature(f);
  if (!locked) console.log(featureType, layerId, style.fillColor);
}
await draw.write((tx) =>
  tx.features.update(featureId, { unset: { style: ['fillColor'] } }),
);
```

`document.load` は `draw.open` と `tx.import` になります。
`draw.open(source)` は文書を置き換え (`replace` のモードに当たります)、
`tx.import(source, { layer, group })` は GeoJSON を文書に足します
(`merge` に当たります)。1 つの `draw.write` の中の複数の取り込みは
1 つの確定になり、`loadMany` の代わりになります。`document.loaded` は
無くなり、読んだものは `change` で届きます。

<!-- docs-check:
declare const file: File;
-->

```ts
// 3.0
const opened = await draw.open(file); // 文書を置き換える
const imported = await draw.write((tx) => tx.import(file)); // 文書に足す
console.log(opened.features, imported.count, imported.skipped);
```

独自の形式は `4.0.0` です。地物は GeoJSON の Feature で、題と説明は
文書の欄になり、`metadata` はアプリケーションの値をそれぞれの前置きで
持ちます。3.0 が読むのはこの版だけで、`3.0.0` 以前の形式の文書は
`invalidInput` で断ります。

### 3.0 の拡張

拡張の窓口を組み直しました。拡張はライブラリーに地図の上の位置を渡し、
描かれた物はライブラリーが答えます。消えた物は、それぞれ代わりを書きます。

- 型の `bounds` と `outline`、`ctx.screen.bounds` と `ctx.screen.outline`
  は無くなりました。型は外形 `footprint` を返します。地図の上に描く形は
  地図の上の 4 つの角 (`{ kind: 'ground', corners }`)、大きさを保つ印は
  位置の周りの画面の上で大きさの決まった箱
  (`{ kind: 'screen', position, halfWidthPx, halfHeightPx }`) です。
  ライブラリーがそこから選択の枠を作ります。枠に大きさを変えるハンドルと
  回すハンドルが付くかは、図形ではなく種類で決まります。
  `selectionStyle.boundingBox` は `selectionStyle.box` になりました
- 地図の上の外形の大きさを変えるハンドルと回すハンドルは、組み込みの形の
  ものと同じです。そのドラッグは、`rotate` と `scale` の編集の全部と同じく、
  型が `transformFields` で宣言した欄 (`angleDegreesKey`、`scaleKey`、
  `uniformScale`) を書き、鍵の無い地物は 0 と 1 から始めます。独自の型は
  その欄だけを持ちます。地物の `maplibre-gl-draw:rotation` と
  `maplibre-gl-draw:scale` は、型がそこで名指したときだけ書かれます。
  自分のハンドルで (`onHandleDrag` で) 地物を回して大きくしていた型は、
  欄を宣言し、角と回転をライブラリーに任せます。`override` に渡す定義は
  これを持てません
- `Handle.kind` は、拡張が付ける名前ではなく、ハンドルの見せ方になり
  ました (ハンドルは `id` で見分けます)。`'resize'` はライブラリーが
  大きさを変えるハンドルとして描いてその大きさで当て、`'custom'` は
  拡張が `drawHandles` で描き、拡張が渡す `sizePx` (印の直径) の中で
  当てます。ほかの種類は警告を出して除かれます。ライブラリーはどの
  ハンドルも頂点のハンドルの見た目の白い丸で描いていました。その見た目
  にしたい型は `drawHandles` で描きます
- `handles(feature, ctx)` と `globalHandles(ctx)` は、画面の代わりに
  `HandleContext` を受けます。`ctx.screen`、ライブラリーが描く選択の枠
  (`ctx.selectionBox`。外形に余白を足したもので、
  `draw.rendered.getSelectionBox` の答え。どの地物にも属さない
  ハンドルでは `null`)、選択の見た目 (`ctx.selectionStyle`) を持ちます
- `HandleProvider` のハンドルのドラッグは、定義と同じ名の
  `onHandleDrag`、`onHandleDragStart`、`onHandleDragEnd` に届きます
  (前は `onDrag`、`onDragStart`、`onDragEnd`)
- 地物の周りに描くものは、描かれている地物を `ctx.draw.rendered` で
  読みます (`get`、`getMany`、`getSelectionBox`。まとめてドラッグしている
  行は `getDraggedRows` で、前の `/kasane` の `draggedRowsOf` です)。
  変わったことは `draw.rendered.changed` で知ります
- `HitTestContext` と `SnapContext` は 1 つの型 `PointContext` に
  なりました。外すものが無いとき、`excludeIds` はありません
- `ctx.drawing` は無くなりました。同じものが `ctx.draw.drawing` です
- `boxSelect(feature, boxPx, ctx)` の画面の箱の引数は `boxPx` です
- 地物の `Hit` は、その地物を `id` だけで指します。`featureId` は、
  付き物が属する地物です。ライブラリーが作らないので、種類 `handle` は
  無くなりました
- 地物の型の `hitTest` は距離だけ `{ distancePx }` を、付き物の提供者の
  `hitTest` は ID と距離 `{ id, distancePx }` を返します。外に渡す `Hit`
  (種類、地物の ID、`featureId`) はライブラリーが埋めます
- プラグインの時間で変わる値は、プラグインが返す API に置いた
  `Observable` で渡します。イベントを送るのはライブラリーだけです
  ([プラグインの値](plugins.ja.md#プラグインの値))
- `Plugin.interaction` は役目ごとに分かれました。`onFeatureCommit(feature)`
  (前は `onDrawCommit`。`ModeContext.commitFeature` に合わせた名です) は
  プラグインの欄になり、選択モードのクリックは `selectMode`
  (`onSelectedFeatureClick` と `onFeatureDoubleClick`。前者は 1 つだけ選んだ
  地物を押し直したときにだけ呼ばれるので、前の `onFeatureClick` を改め
  ました)、排他的な操作は
  `exclusive` です。`exclusive` は `isActive()` (前は `isBusy`) を必ず
  持ち、`finish`、`cancel`、`container` を持てます
- 型と付き物の提供者が、行で持つレイヤーの行から答えて描くものは、
  それぞれの 1 つの欄 `rows` にあります (実験的)。
  `rows.appliesTo` は前の `appliesToRow`、`rows.sprites` は前の
  `rowSprites`、付き物の提供者の `rows.has` は前の `hasRow` です。
  `drawRows` の代わりに、`prepare` の返すものの `rows` が行を GPU に持ちます
- 型は、`renderer` の代わりに定義の `render(feature, ctx)` で、共有の描画器を
  使って描きます。主の入口に `FeatureRenderer` はありません。`OverlayRenderer`
  に `onAdd` と `onRemove` は無く、GPU に何も持ちません
- WebGL を自分で使う型と重ね描きは、プラグインの `ctx.webgl` を通します。
  `addFeatureRenderer(type, { gpuShare, prepare })` と
  `addOverlay({ gpuShare, prepare })` で、型は `/webgl` にあります。`onAdd` で
  作っていたものは `prepare(gpu)` で作ります。ライブラリーは、外した時、
  `draw.destroy()` の時、文脈が失われた時、例外の時にすべてを返すので、
  `onRemove` で解放していたものに呼び出しは要りません。文脈が失われた後は、
  `prepare` が新しい `gpu` でもう一度走ります
  ([プラグインが GPU に持つもの](custom-types.ja.md#プラグインが-gpu-に持つもの))
- `RenderContext.gl` は `gpu.gl` (`GpuContext`) で、資源を作る呼び出しと消す
  呼び出しはありません。`gpu.buffer`、`gpu.texture`、`gpu.vertexArray`、
  `gpu.transformFeedback`、`gpu.fence`、`gpu.program`、`gpu.compile` が作り
  ます。`createProgram` は `gpu.program` になり、`/webgl` から無くなりました。
  `QuadShader` は `new QuadShader(gpu, content)` です。断りはコード
  `tooLarge` の `DrawError` です
- 描く文脈は、`ctx.zoom` と `ctx.pixelRatio` の代わりに描いている画面
  `ctx.screen` (プラグインの `screen` と同じもの) を持ちます。
  `ctx.screen.zoom` と `ctx.screen.pixelRatio` を読んでください
- `ctx.screen` は最後に描いた画面について答えます (`project`、`unproject`、
  `zoom`、`metersPerPixel`)。ポインターのイベントの位置は、その下に
  描かれている位置です。カメラがその後に動いても、つかむ物は描いた物です
- 描いている画面の GPU の値は、描く文脈からでなく `/webgl` で読みます。
  `viewUniforms(ctx)` が `shader`、`projection`、`offset` (前は
  `ctx.shader`、`ctx.projection`、`ctx.offset`) を渡し、
  `offsetUniformsAt(ctx, position)` がある位置からの差の値を渡します
  (`calculateOffsetUniforms` の写しの代わり)。`ShaderData` と
  `OffsetUniforms` は `/webgl` の型です
- 地形の上に塗る四角には、見せる物を渡します。
  `drawQuadSurfaceOnTerrain(ctx, corners, surface, opacity)` とその
  決まった形の中身 (`QuadDrapeSurface`) の代わりに、
  `drawQuadOnTerrain(ctx, corners, content, opacity)` が
  `QuadDrapeContent` を受けます。四角の中の位置の色を返す GLSL の関数と、
  その関数が読む uniform を設定しテクスチャーを結ぶ `bind` です
  ([独自の地物の型](custom-types.ja.md#自分のシェーダー))
- `ctx.terrain` は `TerrainSurface` になりました (前は `TerrainAnchors`)。
  `occlusionOpacity(lngLat)` は前の `ghostOpacity` です。`project` は
  無くなりました。位置がどこに描かれるかは、地形があれば地形の上で、
  `ctx.screen.project(lngLat)` が答えます (地形が無いと
  `terrain.project` は `null` でしたが、こちらは地図の上の点を返します)
- ピクセルの幅を与えるズームは、`ctx.line.draw` のオプションの
  `referenceZoom` です (前は `createdZoom`)。`ctx.point.draw` も、
  印の大きさと縁の太さのためにこれを受け取ります
- 型は自分の地物の見た目を `defaultStyle` で宣言し、描画器は
  `feature.style` を自分の既定と合わせて読む代わりに、
  `ctx.appliedStyle(feature)` で描きます。これは
  `draw.features.getAppliedStyle` の答え (型の見た目に、レイヤーの規則の
  色と地物のスタイルを重ねたもの) と同じです。前の書き方の型はレイヤーの
  規則の色を描かず、`getAppliedStyle` はその型に幾何の既定を答えて
  いました。`override` に渡す定義は持てません
- 規則は、独自の型が `styleRuleChannel` で宣言した鍵 (`'fill'`、
  `'stroke'`、`'point'`) か、宣言が無ければ組み込みの型と同じく定義の
  幾何の鍵を塗ります。前はどの独自の型でも `fillColor` を塗っていました。
  宣言しない点や線の型では、規則の色が `pointColor` か `strokeColor` に
  入るようになります。Point の上に `fillColor` で塗った箱を描く型は、
  `styleRuleChannel: 'fill'` を宣言すると前と同じになります。
  組み込みの型しか知らなかった主の入口の関数 `getStyleRuleChannel(type)` は
  無くなりました。`draw.extensions.featureTypes.getStyleRuleChannel(type)`
  が、ライブラリーが塗るのと同じく、どの型にも答えます
- 拡張が宣言の併合で `FeatureStyle` に足したスタイルの鍵は、
  `FeatureStyleResolved` では省略できる鍵です (前は必須でしたが、見た目は
  型か地物が与えたときだけその鍵を持ちます)。`feature.style` の鍵と同じ
  ように、読む所で確かめてください
- 描く CSS の色を自前の読み方で読んでいた拡張は、主の入口の
  `parseCssColor` で読みます。ライブラリーが色を確かめて描くのと同じ
  読み方なので、同じ色を受けて同じ色で描けます
- 拡張は、地物を 1 つの形の GeoJSON の Feature (凍結したもの) で受け
  取り、ライブラリーの値を `readFeature` で読みます。モードの
  `commitFeature(input)` と `preview.set` は GeoJSON の Feature
  (`type: 'Feature'`。描く型が形状の型と違うときは
  `maplibre-gl-draw:featureType` に書きます) を受け取り、`onHandleDrag` は
  3.0 の差分 (`{ geometry?, properties?, unset? }`) を返します

頂点ごとのハンドルの 2.x と 3.0 の書き方です。ライブラリーが描いていた
白い丸は、型が描きます。

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
  // 選択の色の縁の白い丸。幅は 12 ピクセル
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

## mapbox-gl-draw や terra-draw から

モード、地物の store、イベント、独自のモードといった考え方は、
そのまま引き継げます。組み込みのツールバーは無いので、自分の UI
から `setMode` を呼びます。イベントは draw のインスタンスで購読し、
API で行った書き込みでも発火します。文書の書き込みは `draw.write` の中で
行い、その関数が受け取る取引 `tx` が下の表の `tx` です。

| mapbox-gl-draw | このライブラリー |
| --- | --- |
| `new MapboxDraw()`, `map.addControl(draw)` | `createDraw(map)` |
| `changeMode('simple_select')` | `setMode('select')` |
| `changeMode('direct_select', ...)` | `setMode('select')` |
| `changeMode('draw_line_string')` | `setMode('drawLine')` |
| `add(featureCollection)` | `tx.import(featureCollection)` |
| `get(id)` | `features.get(id)` |
| `getAll()` | `document.toGeoJSON()` |
| `getSelectedIds()` | `selection.value.ids` |
| `delete(ids)` | `tx.features.delete(ids)` |
| `trash()` | `tx.features.delete(draw.selection.target)` |
| `setFeatureProperty(id, key, value)` | `tx.features.update(id, patch)` |
| `draw.create`, `draw.update` | `change` (`features.created`、`updated`) |
| `draw.delete` | `change` (`features.deleted`) |
| `draw.selectionchange` | `selection.subscribe(run)` |
| `draw.modechange` | `mode.subscribe(run)` |

| terra-draw | このライブラリー |
| --- | --- |
| `new TerraDraw({ adapter, modes })` | `createDraw(map)` |
| `setMode('linestring')` | `setMode('drawLine')` |
| `getSnapshot()` | `document.toGeoJSON()` |
| `addFeatures(features)` | `tx.import(featureCollection)` |
| `removeFeatures(ids)` | `tx.features.delete(ids)` |
| `clear()` | `tx.features.delete({ all: true })` |
| `selectFeature(id)` | `selection.set('feature', [id])` |
| `on('change', ...)` | `on('change', ...)` |

選択モードは `simple_select` と `direct_select` の両方の役目を
果たします。選んだ地物の頂点は、選択モードのままドラッグできます。
地物に `mode` のプロパティーは要らず、地物の型が決めます。
`draw.undo()` と `draw.redo()` が、この端末の確定を取り消し、やり直します。
