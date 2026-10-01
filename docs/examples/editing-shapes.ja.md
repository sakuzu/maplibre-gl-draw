---
aside: false
---

# Editing shapes

選んだ地物のハンドルです。大きさを変えて回す枠、頂点と辺の中点、
穴のある面、2 つの部分からなる面、共有する頂点がいっしょに動く
2 つの区画を扱います。

```example
editing-shapes
```

このページは西の区画を選んだ状態で開きます。枠の角の四角を
ドラッグすると、反対の角を基準に大きさが変わります。枠の上の点を
ドラッグすると、中心のまわりに回ります。頂点には丸いハンドルがあり、
辺の中ほどには小さなハンドルがあります。頂点をドラッグすると頂点が
動き、中点をドラッグするとそこに頂点が増えます。頂点をクリックすると
その頂点を選べます。Shift を押しながらクリックすると選ぶ頂点を
足せて、Delete で選んだ頂点を消せます。2 つの区画は 1 本の辺を
共有しています。その辺の端をドラッグすると、東の区画の頂点も
ついてきます。左下の操作のカードにある「共有頂点の同時移動」の
スイッチを切ってから (キーは `T` です) もう一度ドラッグすると、西の区画
だけが動きます。ブラウザーのコンソールには今の状態がログで
出ます。下の段では、穴のある面の Courtyard と、2 つの部分からなる
1 つの地物の Islands を選んでください。どの輪にも、どの部分にも
ハンドルが出ます。

## コード

オプションの `topology.sharedVertexDrag` で、インスタンスを作るときに
共有する頂点の同時移動を有効にします (1)。動作中は
`draw.options.update` で切り替えます。ページは、`ui.actions.add` で
標準の UI に足したスイッチから切り替えます (5)。共有する頂点は位置が完全に
一致するものなので、2 つの区画は辺の両端にまったく同じ位置を
並べます (2)。穴は `Polygon` の 2 つめの輪です。`MultiPolygon` の
部分は、それぞれが 1 つの多角形です。どちらも形状を渡して作ります
(2)。`draw.selection.set` で区画を選んだ状態でページを開きます (4)。

::: code-group
<<< @/../examples/editing-shapes/main.ts
<<< @/../examples/editing-shapes/data.ts
<<< @/../examples/editing-shapes/index.html
:::

## 関連

- 描画と編集のガイドの[選択と編集](../guides/drawing.ja.md#選択と編集)、
  [頂点](../guides/drawing.ja.md#頂点)、
  [Multi の形状と穴](../guides/drawing.ja.md#multi-の形状と穴)
- 吸着と幾何演算のガイドの[共有頂点の同時移動](../guides/snapping-geometry.ja.md#共有頂点の同時移動)
- [`TopologyOptions`](../api/maplibre-gl-draw/interfaces/TopologyOptions.md)
  の `sharedVertexDrag` と、枠とハンドルの見た目を決める
  [`SelectionStyleOptions`](../api/maplibre-gl-draw/interfaces/SelectionStyleOptions.md)
- [`VertexSelectionResource`](../api/maplibre-gl-draw/interfaces/VertexSelectionResource.md)。
  選んだ頂点をコードで扱います
