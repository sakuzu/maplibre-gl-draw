# はじめかた

このページでは、利用者が多角形を描け、描いたものがブラウザーに保存されて
次に開いたときに元に戻る、小さな地図を作ります。10 分ほどで終わります。
maplibre-gl で地図を作れることは前提としますが、このライブラリーについての
知識は必要ありません。正は英語版 ([getting-started.md](getting-started.md))
です。

各手順のコードはすべてこのページにあり、手順を合わせると完全なページに
なります。[Get started](examples/get-started.ja.md) の例は、自分の
ボタンの代わりに標準の UI を地図に重ねた同じページです。ブラウザーで
動き、そのコードも読めます。

## 1. インストール

```sh
npm install @sakuzu/maplibre-gl-draw
```

パッケージは ESM だけです。maplibre-gl は peer dependency です。アプリに
すでに入っている maplibre-gl を使い、まだ入っていなければ npm 7 以降は
一緒にインストールされます。版は
`~6.11.1` (6.11 系の修正版) が必要です。6.12 以降は結合点を点検してから
対応します。v5 には対応しません。公開しているコードは ES2020 で、ブラウザーには WebGL2 が必要です。
maplibre-gl v6 が WebGL2 で対応しているブラウザーで動きます。

maplibre-gl v6 は worker を別のファイルとして配布し、実行時に本体の
モジュールからの相対位置で探します。バンドラーを通すと、この探し方が
うまくいきません。Vite では worker の読み込みがエラーを出さずに失敗し、
スタイルは読み込まれるもののタイルが要求されず、基図が空のままになります。
最初の地図を作る前に、worker の URL を 1 回だけ設定してください。Vite では
次のようにします。

```ts
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);
```

`?url` ではなく `?worker&url` を使ってください。worker は maplibre-gl の
共有のチャンクを import しており、本番のビルドでそれを worker と一緒に
まとめるのは `?worker&url` だけです。ほかのバンドラーでは、ビルドが
`maplibre-gl-worker.mjs` を配信する URL を `setWorkerUrl` に渡します。

リポジトリーの例は、この設定を `examples/maplibre-setup.ts` で共有して
います。

## 2. 地図とインスタンスを作る

ページには、地図を入れる要素とボタンが 2 つ必要です。

```html
<div id="map"></div>
<button id="draw-polygon">Draw a polygon</button>
<button id="save">Save</button>
```

```css
#map {
  position: absolute;
  inset: 0;
}
```

いつもどおり地図を作り、それを `createDraw` に渡します。

```ts
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [139.767, 35.681],
  zoom: 12,
});

const draw = createDraw(map);
```

インスタンスは地図の上に描き、地物を入れる空のレイヤーを 1 つ作り、
`select` モードで始まります。地図の読み込みが終わる前に作ってもかまい
ません。スタイルの準備ができた時点で、描いたものが表示されます。

インスタンスが持つものには、いくつかの名前から届きます。文書の中身は
`draw.features`、`draw.layers`、`draw.groups` で、利用者が選んでいる
ものは `draw.selection` で扱います。文書の全体を保存したり読み込んだり
するのは `draw.document` です。

地図を持つページやコンポーネントを破棄するときは、`map.remove()` の前に
`draw.destroy()` を呼んでください。インスタンスが地図に加えたものを
すべて取り除きます。

## 3. 多角形を描く

描画はモードとして切り替えます。ライブラリーはツールバーを持たないので、
自分で用意したボタンを `setMode` につなぎます。

```ts
document.querySelector('#draw-polygon')?.addEventListener('click', () => {
  draw.setMode('drawPolygon');
});
```

`drawPolygon` モードでは、利用者は次のように描きます。

| 操作 | 結果 |
| --- | --- |
| クリック | 頂点を追加します |
| 最初の頂点をクリック (頂点が 3 つ以上のとき) | 多角形を確定します |
| ダブルクリック (頂点が 3 つ以上のとき) | 多角形を確定します |
| Enter | 多角形を確定します |
| Backspace か Delete | 最後の頂点を削除します |
| Escape | 頂点を破棄します。もう 1 回押すと `select` に戻ります |

新しい位置でダブルクリックすると、その頂点を追加してから確定します。描画中は
地図がズームしません。
多角形を確定するとモードは `select` に戻り、新しい多角形が選ばれた状態に
なるので、利用者はすぐに移動したり頂点をドラッグしたりできます。

地物が作られると、インスタンスが知らせます。`change` は変更で作られた
ものの ID を並べ、`draw.features.get` で各地物を読みます。

```ts
draw.on('change', ({ features }) => {
  for (const id of features.created) {
    const feature = draw.features.get(id);
    console.log('created', id, feature?.geometry.type);
  }
});
```

地物は GeoJSON の Feature の `{ type: 'Feature', id, geometry,
properties }` です。多角形の図形の `coordinates` はリングの配列
`[[[lng, lat], ...]]` で、最初の点が末尾にもう一度入ります。
`feature.properties` には利用者の属性と、ライブラリーが
`maplibre-gl-draw:` で始まる鍵に置く少しの値 (レイヤー、グループ、
スタイル、見えるかどうか、ロックされているかどうか) が入ります。値が
既定の値である鍵は置きません。`readFeature(feature)` は、それらの値を
既定の値を埋めた短い名前で読みます。

ツールバーの表示をモードに合わせる (`select` に自動で戻る場合も含めて)
には、`draw.mode` を `subscribe` で追います。モードや選択のように時間で
変わる値はイベントではありません。`subscribe` は渡した関数を今の値で
すぐに 1 回呼び、値が変わるたびにまた呼びます。

```ts
draw.mode.subscribe((mode) => {
  document
    .querySelector('#draw-polygon')
    ?.classList.toggle('active', mode === 'drawPolygon');
});
```

`drawPoint`、`drawLine`、`drawCircle`、`drawFreehand` も同じように
使います。`drawImage` では、さらにアプリケーションに画像を求めます。
すべてのモードの操作は [描画の手引き](guides/drawing.ja.md) にあります。

## 4. 変更を受け取る

`change` はすべての変更 (作成、移動、頂点の編集、削除、文書を開くこと)
を知らせます。このイベントは、変えた地物の数によらず確定ごとに 1 回届き、
一緒に変わったものすべての ID を並べます。

```ts
draw.on('change', ({ features, source }) => {
  const { created, updated, deleted } = features;
  console.log(
    `${created.length} created, ${updated.length} updated,`,
    `${deleted.length} deleted (${source})`,
  );
});
```

`draw.features.get(id)` は今の地物を読み、受け取る関数の中の
`change.previous(id)` は、変わったか消された地物の変わる前の姿を読みます。
`source` は変更の出どころを表し、利用者の編集とコードの書き込みなら
`'local'`、`draw.undo()` と `draw.redo()` なら `'undo'` と `'redo'`、
文書を開いたなら `'open'` です。同じイベントで、レイヤーとグループ
(`layers` と `groups`)、文書の題 (`document`) の変更も届きます。

API は、次の規則を押さえておくと分かりやすくなります。

- 読みは同期的です。`draw.features.get(id)` ほかの `draw` の読みは
  すぐに戻ります。`draw.setMode(...)` や選択のように、この端末だけを
  変えるものも同期的です
- 文書を書く入口は `draw.write` の 1 つです。渡した関数は取引の `tx` を
  受け取り、書き込みは `tx` に貯まります。関数が終わると全部をまとめて
  確定し、1 回の `change` と undo の 1 段になります。Promise は確定して
  から解けるので、`await` の後に読めば新しい状態が、前に読めば前の状態が
  得られます
- 失敗した書き込みは `DrawError` で reject します。無い ID のような誤った
  引数 (`notFound`) も、読み取り専用のとき (`notEditable`) や
  ロックされた地物 (`locked`) のように状態が拒む書き込みも同じです。
  そのとき取引は何も確定しません
- イベントは確定してから発火するので、受け取る関数からは新しい状態が
  見えます
- `draw.on` は、購読をやめる関数を返します

<!-- docs-check: continue -->

```ts
// 1 つの取引: 2 つの書き込みが 1 回の change と undo の 1 段になる
const [first, second] = draw.selection.value.ids ?? [];
if (first !== undefined && second !== undefined) {
  await draw.write(async (tx) => {
    await tx.features.update(first, {
      properties: { 'maplibre-gl-draw:style': { fillColor: '#e74c3c' } },
    });
    await tx.features.delete(second);
  });
}
// 取り消す
await draw.undo();
```

UI は、呼んだメソッドからではなくイベントから更新してください。利用者も
描いたものを変えるので、イベントを使えば両方を拾えます。

すべてのイベントとその payload は [イベントのリファレンス](reference/events.md) (英語) に
あります。

## 5. 保存と読み込み

`draw.document.toGeoJSON()` は、すべての地物を GeoJSON の
FeatureCollection にして返します。文字列にして、好きな所に保存します。

```ts
const STORAGE_KEY = 'maplibre-gl-draw:basic';

document.querySelector('#save')?.addEventListener('click', () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(draw.document.toGeoJSON()));
});
```

`draw.open` で、今の文書に代えて読み戻します。渡したものが GeoJSON か、
独自の形式か、JSON の文字列か、`File` かを自動で判別します。

<!-- docs-check: continue -->

```ts
const saved = localStorage.getItem(STORAGE_KEY);
if (saved !== null) {
  const result = await draw.open(saved);
  console.log(`opened ${result.features} features`);
  for (const { index, error } of result.skipped) {
    console.warn(`feature ${index} was skipped: ${error.message}`);
  }
}
```

読み取り専用のとき、`open` は `DrawError` (`notEditable`) で reject
します。GeoJSON を開くと、地物とグループを置き換え、レイヤーは残します。
地物は `maplibre-gl-draw:layerId` が存在するレイヤーを指していれば
そのレイヤーに (このライブラリーが書き出した GeoJSON は指しています)、
そうでなければアクティブなレイヤーに入ります。読めない地物 (知らない
geometry の型や不正な座標) は除かれて `skipped` に並び、残りは読まれ
ます。開いた文書は `'open'` を出どころとする 1 回の `change` で届き、
undo の段は捨てられます。今ある地物にファイルを足すには、`draw.write` の
中で `tx.import` に渡します。

GeoJSON は地物ごとの属性とスタイルを保ちますが、レイヤーとグループ
そのものや、その順序は保ちません。それも保つには独自の形式を使います。
`draw.document.toJSON()` が文書の全体を返し、`draw.open` で同じように
読み戻すと、全体を置き換えます。両方の形式の仕様は
[データ形式のリファレンス](reference/data-format.md) (英語) にあります。

## 6. 次に読むもの

これで、地物を描き、変更を受け取り、保存して元に戻せる地図ができました。
ここからは、次に必要なことの手引きを読んでください。

- [描画](guides/drawing.ja.md) では、すべてのモード、選択、移動、拡縮、
  回転、頂点の編集、キーボードを説明しています
- [レイヤー](guides/layers.ja.md) では、地物の整理と描画順を説明して
  います
- [保存と読み込み](guides/save-load.ja.md) では、ファイル、画像、自前の
  保存先の接続を説明しています
- [スタイル](guides/styles.ja.md) では、色とスタイル規則を説明しています
- [フレームワーク](guides/frameworks.ja.md) では、React、Svelte、Vue での
  使い方を説明しています

すべての手引き、リファレンス、内部の文書は
[ドキュメントの索引](README.ja.md) にあります。

何もインストールせずにすべての機能を試すなら、
[playground](https://sakuzu.github.io/maplibre-gl-draw/playground/) か
[例](https://sakuzu.github.io/maplibre-gl-draw/examples/) を開いてください。
[API リファレンス](https://sakuzu.github.io/maplibre-gl-draw/api/) も
同じ場所で公開しています。
