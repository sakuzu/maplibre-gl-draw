# 保存と読み込み

描いたものは 1 つの文書です。文書は地物、レイヤー、グループ、埋め込んだ
ファイル、メタデータでできています。この手引きでは、文書を GeoJSON か
ライブラリー独自の形式で書き出すこと、開き直すことと取り込むこと、
読むときに除かれるもの、画像、変更のたびの保存、自前のストアでの保持、
変更に入っているものを説明します。

## 最小のコード

```ts
// 保存: 文書全体をライブラリーの形式で
localStorage.setItem('drawing', JSON.stringify(draw.document.toJSON()));

// 復元: ライブラリーの文書は地図の上のものを置き換える
const saved = localStorage.getItem('drawing');
if (saved) await draw.open(saved);
```

## 2 つの形式

| 形式 | 書き出す | `draw.open` | `tx.import` |
| --- | --- | --- | --- |
| 独自の形式 | `toJSON()` | 文書を置き換えます | 断ります |
| GeoJSON | `toGeoJSON()` | 地物とグループを置き換えます | 地物を足します |

独自の形式は文書の全体を持ちます。レイヤーとその順序、グループ、地物、
ファイル、メタデータです。GeoJSON は地物の `FeatureCollection` を 1 つ
持ちます。

描いたものを、レイヤー、グループ、並び、スタイル、画像ごとそのまま保存
して復元するには独自の形式を使います。ほかのツールと地物をやり取り
するには GeoJSON を使います。どちらの形式も
[データ形式のリファレンス](../reference/data-format.md) で定めています。

地物は GeoJSON の Feature です。`geometry` は GeoJSON の形状で、
`properties` は GeoJSON のプロパティーです。ライブラリーが地物に持たせる
値 (レイヤー、グループ、型、スタイル、表示、ロック、基準のズーム、円の
半径、画像の大きさ) は、`properties` の中の `maplibre-gl-draw:` で始まる
キーに入っています。それ以外のキーはあなたの属性です。値が既定の値の
キーは書きません。どちらの形式も、`draw.features.get` が読む形のまま
地物を書き出します。

## 文書の書き出し

`toJSON()` は文書をオブジェクト (`DrawDocument`) で返し、
`toGeoJSON()` は GeoJSON の `FeatureCollection` を返します。
`JSON.stringify` でテキストにし、ファイル名はアプリケーションで
付けてください。

```ts
const geojson = draw.document.toGeoJSON();
const title = draw.document.title || 'drawing';
const blob = new Blob([JSON.stringify(geojson)], {
  type: 'application/geo+json',
});

const link = document.createElement('a');
link.href = URL.createObjectURL(blob);
link.download = `${title}.geojson`;
link.click();
URL.revokeObjectURL(link.href);
```

- 独自の形式の文書には、形式の版 `4.0.0` が入ります
- GeoJSON は RFC 7946 に従います。リングは (文書の中と同じく) 右手の
  法則に従い、位置は小数 7 桁に丸め、経度は -180 から 180 に戻し、
  `FeatureCollection` には `bbox` が付きます
- 非表示の地物も、プロパティーに `maplibre-gl-draw:visible: false` を
  残して書き出します。そのため、書き出して読み戻しても非表示のままです
- GeoJSON に置き場所の無い地物の値 (レイヤー、グループ、スタイル、
  ロック、`Circle` のような型) は、接頭辞 `maplibre-gl-draw:` の付いた
  プロパティーです。そのファイルを読み戻すと元に戻ります
- 画像はデータ URL として埋め込むので、ファイル単体で完結します
- 題名と説明は `draw.write((tx) => tx.document.update({ title }))` で
  設定し、`draw.document.title` と `draw.document.description` で読みます

自分の属性だけが欲しい読み手は、ライブラリーのキーを除きます。

```ts
import { isDrawProperty } from '@sakuzu/maplibre-gl-draw';

const rows = draw.document.toGeoJSON().features.map((f) =>
  Object.fromEntries(
    Object.entries(f.properties ?? {}).filter(([key]) => !isDrawProperty(key)),
  ),
);
```

一部の地物だけを書き出すときは、読んだ形のまま書きます。
`draw.features.get` の地物は GeoJSON の Feature なので、それを並べた
`{ type: 'FeatureCollection', features }` が GeoJSON です。`toGeoJSON()`
と違い、経度は持っている値のままで、画像は画素を持たずに書き出されます。

## 開くと取り込み

`draw.open(source)` は文書をソースの中身で置き換え、`draw.write` の中の
`tx.import(source, options?)` はそれを文書に足します。どちらも `File` か
`Blob`、JSON の文字列、ライブラリーの文書、GeoJSON の
`FeatureCollection` を受け取ります。

```ts
const input = document.querySelector<HTMLInputElement>('#file');
input?.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const result = await draw.write((tx) => tx.import(file));
    console.log(result.count, result.layerId);
    for (const { index, error } of result.skipped) {
      console.warn(`feature ${index} left out: ${error.message}`);
    }
  } catch (error) {
    console.error('not imported', error); // 文書は変わらない
  }
});
```

- 形式は中身から判断します。ライブラリーの文書でも GeoJSON でもなければ、
  コード `unsupportedFormat` の `DrawError` で失敗します
- ライブラリーの文書の `draw.open` はすべてを置き換え、GeoJSON の
  `draw.open` は地物とグループを置き換えてレイヤーは残します。出どころ
  `'open'` の 1 回の `change` になり、undo の段は捨てられます。読んだ地物の
  数 (`features`) と除いた地物 (`skipped`) を返します
- `tx.import` は GeoJSON を文書に足します。同じ取引のほかの書き込みと
  一緒に 1 つの確定と undo の 1 段になります。足した地物の数 (`count`)、
  そのレイヤー (`layerId`)、除いた地物 (`skipped`) を返します。ライブラリーの文書は開くだけなので、
  `tx.import` は `invalidInput` で受け付けません
- 読み取り専用のあいだは、どちらも `notEditable` で失敗します
- データは文書を変える前に検証するので、失敗した読み込みでは、描いた
  ものはそのまま残ります
- ライブラリーの文書は、どこかの形が不正なとき、存在しないものを参照
  しているとき、ライブラリーが書く版 (`4.0.0`) でないときは、全体を
  受け付けず、コード `invalidInput` で失敗します
- 形状が使えない GeoJSON の地物 (形状が無い、対応していない、
  有限でない数を含む、位置が 1 つだけの線、閉じていないリングなど) は
  除かれ、その番号と `DrawError` が `skipped` に載ります。残りは読みます
- 型や形の合わないスタイルの値 (CSS の色ではない色、0 から 1 の範囲外の
  不透明度) は捨て、地物は残します
- 埋め込まれた画像が、宣言した型の PNG、JPEG、WebP、GIF のデータ URL
  でないとき、または画素をデコードできないときは、読み込み全体を
  `invalidInput` で受け付けません。縮小が必要な画像を、ブラウザーが
  それらの型で書き出せないときは `unsupportedFormat` で受け付けません
- 文書にすでにある ID の地物を取り込むと、新しい ID を振ります
  (`duplicateIds: 'renew'`。省いたときの既定です)。そのため、
  `toGeoJSON()` で書き出したファイルを同じ描画に取り込み直せます。
  上書きはしません
- 地物は、`options.layer` (ID か、同じ確定でレイヤーを作る
  `LayerInput`) を指定すればそのレイヤーに、無ければ
  `maplibre-gl-draw:layerId` のレイヤーがあればそのレイヤーに、それも
  無ければアクティブなレイヤーに入ります
- `options.group` (`featureIds` の無い `GroupInput`) を指定すると、
  読んだ地物をすべて、同じ確定で作る 1 つのグループに入れます。この
  とき地物はすべて 1 つのレイヤーに入り、GeoJSON の地物が指すグループ
  には入りません
- Multi の形状は Multi の地物のまま保ちます。`GeometryCollection` は、
  形状の型ごとに多くても 1 つの Multi の地物にまとめます

読んだものは、足したすべての地物を `features.created` に並べた 1 回の
`change` で届きます ([イベント](../reference/events.md))。

### 複数のソースをまとめて読む

`tx.import` は 1 つの `draw.write` の中で何度でも呼べます。複数の
ファイルの取り込みが 1 つの確定、1 回の `change`、undo の 1 段になります。
読めないソースが 1 つでもあれば、書き込みはその `DrawError` で失敗し、
何も書きません。

```ts
declare const files: File[];

const results = await draw.write(async (tx) => {
  const out = [];
  for (const file of files) out.push(await tx.import(file));
  return out;
});
console.log(results.length);
```

オプションに `layer` と `group` を指定すれば、ファイルごとにレイヤーを
1 つ、フォルダーにグループを 1 つ作る取り込みも 1 つの確定のままです。
新しいレイヤーと地物とグループは、1 回の `change` で届きます。

```ts
declare const folder: { name: string; files: File[] };

const results = await draw.write(async (tx) => {
  const out = [];
  for (const file of folder.files) {
    out.push(
      await tx.import(file, {
        layer: { name: file.name },
        group: { name: folder.name },
      }),
    );
  }
  return out;
});
for (const result of results) console.log(result.layerId);
```

取り込みの `layer` には、同じ取引の前の取り込みが作るレイヤーの ID も
指定できます。1 回の取り込みの複数のファイルで新しいレイヤーを 1 つ共有し、
あるファイルの地物をそのレイヤーのグループにまとめることもできます。

```ts
declare const files: [File, File];

await draw.write(async (tx) => {
  await tx.import(files[0], { layer: { id: 'survey', name: 'Survey' } });
  await tx.import(files[1], { layer: 'survey', group: { name: 'second file' } });
});
```

### 書き込まずに読む

`parseGeoJSON(input, options?)` と `parseNative(input, options?)` は、
`tx.import` と同じようにソースを読み、何も書き込みません。描画は要らず、
`ParsedDocument` (地物、グループ、ファイル、レイヤー、除いた地物) を
返します。アプリケーションは、それを好きな場所に書き込めます。分けて
書く、別のストアに書く、置き場所を決めてから書く、といった使い方です。

```ts
import { parseGeoJSON } from '@sakuzu/maplibre-gl-draw';

declare const geojson: GeoJSON.FeatureCollection;

const target = draw.layers.getActive()?.id;
const parsed = await parseGeoJSON(geojson, { layerId: target });
for (const { index, reason, detail } of parsed.skipped) {
  console.warn(`feature ${index} left out (${reason}): ${detail}`);
}
await draw.write(async (tx) => {
  // 先にグループから出した地物を作り、それを入れるグループを後に作る
  await tx.features.create(
    parsed.features.map(({ properties, ...rest }) => {
      const { 'maplibre-gl-draw:groupId': _, ...kept } = properties;
      return { ...rest, properties: kept };
    }),
  );
  for (const group of parsed.groups) await tx.groups.create(group);
});
```

- 地物、グループ、レイヤー、ファイルには、すべて新しい ID を振ります。
  入力の ID は残しません。それらの間の参照 (地物のグループ、グループの
  メンバー、Image のファイル) は新しい ID を指します
- ライブラリーが知らない参照は、そのまま残します。アプリケーションや
  拡張が `properties` に持つ、ほかの地物の ID などです。`idMap` は、
  入力の ID ごとの新しい ID を、種類 (`features`、`groups`、`files`、
  `layers`) ごとに持ちます。これで参照を付け替えます。読まなかった ID
  は載りません
- `layerId` を指定すると、すべての地物をそのレイヤーに入れます。指定
  しなければ、GeoJSON の地物はレイヤーを指さず
  (`maplibre-gl-draw:layerId` が無く)、ライブラリーの文書の地物は
  `layers` にある自分のレイヤーの ID を持ちます。`layers` は文書の
  レイヤーを奥から並べたもので、アプリケーションが作ります
- 同じ `maplibre-gl-draw:groupId` を指す GeoJSON の地物は、1 つの新しい
  グループになります。`flattenMulti: true` は Multi の形状をパートごとの
  地物に分けます
- `Image` の地物は `files` の中の自分のファイルを指しますが、文書は
  そのファイルを持っていません。画像のあるソースは `tx.import` で書きます
- 地物に名前は付けません。地物は入力の順に並びます
- `tx.import` なら除く地物と、埋め込まれた画像を取り込めない地物は除き、
  その番号、コード (`invalidInput`。ブラウザーが書き出せない画像は
  `unsupportedFormat`)、理由を `skipped` に載せます。promise が失敗
  するのは、入力がその形式でないとき (`unsupportedFormat`) と、
  `draw.open` なら受け付けないライブラリーの文書のとき (`invalidInput`)
  だけです

アプリケーションは、地物を書き込む前に、自分の参照を `idMap` で
付け替えられます。次の例では、地物が `properties.target` にほかの地物の
ID を持っています。

```ts
import type { ParsedDocument } from '@sakuzu/maplibre-gl-draw';

declare const parsed: ParsedDocument;

const features = parsed.features.map((feature) => {
  const target = feature.properties.target;
  if (typeof target !== 'string') return feature;
  const renamed = parsed.idMap.features[target];
  return { ...feature, properties: { ...feature.properties, target: renamed } };
});
```

### アプリケーションの ID

ライブラリーは、作るものすべてに既定で ULID を振ります。`createDraw`
のオプション `generateId` は、これを置き換えます。ID を指定せずに
描いたり作ったりした地物、グループ、レイヤー、画像のファイル、形状の
操作の結果は、ここから ID を受け取ります。ID の無い地物と、ID が
すでに使われている地物にも、`tx.import` はここから ID を振ります。インスタンスを作るときにしか指定できません。

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
`tx.features.create` の `id` のように、コードが渡した ID はそのまま
使います。`parseGeoJSON` と `parseNative` にも同じ関数を渡すと、文書の
ID がすべて 1 か所から来ます。

## 地図にドロップされたファイル

ライブラリーは、地図にドロップされたファイルを受け取りません。どの
ファイルを受け付けるか、どこに置くか、独自の形式のファイルで描いた
ものを置き換えてよいかは、アプリケーションが決めることだからです。
ドロップされたファイルを読むには、地図の要素 (コンテナー) でドロップを
受け、ファイルを 1 つの `draw.write` の中で取り込みます。

```ts
const container = map.getContainer();

// これが無いと、ブラウザーはドロップせずにファイルを開く
container.addEventListener('dragover', (event) => event.preventDefault());

container.addEventListener('drop', async (event) => {
  event.preventDefault();
  // 画像は画像のモードが置く (後述)。データのファイルは自分の位置を持っている
  const files = [...(event.dataTransfer?.files ?? [])].filter(
    (file) => !file.type.startsWith('image/'),
  );
  try {
    await draw.write(async (tx) => {
      for (const file of files) await tx.import(file);
    });
  } catch (error) {
    console.error('ファイルを取り込めませんでした', error);
  }
});
```

ほかのことは、アプリケーションがこのリスナーの中で決めます。
`draw.isReadOnly()` や `draw.isInteractionLocked()` が true の間は
ドロップを断る、独自の形式のファイルで描いたものを置き換える前に
確かめてから `draw.open` で開く、ファイルを自分で読んで地物を
データセットに渡す ([大量のデータを表示する](large-data.ja.md)) といった
ことができます。

## 画像

画像は画像のモード `drawImage` が置きます。このモードはオプション
`requestImage` でアプリケーションにファイルを求め、このモードで地図を
クリックした位置に置きます ([描画と編集](drawing.ja.md#画像))。コードから画像を置くときは、
書き出した GeoJSON と同じ形にします。型が `Image` の地物に、画像を
データ URL で `maplibre-gl-draw:imageData` に、その型を
`maplibre-gl-draw:imageMimeType` に持たせ、`tx.import` に渡します
([データ形式](../reference/data-format.md))。

画像は WebP に変換します。ブラウザーが WebP を作れないときは、透明な
画素が無ければ JPEG に変換し、あればブラウザーが返した形式 (PNG など)
のままにします。一辺が 4096 px を
超えると縮小して、文書のファイルとして 1 度だけ保存します。新しい `Image` の地物は、
プロパティー `maplibre-gl-draw:imageFileId` でそれを参照します。
読むファイルに埋め込まれた画像は、宣言した型と一致する
`data:image/(png|jpeg|webp|gif);base64,` のデータ URL だけを受け付け
ます。

## 変更のたびに保存する

`change` は、文書を変えた確定 1 つごとに、その中で
変わったものすべての ID を載せて 1 度だけ届きます。編集のたびに保存する
なら、このイベントを使います。選択やモードだけの変更では届きません。

```ts
let timer: ReturnType<typeof setTimeout> | undefined;

draw.on('change', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    localStorage.setItem('drawing', JSON.stringify(draw.document.toJSON()));
  }, 500);
});
```

ドラッグは離したときに 1 度だけ書き込まれます。途中に見えるのは下書きで、
変更にはなりません。

1 つの `draw.write` の中の複数の書き込みは、名付けた `label` を持つ
1 つの `change` として届き、undo の 1 段になります。

```ts
await draw.write(
  async (tx) => {
    await tx.features.update(featureId, {
      properties: { 'maplibre-gl-draw:visible': false },
    });
    await tx.layers.update(layerId, { opacity: 0.5 });
  },
  { label: 'toolbar' },
);
```

## 自前のストア

描いたものをデータベースやサーバーに保つだけなら、インスタンスの
変更を受け取れば足りることがほとんどです。

<!-- docs-check:
declare function sendToServer(change: unknown): void;
-->

```ts
draw.getStore().subscribe((change) => {
  // change.features, change.layers, change.groups, change.source ...
  sendToServer(change);
});
```

`draw.getStore().subscribe(listener)` は、変更の全体を `DocumentChange`
として届けます。作られたもの、変わる前と合わせた変わったもの、消された
ものが入ります。選択、編集中の地物、モードの変更も、それぞれの分類で
届けます。`draw.on('change', listener)` は同じトランザクションを ID で
知らせ、その中身はコレクションで読みます。

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

ID が独自の形のストア (共有の文書の書き手の ID など) は、省略できる
`acceptsId(id)` を実装し (地物、グループ、レイヤーのどれの ID かは渡さず、
ID だけを渡します)、その形の ID を作る `generateId` と一緒に
渡します。`tx.import` は、ストアが受けない ID の地物、グループ、
レイヤーに新しい ID を付けます。そのような ID で地物、グループ、
レイヤーを作ると (`id` を付けた `tx.features.create` など)、何も書かずに
`invalidInput` で拒みます。

ストアが持つ文書は、`document.toJSON()` が書き出すものと同じです。形は
[データ形式のリファレンス](../reference/data-format.md) にあります。

## 変更に入っているもの

`draw.undo()` と `draw.redo()` は、この端末の確定を `draw.write` 1 つ
ごとに 1 段ずつ取り消し、やり直します (`undo: false` の書き込みは段に
なりません)。リスナーが文書を追いかけるのに必要なものは、Store が届ける
(`draw.getStore().subscribe`) すべての `DocumentChange` に入っています。

- どの更新にも変更前の `previous` のオブジェクトが付き、削除には削除した
  オブジェクトが付きます
- 1 つの確定が 1 つの変更になるので、幾何演算、グループ化、
  複数の地物のドラッグは 1 つの手順として届きます
- `source` は変更の出どころを示します。編集と `draw.write` の書き込み
  なら `'local'`、取り消しとやり直しなら `'undo'` と `'redo'`、文書を
  開いたなら `'open'`、自前のストアなら `'remote'` です

レイヤー、グループ、削除した地物のグループも、地物と同じ変更で
届きます。

### 地物を行で持つストア

地物を列の行で持つストア (`createTableStore` や、
`createFeatureTables` の上に作った自前のストア) は、地物になっていない
行 (選んでいない、編集していない行) を、地物でなく行として、行の番号
(handle) で知らせます。項目の場所 (レイヤー、グループ、ほかの項目との
並び) は、地物か行かによらず `change.order` に入ります。1 つの移動なら
項目がいた場所 (`ItemMove.from`。行を持つ Store の行なら移動の前の並びの
鍵 `ItemMove.before` も) を、たくさんの行なら移動の前の並びの鍵
(`RowsMove.before`) を持ちます。`draw.undo()` は、これらの行の書き込みも
地物と同じように取り消します。削除した行は元の場所に、削除したグループは
元の場所に戻ります。

レイヤーとグループの項目をリストで持ち、項目を場所に置く以外の方法で
リストを変える自前のストアは、変更の前と後のリストから `diffItemOrder`
で `change.order` の移動を作ります。

そうしたストアの表の writer (`@sakuzu/maplibre-gl-draw/kasane` の
`createTableStore` の writer) には、ほかの端末と内容を揃えるストアのための
部品がもう 1 つあります。`writer.clear()` は、文書がよそから置き換わるとき
(最初から読み直すとき)、行を `addPages` で戻す前に、表から行を全部
出します。まとめて選んだ地物を手放し、途中の仕事を捨て、ID は行の handle を
持ち続けます。

## 同じ地図の上の別の文書

`draw.document.setShown(store)` は、この端末だけで、文書の代わりに別の
文書を見せます。たとえば文書の過去の版を、地物を行で持つストアに
読み込み、2 つ目の地図も地物も作らずに同じ地図で見ます。見せている
あいだ、インスタンスは読み取り専用で、ポインターとキーは地図を動かす
だけです。`setShown(null)` で文書に戻ります。

```ts
import { createTableStore } from '@sakuzu/maplibre-gl-draw/kasane';

const version = createTableStore();
version.store.createLayer({
  id: 'buildings',
  name: 'Buildings',
  visible: true,
  locked: false,
  opacity: 1,
  styleRule: undefined,
  metadata: undefined,
  kind: 'table',
});
// Worker で作った版の行を足す:
// version.writer.addPages('buildings', pages)
draw.document.setShown(version.store);
// ...
draw.document.setShown(null);
```

`writer.addPages(layerId, pages)` は、行の頁をその場で取り込み、
ストアのほかの書き込みと同じく、その行を作った行として知らせます
(`change.rows`)。行の頁を取り込む手間は、作る手間に比べて小さいです。
たくさん足すときは、少しずつ足すと描画を止めません。`copyTableStore`
は塊ずつ写します。

`draw.view.preview(source)` も同じように見せます。`source` は
`draw.open` と同じく読みます (ライブラリーの文書、GeoJSON、JSON の文字列、
ファイル)。自分の行のストアに読み込んで見せ、`draw.view.preview(null)` で
文書に戻ります。読んでいる途中に別の `source` を渡すと、後の物を見せます。

```ts
await draw.view.preview(pastVersion); // ライブラリーの文書
// ...
await draw.view.preview(null);
```

文書を別の地図で描く (印刷する) ときは、`@sakuzu/maplibre-gl-draw/kasane`
の `copyTableStore` で、地物を行で持つストアに写します。レイヤーと
グループと並びは一度に、行は塊ずつ、地物を作らずに写します。

<!-- docs-check:
declare const printMap: import('maplibre-gl').Map;
-->

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { copyTableStore } from '@sakuzu/maplibre-gl-draw/kasane';

const copy = copyTableStore(draw.getStore());
const printed = createDraw(printMap, {
  store: copy.store,
  initDefaultLayer: false,
});
while (copy.copyNext()) await new Promise(requestAnimationFrame);
```

どちらも `draw.memory` で端末の上限に数えます
([性能](performance.ja.md#端末の上限に対するメモリー))。

## 関連する例

- [Save and load](../examples/save-and-load.ja.md) では、GeoJSON の
  ファイルを読み込んで `skipped` を知らせ、独自の形式を `localStorage` に
  保存して読み戻します。2 つの形式をファイルとしてダウンロードし、
  ディスクのファイルを開き、地図にドロップされたファイルを読み込みます

## リファレンス

- [`DocumentResource`](../api/maplibre-gl-draw/interfaces/DocumentResource.md)
  (`setShown`) と
  [`DrawDocument`](../api/maplibre-gl-draw/interfaces/DrawDocument.md)
- [`OpenResult`](../api/maplibre-gl-draw/interfaces/OpenResult.md)、
  [`ImportOptions`](../api/maplibre-gl-draw/interfaces/ImportOptions.md)、
  [`ImportResult`](../api/maplibre-gl-draw/interfaces/ImportResult.md)、
  [`SkippedFeature`](../api/maplibre-gl-draw/interfaces/SkippedFeature.md)
- [`isDrawProperty`](../api/maplibre-gl-draw/functions/isDrawProperty.md)
  と
  [`DrawProperties`](../api/maplibre-gl-draw/interfaces/DrawProperties.md)
- [`Store`](../api/maplibre-gl-draw/interfaces/Store.md)、
  [`StoreView`](../api/maplibre-gl-draw/interfaces/StoreView.md)、
  [`DocumentChange`](../api/maplibre-gl-draw/interfaces/DocumentChange.md)
- [データ形式](../reference/data-format.md) と
  [イベント](../reference/events.md)
