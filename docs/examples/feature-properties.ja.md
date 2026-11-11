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

`tx.import` で GeoJSON を文書に取り込むと、各地物はその ID と
properties を持ちます (2)。`tx.features.update` は `properties` を
キーごとに併合し、`unset` に書いたキーを消します (3)。パネルも同じ
呼び出しで変更を書き込みます。`change` は確定ごとに変わった地物の
ID を並べ、`previous` で各地物の確定の前の姿を読めます (1)。
`maplibre-gl-draw:` で始まるライブラリーのキーも同じ properties にあり、
`isDrawProperty` で見分けます。`createDrawUI` には
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
- [`tx.features.update`](../api/maplibre-gl-draw/interfaces/TransactionFeatures.md#update)。
  `properties` をキーごとに併合します
- [`tx.import`](../api/maplibre-gl-draw/interfaces/Transaction.md#import)
- [取引ごとの変更](../reference/events.md#one-change-per-commit) (英語)。
  `change` が運ぶものを説明します
- 標準の UI の[インスペクター](../../ui/README.md#inspector) (英語)
