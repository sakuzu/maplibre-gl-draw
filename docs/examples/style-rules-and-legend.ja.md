---
aside: false
---

# Style rules and legend

地物の属性から決まる色です。レイヤーのスタイル規則が 1 つの属性から
地物を塗り分け、凡例がそれぞれの色の意味を示します。

```example
style-rules-and-legend
```

街区は用途で塗り分けてあります。左のパネルの凡例のタブを開くと、
規則の行が並びます。`R` を押すと、レイヤーの規則が次の種類に
変わります。1 色、カテゴリー別、人口の階級別、人口のグラデーションの
順です。人口を持たない街区は、規則が読めない値の色になります。
左のパネルでレイヤーを選ぶと、右のパネルに規則の種類と、規則が読む
属性が出ます。

## コード

ページは自分のレイヤーを作ります。規則の色が見やすいように、塗りを
既定値より濃くしています。規則が決めるのは色で、不透明度はスタイルの
ままです。4 種類の規則は、ただのオブジェクトです (1)。規則はレイヤーのキーで、
レイヤーを作るときに渡し (2)、`draw.layers.update` で変えます (3)。
地図と凡例はすぐに追従します。標準の UI の凡例は、行を
`deriveLegend` で作ります。自分のページで凡例を描くときも、同じ関数を
呼べます。

::: code-group
<<< @/../examples/style-rules-and-legend/main.ts
<<< @/../examples/style-rules-and-legend/data.ts
<<< @/../examples/style-rules-and-legend/index.html
:::

## 関連

- スタイルのガイドの[スタイル規則](../guides/styles.ja.md#スタイル規則)と
  [凡例](../guides/styles.ja.md#凡例)。規則と地物のスタイルの
  [どの色が使われるか](../guides/styles.ja.md#どの色が使われるか)も
  説明します
- [`StyleRule`](../api/maplibre-gl-draw/type-aliases/StyleRule.md) と
  [`deriveLegend`](../api/maplibre-gl-draw/functions/deriveLegend.md)
- [`layers.update`](../api/maplibre-gl-draw/interfaces/LayersCollection.md#update)
- 標準の UI の[凡例](../../ui/README.md#use) (英語)
