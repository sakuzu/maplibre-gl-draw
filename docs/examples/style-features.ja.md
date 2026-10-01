---
aside: false
---

# Style features

地物ごとの見た目です。色、線の太さと透明度、破線と点線、点の形と
大きさを決めます。

```example
style-features
```

このページは街区を選んだ状態で開くので、右のパネルにそのスタイルの
欄が出ます。値を変えると、街区はすぐにその見た目になります。ほかの
地物を選ぶと、その型の欄が出ます。点は形と大きさ、線は太さと破線、
面は塗りと輪郭です。

## コード

どの地物も、作るときに自分の `style` を持たせます (1)。スタイルを
持たない地物が使う型ごとの既定値は、`draw.options.update` で変えます
(2)。道具で面を描くと、その既定値で描かれます。パネルは変更を
`draw.features.update` で書き込みます (複数の地物なら `updateMany`)。
ページの最後で、同じ呼び出しを 1 度だけ実行しています (5)。

::: code-group
<<< @/../examples/style-features/main.ts
<<< @/../examples/style-features/data.ts
<<< @/../examples/style-features/index.html
:::

## 関連

- [スタイル](../guides/styles.ja.md)。スタイルのキー、既定値、レイヤーの
  スタイル規則、どの色が使われるかを説明します
- [`FeatureStyle`](../api/maplibre-gl-draw/interfaces/FeatureStyle.md)。
  キーとその値です
- [`features.update`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md#update)。
  スタイルをキーごとに併合します
- [`options.update`](../api/maplibre-gl-draw/interfaces/OptionsResource.md#update)
  と [`RuntimeOptions`](../api/maplibre-gl-draw/interfaces/RuntimeOptions.md)
  の `style`
- 標準の UI の[インスペクター](../../ui/README.md#inspector) (英語)
