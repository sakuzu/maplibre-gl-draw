# スタイル

地物の見た目は 3 つのところから決まります。地物自身の
`style`、そのレイヤーのスタイル規則、インスタンスの既定値です。この
手引きでは、それぞれの設定、それらが適用される順番、規則から得られる
凡例、ライブラリーが返す文字列 (ホストが自分の言語に差し替えられます) を
説明します。

## 最小のコード

```ts
// レイヤーの地物を属性で塗り分ける
draw.layers.update(layerId, {
  styleRule: {
    kind: 'categorical',
    property: 'landuse',
    map: { park: '#4caf50', water: '#2196f3' },
    other: '#9e9e9e',
  },
});

// 1 つの地物は規則によらず自分の色を保つ
draw.features.update(featureId, { style: { fillColor: '#ff9800' } });
```

規則はレイヤーを描くときに評価されるので、`landuse` が変わった
地物は、`style` に触れなくてもすぐに新しい色になります。

## 地物自身のスタイル

`Feature.style` は `FeatureStyle` です。どのキーも省略でき、省略した
キーには規則の色か既定値が使われます。

| 型 | キー |
| --- | --- |
| 点 | `pointColor`、`pointRadius`、`pointShape`、`pointOpacity` |
| 線 | `strokeColor`、`strokeOpacity`、`strokeWidth`、`lineStyle` |
| 面 | 線のキー、`fillColor`、`fillOpacity` |
| `Image` | `imageOpacity` |

点は `Point` と `MultiPoint`、線は `LineString`、`MultiLineString`、
`Freehand`、面は `Polygon`、`MultiPolygon`、`Circle` です。

```ts
draw.features.create({
  type: 'LineString',
  geometry: {
    type: 'LineString',
    coordinates: [
      [139.7, 35.68],
      [139.71, 35.69],
    ],
  },
  style: { strokeColor: '#1e88e5', strokeWidth: 4, lineStyle: 'dashed' },
});
```

`features.update` は、スタイルをキーごとに併合します。渡したキーだけが
変わり、ほかのキーはそのまま残ります。`undefined` を渡したキーは消え、
その地物には規則の色か既定値がまた使われます。

```ts
// 太くし、色は規則の色に戻す
draw.features.update(featureId, {
  style: { strokeWidth: 6, strokeColor: undefined },
});
```

- 色は CSS の色 (`#1e88e5`、`rgb(30 136 229)`、`hsl(...)`、`tomato`)
  で、不透明度は 0 から 1 です。型や形の合わない値は、コード
  `invalid-input` の `DrawError` を投げます
- `lineStyle` は `solid`、`dashed`、`dotted` のどれかです
- `strokeWidth` は、地物を描いたときのズーム、つまり基準のズーム
  (プロパティー `maplibre-gl-draw:createdZoom`) での幅をピクセルで
  表します。その後は紙に描いた線のように、形と同じく地図に合わせて
  太くなったり細くなったりします
- 描画モードは、オプション `scaleWithZoom` が `false` のとき以外は
  基準のズームを書きます。基準のズームを持たない地物
  (`features.create` で作った地物や、このオプションを切って描いた地物)
  は、どのズームでも画面上のピクセルでの幅を保ちます
- 点は、どのズームでも画面上の大きさを保ちます
- `pointShape` は `circle`、`square`、`triangle`、`star` のどれかで、
  既定値の形より優先されます。そのため、1 つのインスタンスの中で
  点の形を混ぜられます。当たり判定は、形によらず、その形を囲む円で
  行います
- ロックされた地物はスタイルを変えられません
  ([レイヤーとグループ](layers.ja.md))
- `FeatureStyle` が定めていないキーも、検査せずにそのまま保ち、保存し、
  読み込みます。そのため、拡張は自分のキーを入れておけます。そのキーを
  読むコードが値を確かめます

## 既定値

自分のスタイルを持たない地物の見た目は、インスタンスのオプション
`style` で設定します。種類ごとに 1 つの `FeatureStyle` を渡します。
種類は `point`、`line`、`polygon`、`circle`、`image` です。省略した
キーは組み込みの既定値のままです。

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map, {
  style: {
    point: { pointColor: 'tomato', pointRadius: 6, pointShape: 'square' },
    line: { strokeColor: '#1e88e5', strokeWidth: 3 },
    polygon: { strokeColor: '#1a3380', fillColor: '#1a3380', fillOpacity: 0.15 },
  },
  previewStyle: { strokeColor: '#ff6f00' },
  selectionStyle: {
    boxSelection: {
      fillColor: '#ff6f00',
      fillOpacity: 0.1,
      strokeColor: '#ff6f00',
      strokeWidth: 1,
    },
  },
});
```

- `previewStyle` は描いている途中の形の見た目です。線のキーはその線と
  頂点の輪郭に、点のキーはその頂点に使われます
- `selectionStyle` は、選択を囲む枠とそのハンドル (拡縮、回転、頂点、
  中点、半径のハンドル、円の中心、矩形選択の矩形) の見た目です。渡した
  部分は、その部分の既定値を置き換えるので、部分ごとにすべての項目を
  渡してください。色は CSS の色、大きさは CSS ピクセルです
- `circle` を省略すると `polygon` が使われます。`image` が受け取るのは
  `imageOpacity` だけです

どれもインスタンスの動作中に変えられます。`options.update` は、渡した
値をすでに設定されている値に併合します。

```ts
draw.options.update({ style: { polygon: { fillOpacity: 0.4 } } });
draw.options.update({ scaleWithZoom: false });
```

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
draw.layers.update(layerId, {
  styleRule: {
    kind: 'graduated',
    property: 'population',
    breaks: [1000, 5000, 10000],
    colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#2171b5'],
    other: '#cccccc',
  },
});

draw.layers.update(otherLayerId, {
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
draw.layers.update(layerId, { styleRule: undefined });
```

- 規則の色は `#rrggbb` で書いてください
- `categorical` は、文字列、数値、真偽値を文字列にしたもの
  (`String(value)`) を `map` のキーと照らし合わせます
- `graduated` は、昇順に並んだ n 個の `breaks` と n + 1 個の `colors` を
  取ります。`breaks[i]` 未満の値には `colors[i]` が、どの境界値未満でも
  ない値には最後の色が使われます
- `continuous` は、`ramp` の 2 色を `min` から `max` まで OKLab 色空間で
  混ぜるので、中間の色が濁りません。範囲外の値には、近い方の端の色が
  使われます
- `styleRule` はレイヤーの普通の項目です。文書と一緒に保存され、変更は
  ほかの変更と同じように `layer.updated` で届きます

データセットでも同じ型の規則を使えます。
[大量のデータを表示する](large-data.ja.md) を参照してください。

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

`features.getAppliedStyle(id)` は、地物が実際に描かれる見た目を、
すべてのキーを埋めて返します。インスペクターのパネルに表示するときに
使えます。

```ts
const look = draw.features.getAppliedStyle(featureId);
if (look) console.log(look.fillColor, look.strokeWidth, look.lineStyle);
```

評価の処理は純関数としても公開しているので、表の行を地図と同じ色で塗る
など、ほかの用途にも使えます。

<!-- docs-check:
declare const rule: import('@sakuzu/maplibre-gl-draw').StyleRule;
-->

```ts
import { evaluateStyleRule, getStyleRuleChannel } from '@sakuzu/maplibre-gl-draw';

const color = evaluateStyleRule(rule, feature.properties);
const channel = getStyleRuleChannel(feature.type); // 'point'、'stroke'、'fill' のどれか
```

## 凡例

`deriveLegend(rule)` は、規則をラベルと色の組に変換します。
ライブラリーは凡例を描かないので、ホストが組み立ててください。

```ts
import { deriveLegend } from '@sakuzu/maplibre-gl-draw';

const layer = draw.layers.get(layerId);
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
説明) は、すべてメッセージの表から取られます。既定は英語で、
ライブラリーに入っている言語はこれだけです。オプション `messages` で、
インスタンスごとに項目を差し替えられます。指定しなかった項目は英語の
既定のままです。

<!-- docs-check:
declare const rule: import('@sakuzu/maplibre-gl-draw').StyleRule;
-->

```ts
import { createDraw, deriveLegend } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map, {
  messages: {
    legendOther: 'Autres',
    legendBelow: (upper) => `Moins de ${upper}`,
  },
});

// 表は後から変えられる
draw.options.update({ messages: { legendAll: 'Tout' } });

// deriveLegend はインスタンスを持たないので、表を引数で受け取る
deriveLegend(rule, { legendOther: 'Autres' });
```

値は文字列か、文字列にした数値から文字列を作る関数です。表は
インスタンスごとに持つので、1 つのページにある 2 つの地図で別々の言語を
使えます。ロケールの自動判定は行いません。

ライブラリーが新しい地物、レイヤー、グループに付ける名前の語
(`Layer 1`) は、この表には含まれません。オプション `autoName` で翻訳して
ください ([描画と編集](drawing.ja.md))。

## 関連する例

- [style-rules](../../examples/style-rules/) では、レイヤーに
  各種類の規則を設定し、`deriveLegend` で凡例を組み立て、オプション
  `style` と `messages` を設定します

## リファレンス

- [`FeatureStyle`](../api/maplibre-gl-draw/interfaces/FeatureStyle.md)
  と
  [`FeatureStyleResolved`](../api/maplibre-gl-draw/type-aliases/FeatureStyleResolved.md)
- [`StyleRule`](../api/maplibre-gl-draw/type-aliases/StyleRule.md)
- [`deriveLegend`](../api/maplibre-gl-draw/functions/deriveLegend.md)
  と [`LegendEntry`](../api/maplibre-gl-draw/interfaces/LegendEntry.md)
- [`evaluateStyleRule`](../api/maplibre-gl-draw/functions/evaluateStyleRule.md)
  と
  [`getStyleRuleChannel`](../api/maplibre-gl-draw/functions/getStyleRuleChannel.md)
- [`RuntimeOptions`](../api/maplibre-gl-draw/interfaces/RuntimeOptions.md)
  (`style`、`previewStyle`、`selectionStyle`、`scaleWithZoom`、
  `messages`) と
  [`SelectionStyleOptions`](../api/maplibre-gl-draw/interfaces/SelectionStyleOptions.md)
- [`Messages`](../api/maplibre-gl-draw/interfaces/Messages.md)
