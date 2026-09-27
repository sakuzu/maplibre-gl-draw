# mapbox-gl-draw や terra-draw からの移行

モード、地物の store、イベント、独自のモードといった考え方は、
そのまま引き継げます。移行の進め方を左右する違いは、次の 3 つ
です。

- 地物は GeoJSON の Feature ではなく、このライブラリー独自の
  レコード (`{ id, type, coordinates, layerId, properties, style,
  locked, visible }`) です。アプリケーションとの境界で、`load`
  (GeoJSON を入れる) と `export('geojson')` (GeoJSON を出す) を
  使って変換してください
- 組み込みのツールバーはありません。自分の UI から `setMode` を
  呼びます
- イベントは、地図ではなく draw のインスタンスで `draw.on` を
  使って購読します。API で行った変更でも発火します

## 最小のコード

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

`load` は Promise を返します。GeoJSON を読み込むと今ある地物に
追加され、このライブラリー独自の形式を読み込むと今ある地物を
置き換えます。`load` が受け取るのは FeatureCollection なので、
Feature が 1 つだけのときは FeatureCollection で包んでください。

## mapbox-gl-draw から

| mapbox-gl-draw | このライブラリー |
| --- | --- |
| `new MapboxDraw()`, `map.addControl(draw)` | `createMapLibreGLDraw(map)` |
| `changeMode('simple_select')` | `setMode('select')` |
| `changeMode('direct_select', ...)` | `setMode('select')` (後述) |
| `changeMode('draw_point')` | `setMode('draw_point')` |
| `changeMode('draw_line_string')` | `setMode('draw_line')` |
| `changeMode('draw_polygon')` | `setMode('draw_polygon')` |
| `getMode()` | `getMode()` |
| `add(featureCollection)` | `load(featureCollection)` |
| `get(id)` | `getFeature(id)` (GeoJSON でなくレコード) |
| `getAll()` | `export('geojson')` か `getAllFeatures()` |
| `getSelectedIds()` | `getSelectedIds()` |
| `getSelected()` | `getSelectedFeatures()` (レコード) |
| `delete(ids)` | id ごとに `deleteFeature(id)` |
| `deleteAll()` | `deleteAllFeatures()` |
| 選択モードでの `trash()` | `deleteSelection()` |
| `setFeatureProperty(id, key, value)` | `updateFeature` (後述) |
| 独自のモードのオブジェクト | `registerMode(name, factory)` |
| スタイルレイヤーの `styles` 配列 | `style` とレイヤーごとの `styleRule` |

選択モードは、`simple_select` と `direct_select` の両方の役目
を果たします。選択した線や多角形の頂点は選択モードのままドラッグ
できるので、頂点を編集するために切り替えるモードはありません。

`updateFeature` は `properties` を丸ごと置き換えるので、元の値と
合わせて渡してください。

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

| mapbox-gl-draw のイベント | このライブラリー |
| --- | --- |
| `draw.create` | `draw.feature.create` |
| `draw.update` | `draw.feature.update` |
| `draw.delete` | `draw.feature.delete` |
| `draw.selectionchange` | `draw.selection.change` |
| `draw.modechange` | `draw.mode.change` |

mapbox-gl-draw は、イベントを地図の上で、地物の配列を付けて
発火させます。また、自身の API で行った変更ではイベントを出し
ません。このライブラリーの `draw.feature.*` は、`load` も含めた
すべての変更で、地物 1 件ごとに発火します (1,000 件を読み込むと
`draw.feature.create` が 1,000 回発火します)。
`draw.features.change` は、1 つのトランザクションの変更を、変更
の出どころと一緒にまとめて知らせます。何かが変わったことだけを
知りたいときは、こちらを使ってください。

## terra-draw から

| terra-draw | このライブラリー |
| --- | --- |
| `new TerraDraw({ adapter, modes })`, `start()` | `createMapLibreGLDraw(map)` |
| `setMode('point')` | `setMode('draw_point')` |
| `setMode('linestring')` | `setMode('draw_line')` |
| `setMode('polygon')` | `setMode('draw_polygon')` |
| `setMode('circle')` | `setMode('draw_circle')` |
| `setMode('freehand')` | `setMode('draw_freehand')` |
| `setMode('select')` | `setMode('select')` |
| `getSnapshot()` | `export('geojson')` か `getAllFeatures()` |
| `getSnapshotFeature(id)` | `getFeature(id)` (GeoJSON でなくレコード) |
| `addFeatures(features)` | `load({ type: 'FeatureCollection', features })` |
| `removeFeatures(ids)` | id ごとに `deleteFeature(id)` |
| `clear()` | `deleteAllFeatures()` |
| `selectFeature(id)` | `select(id)` |
| `on('change', ...)` | `on('draw.features.change', ...)` |
| `on('select', ...)` | `on('draw.selection.change', ...)` |

terra-draw では、追加する地物がどのモードのものかを判断する
ために、各地物に `mode` プロパティーが必要です。このライブラリー
では必要ありません。地物の型で決まり、`properties` はそのまま
保たれます。組み込みのモードは、列挙しなくてもすべて使えます。
開始のための操作もありません。

terra-draw の `finish` イベントは、描き終わりとドラッグの終わり
の両方で発火します。このライブラリーでは、描き終わりは
`draw.feature.create`、ドラッグの終わりは `draw.feature.update`
(または [プラグイン](plugins.ja.md) の `drag:end` フック) で
知らせます。

## 対応するものが無いもの

- 組み込みの undo。変更の通知には、どの変更にも変更前の状態が
  付いています ([保存と読み込み](save-load.ja.md) を参照)
- ツールバーなどの DOM の部品
- 地図のスタイルレイヤーによるスタイル指定。地物は WebGL の
  カスタムレイヤーで描くので、`FeatureStyle` とスタイル規則で
  見た目を決めます ([スタイル](styles.ja.md) を参照)

## 関連する例

- [examples/basic/](../../examples/basic/) では、
  インスタンスを作り、描画して、イベントを購読します
- [examples/save-load/](../../examples/save-load/) では、
  GeoJSON を読み込み、書き出します

## リファレンス

- [MapLibreGLDraw](../api/maplibre-gl-draw/interfaces/MapLibreGLDraw.md)
- [Feature](../api/maplibre-gl-draw/interfaces/Feature.md)
- [イベント](../reference/events.md)
