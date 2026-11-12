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

draw.on('change', ({ features }) => {
  for (const id of features.created) {
    const feature = draw.features.get(id);
    console.log(feature?.geometry.type, feature?.properties.name);
  }
});

draw.mode.subscribe((mode) => {
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

今のモードは `draw.getMode()` で読めます。モードが変わるたびに
`draw.mode` が知らせます (`draw.mode.subscribe`)。独自のモードは
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

- 線は頂点が 2 つ、多角形は 3 つ揃ってから、Enter か、ダブルクリックか、
  最後 (線) または最初 (多角形) の頂点のクリックで終わります。その頂点の上ではカーソルが
  ポインターに変わります
- Backspace と Delete は、線や多角形で最後に置いた頂点を削除します
- 円の半径は中心とポインターの距離で決まり、半径が 1 m 以上になると
  2 回目のクリックで終わります
- 線、多角形、円を描いている途中で別のモードに切り替えると、描きかけの
  形は捨てられます
- 新しい位置でダブルクリックすると、その頂点を 1 つだけ追加してから形を
  終えます。描画中のダブルクリックで地図はズームしません。最後に置いた
  頂点をクリックしても、そこに 2 つ目の頂点は追加されません
- 描画モードに入ると選択が解除されます

描いている途中の形は、`previewStyle` の設定で表示します。キーは地物の
スタイルと同じで、線のキーが線を、点のキーが頂点を決めます。頂点の縁は
`pointStrokeColor` と `pointStrokeWidth` です。

```ts
draw.options.update({
  previewStyle: { strokeColor: '#e11d48', strokeWidth: 2, pointRadius: 5 },
});
```

その形は、この端末の 1 つの `create` の編集を持つ下書き (`draw.sketches`)
です。作られる地物と、モードが渡したときは `placedVertexCount` (始めから
何個の頂点が置かれたか) と `highlightedVertexIndex` (強調して描く頂点) を
持ちます。描いている間は何も書き込まれません。最初の形、変わるたびの形、
終わりを `draw.sketches` が知らせます。地物が作られたとき、捨てられたとき、
モードを離れたときに終わり、一覧から外れます。地図の描画がその変化を
描いたことは、ID なしの `draw.rendered.changed` が知らせます。間引きは
しないので、重い処理をする関数は自分で次に描くときまで待ってください。
描いている途中の長さを表示するのに使います。

```ts
import { length } from '@sakuzu/maplibre-gl-draw/geometry';

draw.sketches.subscribe((sketches) => {
  for (const { edits } of sketches) {
    const edit = edits[0];
    if (edit?.kind !== 'create') continue;
    const { geometry } = edit.feature;
    if (geometry.type === 'LineString') {
      console.log(`${Math.round(length(geometry))} m`);
    }
  }
});
```

### 描き終えた後

点、線、多角形、円は、その選択と合わせて 1 つの取引で作られ、新しい
地物が選ばれた状態で `select` に戻ります。変更の全体について `change` が
1 回届き、新しい地物は `features.created` に入ります。新しい選択は
`draw.selection` が知らせます。

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

ライブラリーはファイルのダイアログを開きません。`draw_image` では、地図を
クリックすると (または `draw.mode.drawing.add` を呼ぶと)、オプション
`requestImage` で、置く位置を添えてアプリケーションに画像を求め、すぐに
`select` に戻ります。アプリケーションは自前のファイル選択を表示して
ファイルを返し、インスタンスはそれをその位置に、アクティブなレイヤーへ、
地図のズームで、1 つの確定として置きます。UI のパッケージの画像の道具は、
押すとすぐに地図の中心を渡すので、ファイル選択がすぐに開きます。

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map, {
  requestImage: (_at, { signal }) =>
    new Promise<Blob>((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) resolve(file);
        else reject(new Error('no file'));
      });
      signal.addEventListener('abort', () => reject(signal.reason));
      input.click();
    }),
});

// 地図の中心に置く画像をいま求める
draw.mode.set('draw_image');
const center = map.getCenter();
draw.mode.drawing.add([center.lng, center.lat]);
```

- `requestImage` が無ければ、画像のモードは何も置きません。動いている
  あいだも `draw.options.update` で替えられます
- `signal` は、インスタンスを外したときと、次の画像を求めたときに要求を
  止めます
- 置けなかった画像 (画像でないファイルなど) は、出どころ `image` の
  `error` イベントで知らせます

画像は WebP に変換されます。ブラウザーが WebP を作れないときは、透明な
画素が無ければ JPEG に変換され、あればブラウザーが返した形式 (PNG など)
になります (一辺が 4096 px を超えると縮小します)。変換した画像は文書の
ファイルとして 1 度だけ保存され、地物はそれを参照します。複数の Image
地物が、保存した 1 つのファイルを共有できます。

ライブラリーは、地図にドロップされたファイルを受け取りません。ドロップ
されたファイルを読むには、アプリケーションがドロップを受けて取り込みます
([保存と読み込み](save-load.ja.md) を参照)。ドロップされた画像も同じ形で
落とした位置に置けます。`draw_image` に入り、落とした位置で
`draw.mode.drawing.add` を呼び、`requestImage` から落とされたファイルを
返します。

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
- 1 回のドラッグは 1 つの変更になります。ドラッグは下書きで見せ、離した
  ときに最後の状態が書き込まれるまで文書は変わりません。`drag.started` と
  `drag.ended` が始まりと終わりを知らせます
- ロックされた地物は選べますが、動きません。1 つだけならハンドルが
  出ません。ほかの地物と一緒に選ぶと、ほかが動いてもその場に残り、
  枠とハンドルは全部を囲みます。ロックされた地物を押しても何も動きません
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
`set` が `false` を返します。変わるたびに `draw.vertexSelection` が
知らせます (`draw.vertexSelection.subscribe`)。頂点を削除しても、地物自体は
消えません。

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
`selection.value` は選んでいるものを伝えます。種類、地物の数、地物の
レイヤーと範囲 (`bbox`)、ID です。`draw.selection.target` は書き込みに
渡す選んでいるものの指定で、`tx.features.delete` に渡すと選んでいるものを
削除します。選択が変わるたびに `draw.selection` が知らせます
(`draw.selection.subscribe`)。

```ts
const { type, count, ids, bbox } = draw.selection.value;
// 何も選んでいない時は種類が 'feature' で数が 0 です
const kept = draw.selection.target; // 今の選択
draw.selection.clear();
draw.selection.set(kept); // もう一度選びます
```

`selection.setAll(filter)` は絞り込みに合う地物をすべて選びます (Cmd+A は
すべてを選びます)。`selection.count(filter)` は選んだ地物を数えます。
`tx.features.update(draw.selection.target, patch)` は選んだ地物を 1 回の
確定で書き換えます。差分は関数で作れます。関数は地物ごとではなく、地物の
種類 (型、書式、作ったときのズーム) ごとに 1 回呼ばれます。

```ts
draw.selection.setAll({ shown: true });
await draw.write((tx) =>
  tx.features.update(draw.selection.target, (sample) => ({
    properties: {
      'maplibre-gl-draw:style': {
        strokeWidth: sample.type === 'LineString' ? 4 : 2,
      },
    },
  })),
);
```

### たくさんの地物を一度に

地物を行で持つストアでは、2,000 件を超える地物の選択 (多くの地物を囲む
矩形、`selection.setAll`) は ID を並べません。`selection.value.ids` は
`null` で、値のほかの欄は少ない地物と同じに読めます。地物ごとの枠と、全体を
囲む枠とハンドルは、複数選択と同じに表示されます。そのうちの 1 つを押して
ドラッグするとすべてが動き、枠のハンドルですべてを回転、拡縮できます。
書き込みは離したときに 1 回だけ行われます。矢印キーでも動かせます。押し続けた
分の移動は、最後に押してから少し経ったときに 1 回で書き込まれます (取り消しの
1 歩になります)。1 件ずつ選んだときと同じく、ロックされた地物はその場に残り、
ドラッグの途中でロックされた地物も残ります。

`draw.selection.target` を渡した書き込み (`tx.features.delete`、`update`、
`place`、`translate`、`rotate`、`scale`) は、それらの地物にも効きます。
`selection.features(filter, { limit, after })` はそれを 1 ページずつ読み、上限の無い読み出しは断ります。
`selection.set(selection.target)` は、前に読んだ選択 (それらの地物を含みます)
をもう一度選びます。選んだ地物の数で断る操作はありません。地物を読む物
(コピーや複製) は 1 ページずつ読みます。

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

矢印キーは、選んだ地物を画面上でその距離だけ動かします。押した分の移動は
書き込む前に表示され、最後に押してから少し (300 ms) 経ったとき、ページが
隠れたとき、選択が変わったとき、ほかのキーや押す操作やドラッグの前に、1 つの
変更として書き込まれます。ロックされた地物はその場に残り、ほかが動きます。選んだ
地物がすべてロックされているとき、読み取り専用のとき、操作ロック中は
何も動きません。そのときと、何も選んでいないときは、
キーが地図に渡り、地図がパンします。地物をダブルクリックしても
地図はズームしません。

ライブラリーが使ったキーは、どのモードでも既定の動作を止めます
(`KeyboardEvent.preventDefault()`)。使わなかったキーはそのままにします。
何も選んでいないときの Delete、取り消すものも解除するものも無いときの
Escape、描画モードで確定するものも消すものも無いときの Enter と
Backspace がそれに当たります。プラグインや拡張のモードが消費したキーも
同じように止めます。地図の周りのパネルのために、キャンバスの外
(`document`) でも同じキーを受け取るページは、地図が使ったキーを
飛ばせます。

<!-- docs-check:
declare function deleteFromThePanel(): void;
-->
```ts
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return; // 地図が使ったキー
  if (event.key === 'Delete') deleteFromThePanel();
});
```

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

- GeoJSON の `draw.open` と `tx.import` (Multi の形状は保たれます。
  `parseGeoJSON` に `flattenMulti: true` を渡すと単一の地物に分けられ
  ます)
- 幾何演算 (離れた多角形を結合すると `MultiPolygon` になり、内側を
  型抜きすると穴になります。[吸着と幾何演算](snapping-geometry.ja.md))
- 形状を渡した `tx.features.create`

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

`draw.write` の中の `tx.features.create` は GeoJSON の Feature を受け取り、
書いたとおりの地物を返します。フォームに入力された座標、距離と方位から
求めた位置、自動化、テストに使えます。

```ts
import { destination } from '@sakuzu/maplibre-gl-draw/geometry';

const start = [139.7, 35.68];
const line = await draw.write((tx) =>
  tx.features.create({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [start, destination(start, 500, 90)], // 東へ 500 m
    },
    properties: { name: 'Survey line' },
  }),
);
draw.selection.set('feature', [line.id]);
```

- `properties['maplibre-gl-draw:layerId']` か
  `properties['maplibre-gl-draw:groupId']` で指定しない限り、地物は
  アクティブなレイヤーに入ります。コードから作る地物は、利用者が描き込め
  ないロック中や非表示のレイヤーにも入れられます
- 描く型は形状の型です。`properties['maplibre-gl-draw:featureType']` で
  別の型を指定できます
- 読み取り専用のあいだ、書き込みは `DrawError` (`not-editable`) で
  reject します。入力が誤っているときも `DrawError` で reject し、何も
  作りません
- 円は中心を表す `Point` の形状で型が `Circle` の地物で、半径は
  `properties['maplibre-gl-draw:radiusMeters']` に入れます
- コードから作った地物には自動の名前も基準のズームも付かず、モードも
  選択も変わりません
- 地物の配列を渡すと、`create` はそれを同じ取引ですべて作り、ID を
  返します

```ts
await draw.write((tx) =>
  tx.features.create({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [139.7, 35.68] },
    properties: {
      'maplibre-gl-draw:featureType': 'Circle',
      'maplibre-gl-draw:radiusMeters': 250,
    },
  }),
);
```

組み込みのモードと同じ規則 (書き込めるレイヤー、自動の名前、基準の
ズーム) で描く道具は、独自のモードとして作り、`commitFeature` で地物を
作ります ([プラグイン](plugins.ja.md))。

### 描画モードをコードから動かす

`draw.mode.set` は `draw.setMode` と同じくモードを替え、何も返しません。
操作のロックがあるときと、書き込めるレイヤーが無いときは、描画モードに
入りません。`{ repeat: true }` を渡すと、描画モードは地物を作った後 (または
画像を求めた後) も替わらず、次の形を描けます。Escape では抜けます。

`draw.mode.drawing` は、いまの描画モードが描いている形を動かします。
`add` と `move` はその位置のクリックと移動、`commit` は Enter、`undo`、
`redo`、`cancel` はそれぞれのキーと同じです。`active` は描いている途中の
形があるかを答えます。いまのモードが描画モードでないときは、どれも
コード `invalid-state` の `DrawError` を投げます。`commit` は作った地物の
書き込みを返し、`draw.write` のオプションの `label` と `undo` を受けます。
モードが形から何も作らないとき (頂点が足りない) は `invalid-state` で
reject します。

```ts
draw.mode.set('draw_line');
draw.mode.drawing.add([139.7, 35.68]);
draw.mode.drawing.move([139.71, 35.69]);
draw.mode.drawing.add([139.71, 35.69]);
const line = await draw.mode.drawing.commit({ label: 'Route' });
console.log(line.id);
```

`draw.drawing` は、いまの描画モードが描いている形をコードから動かします。
1 つずつ入力された座標、ほかの入力機器、自動化に使えます。形を作るのは
モードなので、ポインターで描いた形と同じく、書き込めるレイヤー、自動の
名前、基準のズームが付き、描き終えると選択されます。

```ts
draw.setMode('draw_line');
draw.drawing.addVertex([139.7, 35.68]); // その位置のクリックと同じ
draw.drawing.moveTo([139.71, 35.69]); // プレビューが付いてくる
draw.drawing.addVertex([139.71, 35.69]);
draw.drawing.finish(); // Enter と同じ。モードは select に戻る
```

- `addVertex`、`moveTo`、`finish` は、位置を画面に投影した点での
  クリック、移動、Enter と同じポインターとキーのイベントになります。
  地図からの入力と同じく、モードより先にプラグインの `input` の
  受け手を通ります。位置はそのまま使い、吸着はしません。イベントには
  `programmatic: true` が付きます
- 位置は正確な値として扱うので、ポインターのクリックの許容 (10 px) は
  当てはまりません。最後の頂点から数ピクセルの頂点も置き、面の最初の
  頂点の近くの頂点でも面を閉じません。閉じる頂点とまったく同じ位置の
  ときだけ形を描き終えます
- `addVertex` は、描画モードが動いていないとき、またはクリックを
  受け取ったものがないときに `false` を返します。何が起きるかはモード
  しだいです。`draw_point` では点を作り、線や面の閉じる頂点の上では形を
  描き終えます
- `finish` は、頂点が足りていれば、最後の頂点がどこにあっても形を
  完成させます。描いている途中の形がないとき、またはモードが形を完成
  させなかったとき (頂点が足りない) に `false` を返します
- `cancel`、`undoVertex`、`redoVertex` は、描いている途中の形を捨て、
  最後の頂点を取り除き、それを戻します
- `isActive` は描画モードが描いているか最初の頂点を置ける状態かを、
  `isDrawing` は描いている途中の形があるかを答えます

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
移動、グループ化、取り消しができます。`tx.features.create` を使うと、
アプリケーションでフォームなどの座標を入力する別の手段を用意できます。

## 関連する例

- [Get started](../examples/get-started.ja.md) では、標準の UI の道具で
  描き、`change` を受け取ります
- [Build your own UI](../examples/custom-ui.ja.md) では、自分のボタンから
  `setMode` を呼び、`draw.mode` と `draw.selection` を追います
- [Editing shapes](../examples/editing-shapes.ja.md) では、枠、頂点と
  中点のハンドル、穴のある面、`MultiPolygon`、いっしょに動く共有の頂点を
  見せます

## リファレンス

- [`Draw`](../api/maplibre-gl-draw/interfaces/Draw.md) (`setMode`、
  `getMode`)
- [`Mode`](../api/maplibre-gl-draw/type-aliases/Mode.md) と
  [`MODES`](../api/maplibre-gl-draw/variables/MODES.md)
- [`FeaturesCollection`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md)、
  [`TransactionFeatures`](../api/maplibre-gl-draw/interfaces/TransactionFeatures.md)
  と [`FeatureInput`](../api/maplibre-gl-draw/type-aliases/FeatureInput.md)
- [`SelectionResource`](../api/maplibre-gl-draw/interfaces/SelectionResource.md)
  と
  [`VertexSelectionResource`](../api/maplibre-gl-draw/interfaces/VertexSelectionResource.md)
- [`VertexRef`](../api/maplibre-gl-draw/interfaces/VertexRef.md)
- [`DrawingResource`](../api/maplibre-gl-draw/interfaces/DrawingResource.md)
- [`AutoNameOptions`](../api/maplibre-gl-draw/interfaces/AutoNameOptions.md)
- [`SelectionStyleOptions`](../api/maplibre-gl-draw/interfaces/SelectionStyleOptions.md)
  と [`RuntimeOptions`](../api/maplibre-gl-draw/interfaces/RuntimeOptions.md)
  (ハンドルと描いている途中の形の色と大きさ)
- [イベント](../reference/events.md)
