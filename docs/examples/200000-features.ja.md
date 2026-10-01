---
aside: false
---

# 200,000 features

20 万の建物からなる架空の町を、1 度で描いたものに読み込みます。
どの建物も、編集できる地物です。

```example
200000-features
```

建物は、手で描いた地物と同じ地物です。1 つをクリックして選ぶと、
右のパネルに名前が出て、属性のタブに階数が出ます。そこで変えた値はすぐに反映されます。
ドラッグで動かしたり、頂点を動かしたり、Delete キーで消したり
できます。縮小すると町の全体が見えます。読み込みにかかった時間は、
ブラウザーのコンソールに出ます。

## コード

標準の UI のレイヤーのパネルは、地物を並べずにレイヤーだけを
並べます (1)。パネルの一覧は地物ごとに行を作るためです。町は、
種を決めた乱数でコードから作るので、いつ開いても同じです (2、3)。
`draw.document.load` は 20 万の地物を 1 つのトランザクションで
書き込みます (4)。変更もイベントも描き直しも 1 回です。
`draw.features.createMany` も 1 つのトランザクションです。

::: code-group
<<< @/../examples/200000-features/main.ts
<<< @/../examples/200000-features/index.html
:::

## 関連

- [性能](../guides/performance.ja.md)。多くの地物の書き込み、
  208,073 の地物で測った例、データの置き場所を説明します
- [大量のデータを表示する](../guides/large-data.ja.md)。編集せずに
  見せるだけのデータに使います
- [`draw.document.load`](../api/maplibre-gl-draw/interfaces/DocumentResource.md)
  と
  [`features.createMany`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md#createmany)
- 標準の UI の[レイヤーのパネル](../../ui/README.md#use)と、その
  `features` のオプション (英語)
