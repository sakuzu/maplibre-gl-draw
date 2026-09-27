# レイヤーとグループ

すべての地物はどれかのレイヤーに属し、1 つのレイヤーの
地物はグループにまとめられます。この手引きでは、レイヤー、新しい
地物が入るアクティブなレイヤー、グループ、ロック、描画順と、
MapLibre 自身のレイヤーを描画のレイヤーの間に置く方法を説明します。

## 最小のコード

```ts
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map);

// 既定のレイヤー ("Layer 1") がある。2 つ目を足してそこに描く
// (読み取り専用のとき addLayer は null を返す)
const notes = draw.addLayer('Notes');
if (notes !== null) {
  draw.setActiveLayer(notes);
  draw.setMode('draw_point');

  // 後で: ロックし、選択はできるが編集はできないようにする
  draw.updateLayer(notes, { locked: true });
}
```

## レイヤー

`Layer` は、`name`、`visible`、`locked`、`opacity`、中の項目の並び
`order` (地物とグループの ID で、末尾が前面)、省略できる
`styleRule` ([スタイル](styles.ja.md)) を持ちます。

| メソッド | 動作 |
| --- | --- |
| `addLayer(name?)` | 最前面にレイヤーを追加し、ID を返します |
| `updateLayer(id, updates)` | レイヤーの項目を変えます |
| `deleteLayer(id)` | レイヤーを中の地物やグループごと削除します |
| `getAllLayers()`、`getLayer(id)` | 読み取ります |

読み取り専用の間は、`addLayer` は何も追加せずに `null` を返します。
`addFeature` と `addGroup` も同じです ([読み取り専用](read-only.ja.md))。

名前を指定せずに追加したレイヤーとグループには、自動の名前付けで
名前が付きます (`Layer 2`、`Group 1`)。語は `autoName` オプションから
取られます ([自動の名前](drawing.ja.md#自動の名前))。

インスタンスを作ると、ID が `default-layer` の既定のレイヤーができます。
`initDefaultLayer: false` を指定するとレイヤーは作られず、ホストが自分で
作ります。自前のデータから構造を復元するときなどに使います。

`deleteLayer` は、レイヤーの中にあるものをすべて削除します。レイヤーを
選んでいるときの `draw.deleteSelection()` と Delete キーは、少なくとも
1 つのレイヤーを残し、ロックされた地物やグループを含むレイヤーは
削除しません。

変更すると、`draw.layer.create`、`draw.layer.update`、
`draw.layer.delete`、`draw.layer.reorder` が出ます。

## アクティブなレイヤー

新しい地物はアクティブなレイヤーに入ります。
`setActiveLayer(id)` で設定し、`getActiveLayer()` で読み取ります。
アクティブなレイヤーが削除されると、最初のレイヤーがアクティブになります。

利用者が描いたものは、存在していて、ロックされておらず、表示されている
(全員に対しても、ローカルでも非表示になっていない) レイヤーにだけ書き
込まれます。アクティブなレイヤーに書き込めないときは、書き込める最初の
レイヤーに入ります。アクティブなレイヤーに再び書き込めるようになれば、
そちらに戻ります。書き込めるレイヤーが 1 つも無い間は、`setMode` は描画
モードを受け付けません。この規則は利用者の描画にだけ当てはまり、
`addFeature` と `load` は存在するどのレイヤーでも受け付けます。

## 描画順

どの階層でも、配列の末尾が前面です。

1. レイヤーどうしでは、レイヤーの順 (`getLayerOrder()`)
2. レイヤーの中では、`layer.order` (地物とグループ)
3. グループの中では、`group.featureIds`

`getAllFeatures()` は、すべての地物をこの順に背面から返します。

<!-- docs-check:
declare const notes: string;
-->

```ts
// notes レイヤーを既定のレイヤーの背面へ
draw.setLayerOrder([notes, 'default-layer']);

// 1 つのフィーチャーをレイヤーの最前面へ
const layer = draw.getLayer('default-layer');
if (layer) draw.reorderInLayer(featureId, layer.id, layer.order.length - 1);

// フィーチャーかグループを別のレイヤーへ移す
draw.moveToLayer(featureId, notes);
```

レイヤーの順は文書の一部です。`export('native')` が保存し、`load()` が
丸ごと置き換え、差し替えた Store が持ちます。レイヤーではない独自の
項目も入れられます。データセットの ID
([大量のデータ](large-data.ja.md) を参照) と区切り (後述) です。その
意味はアプリが決め、ライブラリーはそれぞれの位置を保つだけです。

- `setLayerOrder` は、レイヤーではない ID も残します。空の文字列は
  捨て、同じ ID が繰り返されたら最初の位置に残します
- `addLayer` は新しいレイヤーを最前面に置き、`deleteLayer` はその
  レイヤーの ID だけを外します。ほかに項目を外す操作は無いので、独自の
  項目は、それを除いた順をアプリが設定するまで残ります
- 何も指さない ID は、描画のときに読み飛ばされます

## グループ

グループは 1 つのレイヤーの地物をまとめ、一緒に選択、移動、
非表示、ロックできるようにします。

<!-- docs-check:
declare const idA: string;
declare const idB: string;
-->

```ts
// 読み取り専用なら null
const groupId = draw.addGroup([idA, idB], draw.getActiveLayer(), 'Site');

// 現在の選択から。Cmd/Ctrl+G と同じ
draw.select([idA, idB]);
const created = draw.groupSelection(); // まとめられないときは null
```

`groupSelection` は、2 つ以上の地物が選ばれていて、すべて同じ
レイヤーにあり、どれもまだグループに入っていないときにグループを作り
ます。グループは、レイヤーの並びの中で、選ばれた地物のうち最も
前面にあるものの位置に入ります。

| メソッド | 動作 |
| --- | --- |
| `addFeatureToGroup(featureId, groupId, index?)` | グループに入れます |
| `removeFeatureFromGroup(featureId)` | グループの直後に出します |
| `reorderInGroup(featureId, groupId, index)` | グループの中で並べ替えます |
| `ungroupSelection()` | グループを解除するか、メンバーを出します |
| `ungroupGroup(groupId)` | 1 つのグループを解除します |
| `deleteGroup(groupId)` | グループを削除し、地物は残します |

- `ungroupSelection` は、選んだグループを解除するか、選んだメンバーを
  そのグループから出します。Shift+Cmd/Ctrl+G と同じ動作です
- グループを解除するか削除すると、中の地物は元の順のまま、
  グループがあった位置に入ります
- 空になったグループ (最後のメンバーが出たか削除された) は自動で削除
  されます
- 地物は常にちょうど 1 か所に並びます。`groupId` があれば
  そのグループの `featureIds` に、無ければレイヤーの `order` に並び
  ます。`updateFeature` で `layerId` か `groupId` を変えると、並ぶ場所が
  移ります

## ロック

地物、グループ、レイヤーの `locked` を設定すると、選択と表示は
できますが、それ以外の編集はすべて拒まれます。

```ts
draw.updateFeature(featureId, { locked: true });
draw.updateGroup(groupId, { locked: true });
draw.updateLayer(layerId, { locked: true });
```

- ロックは継承されます。地物自身か、そのグループか、その
  レイヤーがロックされていれば、その地物はロックされています。
  `isFeatureLocked(feature, draw.getStore())` で判定できます
- ロックされた地物は選べて、`getSelectedFeatures()` にも含まれ
  ます
- 移動、拡縮、回転、頂点の編集、削除はできず、ハンドルは出ず、矩形選択
  でも選ばれません
- `updateFeature`、`updateGroup`、`updateLayer` は、ロックされた項目の
  `locked` と `visible` 以外を変えようとすると `false` を返します
- Delete キーはロックされた地物を残します。選んだグループからは
  ロックされていないメンバーだけが削除され、ロックされた項目を含む
  レイヤーは削除されません
- 幾何演算は、ロックされた地物を読み飛ばします

データに触れずにすべての編集をまとめて止めるには、読み取り専用か操作
ロックを使ってください ([読み取り専用](read-only.ja.md))。

## 表示

地物、グループ、レイヤーの `visible: false` は、文書を共有して
いる全員に対して隠します。この設定は保存され、書き出されます。この
クライアントでだけ隠すには、`setLocallyHidden` を使います
([読み取り専用](read-only.ja.md))。非表示の地物は、描画、当たり
判定、吸着、幾何演算の対象になりません。

## 不透明度

`opacity` (0 から 1) で、レイヤー全体を薄くできます。レイヤーについて
描くものすべて (塗り、線、点、画像と、独自の型の描画器や地物に
付随する描画が描くもの) のアルファに掛けられます。

```ts
draw.updateLayer(layerId, { opacity: 0.4 });
```

- 描画のときに掛けるので、値を変えても (スライダーで動かすなど) 何も作り
  直しません
- 見た目だけの設定です。不透明度が 0 のレイヤーの地物にも当たり
  判定があり、選べます。邪魔にならないようにするには非表示にしてください
- 独自の型の描画器は、この値を `context.opacity` で受け取り、自分の
  アルファに掛けます ([独自の型](custom-types.ja.md))

## 区切りと枠

描いたものは全体で 1 つの MapLibre のカスタムレイヤーなので、MapLibre の
レイヤー (ベクタータイルやラスター) は、そのすべての下か上のどちらかに
なります。そうしたレイヤーを描画のレイヤーの間に置くには、レイヤーの
並びの項目の 1 つを区切りとして印を付けます。すると描画は、区切りと区切り
の間ごとに 1 つのカスタムレイヤー (枠) に分かれ、ホストは自分の MapLibre
のレイヤーをその間に移せます。1 つの地物を `beforeId` で MapLibre の
レイヤーの間に置くことはできません。動かせるのは区切りの間ごとの
まとまりです。

<!-- docs-check:
declare const parcels: string;
declare const notes: string;
-->

```ts
const SEPARATOR = 'sep:';

const draw = createMapLibreGLDraw(map, {
  isExternalEntry: (id) => id.startsWith(SEPARATOR),
});

// 道路 (MapLibre のレイヤー) を parcels と notes の間に
draw.setLayerOrder([parcels, `${SEPARATOR}roads`, notes]);

function placeNativeLayers(): void {
  const order = draw.getLayerOrder();
  const slots = draw.getRenderSlots();
  order.forEach((entry, index) => {
    if (!entry.startsWith(SEPARATOR)) return;
    // 区切りの上の枠のすぐ下、無ければ最前面
    const above = slots.find((slot) => slot.from > index);
    map.moveLayer(entry.slice(SEPARATOR.length), above?.layerId);
  });
}

placeNativeLayers();
draw.on('draw.renderslots.change', placeNativeLayers);
```

- `getRenderSlots()` は枠を背面から返します。どの枠も、レイヤーの並びの
  上の区間 `[from, to)` と、自分のカスタムレイヤーの ID を持っています
- 区切りが無ければ枠は `maplibre-gl-draw-layer` の 1 つだけです
- `draw.renderslots.change` は、枠が追加されたり削除されたり、区間が
  変わったりしたときに発火します。そのときに MapLibre のレイヤーを置き
  直してください

## 関連する例

- [style-rules](../../examples/style-rules/) では、レイヤーを
  追加し、スタイル規則を設定します
- [read-only](../../examples/read-only/) では、レイヤーをロックし、
  `isFeatureLocked` で確かめます

## リファレンス

- [`MapLibreGLDraw`](../api/maplibre-gl-draw/interfaces/MapLibreGLDraw.md)
  (レイヤー、グループ、並びのメソッドと `getRenderSlots`)
- [`Layer`](../api/maplibre-gl-draw/interfaces/Layer.md) と
  [`Group`](../api/maplibre-gl-draw/interfaces/Group.md)
- [`RenderSlot`](../api/maplibre-gl-draw/interfaces/RenderSlot.md)
- [`isFeatureLocked`](../api/maplibre-gl-draw/functions/isFeatureLocked.md)
- [イベント](../reference/events.md)
