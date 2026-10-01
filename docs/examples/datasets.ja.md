---
aside: false
---

# Datasets

見せるだけのデータです。5 万のセルを一度に渡し、点は地図の見えている
範囲の分だけ取り寄せます。

```example
datasets
```

青いセルと色のついた点は 2 つのデータセットの行で、描いたものの
地物ではありません。選ぶことも直すこともできず、レイヤーのパネルにも
並ばず、描いたものと一緒に保存もされません。セルか点をクリックすると、
その行がブラウザーのコンソールに出ます。右のパネルは描いた地物だけを
表示するので、閉じたままです。地図を動かすと、新しい範囲の点が
取り寄せられます。画面の上で重なる点は、ズーム 17 までは間引かれます。
道具で面を描くと、セルの手前、点の奥に置かれます。

## コード

セルはコードで作り (1)、`draw.datasets.add` に一度に渡して、
スタイル規則で塗り分けます (2)。`provider` は、地図が止まると
見えている範囲とズームを受け取って呼ばれます (3)。実際のプロバイダーは
サーバーから行を取り寄せます。`order` で、それぞれのデータセットを
描いたものの奥か手前に置きます (2、4)。`interactive: true` にすると
行がクリックを受け、`dataset.clicked` がそれを知らせます (5)。

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
- [イベント](../reference/events.md) (英語)。`dataset.clicked` も
  その 1 つです
