# スタイル

地物の見た目は 3 つのところから決まります。地物自身の
`style`、そのレイヤーのスタイル規則、インスタンスの既定値です。この
手引きでは、それぞれの設定、それらが適用される順番、規則から得られる
凡例、ライブラリーが返す文字列 (ホストが自分の言語に差し替えられます) を
説明します。

## 最小のコード

```ts
await draw.write(async (tx) => {
  // レイヤーの地物を属性で塗り分ける
  await tx.layers.update(layerId, {
    styleRule: {
      kind: 'categorical',
      property: 'landuse',
      map: { park: '#4caf50', water: '#2196f3' },
      other: '#9e9e9e',
    },
  });

  // 1 つの地物は規則によらず自分の色を保つ
  await tx.features.update(featureId, {
    properties: { 'maplibre-gl-draw:style': { fillColor: '#ff9800' } },
  });
});
```

規則はレイヤーを描くときに評価されるので、`landuse` が変わった
地物は、スタイルに触れなくてもすぐに新しい色になります。

## 地物自身のスタイル

地物は自分のスタイルを `properties['maplibre-gl-draw:style']` に
`FeatureStyle` として持ち、`readFeature(feature).style` で読めます
(無ければ `{}` です)。どのキーも省略でき、省略したキーには規則の色か
既定値が使われます。

| 型 | キー |
| --- | --- |
| 点 | `pointColor`、`pointRadius`、`pointShape`、`pointOpacity` |
| 点の縁 | `pointStrokeColor`、`pointStrokeWidth` |
| 線 | `strokeColor`、`strokeOpacity`、`strokeWidth`、`lineStyle` |
| 面 | 線のキー、`fillColor`、`fillOpacity` |
| `Image` | `imageOpacity` |

点は `Point` と `MultiPoint`、線は `LineString`、`MultiLineString`、
`Freehand`、面は `Polygon`、`MultiPolygon`、`Circle` です。点の印の縁は
`pointStrokeColor` (既定は白) と `pointStrokeWidth` (既定は 2) で、
`strokeColor` と `strokeWidth` は線と面の縁だけに使われます。

```ts
await draw.write((tx) =>
  tx.features.create({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [139.7, 35.68],
        [139.71, 35.69],
      ],
    },
    properties: {
      'maplibre-gl-draw:style': {
        strokeColor: '#1e88e5',
        strokeWidth: 4,
        lineStyle: 'dashed',
      },
    },
  }),
);
```

`tx.features.update` は、スタイルをキーごとに併合します。渡したキーだけが
変わり、ほかのキーはそのまま残ります。`unset.style` に書いたキーは消え、
その地物には規則の色か既定値がまた使われます。`undefined` を渡したキーは
受け付けません (`invalidInput`)。

```ts
// 太くし、色は規則の色に戻す
await draw.write((tx) =>
  tx.features.update(featureId, {
    properties: { 'maplibre-gl-draw:style': { strokeWidth: 6 } },
    unset: { style: ['strokeColor'] },
  }),
);
```

- 色は CSS の色 (`#1e88e5`、`rgb(30 136 229)`、`hsl(...)`、`tomato`)
  で、不透明度は 0 から 1 です。型や形の合わない値は、書き込みをコード
  `invalidInput` の `DrawError` で reject します
- `parseCssColor(value)` は、ライブラリーと同じ読み方で色を読み、
  0 から 1 の `[red, green, blue, alpha]` を返します。ライブラリーが色と
  して受けない値には `null` を返します。拡張は、自分のスタイルの鍵の色を
  これで確かめ、自分のシェーダーで描く色もこれで読みます。そうすると、
  ライブラリーと同じ色を受けて同じ色で描けます
- `lineStyle` は `solid`、`dashed`、`dotted` のどれかです
- `strokeWidth` は、地物を描いたときのズーム、つまり基準のズーム
  (プロパティー `maplibre-gl-draw:createdZoom`) での幅をピクセルで
  表します。その後は印刷した地図に描いた線のように、形と同じく地図に
  合わせて太くなったり細くなったりします。細さに下限はありません。
  1 ピクセルより細くなると、細くする代わりに薄く描くので、地図を引くと
  消えていきます
- 描画モードは、オプション `scaleWithZoom` が `false` のとき以外は
  基準のズームを書きます。基準のズームを持たない地物
  (`tx.features.create` で作った地物や、このオプションを切って描いた地物)
  は、どのズームでも画面上のピクセルでの幅を保ちます
- 点は、どのズームでも画面上の大きさを保ちます
- `pointShape` は `circle`、`square`、`triangle`、`star` のどれかで、
  既定値の形より優先されます。そのため、1 つのインスタンスの中で
  点の形を混ぜられます。当たり判定は、形によらず、その形を囲む円で
  行います
- ロックされた地物はスタイルを変えられず、書き込みは `locked` で
  reject します ([レイヤーとグループ](layers.ja.md))
- `FeatureStyle` が定めていないキーも、検査せずにそのまま保ち、保存し、
  読み込みます。そのため、拡張は自分のキーを入れておけます。そのキーを
  読むコードが値を確かめます

## 既定値

自分のスタイルを持たない地物の見た目は、インスタンスのオプション
`style` で設定します。種類ごとに 1 つの `FeatureStyle` を渡します。
種類は `point`、`line`、`polygon`、`circle`、`image` です。省略した
キーは組み込みの既定値のままです。独自の型は、その代わりに自分の地物の
見た目を宣言できます (`defaultStyle`。
[独自の型](custom-types.ja.md#型の見た目) を参照)。型が書かなかった
キーは、ここの既定値のままです。

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
    selectionRectangle: {
      fillColor: '#ff6f00',
      fillOpacity: 0.1,
      strokeColor: '#ff6f00',
      strokeWidth: 1,
    },
  },
});
```

- `previewStyle` は描いている途中の形の見た目です。線のキーはその線に、
  点のキーはその頂点に、塗りのキーはその塗りに使われます。頂点の輪郭は
  `pointStrokeColor` と `pointStrokeWidth` です。形を描く下書きは、
  その上に自分の見た目を重ねられます (下を参照してください)
- `selectionStyle` は、選択を囲む枠とそのハンドル (拡縮、回転、頂点、
  中点、半径のハンドル、円の中心、矩形選択の矩形) の見た目です。渡した
  部分は、その部分の既定値を置き換えるので、部分ごとにすべての項目を
  渡してください。色は CSS の色、大きさは CSS ピクセルです
- ハンドル、線、点の枠は、画面の上の大きさを保ちます。ハンドルはどの
  傾きでも渡した大きさでその位置に描かれ、点の枠は画面の上で印を
  囲みます。広がりのある地物の枠の余白 (`box.margin`) と回す
  ハンドルの距離 (`rotateHandle.distance`) は、地図の上に置かれます。
  どちらも、今の表示の縮尺 (`ScreenContext.metersPerPixel`) で地物の
  所の地面の長さ (メートル) に直されるので、枠とハンドルは地図と一緒に
  傾いて回り、地図の上の場所を保ちます。傾けていない地形の無い Web
  メルカトルの地図では、渡したピクセルのとおりです。傾けると地図と同じ
  ように縮んで見え (地平線に近いほど短く)、地球儀では表示の中心で渡した
  ピクセルになり、端に近いほど短くなります。地形の上では地面に沿います
- `circle` を省略すると `polygon` が使われます。`image` が受け取るのは
  `imageOpacity` だけです

どれもインスタンスの動作中に変えられます。`options.update` は、渡した
値をすでに設定されている値に併合します。

```ts
draw.options.update({ style: { polygon: { fillOpacity: 0.4 } } });
draw.options.update({ scaleWithZoom: false });
```

値を変えた更新の後には、`draw.options` が設定をまた知らせます
(`draw.options.subscribe`)。設定を表示する UI は、これで追随できます
([イベントのリファレンス](../reference/events.md#drawoptions) (英語)
を参照してください)。

形を描く `draw.sketches` の下書き (`placedVertexCount` のある編集
`create`) は、自分の `previewStyle` を持てます。その下書きの形にだけ、
設定の上に重ねて使われます。置いた頂点を結ぶ線にはすべての線のキーが
使われます。ポインターへの線と最初の頂点へ戻る線には色、幅、不透明度が
使われ、破線のままです。これで、同時に描く 2 つの形を見分けられます。
たとえば、提案の形を灰色の破線で見せたり、面の 2 つの候補を色で
分けたりできます。

```ts
const proposal = draw.sketches.add({
  edits: [
    {
      kind: 'create',
      feature: {
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [139.76, 35.68],
            [139.77, 35.69],
          ],
        },
      },
      placedVertexCount: 1,
    },
  ],
  previewStyle: { strokeColor: '#888888', lineStyle: 'dashed' },
});
if (proposal) {
  draw.sketches.update(proposal.id, { previewStyle: { strokeColor: '#1e88e5' } });
}
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
await draw.write(async (tx) => {
  await tx.layers.update(layerId, {
    styleRule: {
      kind: 'graduated',
      property: 'population',
      breaks: [1000, 5000, 10000],
      colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#2171b5'],
      other: '#cccccc',
    },
  });

  await tx.layers.update(otherLayerId, {
    styleRule: {
      kind: 'continuous',
      property: 'height',
      min: 0,
      max: 300,
      ramp: ['#fff5eb', '#7f2704'],
      other: '#cccccc',
    },
  });
});

// 規則を外す
await draw.write((tx) => tx.layers.update(layerId, { styleRule: undefined }));
```

- 規則の色は CSS の色で書きます。`evaluateStyleRule` と `deriveLegend` は
  `#rrggbb` にそろえて返します
- `categorical` は、文字列、数値、真偽値を文字列にしたもの
  (`String(value)`) を `map` のキーと照らし合わせます
- `graduated` は、昇順に並んだ n 個の `breaks` と n + 1 個の `colors` を
  取ります。`breaks[i]` 未満の値には `colors[i]` が、どの境界値未満でも
  ない値には最後の色が使われます
- `continuous` は、`ramp` の 2 色を `min` から `max` まで OKLab 色空間で
  混ぜるので、中間の色が濁りません。範囲外の値には、近い方の端の色が
  使われます
- `styleRule` はレイヤーの普通の項目です。文書と一緒に保存され、変更は
  ほかの変更と同じように `change` の `layers.updated` で届きます

データセットでも同じ型の規則を使えます。
[大量のデータを表示する](large-data.ja.md) を参照してください。

## どの色が使われるか

1. 地物自身の、そのチャンネルの色。点は `pointColor`、線は
   `strokeColor`、面と画像は `fillColor` です。独自の型は、宣言した
   チャンネル (`styleRuleChannel`) か、それが無ければ定義の幾何の
   チャンネルです
2. レイヤーの規則
3. 地物の独自の型が宣言した見た目 (`defaultStyle`)、その次に
   インスタンスの既定値

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

`features.getAppliedStyle(id)` は、文書の地物の値のとおりの見た目を、
すべてのキーを埋めて返します (`style.circle` と `style.image` の既定と、
独自の型が宣言した見た目も含みます)。インスペクターのパネルに表示する
ときに使えます。下書きは当たりません。独自の型の描画器は、描く地物に
下書きを当てた見た目を、同じ組み立て方で描く文脈から読みます
(`ctx.appliedStyle(feature)`)。

```ts
const look = draw.features.getAppliedStyle(featureId);
if (look) console.log(look.fillColor, look.strokeWidth, look.lineStyle);
```

`style` オプションと地物のスタイルの色は、渡した文字列のまま、アルファも
含めて返ります。規則の色は `#rrggbb` で返ります。

評価の処理は純関数としても公開しているので、表の行を地図と同じ色で塗る
など、ほかの用途にも使えます。色が入る見た目の部分は、独自の型を知って
いるインスタンスが答えます。`draw.extensions.featureTypes.getStyleRuleChannel(type)`
は、組み込みの型には種類のチャンネルを、独自の型には宣言したチャンネル
(`styleRuleChannel`) か、それが無ければ定義の幾何のチャンネルを返します。
ライブラリーが塗るのと同じ判定です。

<!-- docs-check:
declare const rule: import('@sakuzu/maplibre-gl-draw').StyleRule;
-->

```ts
import { evaluateStyleRule } from '@sakuzu/maplibre-gl-draw';

const color = evaluateStyleRule(rule, feature.properties);
// 'point'、'stroke'、'fill' のどれか
const channel = draw.extensions.featureTypes.getStyleRuleChannel(feature.type);
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

拡張は同じ表に自分の鍵を足すので、オプション `messages` はそれも
翻訳します ([プラグインの文言](plugins.ja.md#プラグインの文言))。

ライブラリーが新しい地物、レイヤー、グループに付ける名前の語
(`Layer 1`) は、この表には含まれません。オプション `autoName` で翻訳して
ください ([描画と編集](drawing.ja.md))。

## 関連する例

- [Style features](../examples/style-features.ja.md) では、地物ごとに
  スタイルを付けて並べて比べ、型の既定値を変えます
- [Style rules and legend](../examples/style-rules-and-legend.ja.md)
  では、レイヤーに各種類の規則を設定し、その行を標準の UI の凡例に
  出します
- [Zoom and scale](../examples/zoom-and-scale.ja.md) では、地物の
  基準のズームを決め、ズームに従う太さと画面の上で固定した太さを
  比べ、`scaleWithZoom` を切り替えます

## リファレンス

- [`FeatureStyle`](../api/maplibre-gl-draw/interfaces/FeatureStyle.md)
  と
  [`FeatureStyleResolved`](../api/maplibre-gl-draw/type-aliases/FeatureStyleResolved.md)
- [`StyleRule`](../api/maplibre-gl-draw/type-aliases/StyleRule.md)
- [`deriveLegend`](../api/maplibre-gl-draw/functions/deriveLegend.md)
  と [`LegendEntry`](../api/maplibre-gl-draw/interfaces/LegendEntry.md)
- [`evaluateStyleRule`](../api/maplibre-gl-draw/functions/evaluateStyleRule.md)
  と
  [`FeatureTypesCollection.getStyleRuleChannel`](../api/maplibre-gl-draw/interfaces/FeatureTypesCollection.md#getstylerulechannel)
- [`parseCssColor`](../api/maplibre-gl-draw/functions/parseCssColor.md)
- [`RuntimeOptions`](../api/maplibre-gl-draw/interfaces/RuntimeOptions.md)
  (`style`、`previewStyle`、`selectionStyle`、`scaleWithZoom`、
  `messages`) と
  [`SelectionStyleOptions`](../api/maplibre-gl-draw/interfaces/SelectionStyleOptions.md)
- [`Messages`](../api/maplibre-gl-draw/interfaces/Messages.md)
