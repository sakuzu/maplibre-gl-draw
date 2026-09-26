# スタイル

地物の見た目は 3 つのところから決まります。地物自身の
`style`、そのレイヤーのスタイル規則、インスタンスの既定値です。この
手引きでは、それぞれの設定と、それらが適用される順番、規則から得られる
凡例、ライブラリーが返す文字列 (ホストが自分の言語に差し替えられます) を
説明します。

## 最小のコード

```ts
// レイヤーのフィーチャーを属性で塗り分ける
draw.updateLayer(layerId, {
  styleRule: {
    kind: 'categorical',
    property: 'landuse',
    map: { park: '#4caf50', water: '#2196f3' },
    other: '#9e9e9e',
  },
});

// 1 つのフィーチャーは規則によらず自分の色を保つ
draw.updateFeature(featureId, { style: { fillColor: '#ff9800' } });
```

規則はレイヤーを描くときに評価されるので、`landuse` が変わった
地物は、`style` に触れなくてもすぐに新しい色になります。

## 地物自身のスタイル

`Feature.style` は `FeatureStyle` です。どのキーも省略でき、省略した
キーには規則の色か既定値が使われます。

| 型 | キー |
| --- | --- |
| 点 | `pointColor`、`pointRadius`、`pointShape` |
| 線 | `strokeColor`、`strokeOpacity`、`strokeWidth`、`lineStyle` |
| 面 | 線のキー、`fillColor`、`fillOpacity` |
| `Image` | `imageOpacity` |

点は `Point` と `MultiPoint`、線は `LineString`、`MultiLineString`、
`Freehand`、面は `Polygon`、`MultiPolygon`、`Circle` です。

```ts
draw.addFeature({
  type: 'LineString',
  coordinates: [
    [139.7, 35.68],
    [139.71, 35.69],
  ],
  style: { strokeColor: '#1e88e5', strokeWidth: 4, lineStyle: 'dashed' },
});
```

- 色は `#rgb` か `#rrggbb` で、不透明度は 0 から 1 です
- `lineStyle` は `solid`、`dashed`、`dotted` のどれかです
- `strokeWidth` は、地物を描いたときのズーム (`properties.createdZoom`)
  での幅をピクセルで表します。その後は紙に描いた線のように、形と同じく
  地図に合わせて太くなったり細くなったりします。描画モードは、
  インスタンスを `scaleWithZoom: false` で作ったとき以外は
  `createdZoom` を書きます。`createdZoom` を持たない地物 (API で足した
  地物や、このオプションで描いた地物) は、どのズームでも画面上の
  ピクセルでの幅を保ちます
- 点は、どのズームでも画面上の大きさを保ちます
- `pointShape` は `circle`、`square`、`triangle`、`star` のどれかで、
  既定値の `shape` より優先されます。そのため、1 つのインスタンスの中で
  点の形を混ぜられます。当たり判定は、形によらず、その形を囲む円で
  行います
- ロックされた地物はスタイルを変えられません
  ([レイヤーとグループ](layers.ja.md))
- `FeatureStyle` が定めていないキーも、検査せずにそのまま保ち、保存し、
  読み込みます。そのため、拡張は自分のキーを入れておけます。そのキーを
  読むコードが値を確かめます

## 既定値

自分のスタイルを持たない地物と、描画中のプレビューの見た目は、
インスタンスに `Options.style` で 1 度だけ設定します。ここでの色は、
各成分が 0 から 1 の RGBA の配列です。

```ts
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map, {
  style: {
    lineString: {
      stroke: {
        width: 3,
        color: [0.12, 0.53, 0.9, 1],
        opacity: 1,
        lineStyle: 'solid',
      },
    },
  },
});
```

設定のまとまりは `point`、`lineString`、`polygon` (`stroke` と `fill`
を持ちます)、`tentative` (描画のプレビュー) です。選択の枠とハンドルは
`Options.selectionStyle` で、矩形選択の矩形は `Options.renderingStyle`
で設定します。既定の値は型のリファレンスに載っています
([`FeatureStyleConfig`](../reference/api/interfaces/index.FeatureStyleConfig.html)、
[`SelectionUIConfig`](../reference/api/interfaces/index.SelectionUIConfig.html))。

`point` の `shape` (スタイルで `pointShape` を指定していない点の形) と
ハンドルの `shape` は、`circle`、`square`、`triangle` (頂点が上)、
`star` (5 つの角を持ち、先端が上) のどれかです。三角形と星は、同じ
`size` と縁取りの円の中に収まり、縁取りはその輪郭の内側に描かれ、当たり
判定はその円で行います。`icon` は拡張の描画器が描くための名前で、組み込みの
描画器は円として描きます。

## スタイル規則

レイヤーの `styleRule` は、各地物のプロパティーから色を決めます。
種類は 4 つあります。

| `kind` | 用途 | `property` と `other` 以外の項目 |
| --- | --- | --- |
| `single` | すべての地物を 1 色で | `color` だけ |
| `categorical` | 値ごとに 1 色 | `map` |
| `graduated` | 境界値で階級に分ける | `breaks`、`colors` |
| `continuous` | 2 色の間の連続した色 | `min`、`max`、`ramp` |

<!-- docs-check:
declare const otherLayerId: string;
-->

```ts
draw.updateLayer(layerId, {
  styleRule: {
    kind: 'graduated',
    property: 'population',
    breaks: [1000, 5000, 10000],
    colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#2171b5'],
    other: '#cccccc',
  },
});

draw.updateLayer(otherLayerId, {
  styleRule: {
    kind: 'continuous',
    property: 'height',
    min: 0,
    max: 300,
    ramp: ['#fff5eb', '#7f2704'],
    other: '#cccccc',
  },
});

// 規則を外す
draw.updateLayer(layerId, { styleRule: undefined });
```

- `categorical` は、文字列、数値、真偽値を文字列にしたもの
  (`String(value)`) を `map` のキーと照らし合わせます
- `graduated` は、昇順に並んだ n 個の `breaks` と n + 1 個の `colors` を
  取ります。`breaks[i]` 未満の値には `colors[i]` が、どの境界値未満でも
  ない値には最後の色が使われます
- `continuous` は、`ramp` の 2 色を `min` から `max` まで OKLab 色空間で
  補間するので、中間の色が濁りません。範囲外の値は端の値として扱います
- `styleRule` はレイヤーの普通の項目です。保存され、独自の形式で書き
  出され、ほかの変更と同じように `draw.layer.update` で通知されます

データセットでも同じ型の規則を使えます。
[大量のデータ](large-data.ja.md) を参照してください。

## どの色が使われるか

1. 地物自身の、そのチャンネルの色。点は `pointColor`、線は
   `strokeColor`、面とそれ以外の型は `fillColor`
2. レイヤーの規則
3. インスタンスの既定値

- 規則が色を決めるのは 1 つのチャンネルだけです。面の塗りは規則から
  決まり、輪郭は、スタイルで `strokeColor` を指定しない限り既定のまま
  です
- 色以外のスタイルのキー (幅、不透明度、線の種類) は、規則の色と一緒に
  適用されます
- そのプロパティーを持たない地物や、値が規則に当てはまらない
  地物には、既定値ではなく `other` が使われます。そのため、
  「値が無い」と「規則が無い」を見分けられます
- `graduated` と `continuous` が受け付けるのは数値だけです。数字の
  文字列には `other` が使われます

評価の処理は純関数としても公開しているので、表の行を地図と同じ色で塗る
など、ほかの用途にも使えます。

<!-- docs-check:
declare const rule: import('@sakuzu/maplibre-gl-draw').StyleRule;
-->

```ts
import {
  evaluateStyleRule,
  getStyleRuleChannel,
  resolveFeatureStyle,
} from '@sakuzu/maplibre-gl-draw';

const color = evaluateStyleRule(rule, feature.properties); // '#RRGGBB'
const style = resolveFeatureStyle(
  feature,
  rule,
  getStyleRuleChannel(feature.type),
);
```

## 凡例

`deriveLegend(rule)` は、規則をラベルと色の組に変換します。
ライブラリーは凡例を描かないので、ホストが組み立ててください。

```ts
import { deriveLegend } from '@sakuzu/maplibre-gl-draw';

const layer = draw.getLayer(layerId);
const entries = layer?.styleRule ? deriveLegend(layer.styleRule) : [];

const list = document.querySelector('#legend');
list?.replaceChildren(
  ...entries.map(({ label, color }) => {
    const item = document.createElement('li');
    item.style.setProperty('--swatch', color);
    item.textContent = label;
    return item;
  }),
);
```

| `kind` | 項目 (英語の既定) |
| --- | --- |
| `single` | `All` |
| `categorical` | `map` のキーを順に並べ、最後に `Other` |
| `graduated` | `Below 1000`、`1000 to below 5000`、…、`Other` |
| `continuous` | `min`、`max`、最後に `Other` |

数値は `String()` で文字列にします。桁区切りや単位はホストに任せて
います。

## メッセージ

ライブラリーが値として返す文字列 (凡例のラベルや、吸着のガイドの
説明) は、すべてメッセージの表から取られます。既定は英語の
`MESSAGES_EN` で、ライブラリーに入っている言語はこれだけです。
`Options.messages` で、インスタンスごとに項目を差し替えられます。
指定しなかった項目は英語の既定のままです。

<!-- docs-check:
declare const rule: import('@sakuzu/maplibre-gl-draw').StyleRule;
-->

```ts
const draw = createMapLibreGLDraw(map, {
  messages: {
    legendOther: 'Autres',
    legendBelow: (upper) => `Moins de ${upper}`,
  },
});

// deriveLegend はインスタンスを持たないので、表を引数で受け取る
deriveLegend(rule, { legendOther: 'Autres' });
```

値は文字列か、文字列にした数値から文字列を作る関数です。表は
インスタンスごとに持つので、1 つのページにある 2 つの地図で別々の言語を
使えます。ロケールの自動判定は行いません。

ライブラリーが新しい地物、レイヤー、グループに付ける名前の語
(`Layer 1`) は、この表には含まれません。`Options.autoName` で翻訳して
ください ([自動の名前](drawing.ja.md#ほかの言語の名前))。

## 関連する例

- [style-rules](../../examples/style-rules/) では、レイヤーに
  各種類の規則を設定し、`deriveLegend` で凡例を組み立て、`Options.style`
  と `Options.messages` を設定します

## リファレンス

- [`FeatureStyle`](../reference/api/interfaces/index.FeatureStyle.html)
- [`StyleRule`](../reference/api/types/index.StyleRule.html)
- [`deriveLegend`](../reference/api/functions/index.deriveLegend.html)
  と [`LegendEntry`](../reference/api/interfaces/index.LegendEntry.html)
- [`evaluateStyleRule`](../reference/api/functions/index.evaluateStyleRule.html)
  と
  [`resolveFeatureStyle`](../reference/api/functions/index.resolveFeatureStyle.html)
- [`FeatureStyleConfig`](../reference/api/interfaces/index.FeatureStyleConfig.html)
- [`Messages`](../reference/api/interfaces/index.Messages.html) と
  [`MESSAGES_EN`](../reference/api/variables/index.MESSAGES_EN.html)
