# 保存と読み込み

描いたものは 1 つの文書です。文書は地物、レイヤー、グループ、埋め込んだ
ファイル、メタデータでできています。この手引きでは、文書を GeoJSON か
ライブラリー独自の形式で書き出すこと、読み込み、読み込みで除かれる
もの、画像、変更のたびの保存、自前のストアでの保持、変更に入っている
ものを説明します。

## 最小のコード

```ts
// 保存: 文書全体をライブラリーの形式で
localStorage.setItem('drawing', JSON.stringify(draw.document.toJSON()));

// 復元: ライブラリーの文書は地図の上のものを置き換える
const saved = localStorage.getItem('drawing');
if (saved) await draw.document.load(saved);
```

## 2 つの形式

| 形式 | 書き出すメソッド | `load` の既定の動作 |
| --- | --- | --- |
| 独自の形式 | `document.toJSON()` | 文書を置き換えます |
| GeoJSON | `document.toGeoJSON()` | 地物を追加します |

独自の形式は文書の全体を持ちます。レイヤーとその順序、グループ、地物、
ファイル、メタデータです。GeoJSON は地物の `FeatureCollection` を 1 つ
持ちます。

描いたものを、レイヤー、グループ、並び、スタイル、画像ごとそのまま保存
して復元するには独自の形式を使います。ほかのツールと地物をやり取り
するには GeoJSON を使います。どちらの形式も
[データ形式のリファレンス](../reference/data-format.md) で定めています。

地物は GeoJSON を持っています。`geometry` は GeoJSON の形状で、
`properties` は GeoJSON のプロパティーです。ライブラリーが地物に持たせる
値 (基準のズーム、円の半径、画像の大きさ) は、`properties` の中の
`maplibre-gl-draw:` で始まるキーに入っています。それ以外のキーは
あなたの属性です。どちらの形式も `properties` をそのまま書き出します。

## 文書の書き出し

`toJSON()` は文書をオブジェクト (`DrawDocument`) で返し、
`toGeoJSON()` は GeoJSON の `FeatureCollection` を返します。
`JSON.stringify` でテキストにし、ファイル名はアプリケーションで
付けてください。

```ts
const geojson = draw.document.toGeoJSON();
const title = draw.metadata.get().title || 'drawing';
const blob = new Blob([JSON.stringify(geojson)], {
  type: 'application/geo+json',
});

const link = document.createElement('a');
link.href = URL.createObjectURL(blob);
link.download = `${title}.geojson`;
link.click();
URL.revokeObjectURL(link.href);
```

- 独自の形式の文書には、形式の版 `3.0.0` が入ります
- GeoJSON は RFC 7946 に従います。リングは右手の法則に従い、位置は
  小数 7 桁に丸め、`FeatureCollection` には `bbox` が付きます
- 非表示の地物も、プロパティーに `visible: false` を残して
  書き出します。そのため、書き出して読み戻しても非表示のままです
- GeoJSON に置き場所の無い地物の項目 (レイヤー、グループ、スタイル、
  ロック、`Circle` のような型) は、接頭辞 `maplibre-gl-draw:` を付けた
  プロパティーとして書き出します。そのファイルを読み戻すと元に戻ります
- 画像はデータ URL として埋め込むので、ファイル単体で完結します
- 題名と説明は `draw.metadata.update({ title })` で設定します

自分の属性だけが欲しい読み手は、ライブラリーのキーを除きます。

```ts
import { isDrawProperty } from '@sakuzu/maplibre-gl-draw';

const rows = draw.document.toGeoJSON().features.map((f) =>
  Object.fromEntries(
    Object.entries(f.properties ?? {}).filter(([key]) => !isDrawProperty(key)),
  ),
);
```

描画に無い地物や、一部の地物だけを書き出すときは、それらを
`featuresToGeoJSON(features, { getFile })` に渡します。渡した順に、
`toGeoJSON()` と同じ規則で書き出します。地物 1 つなら
`featureToGeoJSON` を使います。`getFile` は ID から画像のファイルを
引く関数で、たとえば `(id) => store.getFile(id)` です。渡さないと、
画像は画素を持たずに書き出されます。

## 読み込み

`draw.document.load(source, options?)` は、`File` か `Blob`、JSON の
文字列、ライブラリーの文書、GeoJSON (`FeatureCollection`、`Feature`、
形状) を受け取ります。返すのは `LoadResult` の Promise で、文書が
読み取り専用のときは `null` の Promise です。

```ts
const input = document.querySelector<HTMLInputElement>('#file');
input?.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const result = await draw.document.load(file);
    if (!result) return; // 読み取り専用
    console.log(result.format, result.featureIds.length, result.replaced);
    for (const { index, reason } of result.skipped ?? []) {
      console.warn(`feature ${index} left out: ${reason}`);
    }
  } catch (error) {
    console.error('not loaded', error); // 文書は変わらない
  }
});
```

- 形式は中身から判断します。ライブラリーの文書、GeoJSON、画像ファイル
  (後述) のどれでもなければ、コード `unsupported-format` の
  `DrawError` で失敗します
- `mode` で、文書を置き換える (`replace`。ライブラリーの文書の既定) か
  追加する (`merge`。GeoJSON の既定) かを選びます。ライブラリーの文書は
  置き換えしかできません。`replace` を指定した GeoJSON は、地物と
  グループを置き換え、レイヤーは残します
- データは文書を変える前に検証するので、失敗した読み込みでは、描いた
  ものはそのまま残ります
- ソースを読み終えた後 (画像ならデコードした後) の書き込みは、形式に
  かかわらず、出どころ `load` の 1 つのトランザクションになります。
  `document.changed` は 1 回で、変更を記録するリスナーにとっては 1 つの
  手順です
- ライブラリーの文書は、どこかの形が不正なとき、存在しないものを参照
  しているとき、ライブラリーが読めない major の版のときは、全体を
  受け付けず、コード `invalid-input` で失敗します。前の major の版の
  文書は、読み込むときに新しい版に直します
- 形状が使えない GeoJSON の地物 (形状が無い、対応していない、
  有限でない数を含む、位置が 1 つだけの線、閉じていないリングなど) は
  除かれ、その番号と理由が `skipped` に載ります。残りは読み込みます
- 型や形の合わないスタイルの値 (CSS の色ではない色、0 から 1 の範囲外の
  不透明度) は捨て、地物は残します
- 埋め込まれた画像が、宣言した型の PNG、JPEG、WebP、GIF のデータ URL
  でないとき、または画素をデコードできないときは、読み込み全体を
  `invalid-input` で受け付けません。縮小が必要な画像を、ブラウザーが
  それらの型で書き出せないときは、画像ファイルと同じく
  `unsupported-format` で受け付けません
- ID がすでに使われている GeoJSON の地物には新しい ID を振り
  ます。そのため、`toGeoJSON()` で書き出したファイルを同じ描画に
  読み戻せます
- GeoJSON の地物は、`options.layerId` を指定すればそのレイヤーに、
  無ければ `maplibre-gl-draw:layerId` のレイヤーがあればそのレイヤーに、
  それも無ければアクティブなレイヤーに入ります
- `options.layer` (`LayerInput`) を指定すると、同じトランザクションで
  レイヤーを作り、すべての地物をそこに入れます。その ID は
  `LoadResult.layerId` に載ります。`layerId` と一緒には指定できません
  (`invalid-input`)
- `options.group` (`featureIds` の無い `GroupInput`) を指定すると、
  読んだ地物をすべて、同じトランザクションで作る 1 つのグループに
  入れます。グループは地物が入った場所に置きます。このとき地物はすべて
  1 つのレイヤー (`layer` か `layerId` のレイヤー、無ければアクティブな
  レイヤー) に入り、GeoJSON の地物が指すグループには入りません。その ID
  は `LoadResult.groupId` に載ります。何も読まなければグループは作り
  ません。ライブラリーの文書は自分のレイヤーとグループを持つので、
  `layer` も `group` も受け付けません
- Multi の形状は Multi の地物のまま保ちます。`flattenMulti: true`
  を指定すると単一の地物に分けます。`GeometryCollection` は、
  形状の型ごとに多くても 1 つの Multi の地物にまとめます

何かを読んだ読み込みは、同じ結果を載せて `document.loaded` を出し、
追加した地物ごとに `feature.created` を出します。読み込み 1 回ごとに
反応するには、`document.changed` か `document.loaded` を受けてください
([イベント](../reference/events.md))。

### 複数のソースをまとめて読む

`draw.document.loadMany(items)` は、すべてのソースを先に読み、それから
全部を 1 つのトランザクションで書きます。そのため、複数のファイルの
取り込みが 1 回の `document.changed` になり、取り消すのも送るのも 1 回で
済みます。項目は順に、`load` と同じように書きます。

```ts
declare const files: File[];

const results = await draw.document.loadMany(
  files.map((file) => ({ source: file, options: { mode: 'merge' as const } })),
);
console.log(results?.length); // 読み取り専用のあいだは null
```

読めないソースが 1 つでもあれば、その `DrawError` で失敗し、何も書き
ません。`document.loaded` は項目ごとに届きます。

項目のオプションに `layer` と `group` を指定すれば、ファイルごとに
レイヤーを 1 つ、フォルダーにグループを 1 つ作る取り込みも 1 つの
トランザクションのままです。新しいレイヤーと地物とグループは、1 回の
`document.changed` と、Store の 1 回の通知で届きます。

```ts
declare const folder: { name: string; files: File[] };

const results = await draw.document.loadMany(
  folder.files.map((file) => ({
    source: file,
    options: { layer: { name: file.name }, group: { name: folder.name } },
  })),
);
for (const result of results ?? []) console.log(result.layerId, result.groupId);
```

項目の `layerId` には、前の項目が `layer` で作るレイヤーも指定できます。
1 回の取り込みの複数のファイルで新しいレイヤーを 1 つ共有し、ある
ファイルの地物をそのレイヤーのグループにまとめることも、同じ
トランザクションのままできます。

```ts
declare const files: File[];

await draw.document.loadMany([
  { source: files[0], options: { layer: { id: 'survey', name: 'Survey' } } },
  {
    source: files[1],
    options: { layerId: 'survey', group: { name: 'second file' } },
  },
]);
```

### 書き込まずに読む

`parseGeoJSON(input, options?)` と `parseNative(input, options?)` は、
読み込みと同じようにソースを読み、何も書き込みません。描画は要らず、
`ParsedDocument` (地物、グループ、ファイル、レイヤー、除いた地物) を
返します。アプリケーションは、それを好きな場所に書き込めます。分けて
書く、別のストアに書く、置き場所を決めてから書く、といった使い方です。
`featuresToGeoJSON` と対になる関数です。

```ts
import { parseGeoJSON, type Store } from '@sakuzu/maplibre-gl-draw';

declare const geojson: GeoJSON.FeatureCollection;
declare const store: Store; // createDraw に渡した Store。ファイルはここに置く

const target = draw.layers.getActive()?.id;
const parsed = await parseGeoJSON(geojson, { layerId: target });
for (const { index, reason, detail } of parsed.skipped) {
  console.warn(`feature ${index} left out (${reason}): ${detail}`);
}
draw.transact(() => {
  for (const file of parsed.files) store.createFile(file);
  // 先に地物を作り、それを入れるグループを後に作る
  draw.features.createMany(parsed.features.map(({ groupId: _, ...rest }) => rest));
  draw.groups.createMany(parsed.groups);
});
```

- 地物、グループ、レイヤー、ファイルには、すべて新しい ID を振ります。
  入力の ID は残しません。それらの間の参照 (地物のグループ、グループの
  メンバー、Image のファイル) は新しい ID を指します
- `layerId` を指定すると、すべての地物をそのレイヤーに入れます。指定
  しなければ、GeoJSON の地物の `layerId` は空になり、ライブラリーの
  文書の地物は `layers` にある自分のレイヤーの ID を持ちます。`layers`
  は文書のレイヤーを奥から並べたもので、アプリケーションが作ります
- 同じ `maplibre-gl-draw:groupId` を指す GeoJSON の地物は、1 つの新しい
  グループになります。`flattenMulti` は、読み込みと同じく Multi の形状を
  分けます
- 地物に名前は付けません。地物は入力の順に並びます
- 読み込みなら除く地物と、埋め込まれた画像を取り込めない地物は除き、
  その番号、コード (`invalid-input`。ブラウザーが書き出せない画像は
  `unsupported-format`)、理由を `skipped` に載せます。promise が失敗
  するのは、入力がその形式でないとき (`unsupported-format`) と、
  読み込みなら受け付けないライブラリーの文書のとき (`invalid-input`)
  だけです

### アプリケーションの ID

ライブラリーは、作るものすべてに既定で ULID を振ります。`createDraw`
のオプション `generateId` は、これを置き換えます。ID を指定せずに
描いたり作ったりした地物、グループ、レイヤー、画像のファイル、形状の
操作の結果は、ここから ID を受け取ります。ID の無い GeoJSON の地物と、
ID がすでに使われている GeoJSON の地物にも、読み込みはここから ID を
振ります。インスタンスを作るときにしか指定できません。

```ts
import { createDraw, parseGeoJSON } from '@sakuzu/maplibre-gl-draw';

declare const geojson: GeoJSON.FeatureCollection;

const generateId = () => crypto.randomUUID();
const app = createDraw(map, { generateId });
const parsed = await parseGeoJSON(geojson, { generateId });
console.log(app.features.count(), parsed.features.length);
```

この関数は、空でない文字列を返します。その文字列は文書が続く間
一意で、名付けたものを消した後も使い回してはいけません。
`features.create` の `id` のように、コードが渡した ID はそのまま
使います。`parseGeoJSON` と `parseNative` にも同じ関数を渡すと、文書の
ID がすべて 1 か所から来ます。

## 地図にドロップされたファイル

ライブラリーは、地図にドロップされたファイルを受け取りません。どの
ファイルを受け付けるか、どこに置くか、独自の形式のファイルで描いた
ものを置き換えてよいかは、アプリケーションが決めることだからです。
ドロップされたファイルを読み込むには、地図の要素 (コンテナー) で
ドロップを受け、位置を `map.unproject` で座標に直し、ファイルを 1 つずつ
`draw.document.load` に渡します。

```ts
const container = map.getContainer();

// これが無いと、ブラウザーはドロップせずにファイルを開く
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
      // 位置は画像が使う。データのファイルは自分の位置を持っている
      await draw.document.load(file, {
        coordinate: [lng, lat],
        zoom: map.getZoom(),
        layerId: draw.layers.getActive()?.id,
      });
    } catch (error) {
      console.error(`${file.name} を読み込めませんでした`, error);
    }
  }
});
```

ほかのことは、アプリケーションがこのリスナーの中で決めます。
`draw.isReadOnly()` や `draw.isInteractionLocked()` が true の間は
ドロップを断る、独自の形式のファイルで描いたものを置き換える前に
確かめる、ファイルを自分で読んで地物をデータセットに渡す
([大量のデータを表示する](large-data.ja.md)) といったことができます。

## 画像

画像ファイルには、置く場所の指定が必要です。

<!-- docs-check:
declare const imageFile: File;
-->

```ts
await draw.document.load(imageFile, {
  coordinate: [139.767, 35.681],
  zoom: map.getZoom(),
  layerId: draw.layers.getActive()?.id,
});
```

画像は WebP に変換します。ブラウザーが WebP を作れないときは、透明な
画素が無ければ JPEG に変換し、あればブラウザーが返した形式 (PNG など)
のままにします。一辺が 4096 px を
超えると縮小して、文書のファイルとして 1 度だけ保存します。新しい `Image` の地物は、
プロパティー `maplibre-gl-draw:imageFileId` でそれを参照します。
読み込むファイルに埋め込まれた画像は、宣言した型と一致する
`data:image/(png|jpeg|webp|gif);base64,` のデータ URL だけを受け付け
ます。`draw_image` モードは `image.requested` でアプリケーションに
ファイルを求めます。このモードについては [描画と編集](drawing.ja.md) を
参照してください。

## 変更のたびに保存する

`document.changed` は、文書を変えたトランザクション 1 つごとに、その中で
変わったものをすべて載せて 1 度だけ届きます。編集のたびに保存するなら、
このイベントを使います。選択やモードだけの変更では届きません。

```ts
let timer: ReturnType<typeof setTimeout> | undefined;

draw.on('document.changed', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    localStorage.setItem('drawing', JSON.stringify(draw.document.toJSON()));
  }, 500);
});
```

ドラッグ中はポインターが動く間に途中の状態が書き込まれ、その一つひとつが
変更になります。上のように保存を間引くか、ドラッグを終える
`isIntermediate` の付かない更新を待ってください。

自分の複数の書き込みを 1 つの変更にするには、`draw.transact` で包みます。
それらは、名付けた出どころを持つ 1 つの `document.changed` として
届きます。

```ts
draw.transact(
  () => {
    draw.features.update(featureId, { visible: false });
    draw.layers.update(layerId, { opacity: 0.5 });
  },
  { source: 'toolbar' },
);
```

## 自前のストア

描いたものをデータベースやサーバーに保つだけなら、インスタンスの
変更を受け取れば足りることがほとんどです。

<!-- docs-check:
declare function sendToServer(change: unknown): void;
-->

```ts
draw.on('document.changed', (change) => {
  // change.features, change.layers, change.groups, change.source ...
  sendToServer(change);
});
```

`draw.getStore().subscribe(listener)` も同じ `DocumentChange` を届け
ます。こちらはコレクションを通さずに文書を読むときにも使えます。

文書そのものを別の場所に置く必要があるときは、作るときにオプション
`store` でインスタンスにストアを渡します。

<!-- docs-check:
declare function createServerStore(): Store;
-->

```ts
import { createDraw, type Store } from '@sakuzu/maplibre-gl-draw';

// Store の約束を満たす自前の実装
const store: Store = createServerStore();
const draw = createDraw(map, { store });
```

ストアが持つのは、文書 (地物、レイヤーとその重なりの順、グループ、
ファイル、メタデータ) と、この端末の状態 (選択、編集中の地物、選んだ
頂点、モード、読み取り専用、操作ロック、隠している項目) です。
インスタンスは、どちらも `Store` のメソッドだけで読み書きし、変更を
購読し、書き込みを `transact` でまとめます。`isReadOnly()` が true の
あいだは、文書の書き込みを呼びません。描いている途中の形、範囲選択、
ドラッグは、インスタンスが持ちます。

自前のストアは、いくつかの約束を守ります。ID を重ねないこと、
レイヤーの `items` とグループの `layerId` を合わせておくこと、いちばん
外側の取引ごとに 1 回通知すること、別の場所から受け取った文書を
`reset: true` の 1 つの `DocumentChange` で届けること、書き込みが
当てはまったかどうかを返すことです。約束のすべては
[`Store`](../api/maplibre-gl-draw/interfaces/Store.md) と
[`StoreView`](../api/maplibre-gl-draw/interfaces/StoreView.md) に
書いてあります。

自動の名前 ("Point 3"、"Layer 2") の番号は、ストアが返す名前から数え、
同じ番号を 2 度使いません。文書の一部だけを持つストアは、省略できる
`getMaxNameNumber` と `recordNameNumber` も実装できます。持っていない
部分で使われた番号を、使い直さないためです。

ストアが持つ文書は、`document.toJSON()` が書き出すものと同じです。形は
[データ形式のリファレンス](../reference/data-format.md) にあります。

## 変更に入っているもの

core は変更の履歴を持ちません。リスナーが文書を追いかけたり、前の状態に
戻したりするのに必要なものは、すべての `DocumentChange` に入っています。

- どの更新にも変更前の `previous` のオブジェクトが付き、削除には削除した
  オブジェクトが付きます
- 1 つのトランザクションが 1 つの変更になるので、幾何演算、グループ化、
  複数の地物のドラッグは 1 つの手順として届きます
- `source` は変更の出どころを示します。編集と API の呼び出しなら
  `'local'`、どの形式の読み込みでも `'load'`、自前のストアなら
  `'remote'` で、`transact` に渡した任意の値も入ります
- ドラッグの途中の更新には `isIntermediate: true` が付きます。その後に
  来る、これが付いていない更新でドラッグが終わります

レイヤー、グループ、削除した地物のグループも、地物と同じ変更で
届きます。リスナーが自分で適用する変更には、自分の出どころを付け
られるので、リスナーはその出どころで自分の変更を除けます。

## 関連する例

- [Save and load](../examples/save-and-load.ja.md) では、GeoJSON の
  ファイルを読み込んで `skipped` を知らせ、独自の形式を `localStorage` に
  保存して読み戻します。2 つの形式をファイルとしてダウンロードし、
  ディスクのファイルを開き、地図にドロップされたファイルを読み込みます

## リファレンス

- [`DocumentResource`](../api/maplibre-gl-draw/interfaces/DocumentResource.md)
  と [`DrawDocument`](../api/maplibre-gl-draw/interfaces/DrawDocument.md)
- [`LoadOptions`](../api/maplibre-gl-draw/interfaces/LoadOptions.md)、
  [`LoadResult`](../api/maplibre-gl-draw/interfaces/LoadResult.md)、
  [`SkippedFeature`](../api/maplibre-gl-draw/interfaces/SkippedFeature.md)
- [`isDrawProperty`](../api/maplibre-gl-draw/functions/isDrawProperty.md)
  と
  [`DrawProperties`](../api/maplibre-gl-draw/type-aliases/DrawProperties.md)
- [`Store`](../api/maplibre-gl-draw/interfaces/Store.md)、
  [`StoreView`](../api/maplibre-gl-draw/interfaces/StoreView.md)、
  [`DocumentChange`](../api/maplibre-gl-draw/interfaces/DocumentChange.md)
- [データ形式](../reference/data-format.md) と
  [イベント](../reference/events.md)
