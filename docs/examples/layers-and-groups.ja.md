---
aside: false
---

# Layers and groups

描画のレイヤーと、その中のグループです。重なりの順、描いたものが
入るレイヤー、表示、ロック、不透明度をコードで決め、左のパネルに
出します。

```example
layers-and-groups
```

左のパネルには、レイヤーが手前から並び、その中にグループと地物が
並びます。目のボタンでレイヤー、グループ、地物を隠し、錠前のボタンで
ロックします。行のつまみをドラッグすると並べ替えられ、名前を
ダブルクリックすると名前を直せます。追加のメニューからは、
レイヤーや、選んだ地物のグループを足せます。レイヤーを選ぶと、
右のパネルにその不透明度が出ます。ロックしたグループの地物は、
選べますが動かせません。Paths は 60 パーセントの不透明度で薄く
なっています。道具で線を描くと、アクティブなレイヤーの Paths に
入ります。

## コード

文書は空のレイヤーを 1 つ持って始まるので、ページはそれに名前を
付け、その後ろに 2 つ目のレイヤーを作ります (1)。地物は `layerId` の
レイヤーに入ります (2)。グループは 1 つのレイヤーの地物をまとめます。
`features.move` でもう 1 つの地物を入れ、グループをロックします (3)。
`visible: false` は、文書を共有する全員に対して下書きを隠します (4)。
`layers.reorder` はすべてのレイヤーの ID を奥から受け取り、
`opacity` はレイヤー全体を薄くします (5)。`layers.setActive` は、
道具で描いたものが入るレイヤーを決めます (6)。

::: code-group
<<< @/../examples/layers-and-groups/main.ts
<<< @/../examples/layers-and-groups/data.ts
<<< @/../examples/layers-and-groups/index.html
:::

## 関連

- [レイヤーとグループ](../guides/layers.ja.md)。アクティブなレイヤー、
  重なりの順、グループ、ロック、表示、不透明度を説明します
- [`LayersCollection`](../api/maplibre-gl-draw/interfaces/LayersCollection.md)
  と [`GroupsCollection`](../api/maplibre-gl-draw/interfaces/GroupsCollection.md)
- [`features.move`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md#move)
- [読み取り専用](../guides/read-only.ja.md)。このページだけで隠す方法と、
  すべての編集を一度に止める方法です
- 標準の UI の[レイヤーのパネル](../../ui/README.md#use) (英語)
