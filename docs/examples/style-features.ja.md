---
aside: false
---

# Style features

地物ごとの見た目を並べて比べます。塗りと輪郭の色、太さの違う実線と
破線と点線、点の 4 つの形と 4 つの大きさです。

```example
style-features
```

上の段には 3 つの面があり、どれも塗りと輪郭が別の色です。輪郭は
1 px の実線、3 px の破線、6 px の点線です。その下の線は太さが 1 px、
4 px、10 px です。次の段は円、正方形、三角形、星の点で、半径は 6 px、
9 px、12 px、15 px です。いちばん下は地上で 80 m の円です。
このページは真ん中の面を選んだ状態で開くので、右のパネルにその
スタイルの欄が出ます。値を変えると、面はすぐにその見た目になります。
ほかの地物を選ぶと、その型の欄が出ます。点は形と大きさ、線は太さと
破線、面は塗りと輪郭です。

## コード

どの地物も、作るときに自分の `style` を持たせます (1)。スタイルを
持たない地物が使う型ごとの既定値は、`draw.options.update` で変えます
(2)。道具で面を描くと、その既定値で描かれます。パネルは変更を
`draw.features.update` で書き込みます (複数の地物なら `updateMany`)。
ページの最後で同じ呼び出しを 1 度だけ実行し、真ん中の面の輪郭を
破線にしています (5)。

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
