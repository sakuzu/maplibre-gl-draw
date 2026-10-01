---
aside: false
---

# Style rules and legend

地物の属性から決まる色です。レイヤーのスタイル規則が 1 つの属性から
地物を塗り分け、凡例がそれぞれの色の意味を示します。属性を直すと、
色も変わります。

```example
style-rules-and-legend
```

400 件の建物は描いたものの地物で、Overture Maps のサンプルデータから
取り出しています。高さを持つ建物のうち、中心に近いものです。色が
読みやすいように、背景地図は明るい灰色の Positron です。開いた
ときは高さで塗り分けてあり、階級の境目は 10、20、40、80 m です。
左のパネルの凡例のタブを開くと、規則の行が並びます。左下の操作の
カードにある「次の規則」のボタンか、そのキーの `R` を押すと、
レイヤーの規則が次の種類に変わります。建物の種類別、高さの
グラデーション、1 色の順です。種類を持たない建物が多く、それらは
規則が読めない値の色になります。左のパネルでレイヤーを選ぶと、
右のパネルに規則の種類と、規則が読む属性が出ます。

規則は属性を読むので、描いたものは直せるままです。建物を選び、
右のパネルの属性のタブで `height` を変えると、その色がすぐに
変わります。

## コード

ページは自分のレイヤーを作ります。規則の色が見やすいように、塗りを
既定値より濃くし、白い輪郭をつけています。規則が決めるのは塗りの色で、
不透明度と輪郭はスタイルのままです。4 種類の規則は、ただの
オブジェクトです (1)。ページはサンプルデータの建物を取り寄せ、
高さを持つ建物のうち近い 400 件を、規則が読む属性とともに取り出します
(2)。`draw.document.load` は、規則を持つレイヤーを作って建物を
入れるまでを 1 度で行い (3)、`draw.layers.update` で規則を変えます
(4)。変えるのは、ページが `ui.actions.add` で標準の UI に足したボタンです
(7)。地図と凡例はすぐに追従します。属性のタブは入力をそのまま文字として
保ち、階級と連続の規則は数しか読まないので、ページは `height` と
`floors` に入力された数を数に直します (5)。標準の UI の凡例は、行を
`deriveLegend` で作ります。自分のページで凡例を描くときも、同じ関数を
呼べます。

::: code-group
<<< @/../examples/style-rules-and-legend/main.ts
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

データは [Overture Maps Foundation](https://overturemaps.org) のもので、
ライセンスは ODbL と CDLA です
([サンプルデータ](../../examples/public/data/README.md)、英語)。
