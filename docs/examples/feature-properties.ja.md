---
aside: false
---

# Feature properties

地物の属性です。`properties` のキーと値を GeoJSON から読み込み、
パネルとコードで直します。

```example
feature-properties
```

広い画面では、このページは Market hall を選んだ状態で開き、右の
パネルは属性の
タブを開いた状態で出ます。そこにその属性が並びます。値はその場で直せます。
消すことも、新しいキーで足すこともできます。そこで入力した値は、
入力した文字列のまま保存されます。Library や Avenue を選ぶと、
それぞれの属性が出ます。パネルとコードのどちらで変えても、変更のたびに
ブラウザーのコンソールにログが出ます。

## コード

`draw.document.load` で GeoJSON を読み込むと、各地物はその
properties を持ちます (2)。`draw.features.update` は `properties` を
キーごとに併合し、`undefined` を渡したキーを消します (3)。パネルも
同じ呼び出しで変更を書き込みます。`feature.updated` は、変更の前と後の
地物を運びます (1)。`maplibre-gl-draw:` で始まるライブラリーのキーも
同じ properties にあり、`isDrawProperty` で見分けます。`createDrawUI` には
`inspector: { tabs: ['attributes', 'style'] }` を渡します。`tabs` の
最初のタブが開いた状態で出ます (4)。

::: code-group
<<< @/../examples/feature-properties/main.ts
<<< @/../examples/feature-properties/data.ts
<<< @/../examples/feature-properties/index.html
:::

## 関連

- データ形式の [properties](../reference/data-format.md#properties)
  (英語)。ライブラリーのキーと、GeoJSON の properties の読み方です
- [`features.update`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md#update)。
  `properties` をキーごとに併合します
- [`document.load`](../api/maplibre-gl-draw/interfaces/DocumentResource.md#load)
- [地物のイベント](../reference/events.md#features) (英語)。
  `feature.updated` もその 1 つです
- 標準の UI の[インスペクター](../../ui/README.md#inspector) (英語)
