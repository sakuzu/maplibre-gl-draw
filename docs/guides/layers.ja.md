# レイヤーとグループ

地物はすべてどれかのレイヤーに入り、同じレイヤーの地物はグループに
まとめられます。この手引きでは、レイヤー、新しい地物が入るアクティブな
レイヤー、グループ、ロック、重なりの順を扱い、地図のレイヤーを描画の
レイヤーのあいだに挟む方法も説明します。

## 最小のコード

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map);

// 文書は空のレイヤーを 1 つ持って始まる。2 つ目を足してそこに描く
// (読み取り専用のあいだ create は null を返す)
const notes = draw.layers.create({ name: 'Notes' });
if (notes) {
  draw.layers.setActive(notes.id);
  draw.setMode('draw_point');

  // 後で: ロックして、地物を選べるが編集できないようにする
  draw.layers.update(notes.id, { locked: true });
}
```

## レイヤー

`Layer` は、`name`、`visible`、`locked`、`opacity`、中に持つ
`items` (地物とグループの ID を奥から並べたもの)、省略できる
`styleRule` ([スタイル](styles.ja.md))、省略できる独自の `metadata` を
持ちます。

| メソッド | すること |
| --- | --- |
| `layers.create(input)` | レイヤーを足します。`index` が無ければ手前です |
| `layers.update(id, patch)` | 渡したキーだけを変えます |
| `layers.delete(id)` | 地物とグループごとレイヤーを削除します |
| `layers.get(id)`、`list()`、`count()`、`has(id)` | 読みます |

`create` と `update` は、保存したとおりのレイヤーを返します。読み取り
専用のあいだは何も変えず、`create` と `update` は `null` を、`delete` は
`false` を返します ([読み取り専用](read-only.ja.md))。無い ID を渡すと、
コード `not-found` の `DrawError` を投げます。名前が `Many` で終わる
メソッドは、同じことを複数のレイヤーについて 1 つの取引で行います。

```ts
const roads = draw.layers.create({ name: 'Roads', opacity: 0.8, index: 0 });
const hidden = draw.layers.list({ visible: false });
```

名前を指定せずに作ったレイヤーやグループには、`autoName` の設定の語で
自動の名前 (`Layer 2`、`Group 1`) が付きます
([自動の名前](drawing.ja.md#自動の名前))。

インスタンスを作ると、文書は空のレイヤーを 1 つ持って始まります。
`initDefaultLayer: false` を渡すとレイヤーは作られず、アプリケーションが
自分でレイヤーを作ります。自前のデータから構成を復元するときなどに
使います。

`layers.delete` はレイヤーの中身もすべて削除します。ロックされた
レイヤーや、ロックされた地物かグループを持つレイヤーには `false` を
返します。レイヤーを選んでいるときの選択の削除 (`selection.delete()` と
Delete キー) は、少なくとも 1 つのレイヤーを残します。

変更すると `layer.created`、`layer.updated`、`layer.deleted`、
`layer.reordered` が届きます。

## アクティブなレイヤー

新しい地物はアクティブなレイヤーに入ります。`layers.setActive(id)` で
設定し、`layers.getActive()` で取得します。ロックされたレイヤーは
アクティブにできず、`setActive` は `false` を返します。アクティブな
レイヤーが削除されると、最初のレイヤーがアクティブになります。

利用者の描画は、存在していて、ロックされておらず、表示されている
(全員に対しても、この端末でも隠されていない) レイヤーにだけ書き込み
ます。アクティブなレイヤーに書き込めないときは、書き込める最初の
レイヤーに描き、書き込めるようになるとアクティブなレイヤーに戻ります。
書き込めるレイヤーが 1 つも無いあいだ、`setMode` は描画モードを
受け付けません。この規則は利用者の描画だけのもので、`features.create`
と `document.load` は存在するどのレイヤーにも書き込めます。

## 重なりの順

どの段階でも、並びの末尾が手前です。

1. レイヤーのあいだでは、`layers.list()` の順
2. レイヤーの中では、`layer.items` (地物とグループ)
3. グループの中では、`group.featureIds`

`features.list()` は、すべての地物をこの順に奥から返します。
`layers.reorder` はすべてのレイヤーの ID を奥から並べて受け取り、
`features.move` と `groups.move` が地物とグループを置きます。`index` を
渡さない移動は移動先の手前に置き、`index: 0` は一番奥です。

<!-- docs-check:
declare const notes: import('@sakuzu/maplibre-gl-draw').Layer;
-->

```ts
// notes のレイヤーをほかのすべてのレイヤーの奥に置く
const others = draw.layers.list().filter((layer) => layer.id !== notes.id);
draw.layers.reorder([notes.id, ...others.map((layer) => layer.id)]);

// 1 つの地物をそのレイヤーの一番手前に出す
const target = draw.features.get(featureId);
if (target) draw.features.move(target.id, { layerId: target.layerId });

// 地物やグループを別のレイヤーに移す
draw.features.move(featureId, { layerId: notes.id });
draw.groups.move(groupId, { layerId: notes.id, index: 0 });
```

- レイヤーへ移した地物はグループから出ます。`{ groupId }` はどの
  レイヤーのグループにも地物を移し、`{ groupId: null }` は地物を
  グループから出してグループのすぐ手前に置きます
- `moveMany` は複数の地物やグループを、それらのあいだの順を保って
  移します
- ロックされたものの移動や、ロックされたレイヤーやグループへの移動は
  `false` を返し、何も変えません
- 移った地物ごとに、元の場所と行き先を載せた `feature.moved` が届きます

重なりの順は文書の一部です。`document.toJSON()` は `layerOrder` に書き
出し、文書の `document.load` はこれを置き換えます。

## グループ

グループは同じレイヤーの地物をまとめ、一緒に選ぶ、動かす、隠す、ロック
することができるようにします。

<!-- docs-check:
declare const idA: string;
declare const idB: string;
-->

```ts
// 読み取り専用のあいだは null
const site = draw.groups.create({ featureIds: [idA, idB], name: 'Site' });

// Cmd/Ctrl+G と同じく、今の選択から作ることもできる
draw.selection.set('feature', [idA, idB]);
const created = draw.selection.group(); // まとめられないときは null
```

地物が同じレイヤーにそろっていなければ、`groups.create` は `DrawError`
を投げます。`selection.group()` がグループを作るのは、同じレイヤーの
地物を 2 つ以上選んでいて、どれもまだグループに入っていないときです。
グループは、レイヤーの中で最も手前にあった地物の位置に入ります。

| メソッド | すること |
| --- | --- |
| `features.move(id, { groupId })` | 地物をグループに入れます |
| `features.move(id, { groupId: null })` | グループのすぐ手前に出します |
| `features.move(id, { groupId, index })` | グループの中で並べ替えます |
| `groups.delete(id)` | グループを解き、地物は残します |
| `selection.ungroup()` | 下の Shift+Cmd/Ctrl+G と同じ |

- グループを解くと、その地物が順を保ってグループのあった位置に入ります
- Shift+Cmd/Ctrl+G と `selection.ungroup()` は、選んだグループを
  解くか、選んだ地物をそのグループから出します
- 空になったグループ (最後の地物が出たか削除された) は、合わせて削除
  されます
- 地物は必ずどこか 1 か所に並んでいます。`groupId` を持つならその
  グループの `featureIds` に、持たないならレイヤーの `items` にあります

変更すると `group.created`、`group.updated`、`group.deleted` が
届きます。

## ロック

地物、グループ、レイヤーの `locked` は、選ぶことと表示することだけを
許し、ほかの編集をすべて拒みます。

```ts
draw.features.update(featureId, { locked: true });
draw.groups.update(groupId, { locked: true });
draw.layers.update(layerId, { locked: true });
```

- ロックは引き継がれます。地物自身、そのグループ、そのレイヤーの
  どれかがロックされていれば、その地物はロックされています
- ロックされた地物も選べ、`selection.features()` に含まれます
- 移動、拡縮、回転、頂点の編集、削除はできず、ハンドルも出ず、矩形選択
  でも選ばれません
- ロックされたものについて、`locked` と `visible` 以外を変える差分を
  渡すと `update` は `null` を返し、`delete` と `move` は `false` を
  返します
- Delete キーはロックされた地物を残します。グループを選んでいれば
  ロックされていない地物だけが削除され、ロックされたものを持つ
  レイヤーは削除されません
- 幾何演算はロックされた地物を拒みます

引き継がれたロックは、3 つのものから読み取ります。

```ts
function isLocked(id: string): boolean {
  const f = draw.features.get(id);
  if (!f) return false;
  const group = f.groupId ? draw.groups.get(f.groupId) : undefined;
  const layer = draw.layers.get(f.layerId);
  return f.locked || group?.locked === true || layer?.locked === true;
}
```

データに手を付けずにすべての編集を一度に止めるには、読み取り専用か
操作ロックを使います ([読み取り専用](read-only.ja.md))。

## 表示

地物、グループ、レイヤーの `visible: false` は、文書を共有する全員に
対して隠します。保存され、書き出しにも入ります。この端末だけで隠すには
`draw.hidden.add(id)` を使います ([読み取り専用](read-only.ja.md))。
隠れた地物は、描画、当たり判定、吸着、幾何演算の対象にならず、選ぶことも
できません。

## 不透明度

`opacity` (0 から 1) はレイヤー全体を薄くします。塗り、線、点、画像、
独自の地物の型が描くものなど、そのレイヤーに描くすべての不透明度に
掛け合わされます。

```ts
draw.layers.update(layerId, { opacity: 0.4 });
```

- 地図を描くときに掛けるので、スライダーなどで値を変えても負担は
  小さく済みます
- 見た目だけの設定です。不透明度 0 のレイヤーの地物も当たり判定があり、
  選べます。レイヤーを邪魔にならないようにするには、隠してください
- 独自の描画は、この値を `RenderContext` の `opacity` として受け取り、
  自分の不透明度に掛けます ([独自の地物の型](custom-types.ja.md))

## 地図のレイヤーを挟む

描画は地図の 1 つのレイヤーで描かれるので、地図のレイヤー (ベクター
タイル、ラスター) は描画全体の下か上のどちらかになります。そうした
レイヤーを描画のレイヤーのあいだに入れるには、重なりの順に自前の項目を
足し、`isExternalEntry` でそれが文書の外から来たものだとインスタンスに
伝えます。すると描画はその項目で区切られ、項目のあいだに続くレイヤーの
並びごとに地図のレイヤーが 1 つ作られます。アプリケーションは、自分の
地図のレイヤーをその並びのあいだへ動かします。1 つの地物だけを地図の
レイヤーのあいだに置くことはできず、描画の並びがまとめて動きます。

<!-- docs-check:
declare const parcels: string;
-->

```ts
const SEPARATOR = 'sep:';

const draw = createDraw(map, {
  isExternalEntry: (id) => id.startsWith(SEPARATOR),
});

// 地図の道路を parcels のレイヤーのすぐ手前に入れる
const doc = draw.document.toJSON();
doc.layerOrder.splice(doc.layerOrder.indexOf(parcels) + 1, 0, `${SEPARATOR}roads`);
await draw.document.load(doc);

function placeMapLayers(): void {
  const order = draw.getStore().getLayerOrder();
  const stack = draw.getLayerStack();
  order.forEach((entry, index) => {
    if (!entry.startsWith(SEPARATOR)) return;
    // 項目の上にある並びのすぐ下へ。無ければ一番上へ
    const above = stack.find((run) => run.from > index);
    map.moveLayer(entry.slice(SEPARATOR.length), above?.layerId);
  });
}

placeMapLayers();
draw.on('layerStack.changed', placeMapLayers);
```

- 自前の項目は、文書を通して重なりの順に入ります。読み込む文書の
  `layerOrder` か、インスタンスに渡す Store に持たせます。
  `layers.reorder` はレイヤーだけを動かし、自前の項目はそれぞれの位置に
  残します
- `draw.getStore().getLayerOrder()` は、自前の項目も含めた重なりの順の
  全体を返します
- `draw.getLayerStack()` は並びを奥から返します。それぞれが、重なりの順の
  範囲 `[from, to)` と、それを描く地図のレイヤーの ID を持ちます
- 自前の項目が無ければ並びは 1 つで、`maplibre-gl-draw-layer` です
- 並びが増減したときや範囲が変わったときに `layerStack.changed` が
  届きます。そのときに地図のレイヤーを置き直してください
- `order: 'layer-order'` のデータセットは、同じ順の中の自分の ID の位置に
  描かれます ([大量のデータを表示する](large-data.ja.md))

## 関連する例

- [style-rules](../../examples/style-rules/) では、レイヤーを足して
  スタイルの規則を付けます
- [read-only](../../examples/read-only/) では、レイヤーをロックします

## リファレンス

- [`LayersCollection`](../api/maplibre-gl-draw/interfaces/LayersCollection.md)
  と [`GroupsCollection`](../api/maplibre-gl-draw/interfaces/GroupsCollection.md)
- [`Layer`](../api/maplibre-gl-draw/interfaces/Layer.md)、
  [`LayerInput`](../api/maplibre-gl-draw/interfaces/LayerInput.md)、
  [`Group`](../api/maplibre-gl-draw/interfaces/Group.md)
- [`MoveTarget`](../api/maplibre-gl-draw/type-aliases/MoveTarget.md)
- [`Draw`](../api/maplibre-gl-draw/interfaces/Draw.md) (`getLayerStack`)
  と [`LayerStackEntry`](../api/maplibre-gl-draw/interfaces/LayerStackEntry.md)
- [イベント](../reference/events.md)
