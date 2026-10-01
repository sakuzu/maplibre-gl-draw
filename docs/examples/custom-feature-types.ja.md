---
aside: false
---

# Custom feature types

ライブラリーにない地物の型です。ルートは独自のスタイルのキーを持つ線で、
その定義が描き方、当たり判定、範囲選択を決めます。右のパネルには、
そのキーのための節を足します。

```example
custom-feature-types
```

このページは川沿いのルートを選んだ状態で開きます。右のパネルのルートの
節に、色、太さ、破線かどうかが出ます。そこで変えると、すぐに描き直され
ます。もう 1 つのルートをクリックするか、Shift を押しながらドラッグして
その頂点に範囲選択の枠をかけると選べます。頂点をドラッグすると動かせます。

このページには自分の操作が 1 つあります。地図の左下の操作のカードにある
スイッチです。そのキーは `?` の一覧に出ます。パネルの欄に入力している
間は、キーは働きません。

| 操作 | キー | すること |
| --- | --- | --- |
| ルートの型 | `U` | ルートの型の登録を外します。また登録します |

スイッチを切ると、2 つのルートは形とスタイルのキーを持ったまま描画に
残りますが、何もそれを描かなくなり、クリックも素通りします。範囲選択の
枠を頂点にかけると、まだ選べます。ライブラリーは、知らない型の地物を
位置で範囲選択に入れるからです。もう一度入れると、ルートは前と同じ
見た目で描かれ、クリックで選べるようになります。

## コード

定義 (`route.ts`) は、型に描画、当たり判定、範囲選択、選択枠、頂点の
ハンドルを与えます。描画にはライブラリーの共有の線の描画を使います。
`featureTypes.add` で登録し (1)、`featureTypes.remove` で外します。外すのは、
ページが `ui.actions.add` で足したスイッチです (6)。ルートのスタイルのキー
(`routeColor`、`routeWidth`、`routeDashed`) は、`FeatureStyle` への宣言の
併合で宣言します。core は自分が定義していないキーも地物と一緒に保ち、
描画の側は値を確かめてから使います。

標準の UI のインスペクターは、ライブラリーの型にしかスタイルの欄を
出しません。そこでページは `ui.inspector.sections.add` で、ルートのキーの
ための節を足します (4)。`fields` の欄 (色、スライダー、スイッチ) は UI が
描き、`onchange` は変わったキーを選んだルートのスタイルに書き込みます。

::: code-group
<<< @/../examples/custom-feature-types/main.ts
<<< @/../examples/custom-feature-types/route.ts
<<< @/../examples/custom-feature-types/data.ts
<<< @/../examples/custom-feature-types/index.html
:::

## 関連

- [独自の地物の型](../guides/custom-types.ja.md)。型の定義、その描画と
  当たり判定を説明します
- [`FeatureTypeDefinition`](../api/maplibre-gl-draw/interfaces/FeatureTypeDefinition.md)
  と [`FeatureStyle`](../api/maplibre-gl-draw/interfaces/FeatureStyle.md)
- 標準の UI の[インスペクターの節](../../ui/README.md#inspector) (英語)
