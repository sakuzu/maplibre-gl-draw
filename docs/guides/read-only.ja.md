# 読み取り専用、操作ロック、ローカル非表示

利用者が何を変えられて何を見られるかは、3 つの切り替えで決め
ます。権限や役割には関わりません。権限や役割はホストの
アプリケーションで扱います。

- 読み取り専用にすると、文書への書き込みがすべて止まります
- 操作ロックをかけると、選択はできても編集は始められません
- ローカル非表示にすると、地物、グループ、レイヤーを
  このクライアントでだけ隠せます

3 つともインスタンスのローカルな状態です。保存も書き出しも
されず、ほかのクライアントとも共有されません。

## 最小のコード

<!-- docs-check:
declare function showInfoPanel(features: unknown[]): void;
-->

```ts
// 閲覧者: 選択して中身を見られるが、編集はできない
draw.setInteractionLock(true);
draw.setReadOnly(true);

draw.on('draw.selection.change', ({ ids }) => {
  showInfoPanel(ids.map((id) => draw.getFeature(id)));
});

// この利用者に対してだけレイヤーを隠す
draw.setLocallyHidden(layerId, true);
```

利用者は地物をクリックして選択の枠を見られ、フィー
チャーの上からでも地図をパンできます。利用者が何をしても描画は
変わりません。

## 読み取り専用

`setReadOnly(true)` にしている間は、文書への書き込みをすべて
拒みます。対象は地物、レイヤー、グループ、ファイル、
メタデータです。

```ts
draw.setReadOnly(true);
draw.isReadOnly(); // true
draw.updateFeature(featureId, { visible: false }); // false。何も変わらない
draw.addFeature({ type: 'Point', coordinates: [139.767, 35.681] }); // null
```

- 拒んだ書き込みは、boolean を返すメソッドでは `false` を返し
  ます。`addFeature`、`addLayer`、`addGroup` (ふだんは新しい
  ID を返すメソッド) では `null` を返し、そのほかのメソッドでは
  何もしません。例外は投げません
- すべての経路に効きます。API、描画モード、キーボード、形状
  演算、`load`、プラグインです
- ローカルな状態は変わります。選択、モード、頂点の選択、
  ローカル非表示です
- 自前のストアがほかの所から適用した変更は、そのまま届いて描画
  されます。そのため、読み取り専用の閲覧者にもほかの利用者の
  編集が見えます
- データセットは文書に含まれないので、読み取り専用の
  間も追加と削除ができます ([大量のデータ](large-data.ja.md))

## 操作ロック

`setInteractionLock(true)` にしている間、利用者は選択はでき
ますが、編集は始められません。コードからの書き込みは止めま
せん。

| できること | 止まること |
| --- | --- |
| 選択、頂点の選択 | 移動、拡縮、回転 |
| ハンドルの無い選択の枠 | 頂点のドラッグ、中点の挿入 |
| 地物の上からの地図のパン | Delete、グループ化、グループ解除のキー |
| ローカル非表示 | 矢印キーでの移動 |
| コードとプラグインからの書き込み | 描画モードへの切り替え |

- 描画中に有効にすると、描きかけの形を捨てて `select` に戻り
  ます
- 有効の間、`setMode` は `select` 以外のモードを拒みます
- 地物の上で始めたドラッグでは、代わりに地図がパン
  します
- 始められない移動や拡縮を、カーソルの形で示すことはあり
  ません

これは、地物のロック
([レイヤーとグループ](layers.ja.md#ロック)) と同じ「選択は
できるが編集はできない」状態を、すべての地物に一度に
かけるものです。理由にかかわらず、ある地物を今編集
できるかどうかを知りたいときは、次のようにします。

<!-- docs-check:
declare function showEditButton(): void;
-->

```ts
import { isInteractionBlocked } from '@sakuzu/maplibre-gl-draw';

const feature = draw.getFeature(featureId);
if (feature && !isInteractionBlocked(feature, draw.getStore())) {
  showEditButton();
}
```

`isInteractionBlocked` は、読み取り専用のとき、操作ロック中の
とき、地物かそのグループかそのレイヤーがロックされて
いるときに真になります。

### どちらを使うか

読み取り専用と操作ロックは互いに独立しています。どちらか一方
だけ、両方、どちらも無し、のどの組み合わせにもできます。

- 文書を一切変えてはいけないときは、読み取り専用を使います。
  たとえば、編集の権利が無い利用者のときです
- 編集してよい利用者の閲覧モードには、操作ロックを使います。
  ホストとそのプラグインは書き込めます (既定のレイヤーを作る、
  設定を適用するなど) が、利用者は地図の上で編集を始められま
  せん
- 閲覧者には両方を有効にします

## ローカル非表示

`setLocallyHidden(id, hidden)` は、地物、グループ、
レイヤーをこのクライアントでだけ隠します。共有の `visible`
フラグはそのままです。

```ts
draw.setLocallyHidden(groupId, true);
draw.isLocallyHidden(groupId); // true
draw.getLocallyHidden(); // 隠している ID の ReadonlySet
```

- レイヤーかグループを隠すと、その中のものもすべて隠れます
- 隠した地物は、描画、クリック、矩形選択、吸着、
  幾何演算のどれの対象にもならず、選択からも外れます
- ローカルで隠したレイヤーには、描画で書き込みません
  ([レイヤーとグループ](layers.ja.md#アクティブなレイヤー) を
  参照してください)
- 文書を変えないので、読み取り専用の間も使えます
- `export`、`getAllFeatures`、`getVisibleFeatures` はローカル
  非表示を考慮しません。変わるのはこのクライアントでの見え方で、
  データではないからです
- 地物、グループ、レイヤーを削除すると、その ID は
  集合から外れます

データセットはローカル非表示の対象外です。表示と非表示
は、データセットの追加と削除で切り替えます。

## 自前のストアと組み合わせるとき

これらの状態は、文書のストアを包むインスタンスの側にあります。
自前の `DocumentStore` ([保存と読み込み](save-load.ja.md)) は、
読み取り専用かどうかを確かめる必要も、これらの状態を持つ必要も
ありません。書き込みはストアに届く前にインスタンスが拒み、
非表示の集合とロックもインスタンスが自分で持ちます。

## 関連する例

- [read-only](../../examples/read-only/) では、読み取り
  専用、操作ロック、ローカル非表示を切り替え、レイヤーをロック
  し、`isFeatureLocked` で確かめます

## リファレンス

- [`MapLibreGLDraw`](../reference/api/interfaces/index.MapLibreGLDraw.html)
  (`setReadOnly`、`setInteractionLock`、`setLocallyHidden` と、
  それぞれの状態を読むメソッド)
- [`isInteractionBlocked`](../reference/api/functions/index.isInteractionBlocked.html)
  と
  [`isFeatureLocked`](../reference/api/functions/index.isFeatureLocked.html)
