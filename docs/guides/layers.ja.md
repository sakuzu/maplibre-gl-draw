# レイヤーとグループ

地物はすべてどれかのレイヤーに入り、同じレイヤーの地物はグループに
まとめられます。この手引きでは、レイヤー、新しい地物が入るアクティブな
レイヤー、グループ、ロック、重なりの順を扱い、地図のレイヤーを描画の
レイヤーのあいだに挟む方法も説明します。

## 最小のコード

```ts
import { createDraw, readFeature } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map);

// 文書は空のレイヤーを 1 つ持って始まる。2 つ目を足してそこに描く
// (読み取り専用のあいだ書き込みは reject する)
const notes = await draw.write((tx) => tx.layers.create({ name: 'Notes' }));
draw.layers.setActive(notes.id);
draw.setMode('draw_point');

// 後で: ロックして、地物を選べるが編集できないようにする
await draw.write((tx) => tx.layers.update(notes.id, { locked: true }));
```

## レイヤー

`Layer` は、`name`、`visible`、`locked`、`opacity`、中に持つ
`items` (地物とグループの ID を奥から並べたもの)、省略できる
`styleRule` ([スタイル](styles.ja.md))、省略できる独自の `metadata`
(自分の前置きの付いた鍵 `app:key` の値) を持ちます。

| メソッド | すること |
| --- | --- |
| `tx.layers.create(input)` | レイヤーを足します。`index` が無ければ手前です |
| `tx.layers.update(id, patch)` | 渡したキーだけを変えます |
| `tx.layers.delete(target)` | 地物とグループごとレイヤーを削除します |
| `tx.layers.place(id, { below } か { above })` | レイヤーを別のレイヤーの隣に置きます |
| `draw.layers.get(id)`、`list()`、`count()`、`has(id)` | 読みます |

書き込みは `draw.write` の中で行います ([はじめに](../getting-started.ja.md))。
`create` と `update` は書いたとおりのレイヤーを、`delete` は 1 つの ID、
複数の ID、`{ all: true }` のどれかを受け取り、削除した数を返します。
読み取り専用のあいだ、書き込みはコード `not-editable` の `DrawError` で
reject します ([読み取り専用](read-only.ja.md))。無い ID を渡すと
`not-found` で reject します。そのとき取引は何も確定しません。

```ts
const roads = await draw.write((tx) =>
  tx.layers.create({ name: 'Roads', opacity: 0.8, index: 0 }),
);
const hidden = draw.layers.list({ visible: false });
```

名前を指定せずに作ったレイヤーやグループには、`autoName` の設定の語で
自動の名前 (`Layer 2`、`Group 1`) が付きます
([自動の名前](drawing.ja.md#自動の名前))。

インスタンスを作ると、文書は空のレイヤーを 1 つ持って始まります。
`initDefaultLayer: false` を渡すとレイヤーは作られず、アプリケーションが
自分でレイヤーを作ります。自前のデータから構成を復元するときなどに
使います。

`tx.layers.delete` はレイヤーの中身もすべて削除します。ロックされた
レイヤーには `locked` で reject します。レイヤーを選んでいるときの
Delete キーでの選択の削除は、少なくとも 1 つのレイヤーを残します。

レイヤーの変更は `change` の `layers.created`、`layers.updated`、
`layers.deleted` で、重なり順の変更は `layers.placed` で届きます。

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
受け付けません。この規則は利用者の描画だけのもので、
`tx.features.create`、`tx.import`、`draw.open` は存在するどのレイヤーにも
書き込めます。

## 重なりの順

どの段階でも、並びの末尾が手前です。

1. レイヤーのあいだでは、`layers.list()` の順
2. レイヤーの中では、`layer.items` (地物とグループ)
3. グループの中では、`group.featureIds`

`features.list()` は、すべての地物をこの順に奥から返します。
`layers.listItems(id, { offset, limit })` と
`groups.listMembers(id, { offset, limit })` は、レイヤーの項目と
グループの地物を、奥から位置で読みます。`layers.countItems(id)` は
項目を数えます。どの種類のレイヤーでも読めます。行で持つレイヤー
(地物を行で持つストアのレイヤー、`kind: 'table'`) は `items` を
持たず、そのグループは `featureIds` を持ちません。
`tx.layers.place(id, { below })` はレイヤーを別のレイヤーのすぐ手前に
置き (`below` はすぐ下になるレイヤーです)、`{ above }` はすぐ奥に置きます。
`tx.features.place` と `tx.groups.place` は、地物とグループを別の項目の
隣か、レイヤーかグループの中に置きます。隣の項目を渡さなければ、置き先の
一番手前に置きます。

<!-- docs-check:
declare const notes: import('@sakuzu/maplibre-gl-draw').Layer;
-->

```ts
await draw.write(async (tx) => {
  // notes のレイヤーをほかのすべてのレイヤーの奥に置く
  const [back] = draw.layers.list();
  if (back !== undefined && back.id !== notes.id) {
    await tx.layers.place(notes.id, { above: back.id });
  }

  // 1 つの地物をそのレイヤーの一番手前に出す
  const target = draw.features.get(featureId);
  const layer = target ? readFeature(target).layerId : null;
  if (layer !== null) await tx.features.place(featureId, { layerId: layer });

  // グループを別のレイヤーの一番手前に移す
  await tx.groups.place(groupId, { layerId: notes.id });
});
```

- レイヤーへ置いた地物はグループから出ます。`{ groupId }` はどの
  レイヤーのグループにも地物を入れ、`{ layerId, below: groupId }` は地物を
  グループから出してグループのすぐ手前に置きます
- 複数の地物 (ID、絞り込み、選択) を渡すと、`tx.features.place` は
  それらのあいだの順を保ちます
- 置く場所は、すぐ下の項目 (`{ below }`) か、すぐ上の項目 (`{ above }`)
  で指します。別のレイヤーやグループへ置くときは、その入れ物も添えます
  (`{ layerId, groupId?, below }`)
- ロックされたものを置くことや、ロックされたレイヤーやグループへ置く
  ことは `locked` で reject し、何も変えません
- 移った地物とグループは、`change` の `features.placed` と
  `groups.placed` に並びます。置き場のほかに何も変わっていなければ、
  `placed` にだけ並びます

重なりの順は文書の一部です。`document.toJSON()` は `layerOrder` に書き
出し、文書の `draw.open` はこれを置き換えます。

## グループ

グループは同じレイヤーの地物をまとめ、一緒に選ぶ、動かす、隠す、ロック
することができるようにします。

<!-- docs-check:
declare const idA: string;
declare const idB: string;
-->

```ts
const site = await draw.write((tx) =>
  tx.groups.create({ members: [idA, idB], name: 'Site' }),
);

// Cmd/Ctrl+G と同じく、今の選択から作ることもできる。scan は頁を止めずに
// 読み、行の Store で 2,000 件を超えて選んだ時 (value.ids が null) も読める
if (draw.selection.value.type === 'feature') {
  const members: string[] = [];
  await draw.selection.scan((row) => members.push(row.id));
  if (members.length > 1) {
    await draw.write((tx) => tx.groups.create({ members }));
  }
}
```

地物が同じレイヤーにそろっていなければ、`tx.groups.create` は
`DrawError` で reject します。グループは、レイヤーの中で最も手前に
あった地物の位置に入ります。

| 書き込み | すること |
| --- | --- |
| `tx.features.place(id, { groupId })` | 地物をグループに入れます |
| `tx.features.place(id, { layerId, below: groupId })` | グループのすぐ手前に出します |
| `tx.features.place(id, { below })` | 別のメンバーの隣へ並べ替えます |
| `tx.groups.delete(id, { members: 'keep' })` | グループを解き、地物は残します |
| `tx.groups.delete(id, { members: 'delete' })` | 地物ごとグループを削除します |

- グループを解くと、その地物が順を保ってグループのあった位置に入ります
- Shift+Cmd/Ctrl+G は、選んだグループを解くか、選んだ地物をその
  グループから出します
- 空になったグループ (最後の地物が出たか削除された) は、合わせて削除
  されます
- 地物は必ずどこか 1 か所に並んでいます。`groupId` を持つならその
  グループの `featureIds` に、持たないならレイヤーの `items` にあります

行で持つレイヤー (地物を行で持つストアのレイヤー) でも、グループには
地物が要ります。このクライアントが削除したグループ (地物と一緒に削除
したもの、最後の地物が出たもの、解除したもの) は、`draw.undo()` で削除を
取り消すと、地物と一緒に元の場所に戻ります。

グループの変更は `change` の `groups.created`、`groups.updated`、
`groups.deleted` で届きます。

## ロック

地物、グループ、レイヤーの `locked` は、選ぶことと表示することだけを
許し、ほかの編集をすべて拒みます。

```ts
await draw.write(async (tx) => {
  await tx.features.update(featureId, {
    properties: { 'maplibre-gl-draw:locked': true },
  });
  await tx.groups.update(groupId, { locked: true });
  await tx.layers.update(layerId, { locked: true });
});
```

地物のロックは `properties['maplibre-gl-draw:locked']` にあり、ロック
されているあいだだけ置かれます。ロックを外すには、その鍵を `unset` に
書きます (`{ unset: { properties: ['maplibre-gl-draw:locked'] } }`)。

- ロックは引き継がれます。地物自身、そのグループ、そのレイヤーの
  どれかがロックされていれば、その地物はロックされています
- ロックされた地物も選べ、`selection.features()` に含まれます
- 移動、拡縮、回転、頂点の編集、削除はできず、ハンドルも出ず、矩形選択
  でも選ばれません
- ほかの地物と一緒に選ぶと、ほかをドラッグや矢印キーで動かしてもその場に
  残ります。ロックされた地物を押しても何も動きません
- ロックされたものを ID で指す書き込みは `locked` で reject します。
  ロックと表示のほかを変える差分の `update`、`delete`、`place` です
- `draw.selection.target` か絞り込みを渡した書き込みは、ロックされた
  地物をそのまま残し、ほかを変えます
- Delete キーはロックされた地物を残します。グループを選んでいれば
  ロックされていない地物だけが削除され、ロックされたものを持つ
  レイヤーは削除されません
- 幾何演算はロックされた地物を拒みます

引き継がれたロックは、3 つのものから読み取ります。

```ts
function isLocked(id: string): boolean {
  const f = draw.features.get(id);
  if (!f) return false;
  const { groupId, layerId, locked } = readFeature(f);
  const group = groupId !== null ? draw.groups.get(groupId) : undefined;
  const layer = layerId !== null ? draw.layers.get(layerId) : undefined;
  return locked || group?.locked === true || layer?.locked === true;
}
```

データに手を付けずにすべての編集を一度に止めるには、読み取り専用か
操作ロックを使います ([読み取り専用](read-only.ja.md))。

## 表示

グループとレイヤーの `visible: false` と、地物の
`properties['maplibre-gl-draw:visible']: false` は、文書を共有する全員に
対して隠します。保存され、書き出しにも入ります。この端末だけで隠すには
`draw.hidden.add(id)` を使います ([読み取り専用](read-only.ja.md))。
隠れた地物は、描画、当たり判定、吸着、幾何演算の対象にならず、選ぶことも
できません。

地物の表示は、その地物自身の印です。地物自身は表示でも、その
グループかレイヤーが隠れていれば描かれません。絞り込みの `shown` は、
この 3 つをまとめて答えます (この端末だけの非表示は見ません)。

```ts
const own = draw.features.list({ visible: true }); // 地物自身の印
const shown = draw.features.list({ shown: true }); // グループとレイヤーも
```

## 不透明度

`opacity` (0 から 1) はレイヤー全体を薄くします。塗り、線、点、画像、
独自の地物の型が描くものなど、そのレイヤーに描くすべての不透明度に
掛け合わされます。

```ts
await draw.write((tx) => tx.layers.update(layerId, { opacity: 0.4 }));
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

```ts
const SEPARATOR = 'sep:';

const draw = createDraw(map, {
  isExternalEntry: (id) => id.startsWith(SEPARATOR),
});

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

- 自前の項目は、文書を通して重なりの順に入ります。開く文書の
  `layerOrder` に、レイヤーの ID のほかに `isExternalEntry` が認める ID を
  持たせるか、インスタンスに渡す Store に持たせます。順の中にある項目は、
  `tx.layers.place` でレイヤーと同じように動かせ、レイヤーの隣の項目にも
  指定できます
- `draw.getStore().getLayerOrder()` は、自前の項目も含めた重なりの順の
  全体を返します。`draw.layers.getOrder()` は、そこからレイヤーでも
  順の中のデータセットでも `isExternalEntry` が認める項目でもなくなった
  ものを除いたものを返します
- `draw.getLayerStack()` は並びを奥から返します。それぞれが、重なりの順の
  範囲 `[from, to)` と、それを描く地図のレイヤーの ID を持ちます
- 自前の項目が無ければ並びは 1 つで、`maplibre-gl-draw-layer` です
- 並びが増減したときや範囲が変わったときに `layerStack.changed` が
  届きます。そのときに地図のレイヤーを置き直してください
- `order: 'layer-order'` のデータセットは、同じ順の中の自分の ID の位置に
  描かれます ([大量のデータを表示する](large-data.ja.md))

## 関連する例

- [Layers and groups](../examples/layers-and-groups.ja.md) では、
  コードでレイヤーを重ね、薄め、アクティブにし、地物をグループにまとめて
  ロックし、1 つを隠します。それを標準の UI のレイヤーのパネルに出します
- [Style rules and legend](../examples/style-rules-and-legend.ja.md)
  では、レイヤーにスタイルの規則を付けます

## リファレンス

- [`LayersCollection`](../api/maplibre-gl-draw/interfaces/LayersCollection.md)、
  [`GroupsCollection`](../api/maplibre-gl-draw/interfaces/GroupsCollection.md)、
  [`TransactionLayers`](../api/maplibre-gl-draw/interfaces/TransactionLayers.md)、
  [`TransactionGroups`](../api/maplibre-gl-draw/interfaces/TransactionGroups.md)
- [`Layer`](../api/maplibre-gl-draw/type-aliases/Layer.md)、
  [`LayerInput`](../api/maplibre-gl-draw/interfaces/LayerInput.md)、
  [`Group`](../api/maplibre-gl-draw/type-aliases/Group.md)
- [`Placement`](../api/maplibre-gl-draw/type-aliases/Placement.md)
- [`Draw`](../api/maplibre-gl-draw/interfaces/Draw.md) (`getLayerStack`)
  と [`LayerStackEntry`](../api/maplibre-gl-draw/interfaces/LayerStackEntry.md)
- [イベント](../reference/events.md)
