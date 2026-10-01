# 読み取り専用、操作ロック、ローカル非表示

利用者が何を変えられて何を見られるかは、3 つの切り替えで決め
ます。権限や役割には関わりません。権限や役割はホストの
アプリケーションで扱います。

- 読み取り専用にすると、文書への書き込みがすべて止まります
- 操作ロックをかけると、選択はできても編集は始められません
- ローカル非表示にすると、地物、グループ、レイヤーを
  この端末でだけ隠せます

3 つともこの端末の状態です。保存も書き出しもされず、文書にも
含まれません。

## 最小のコード

<!-- docs-check:
declare function showInfoPanel(features: unknown[]): void;
-->

```ts
// 閲覧者: 選んで中身を見られるが、編集はできない
draw.setInteractionLocked(true);
draw.setReadOnly(true);

draw.on('selection.changed', () => {
  showInfoPanel(draw.selection.features());
});

// この利用者にだけレイヤーを隠す
draw.hidden.add(layerId);
```

利用者は地物をクリックして枠を見られ、地物の上からでも地図を
パンできます。利用者が何をしても、描いたものは変わりません。

## 読み取り専用

`setReadOnly(true)` にしている間は、文書へのすべての書き込みを
断ります。地物、レイヤー、グループ、ファイル、メタデータが対象です。

```ts
draw.setReadOnly(true);
draw.isReadOnly(); // true
draw.features.update(featureId, { visible: false }); // null。何も変わらない
draw.features.create({
  type: 'Point',
  geometry: { type: 'Point', coordinates: [139.767, 35.681] },
}); // null
```

- 断った書き込みは例外を投げません。書いたものを返すメソッド
  (`create`、`update`、`union` など) は `null` を、真偽値を返す
  メソッド (`delete`、`move`、`reorder`) は `false` を返し、
  `document.load` は `null` で解決します
- 引数の誤りは、読み取り専用かどうかにかかわらず `DrawError` を投げます
- すべての経路に効きます。API、描画モード、キーボード、形状
  演算、読み込み、プラグインです。描画モードには入れますが、描いた
  ものは残りません
- この端末の状態は変わります。選択、モード、頂点の選択、
  ローカル非表示です
- 自前のストアがほかの所から適用した変更は、そのまま届いて描画
  されます。そのため、読み取り専用の閲覧者にもほかの所での
  編集が見えます
- データセットは文書に含まれないので、読み取り専用の
  間も追加と削除ができます ([大量のデータを表示する](large-data.ja.md))

## 操作ロック

`setInteractionLocked(true)` にしている間、利用者は選択はでき
ますが、編集は始められません。コードからの書き込みは止めま
せん。

| できること | 止まること |
| --- | --- |
| 選択、頂点の選択 | 移動、拡縮、回転 |
| ハンドルの無い選択の枠 | 頂点のドラッグ、中点の挿入 |
| 地物の上からの地図のパン | Delete キー、グループ化、グループ解除 |
| ローカル非表示 | 矢印キーでの移動 |
| コードとプラグインからの書き込み | 描画モードへの切り替え |

- 描画中に有効にすると、描きかけの形を捨てて `select` に戻り
  ます
- 有効の間、`setMode` は `select` 以外のモードに `false` を返します
- 地物の上で始めたドラッグでは、代わりに地図がパン
  します
- 始められない移動や拡縮を、カーソルの形で示すことはあり
  ません
- Delete キーが何もしないのと同じく、`selection.delete()` と
  `vertexSelection.delete()` は `false` を返します

これは、地物のロック ([レイヤーとグループ](layers.ja.md)) と同じ
「選択はできるが編集はできない」状態を、すべての地物に一度に
かけるものです。理由にかかわらず、利用者がある地物を今編集できるかを
知るには、操作ロックと `features.isEditable(id)` を見ます。
`isEditable` は、読み取り専用と、地物、そのグループ、そのレイヤーの
ロックをまとめて答えます。

<!-- docs-check:
declare function showEditButton(): void;
-->

```ts
function canEdit(id: string): boolean {
  return !draw.isInteractionLocked() && draw.features.isEditable(id);
}

if (draw.features.has(featureId) && canEdit(featureId)) showEditButton();
```

### どちらを使うか

読み取り専用と操作ロックは独立しています。どちらか一方、両方、
どちらも使わない、のどれにもできます。

- 文書をまったく変えてはならないときは、読み取り専用を使います。
  たとえば編集の権利を持たない利用者のときです
- 編集してよい利用者の閲覧モードには、操作ロックを使います。ホストと
  そのプラグインは書き込めます (既定のレイヤーを作る、設定を当てる)
  が、利用者は地図の上で編集を始められません
- 閲覧者には両方を有効にします

## ローカル非表示

`draw.hidden` は、この端末が隠している地物、グループ、レイヤーの ID を
持ちます。文書の `visible` はそのままです。

```ts
draw.hidden.add(groupId);
draw.hidden.has(groupId); // true
draw.hidden.list(); // 隠している ID
draw.hidden.remove(groupId); // また表示する
draw.hidden.clear(); // この端末が隠したものをすべて表示する
```

- レイヤーやグループを隠すと、その中のものもすべて隠れます
- 隠した地物は、描画、クリック、矩形選択、吸着、形状演算の対象に
  なりません。選択からも外れます
- 隠したレイヤーには、描いた地物が入りません。
  [レイヤーとグループ](layers.ja.md) を参照してください
- 文書を変えないので、読み取り専用の間も使えます
- `features.list`、`document.toJSON()`、`document.toGeoJSON()` は
  これを無視します。変わるのはこの端末の見え方で、データではありません
- `hidden.add` は文書の ID だけを受け取り、それ以外の ID にはコード
  `not-found` の `DrawError` を投げます
- 地物、グループ、レイヤーを削除すると、その ID は集まりから外れます

データセットはこれに加わりません。データセットは、その `setVisible` で
表示と非表示を切り替えます。

## 自前のストアと使う

これらの状態は、インスタンスがストアの外側で持ちます。自前のストア
([保存と読み込み](save-load.ja.md)) は、読み取り専用を確かめることも、
これらの状態を持つこともありません。インスタンスが、ストアに届く前に
書き込みを断り、隠している項目とロックを自分で持ちます。

## 関連する例

- [Read-only viewer](../examples/read-only-viewer.ja.md) では、描画を
  読み込んで読み取り専用にし、クリックした地物の属性を表示します。
  キーで、読み取り専用、操作の錠、レイヤーのロック、ローカルの非表示を
  別々に切り替えます

## リファレンス

- [`Draw`](../api/maplibre-gl-draw/interfaces/Draw.md) (`setReadOnly`、
  `isReadOnly`、`setInteractionLocked`、`isInteractionLocked`)
- [`HiddenCollection`](../api/maplibre-gl-draw/interfaces/HiddenCollection.md)
- [`Feature`](../api/maplibre-gl-draw/interfaces/Feature.md)、
  [`Group`](../api/maplibre-gl-draw/interfaces/Group.md)、
  [`Layer`](../api/maplibre-gl-draw/interfaces/Layer.md) (`locked`)
