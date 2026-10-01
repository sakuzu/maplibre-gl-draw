---
aside: false
---

# Datasets

Overture Maps の東京都心の建物 10,477 件と場所 17,558 件は、見せる
だけのデータである 2 つのデータセットから描き、調査範囲と予定の経路は
利用者が描いたものとして 2 つのレイヤーに置き、建物をその間に挟みます。
左のパネルの凡例のタブには、2 つのデータセットの色の意味が出ます。

```example
datasets
```

建物と色のついた点は 2 つのデータセットの行で、描いたものの地物では
ありません。選ぶことも直すこともできず、描いたものと一緒に保存も
されません。調査範囲と予定の経路は、描いたものの 2 つのレイヤーの
地物です。建物はその間にあり、調査範囲の手前、経路の奥に描かれます。
場所はすべての手前に描かれます。

色が読みやすいように、背景地図は明るい灰色の Positron です。建物は
建坪 (外形の面積) で、桃色から濃い紫まで塗り分けてあり、階級の境目は
50、100、200、500 m² です。サンプルの建物の半分は 70 m² 未満で、
4 分の 1 は 160 m² を超え、20 件に 1 件は 670 m² を超えます。この
境目なら、どの階級にも十分な数の建物が入り、大きな街区が目立ちます。
場所は小さな点で、カテゴリーで塗り分けてあり、多い順に 6 つの
カテゴリーに色がつきます。場所はズーム 14 から出ます。

道具で線を描くと、経路のレイヤーに入り、建物の辺や角に吸着します。
建物か場所をクリックすると、その行が名前と属性とともにブラウザーの
コンソールに出ます。右のパネルは描いた地物だけを表示するので、
閉じます。凡例のタブを開くと、2 つのデータセットの規則が重なりの順に
並びます。手前の場所が先で、建物が後です。地図を動かすと、新しい範囲の
場所が渡し直されます。画面の上で重なる場所は、ズーム 18 までは
間引かれます。

## コード

ページはデータセットへの吸着を有効にし (既定でも有効ですが、見える
ように指定しています)、自分のレイヤーを作ります (1)。調査範囲と
経路は 2 つのレイヤーの地物で、最初のフレームから表示されます (2)。
ページはサンプルデータの 2 つの GeoJSON ファイルを取り寄せ、その地物を
行として `draw.datasets.add` に渡します。建物は一度に渡し、`area` の
階級の規則で塗り分けます (3)。順序を `layer-order` にすると、
データセットはレイヤーの重なりの順に場所を持ちます。
`draw.layers.reorder` で、それを 2 つのレイヤーの間に置きます (4)。
`provider` は、地図が止まると見えている範囲とズームを受け取って
呼ばれます (5)。実際のプロバイダーはサーバーから行を取り寄せますが、
この例では、ページがすでに持っている配列から範囲の中の場所を
取り出します。場所のカテゴリーの規則はデータから作り、多い順の 6 つの
カテゴリーに色をつけ、ほかは灰色にします。凡例のタブはそれぞれの
データセットの規則を読み (`getStyleRule`)、凡例の行に変えるので
(6)、ページが凡例のために足すものはありません。
`interactive: true` にすると行がクリックを受け、`dataset.clicked` が
それを知らせます (7)。行は吸着の候補にもなります。

::: code-group
<<< @/../examples/datasets/main.ts
<<< @/../examples/datasets/index.html
:::

## 関連

- [大量のデータを表示する](../guides/large-data.ja.md)。データセットを
  使う場面、行の渡し方、見えている範囲の取り寄せ、描いたものとの順序、
  間引き、クリックを説明します
- [`draw.datasets`](../api/maplibre-gl-draw/interfaces/DatasetsCollection.md)、
  [`DatasetOptions`](../api/maplibre-gl-draw/type-aliases/DatasetOptions.md)、
  [`DatasetProvider`](../api/maplibre-gl-draw/type-aliases/DatasetProvider.md)
- [`layers.reorder`](../api/maplibre-gl-draw/interfaces/LayersCollection.md#reorder)
  と [`SnappingOptions`](../api/maplibre-gl-draw/interfaces/SnappingOptions.md)
- [イベント](../reference/events.md) (英語)。`dataset.clicked` も
  その 1 つです
- [`Dataset`](../api/maplibre-gl-draw/interfaces/Dataset.md) の
  `getStyleRule` と、凡例のタブが使う
  [`deriveLegend`](../api/maplibre-gl-draw/functions/deriveLegend.md)

データは [Overture Maps Foundation](https://overturemaps.org) のもので、
ライセンスは ODbL と CDLA です
([サンプルデータ](../../examples/public/data/README.md)、英語)。
