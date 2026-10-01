---
aside: false
---

# Get started

いちばん小さなページです。地図に標準の UI を重ね、利用者が地物を
描き、選び、直せるようにします。

```example
get-started
```

地図の下の道具か、そのキー (`V`、`P`、`L`、`A`、`C`、`F`、`I`) で
描きます。地物をクリックして選ぶと、右のパネルに名前、計測値、
スタイル、属性が出ます。そこで変えた値はすぐに地物に反映されます。
左のパネルにはレイヤーとその地物が並びます。変更のたびに、
ブラウザーのコンソールにログが出ます。

## コード

スクリプトが呼ぶのは 4 つです。地図、`createDraw`、`createDrawUI`、
変更を受け取るリスナーです。周りのページには地図の要素だけを置きます。

::: code-group
<<< @/../examples/get-started/main.ts
<<< @/../examples/get-started/index.html
:::

標準の UI は別のパッケージなので、ライブラリーと一緒に入れます。

```sh
npm install @sakuzu/maplibre-gl-draw @sakuzu/maplibre-gl-draw-ui maplibre-gl
```

## 関連

- [はじめかた](../getting-started.ja.md)。同じ手順を 1 つずつ説明します。
  標準の UI の代わりに自分のボタンを使います
- [`createDraw`](../api/maplibre-gl-draw/functions/createDraw.md) と
  そのオプション
- [`createDrawUI`](../../ui/README.md#use) と標準の UI のオプション (英語)
- [文書のイベント](../reference/events.md#the-document) (英語)。
  `document.changed` もその 1 つです
