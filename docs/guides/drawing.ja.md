# 描画と編集

この手引きでは、利用者が地図の上でできることを説明します。6 つの描画
モード、選んだものを移動、拡縮、回転し、頂点を編集する `select` モード、
キーボードとタッチの入力、Multi の形状と穴、コードから地物を作る方法、
新しい地物に付く名前を扱います。

コード例では、[はじめかた](../getting-started.ja.md) のとおりに作った
`draw` があるものとします。

## 最小のコード

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map);

// クリックで頂点を足し、Enter か最初の頂点のクリックで終える
draw.setMode('draw_polygon');

draw.on('feature.created', ({ feature }) => {
  console.log(feature.type, feature.properties.name);
});

draw.on('mode.changed', ({ mode }) => {
  console.log('mode', mode); // 多角形を描き終えると 'select'
});
```

多角形を描き終えると、新しい地物が選ばれた状態でモードが
`select` になります。利用者はそのまま移動したり形を変えたりできます。

## モード

組み込みのモードは 7 つあり、`MODES` に並んでいます。既定は `select`
です (`defaultMode` の設定)。

| モード | 作るもの | 操作 |
| --- | --- | --- |
| `select` | なし | 選択、移動、拡縮、回転、頂点の編集 |
| `draw_point` | `Point` | 1 回クリック |
| `draw_line` | `LineString` | 何度かクリックして終える |
| `draw_polygon` | `Polygon` | 何度かクリックして終える |
| `draw_circle` | `Circle` | 中心をクリックし、半径の位置をクリック |
| `draw_freehand` | `Freehand` | ドラッグで 1 本の線を引く |
| `draw_image` | `Image` | アプリケーションがファイルを選ぶ (後述) |

`draw.setMode(mode)` は、呼んだ後のモードが `mode` なら `true` を返し
ます。操作ロック中に描画モードを指定したときと、書き込めるレイヤーが
無いとき (すべてのレイヤーがロックか非表示のとき。
[レイヤーとグループ](layers.ja.md) を参照) に描画モードを指定したときは、
`false` を返し、何も変わりません。モードの無い名前を渡すと、コード
`not-found` の `DrawError` を投げます。

今のモードは `draw.getMode()` で読めます。モードが変わるたびに、
`mode.changed` が前のモードと合わせて届きます。独自のモードは
`draw.extensions.modes.add` で足します ([プラグイン](plugins.ja.md))。

## 描画モード

描画モードのときに各入力で何が起きるかを表にまとめます。「破棄」は、
描きかけの形を捨ててそのモードに留まることです。何も描いていないとき
だけ、そのキーで `select` に戻ります。

| モード | 頂点を足す | 終える | Escape | Backspace |
| --- | --- | --- | --- | --- |
| `draw_point` | クリック | そのクリック | select へ | - |
| `draw_line` | クリック | Enter、最後の頂点 | 破棄 | 最後の頂点 |
| `draw_polygon` | クリック | Enter、最初の頂点 | 破棄 | 最後の頂点 |
| `draw_circle` | クリック、移動 | 2 回目のクリック | 破棄 | - |
| `draw_freehand` | ドラッグ | 離す | 破棄 | - |

- 線は頂点が 2 つ、多角形は 3 つ揃ってから、Enter か、最後 (線) または
  最初 (多角形) の頂点のクリックで終わります。その頂点の上ではカーソルが
  ポインターに変わります
- Backspace と Delete は、線や多角形で最後に置いた頂点を削除します
- 円の半径は中心とポインターの距離で決まり、半径が 1 m 以上になると
  2 回目のクリックで終わります
- 線、多角形、円を描いている途中で別のモードに切り替えると、描きかけの
  形は捨てられます
- 描画中のダブルクリックは 2 回のクリックとして扱い、地図はズームしません
- 描画モードに入ると選択が解除されます

描いている途中の形は、`previewStyle` の設定で表示します。キーは地物の
スタイルと同じで、線のキーが線と頂点の縁を、点のキーが頂点を決めます。

```ts
draw.options.update({
  previewStyle: { strokeColor: '#e11d48', strokeWidth: 2, pointRadius: 5 },
});
```

### 描き終えた後

点、線、多角形、円は、その選択と合わせて 1 つの取引で作られ、新しい
地物が選ばれた状態で `select` に戻ります。`feature.created` と
`selection.changed` が届き、変更の全体について `document.changed` が
1 回届きます。

フリーハンドは違います。1 本の線 (押す、ドラッグする、離す) ごとに 1 つの
地物になり、続けて線を引けるようにモードは `draw_freehand` の
ままで、新しい地物は選ばれません。線を引いている途中で 2 本目の
指が触れたときや、ブラウザーがタッチを取り消したときは、その線を捨て
ます。

描いた地物には `properties['maplibre-gl-draw:createdZoom']` (描いたときの
ズーム) が付き、線の太さが地図に合わせて変わります
([スタイル](styles.ja.md) を参照)。画面上の太さを保ちたいアプリケー
ションは、インスタンスを `scaleWithZoom: false` で作ります。そのときは、
コードから作った地物と同じく、描いた地物にも基準のズームが付きません。

自動の名前が有効なら、描いた地物には `properties.name` も付きます。
新しい地物はアクティブなレイヤーに入ります。アクティブなレイヤーが
ロックされているか非表示なら、書き込める最初のレイヤーに入ります。

### 画像

ライブラリーはファイルのダイアログを開きません。`draw_image` に入ると、
地図の中心、ズーム、画像を置くレイヤーを載せた `image.requested` を
出し、すぐに `select` に戻ります。アプリケーションは自前のファイル選択を
表示し、選ばれたファイルを `draw.document.load` に渡します。

```ts
draw.on('image.requested', ({ lngLat, zoom, layerId }) => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    await draw.document.load(file, { coordinate: lngLat, zoom, layerId });
  });
  input.click();
});

draw.setMode('draw_image');
```

画像は `coordinate` を中心に置かれ、WebP に変換されます (一辺が 4096 px
を超えると縮小します)。変換した画像は文書のファイルとして 1 度だけ保存
され、地物はそれを参照します。新しい地物は選ばれた状態に
なります。複数の Image 地物が、保存した 1 つのファイルを共有
できます。

ライブラリーは、地図にドロップされたファイルを受け取りません。ドロップ
された画像をその位置に置くには、アプリケーションがドロップを受け、その
位置を付けて `draw.document.load` を呼びます
([保存と読み込み](save-load.ja.md) を参照)。

## 選択と編集

`select` モードでは、地物をクリックすると選ばれ、何も無い所を
クリックすると選択が解除されます。選んだ地物には、枠と、その型が
対応しているハンドルが表示されます。

| 型 | 移動 | 頂点 | 中点 | 四隅 | 回転 |
| --- | --- | --- | --- | --- | --- |
| `Point` | 可 | - | - | - | - |
| `LineString`、`Polygon` | 可 | 可 | 可 | 可 | 可 |
| `MultiLineString`、`MultiPolygon` | 可 | 可 | 可 | 可 | 可 |
| `MultiPoint` | 可 | 可 | - | 可 | 可 |
| `Circle` | 可 | - | - | 可 | - |
| `Freehand` | 可 | - | - | 可 | 可 |
| `Image` | 可 | - | - | 可 | 可 |

各部分をドラッグしたときの動きは次のとおりです。

| 部分 | ドラッグしたとき |
| --- | --- |
| 地物か、その枠の内側 | 地物を移動します |
| 頂点のハンドル | その頂点を移動します |
| 中点のハンドル | そこに頂点を挿入して移動します |
| 四隅のハンドル | 対角の隅を基準に拡縮します |
| 回転のハンドル | 枠の中心の周りに回転します |
| 半径のハンドル (`Circle`) | 中心を固定して半径を変えます |

- 四隅をドラッグすると、円の半径と中心が一緒に変わります。半径の
  ハンドルは中心を保ち、自分の角度
  (`maplibre-gl-draw:radiusHandleAngle`) を覚えています
- 画像は軸ごとではなく全体で拡縮します (`maplibre-gl-draw:scale`)
- 点は画面上で一定の大きさなので、枠だけが表示されます
- 中点のハンドルは、描かれた辺の上の、経度で真ん中の位置に置かれます
- 地球儀の表示でも、2 つの頂点を結ぶ辺はメルカトルの地図と同じ道筋を
  たどります (緯線は緯線のままです)。地図のレイヤーと同じです。塗り、
  縁、枠、ハンドル、当たり判定がこの道筋にそろいます
- 座標が 1 つだけの地物 (1 点の `MultiPoint`) には頂点の
  ハンドルが出ますが、四隅と回転のハンドルは出ません
- 1 回のドラッグは 1 つの変更になります。ドラッグの間は
  `intermediate: true` の `feature.updated` が届き、離したときに最後の
  状態が書き込まれます。`drag.started` と `drag.ended` が始まりと終わりを
  知らせます
- ロックされた地物は選べますが、ハンドルが出ず、動きません
  ([レイヤーとグループ](layers.ja.md))

枠とハンドルの色や大きさは `selectionStyle` の設定で決めます。頂点が
とても多い線や多角形では、ハンドルを画面上で間引きます。
[性能](performance.ja.md) を参照してください。

### 頂点

頂点のハンドルをクリックするとその頂点が選ばれ、Shift+クリックで同じ
地物の別の頂点を選択に足したり外したりできます。Delete か
Backspace で、選んだ頂点を削除します。コードからは
`draw.vertexSelection` で同じことができます。

```ts
draw.vertexSelection.set(featureId, [{ ring: 0, index: 2 }]);
draw.vertexSelection.get(); // { featureId, vertices: [...] }
const removed = draw.vertexSelection.delete();
```

頂点は `VertexRef` (`{ part?, ring, index }`) で指定します
([Multi の形状と穴](#multi-の形状と穴) を参照)。ロックされた地物では
`set` が `false` を返します。変わるたびに `vertexSelection.changed` が
届きます。頂点を削除しても、地物自体は消えません。

- 線は少なくとも 2 点を保ちます
- 多角形のリングは少なくとも 4 つの位置 (閉じた三角形) を保ちます。
  判定はリングごとで、閉じるための位置は最初の位置に合わせて動きます
- `MultiPoint` では頂点 1 つが 1 つのパートで、最後のパートは残ります
- ほかの Multi の型では判定がパートとリングごとなので、あるパートが
  最小の数になっていても、別のパートの頂点は削除できます

頂点のドラッグには吸着が効き、隣の地物と共有している頂点を
まとめて動かせます。[吸着と幾何演算](snapping-geometry.ja.md) を
参照してください。

### 複数選択

| 入力 | 結果 |
| --- | --- |
| 地物を Shift+クリック | 選択に足すか、選択から外します |
| 地図を Shift+ドラッグ | 矩形選択 |
| 選択中の地物をクリック | その地物だけを選びます |
| 別の地物をクリック | 代わりにその地物を選びます |
| 何も無い所をクリック | 選択を解除します |

矩形選択では、形が矩形と交わる地物が選ばれます (点は座標で、
画像は回転を含めた枠で判定します)。それまでに選択があった場合は、矩形の
中の各地物の選択が反転します。ドラッグ中に Escape を押すと、
選択が元に戻ります。ロックされた地物と非表示の地物は
矩形選択では選ばれません。

複数を選ぶと、全体を囲む 1 つの枠と、四隅と回転のハンドルが表示されます。
枠の内側をドラッグすると、すべての地物が同じ量だけ動きます。
四隅をドラッグすると、対角の隅を基準に、それぞれの規則ですべてを拡縮
します (形状は座標を、画像は拡縮率を、点は位置だけを変えます)。回転の
ハンドルでは、枠の中心の周りに回転します (点のマーカーは正立を保ちます)。

タッチ画面には Shift キーが無いので、矩形選択と Shift+クリックは使えま
せん。自前の操作を用意して `draw.selection.set` や
`draw.selection.add` を呼んでください。

```ts
draw.selection.set('feature', [featureId]);
draw.selection.add([feature.id]);
const selected = draw.selection.features();
```

選択は一度に 1 種類のものを持ち、グループやレイヤーも選べます
(`draw.selection.set('group', [groupId])`)。`selection.features()` は、
選んだ地物か、選んだグループやレイヤーの中の地物を返します。
`selection.delete()` は選んでいるものを削除します。選択が変わるたびに、
前の選択と合わせて `selection.changed` が届きます。

## キーボード

ショートカットは地図のキャンバスで受け取ります。地図を押すとキャンバスが
(ページをスクロールせずに) キーボードのフォーカスを得るので、クリック
した直後から効きます。`select` モードでは次のキーが使えます。

| キー | 動作 |
| --- | --- |
| Delete / Backspace | 選んだ頂点を削除し、無ければ選択を削除します |
| Escape | ドラッグを取り消し、無ければ頂点、その次に選択を解除します |
| 矢印キー | 選択を 1 px 動かします (Shift で 10 px) |
| Cmd/Ctrl+G | 選択をグループにします |
| Shift+Cmd/Ctrl+G | グループを解除します |

矢印キーは、選んだ地物を画面上でその距離だけ、1 つの変更として
動かします。選んだ地物がロックされているとき、読み取り専用の
とき、操作ロック中は何も動きません。そのときと、何も選んでいないときは、
キーが地図に渡り、地図がパンします。地物をダブルクリックしても
地図はズームしません。

ウィンドウがフォーカスを失うと、ドラッグは書き込まれずに終わります。
ページの外でボタンを離した場合は、ポインターが最後にあった位置で離した
ものとして扱います。

## タッチとペン

対応している入力は、マウス、キーボード、1 本の指、ペンです。1 本の指は
マウスの左ボタンと同じ操作をします。描画、移動、頂点の編集、回転、拡縮、
フリーハンドの線がそうです。長押しはコンテキストメニューのイベントに、
素早い 2 回のタップはダブルクリックになります。2 本以上の指のジェス
チャーは地図の操作 (パン、ズーム、回転) に使われ、ドラッグ中に 2 本目の
指が触れるとドラッグは取り消されます。

ペンは、ブラウザーが報告するイベントの種類のまま扱います。モードと
プラグインが受け取るポインターのイベント (`DrawPointerEvent`) には
`pointerType` (`'mouse'`、`'touch'`、`'pen'`) が入っています。

## Multi の形状と穴

描画モードが作るのは単一の形状で、多角形は外側のリングだけで描きます。
`MultiPoint`、`MultiLineString`、`MultiPolygon` と穴のある多角形は、
次の方法で作られます。

- GeoJSON の `draw.document.load` (Multi の形状は保たれます。
  `flattenMulti: true` で単一の地物に分けられます)
- 幾何演算 (離れた多角形を結合すると `MultiPolygon` になり、内側を
  型抜きすると穴になります。[吸着と幾何演算](snapping-geometry.ja.md))
- 形状を渡した `draw.features.create`

これらも単一の形状と同じように描画、当たり判定、編集ができます。どの
パートをクリックしても地物全体が選ばれ、枠はすべてのパートを
囲み、各パートと各リングにそれぞれ頂点と中点のハンドルが付きます。

| 型 | `part` | `ring` | `index` |
| --- | --- | --- | --- |
| `LineString` | 0 | 0 | 線の中の位置 |
| `Polygon` | 0 | 0 は外側、1 以降は穴 | リングの中の位置 |
| `MultiPoint` | 位置 | 0 | 0 |
| `MultiLineString` | 線 | 0 | 線の中の位置 |
| `MultiPolygon` | 多角形 | その多角形のリング | リングの中の位置 |

`part` は 0 のときは省略できます。

## コードから地物を作る

`draw.features.create` は型と GeoJSON の形状を受け取り、保存したとおりの
地物を返します。フォームに入力された座標、距離と方位から求めた位置、
自動化、テストに使えます。

```ts
import { destination } from '@sakuzu/maplibre-gl-draw/geometry';

const start = [139.7, 35.68];
const line = draw.features.create({
  type: 'LineString',
  geometry: {
    type: 'LineString',
    coordinates: [start, destination(start, 500, 90)], // 東へ 500 m
  },
  properties: { name: 'Survey line' },
});
if (line) draw.selection.set('feature', [line.id]);
```

- `layerId` か `groupId` で指定しない限り、地物はアクティブなレイヤーに
  入ります。コードから作る地物は、利用者が描き込めないロック中や非表示の
  レイヤーにも入れられます
- 読み取り専用のあいだ、`create` は `null` を返します。入力が誤って
  いれば `DrawError` を投げ、何も作りません
- 円は中心を表す `Point` の形状で、半径は
  `properties['maplibre-gl-draw:radiusMeters']` に入れます
- コードから作った地物には自動の名前も基準のズームも付かず、モードも
  選択も変わりません
- `createMany` は複数の地物を 1 つの取引で作ります

```ts
draw.features.create({
  type: 'Circle',
  geometry: { type: 'Point', coordinates: [139.7, 35.68] },
  properties: { 'maplibre-gl-draw:radiusMeters': 250 },
});
```

組み込みのモードと同じ規則 (書き込めるレイヤー、自動の名前、基準の
ズーム) で描く道具は、独自のモードとして作り、`commitFeature` で地物を
作ります ([プラグイン](plugins.ja.md))。

## 自動の名前

新しい地物、レイヤー、グループには、型ごとの連番の名前が付き
ます。`Point 1`、`LineString 1`、`Polygon 1`、`Circle 1`、`Freehand 1`、
`Image 1`、`Layer 1`、`Group 1` のような名前です。独自の地物の型では、
型の名前を語として使います。

番号は使い回しません。`Point 1` と `Point 2` の後で `Point 2` を削除して
もう一度描くと、`Point 3` になります。読み込みやコードで文書に入って
きた名前も数に入ります。

```ts
const draw = createDraw(map, {
  autoName: {
    typeNames: { Point: 'Pin', Layer: 'Sheet' },
    formatter: (typeName, n) => `${typeName} #${n}`,
  },
});
```

`autoName: false` にすると名前を付けません。その場合、新しい
地物は `name` を持ちません。レイヤーとグループには必ず名前があるので、
名前を指定せずに作ったものには型の語だけが付きます (`Layer`、または
指定した `typeNames.Layer`)。この設定は、インスタンスを動かしたまま
`draw.options.update` で変えられます。

### ほかの言語の名前

自動で付ける名前の語は、すべてこの 1 つの設定から取られます。既定は
英語です。ライブラリーはこの語を翻訳しません。また、この語は
`messages` の設定 ([スタイル](styles.ja.md)) には含まれません。ほかの
言語で表示するアプリケーションは、使う型ごとの語を `typeNames` に
渡してください。キーは型の名前で、`Point`、`LineString`、`Polygon`、
`Circle`、`Freehand`、`Image`、`Layer`、`Group` と、描画に使う独自の
地物の型の名前です。

```ts
const draw = createDraw(map, {
  autoName: {
    typeNames: {
      Point: 'ポイント',
      LineString: 'ライン',
      Polygon: 'ポリゴン',
      Circle: '円',
      Freehand: 'フリーハンド',
      Image: '画像',
      Layer: 'レイヤー',
      Group: 'グループ',
    },
  },
});
```

名前は作ったときに文書へ書き込まれるので、作ったときの言語のまま
残ります。

## 日付変更線の近く

経度は [-180, 180] の範囲を前提としています。日付変更線の近くでは、
反対側の地物を線の隣に描きます。ただし、低ズームで表示が経度 360 度以上に
広がると、地物は世界の複製ごとではなく 1 回だけ描かれ、矩形選択は線を
またぎません。

## アクセシビリティー

描画と編集は地図のキャンバスへのポインター入力で操作し、ライブラリーは
ARIA のロールもラベルも付けません。キーボードでは、削除、矢印キーでの
移動、グループ化、取り消しができます。`draw.features.create` を使うと、
アプリケーションでフォームなどの座標を入力する別の手段を用意できます。

## 関連する例

- [basic](../../examples/basic/) では、多角形を描き、
  `feature.created` と `document.changed` を受け取り、GeoJSON を
  保存します

## リファレンス

- [`Draw`](../api/maplibre-gl-draw/interfaces/Draw.md) (`setMode`、
  `getMode`)
- [`Mode`](../api/maplibre-gl-draw/type-aliases/Mode.md) と
  [`MODES`](../api/maplibre-gl-draw/variables/MODES.md)
- [`FeaturesCollection`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md)
  と [`FeatureInput`](../api/maplibre-gl-draw/interfaces/FeatureInput.md)
- [`SelectionResource`](../api/maplibre-gl-draw/interfaces/SelectionResource.md)
  と
  [`VertexSelectionResource`](../api/maplibre-gl-draw/interfaces/VertexSelectionResource.md)
- [`VertexRef`](../api/maplibre-gl-draw/interfaces/VertexRef.md)
- [`AutoNameOptions`](../api/maplibre-gl-draw/interfaces/AutoNameOptions.md)
- [`SelectionStyleOptions`](../api/maplibre-gl-draw/interfaces/SelectionStyleOptions.md)
  と [`RuntimeOptions`](../api/maplibre-gl-draw/interfaces/RuntimeOptions.md)
  (ハンドルと描いている途中の形の色と大きさ)
- [イベント](../reference/events.md)
