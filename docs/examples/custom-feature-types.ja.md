---
aside: false
---

# Custom feature types

ライブラリーにない地物の型です。ルートは独自のスタイルのキーを持つ線で、
その定義が描き方、当たり判定、範囲選択を決めます。右のパネルには、
そのキーのための節を足します。カードは、点の周りの地図の上に置く紙の
カードです。ライブラリーが回して大きさを変え、レイヤーの規則が紙を
塗ります。

```example
custom-feature-types
```

広い画面では、このページは川沿いのルートを選んだ状態で開きます。右の
パネルのルートの
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

2 枚のカードは、自分のレイヤー Cards にあり、その規則が話題ごとに紙を
塗ります。1 枚を選ぶと、選択の枠の角の大きさを変えるハンドルは形を
保ったまま大きさを変え、上のハンドルは回し、東の辺の真ん中のハンドルは
幅だけを広げます。カードは、作ったときのズームから地図に合わせて大きく
なったり小さくなったりします。

## コード

定義 (`route.ts`) は、型に描画、当たり判定、範囲選択、選択枠、頂点の
ハンドルを与えます。描画にはライブラリーの共有の線の描画を使います。
選択枠の大きさを変えるハンドルと回すハンドルはライブラリーが描き、
頂点のハンドルは `custom` のハンドルで、その印は型が自分で
(`drawHandles` で)、当たる幅で描きます。
`featureTypes.add` で登録し (1)、`featureTypes.remove` で外します。外すのは、
ページが `ui.actions.add` で足したスイッチです (6)。ルートのスタイルのキー
(`routeColor`、`routeWidth`、`routeDashed`) は、`FeatureStyle` への宣言の
併合で宣言します。core は自分が定義していないキーも地物と一緒に保ち、
描画の側は値を確かめてから使います。

標準の UI のインスペクターは、ライブラリーの型にしかスタイルの欄を
出しません。そこでページは `ui.inspector.sections.add` で、ルートのキーの
ための節を足します (4)。`fields` の欄 (色、スライダー、スイッチ) は UI が
描き、`onchange` は変わったキーを選んだルートのスタイルに書き込みます。

カード (`card.ts`) は Point の上に描きます。幅と高さは作ったときの
ズームでのピクセルで、外形は `/geometry` の `pixelsToMeters` でメートルに
直し、`metersToDegrees` で地図の上に置き、角度で回します
(`cardFootprint`)。`transformFields` は、選択の枠のハンドルが書く鍵
(回転と倍率) を名指し、外形がそれを読みます。`handles` は、選択の枠の
東の辺の真ん中に `resize` のハンドルを出し (`eastMiddleOf`)、その
ドラッグが幅を書きます (`widthFromCenter`)。見た目を `defaultStyle` で
宣言し、規則が塗りを塗ることを宣言し (`styleRuleChannel: 'fill'`)、
描画器は `ctx.appliedStyle(feature)` で、規則が塗った紙を描きます (7)。

::: code-group
<<< @/../examples/custom-feature-types/main.ts
<<< @/../examples/custom-feature-types/route.ts
<<< @/../examples/custom-feature-types/card.ts
<<< @/../examples/custom-feature-types/data.ts
<<< @/../examples/custom-feature-types/index.html
:::

## 関連

- [独自の地物の型](../guides/custom-types.ja.md)。型の定義、その描画と
  当たり判定を説明します
- [`FeatureTypeDefinition`](../api/maplibre-gl-draw/interfaces/FeatureTypeDefinition.md)
  と [`FeatureStyle`](../api/maplibre-gl-draw/interfaces/FeatureStyle.md)
- 標準の UI の[インスペクターの節](../../ui/README.md#inspector) (英語)
