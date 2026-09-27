# はじめかた

このページでは、利用者が多角形を描け、描いたものがブラウザーに保存されて
次に開いたときに元に戻る、小さな地図を作ります。10 分ほどで終わります。
maplibre-gl で地図を作れることは前提としますが、このライブラリーについての
知識は必要ありません。正は英語版 ([getting-started.md](getting-started.md))
です。

各手順は、そのまま動かせるページ [examples/basic/](../examples/basic/)
の一部に対応しています。`examples/basic/main.ts` の各部分には、下の
見出しと同じ手順の番号が付いています。

例を動かすには、リポジトリーをクローンして examples を起動します。

```sh
npm install
npm run dev    # 表示される一覧から basic のページを開く
```

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

`examples/basic/main.ts` では、すべての例が共有している
`../maplibre-setup.ts` の import がこれに当たります。

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

`examples/basic/main.ts` では手順 2 に当たります。

## 3. 多角形を描く

描画はモードとして切り替えます。ライブラリーはツールバーを持たないので、
自分で用意したボタンを `setMode` につなぎます。

```ts
document.querySelector('#draw-polygon')?.addEventListener('click', () => {
  draw.setMode('draw_polygon');
});
```

`draw_polygon` モードでは、利用者は次のように描きます。

| 操作 | 結果 |
| --- | --- |
| クリック | 頂点を追加します |
| 最初の頂点をクリック (頂点が 3 つ以上のとき) | 多角形を確定します |
| Enter | 多角形を確定します |
| Backspace か Delete | 最後の頂点を削除します |
| Escape | 頂点を破棄します。もう 1 回押すと `select` に戻ります |

ダブルクリックすると頂点が 2 つ追加され、描画中は地図がズームしません。
多角形を確定するとモードは `select` に戻り、新しい多角形が選ばれた状態に
なるので、利用者はすぐに移動したり頂点をドラッグしたりできます。

地物が作られると、インスタンスが知らせます。

```ts
draw.on('feature.created', ({ feature }) => {
  console.log('created', feature.id, feature.type);
});
```

`feature.geometry` は GeoJSON の図形です。多角形の `coordinates` は
リングの配列 `[[[lng, lat], ...]]` で、最初の点が末尾にもう一度入り
ます。`feature.properties` も GeoJSON の properties で、利用者の属性と、
ライブラリーが `maplibre-gl-draw:` で始まる鍵に置く少しの値が入ります。

ツールバーの表示をモードに合わせる (`select` に自動で戻る場合も含めて)
には、`mode.changed` を受け取ります。

```ts
draw.on('mode.changed', ({ mode }) => {
  document
    .querySelector('#draw-polygon')
    ?.classList.toggle('active', mode === 'draw_polygon');
});
```

`draw_point`、`draw_line`、`draw_circle`、`draw_freehand` も同じように
使います。`draw_image` では、さらにアプリケーションに画像を求めます。
すべてのモードの操作は [描画の手引き](guides/drawing.ja.md) にあります。

`examples/basic/main.ts` では手順 3 に当たります。

## 4. 変更を受け取る

`feature.created` は地物 1 件ごとに発火します。すべての変更 (作成、
移動、頂点の編集、削除、読み込み) にまとめて対応するには、
`document.changed` を受け取ります。このイベントは取引ごとに 1 回届き、
一緒に変わったものをすべて含んでいます。

```ts
draw.on('document.changed', ({ features, source }) => {
  if (!features) return;
  const { created = [], updated = [], deleted = [] } = features;
  console.log(
    `${created.length} created, ${updated.length} updated,`,
    `${deleted.length} deleted (${source})`,
  );
});
```

`updated` の各項目には、`feature` と変わる前の `previous` が入ります。
`source` は変更の出どころを表し、たとえば利用者の編集と API の呼び出し
なら `'local'`、GeoJSON の読み込みなら `'load'` です。同じイベントで、
レイヤー、グループ、文書の題の変更も届きます。

API は、次の規則を押さえておくと分かりやすくなります。

- メソッドは同期的です。`draw.setMode(...)` や
  `draw.features.delete(id)` から戻った時点で、インスタンスを読めば新しい
  状態が得られます。Promise を返すのは `draw.document.load` だけです
- `create` と `update` は、書いたものを返します。無い ID のような誤った
  引数には `DrawError` を投げます。読み取り専用のために書き込みを拒む
  ときは `null` か `false` を返します
- イベントは変更が終わってから発火するので、受け取る関数からは新しい
  状態が見えます
- `draw.on` は、購読をやめる関数を返します

UI は、呼んだメソッドからではなくイベントから更新してください。利用者も
描いたものを変えるので、イベントを使えば両方を拾えます。

`examples/basic/main.ts` では手順 4 に当たります。すべてのイベントと
その payload は [イベントのリファレンス](reference/events.md) (英語) に
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

`draw.document.load` で読み戻します。渡したものが GeoJSON か、独自の
形式か、JSON の文字列か、`File` かを自動で判別します。

<!-- docs-check: continue -->

```ts
const saved = localStorage.getItem(STORAGE_KEY);
if (saved !== null) {
  const result = await draw.document.load(JSON.parse(saved));
  console.log(`loaded ${result?.featureIds.length ?? 0} features`);
  for (const { index, reason } of result?.skipped ?? []) {
    console.warn(`feature ${index} was skipped: ${reason}`);
  }
}
```

読み取り専用のとき、`load` は `null` を返します。GeoJSON を読み込むと、
地物は今ある地物に追加されます。地物が存在するレイヤーを指していれば
そのレイヤーに (このライブラリーが書き出した GeoJSON は指しています)、
そうでなければアクティブなレイヤーに入ります。読めない地物 (知らない
geometry の型や不正な座標) は除かれて `skipped` に並び、残りは読み込まれ
ます。読み込んだ地物は、すべて 1 回の `document.changed` で届きます。

GeoJSON は地物ごとの属性とスタイルを保ちますが、レイヤーとグループ
そのものや、その順序は保ちません。それも保つには独自の形式を使います。
`draw.document.toJSON()` が文書の全体を返し、`draw.document.load` で
同じように読み戻せます。独自の形式を読み込むと、今の文書に追加するの
ではなく置き換えます。両方の形式の仕様は
[データ形式のリファレンス](reference/data-format.md) (英語) にあります。

`examples/basic/main.ts` では手順 5 に当たります。

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
[デモ](https://sakuzu.github.io/maplibre-gl-draw/) を開いてください。
[API リファレンス](https://sakuzu.github.io/maplibre-gl-draw/api/) も
同じ場所で公開しています。
