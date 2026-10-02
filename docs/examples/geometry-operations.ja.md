---
aside: false
---

# Geometry operations

地物を組み合わせ、切り、測ります。結合、交差、差、分割、バッファーは
それぞれ 1 回の呼び出しです。選んだ地物の長さと面積も測ります。

```example
geometry-operations
```

広い画面では、このページは、辺を共有する 2 つの正方形を選んだ状態で
開くので、
右のパネルに 2 つの面に使える演算が出ます。結合を押すと 1 つに
まとまります。Shift を押しながらクリックすると、さらに選べます。
最初の正方形とそれを横切る線を選ぶと、分割で正方形を線に沿って
分けられます。どの地物でも、バッファーでその周りの面を作れます。
演算の結果は選ばれた状態になります。選択が変わるたびに、その長さと
面積がブラウザーのコンソールにログで出ます。

## コード

正方形と線はコードで作ります (1)。パネルの演算は、どれも選択の ID を
渡す `draw.features` の 1 回の呼び出しです。文書を 1 回の変更で書き換え、
作ったものを返します (2)。ページ自身も 1 つ呼び出し、線の周り 40 m の
バッファーを作ります (4)。`length` と `area` は geometry の入口の
関数です。GeoJSON の形状を受け取り、地上のメートルと平方メートルで
返します (3)。

::: code-group
<<< @/../examples/geometry-operations/main.ts
<<< @/../examples/geometry-operations/data.ts
<<< @/../examples/geometry-operations/index.html
:::

## 関連

- [吸着と幾何演算](../guides/snapping-geometry.ja.md)。
  「地物を組み合わせる、分ける」と「geometry の入口」の節で説明します
- [`FeaturesCollection`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md)
  の `union`、`intersection`、`difference`、`split`、`buffer`
- geometry の入口の [`length`](../api/geometry/functions/length.md) と
  [`area`](../api/geometry/functions/area.md)
- 標準の UI の[インスペクター](../../ui/README.md#inspector) (英語)。
  演算のボタンもここにあります
