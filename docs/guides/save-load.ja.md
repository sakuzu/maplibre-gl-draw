# 保存と読み込み

描いたものは、インスタンスの中のストアに保たれています。この手引きでは、
GeoJSON かライブラリー独自の形式での書き出し、読み込み、読み込みで除かれる
もの、画像、自前のストアでの保持と、変更の通知に入っているものを
説明します。

## 最小のコード

```ts
// 保存: 描画全体を文字列で
const { data } = draw.export('native');
localStorage.setItem('drawing', data);

// 復元: 独自形式の文書は地図の上のものを置き換える
const saved = localStorage.getItem('drawing');
if (saved) await draw.load(JSON.parse(saved));
```

## 2 つの形式

| 形式 | `export(...)` で得られるもの | `load(...)` の動作 |
| --- | --- | --- |
| `native` | レイヤー、順序、グループ、地物、ファイル、メタデータ | すべて置き換えます |
| `geojson` | 地物の `FeatureCollection` 1 つ | 地物を追加します |

描いたものを、レイヤー、グループ、並び、スタイル、画像ごとそのまま保存
して復元するには `native` を使います。ほかのツールと地物を
やり取りするには `geojson` を使います。どちらの形式も
[データ形式のリファレンス](../reference/data-format.md) で定めています。

ストアの中の地物は GeoJSON の Feature ではなく、ライブラリー独自の
レコード
(`{ id, type, coordinates, layerId, properties, style, locked, visible }`)
です。`export` と `load` が境界で変換し、`draw.getAllFeatures()` は
レコードそのものを返します。

## 書き出し

```ts
const result = draw.export('geojson');
// result.data: JSON のテキスト
// result.mimeType: 'application/geo+json'
// result.fileName: メタデータの題名から作った名前

// 一部のフィーチャーだけ、または一部のレイヤーだけ
draw.export('geojson', { featureIds: ['a', 'b'] });
draw.export('native', { layerIds: [layerId], fileName: 'site.json' });
```

- `data` は文字列です。ダウンロードさせるには `Blob` に包んでください
- GeoJSON は RFC 7946 に従います。リングは右手の法則に従い、位置は
  小数 7 桁に丸め、FeatureCollection には `bbox` が付きます
- 非表示の地物も、プロパティーに `visible: false` を残して
  書き出します。そのため、書き出して読み戻しても非表示のままです
- `name` と `description` は普通のプロパティーです。ライブラリーの
  それ以外の項目は、接頭辞 `maplibre-gl-draw:` を付けたプロパティーに
  なります
- 画像はデータ URL として埋め込むので、ファイル単体で完結します
- `draw.getSuggestedFileName()` を使うと、書き出さずに独自形式の
  ファイル名が得られます。題名は `draw.setMetadata({ title })` で設定
  します

## 読み込み

`draw.load(source, options?)` は `File` か解析済みのオブジェクトを受け
取り、`LoadResult` の Promise を返します。

```ts
const input = document.querySelector<HTMLInputElement>('#file');
input?.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const result = await draw.load(file);
    console.log(result.format, result.featureIds.length);
    for (const { index, reason } of result.skipped ?? []) {
      console.warn(`feature ${index} left out: ${reason}`);
    }
  } catch (error) {
    console.error('not loaded', error); // 描画は変わらない
  }
});
```

- 名前が `.json` か `.geojson` で終わる `File` (または MIME 型が JSON の
  `File`) は解析します。画像ファイルは Image 地物になります
  (後述)
- オブジェクトは、独自の形式か GeoJSON の `FeatureCollection` かを判定
  します。どちらでもなければ例外を投げます
- データはストアを変える前に検証するので、例外を投げた読み込みでは、
  描いたものはそのまま残ります
- 独自の形式の文書は、どこかの形が不正なとき、存在しないものを参照して
  いるとき、`version` の major が異なるときは、全体を受け付けません
- 形状が使えない GeoJSON の地物 (形状が無い、対応していない、
  有限でない数を含む、位置が 1 つだけの線、閉じていないリングなど) は
  除かれ、その番号と理由が `skipped` に載ります。残りは読み込みます
- 型や形の合わないスタイルの値 (`#rgb` や `#rrggbb` ではない色、0 から
  1 の範囲外の不透明度) は捨て、地物は残します
- ID がすでに使われている GeoJSON の地物には新しい ID を振り
  ます。そのため、書き出したものを同じ描画に読み戻せます
- GeoJSON の地物は、`maplibre-gl-draw:layerId` のレイヤーが
  あればそのレイヤーに、無ければアクティブなレイヤーに入ります
- Multi の形状は Multi の地物のまま保ちます。`flattenMulti: true`
  を指定すると単一の地物に分けます。`GeometryCollection` は、
  形状の型ごとに多くても 1 つの Multi の地物にまとめます

## 地図にドロップされたファイル

ライブラリーは、地図にドロップされたファイルを受け取りません。どの
ファイルを受け付けるか、どこに置くか、独自の形式のファイルで描いた
ものを置き換えてよいかは、アプリケーションが決めることだからです。
ドロップされたファイルを読み込むには、地図の要素 (コンテナー) で
ドロップを受け、位置を `map.unproject` で座標に直し、ファイルを 1 つずつ
`draw.load` に渡します。

```ts
const container = map.getContainer();

// これが無いと、ブラウザーはドロップせずにファイルを開きます
container.addEventListener('dragover', (event) => event.preventDefault());

container.addEventListener('drop', async (event) => {
  event.preventDefault();
  const rect = container.getBoundingClientRect();
  const { lng, lat } = map.unproject([
    event.clientX - rect.left,
    event.clientY - rect.top,
  ]);
  for (const file of event.dataTransfer?.files ?? []) {
    try {
      // 位置は画像が使います。データのファイルは自分の位置を持っています
      await draw.load(file, {
        coordinate: [lng, lat],
        zoom: map.getZoom(),
        layerId: draw.getActiveLayer(),
      });
    } catch (error) {
      console.error(`${file.name} を読み込めませんでした`, error);
    }
  }
});
```

ほかのことは、アプリケーションがこのハンドラーの中で決めます。
`draw.isReadOnly()` や `draw.isInteractionLocked()` が true の間は
ドロップを断る、独自の形式のファイルで描いたものを置き換える前に
確かめる、ファイルを自分で読んで地物をデータセットに渡す
([大量のデータ](large-data.ja.md)) といったことができます。

## 画像

画像ファイルには、置く場所の指定が必要です。

<!-- docs-check:
declare const imageFile: File;
-->

```ts
await draw.load(imageFile, {
  coordinate: [139.767, 35.681],
  zoom: map.getZoom(),
  layerId: draw.getActiveLayer(),
});
```

画像は WebP に変換し、一辺が 4096 px を超えると縮小して、文書の
ファイルとして 1 度だけ保存します。新しい Image 地物は
`imageFileId` でそれを参照します。読み込む文書に埋め込まれた画像は、
宣言した型と一致する `data:image/(png|jpeg|webp|gif);base64,` の
データ URL だけを受け付けます。`draw_image` モードについては
[描画と編集](drawing.ja.md#画像) を参照してください。

## 変更のたびに保存する

`draw.features.change` は、変更 1 回ごとに、その中で変わったものを
すべて載せて 1 度だけ発火します。編集のたびに保存するなら、このイベントを
使います。

```ts
let timer: ReturnType<typeof setTimeout> | undefined;

draw.on('draw.features.change', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    localStorage.setItem('drawing', draw.export('native').data);
  }, 500);
});
```

ドラッグ中はポインターが動く間に途中の状態が書き込まれ、その一つひとつが
変更になるので、上のように保存を間引いてください。レイヤーとグループの
変更には別のイベントがあります (`draw.layer.update` など。
[イベント](../reference/events.md) を参照)。

## 自前のストア

描いたものをデータベースやサーバーに保つだけなら、組み込みのストアの
変更を受け取れば足りることがほとんどです。

<!-- docs-check:
declare function sendToServer(changes: unknown): void;
-->

```ts
draw.getStore().subscribe((changes) => {
  // changes.features, changes.layers, changes.groups, changes.source ...
  sendToServer(changes);
});
```

文書そのものを別の場所に置く必要があるときは、`Options.store` で
インスタンスにストアを渡します。

<!-- docs-check:
declare function createDocumentStore(): DocumentStore;
-->

```ts
import {
  createMapLibreGLDraw,
  type DocumentStore,
} from '@sakuzu/maplibre-gl-draw';

// DocumentStore の約束を満たす自前の実装
const store: DocumentStore = createDocumentStore();
const draw = createMapLibreGLDraw(map, { store });
```

状態は次のように分かれています。

| 型 | 中身 |
| --- | --- |
| `DocumentStore` | 文書 (地物、レイヤー、グループ、ファイル、メタデータ) |
| `Store` | 文書と core のローカルな状態を、1 つの関門の後ろにまとめたもの |
| `StoreView` | 読み取り、`subscribe`、`transact`。`draw.getStore()` が返します |
| `MemoryStore` | メモリー上の `Store` で、既定で使われます |

自前の `DocumentStore` が持つのは文書だけです。選択、モード、読み取り
専用などのローカルな状態は、core がその外側で持ちます。守るべき約束
(どの地物もちょうど 1 つの入れ物に並ぶこと、通知に載せた
オブジェクトを後から変えないこと、`transact` は 1 つの通知にまとめる
ことなど) は
[`DocumentStore`](../reference/api/interfaces/index.DocumentStore.html)
に書いてあります。自前のストアがインスタンスの外から適用した変更も、ローカルの変更と
同じように描画され、通知されます。読み取り専用でも止められません。その
通知には更新元 `'remote'` を付けてください。core は頂点の選択をそれに
合わせて保ち、購読者はローカルの編集と見分けられます。

書き込みはインスタンスを通して行います (`addFeature` や `updateLayer`
など)。`draw.getStore()` には書き込みのメソッドがありません。複数の
書き込みを 1 つの変更にするには、`draw.getStore().transact(() => { ... })`
で包んでください。

## 変更の通知に入っているもの

core は変更の履歴を持ちません。`draw.getStore().subscribe` の購読者が
文書を追いかけたり、前の状態に戻したりするのに必要なものは、すべて
通知に入っています。

- どの更新にも変更前の `previous` のオブジェクトが付き、削除には削除した
  オブジェクトが付きます
- 1 つのトランザクションが 1 つの通知になるので、幾何演算、グループ化、
  複数の地物のドラッグは 1 つの手順として届きます
- `source` は変更の出所を示します。編集なら `'local'`、GeoJSON の
  読み込みなら `'batch'`、独自の形式の読み込みと選択のリセットなら
  `'silent'` で、`transact` に渡した任意の値も入ります
- ドラッグの途中の更新には `isIntermediate: true` が付きます。その後に
  来る、これが付いていない更新でドラッグが確定します

レイヤー、グループ、削除した地物のグループへの所属も、地物と同じ通知で
届きます。購読者が自分で適用する変更には、`transact` に渡す任意の文字列を
出所として付けられるので、購読者はその出所で自分の変更を除けます。

## 関連する例

- [save-load](../../examples/save-load/) では、両方の形式で書き
  出し、GeoJSON のファイルを読み込んで `skipped` を表示し、地図に
  ドロップされたファイルを読み込み、描いたものを `localStorage` に
  保ちます

## リファレンス

- [`LoadOptions`](../reference/api/interfaces/index.LoadOptions.html)、
  [`LoadResult`](../reference/api/interfaces/index.LoadResult.html)、
  [`SkippedFeature`](../reference/api/interfaces/index.SkippedFeature.html)
- [`ExportOptions`](../reference/api/interfaces/index.ExportOptions.html)
  と [`ExportResult`](../reference/api/interfaces/index.ExportResult.html)
- [`DocumentStore`](../reference/api/interfaces/index.DocumentStore.html)、
  [`StoreView`](../reference/api/interfaces/index.StoreView.html)、
  [`StateChanges`](../reference/api/interfaces/index.StateChanges.html)
- [データ形式](../reference/data-format.md) と
  [イベント](../reference/events.md)
