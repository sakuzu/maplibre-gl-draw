# プラグイン

プラグインは、draw のインスタンスに足す振る舞いをひとまとめに
したものです。変更への反応、モードの追加、地物の型の追加、
オーバーレイの描画などを入れられます。名前を持つふつうの
オブジェクトで、`draw.addPlugin` で登録します。プラグインは、
登録のときに受け取る `PluginContext` を通してインスタンスを
操作します。

## 最小のコード

作成、更新、削除された地物をすべてログに出すプラグインです。

```ts
import {
  createMapLibreGLDraw,
  type Plugin,
  type PluginContext,
} from '@sakuzu/maplibre-gl-draw';

function createLoggerPlugin(): Plugin {
  let unsubscribe: Array<() => void> = [];

  return {
    name: 'logger',

    onInstall(ctx: PluginContext) {
      unsubscribe = [
        ctx.on('feature.create', ({ feature }) => {
          console.log('created', feature.id, feature.type);
        }),
        ctx.on('feature.update', ({ feature }) => {
          console.log('updated', feature.id);
        }),
        ctx.on('feature.delete', ({ feature }) => {
          console.log('deleted', feature.id);
        }),
      ];
    },

    onUninstall() {
      for (const off of unsubscribe) off();
      unsubscribe = [];
    },
  };
}

const draw = createMapLibreGLDraw(map);
const removeLogger = draw.addPlugin(createLoggerPlugin());
```

地物を描くと、コンソールに `created` と出ます。`removeLogger()`
を呼ぶとプラグインが外れ、`onUninstall` が実行されてログが
止まります。

## Plugin オブジェクト

必須なのは `name` だけで、インスタンスの中で一意にする必要が
あります。すでに登録されている名前のプラグインを登録しようと
すると、警告を出して登録を飛ばします。そのときに返る関数は何も
しません。

| メンバー | 用途 |
| --- | --- |
| `onInstall(ctx)` | 文脈を受け取ります。購読と登録はここで行います |
| `onUninstall()` | `onInstall` で確保したものを解放します |
| `hooks` | 変更が起きた後に反応します (後述) |
| `modes` | プラグインと一緒に登録、削除されるモードです |
| `api` | ほかのコードが `draw.getPluginApi(name)` で受け取るオブジェクトです |

プラグインは入力の処理にも加われます。使えるのは次のものです。
`onKeyDown` (true を返すと、モードより先にキーを消費します)、
`onMouseMove`、`onDragMove`、`onMouseLeave`、`filterSelection`
(選択の候補を絞ります)、`onFeatureClick` と
`onFeatureDoubleClick` (処理したら true を返します)、
`onFeatureCreated`、そして、インライン編集のような排他的な操作を
プラグインが持つための 4 つのメンバー (`isInteracting`、
`finishInteraction`、`cancelInteraction`、
`getInteractionContainer`) です。

`api` を使うと、ホストやほかのプラグインに関数を公開できます。

```ts
const counter: Plugin = {
  name: 'counter',
  api: { count: () => draw.getAllFeatures().length },
};
draw.addPlugin(counter);

const api = draw.getPluginApi<{ count(): number }>('counter');
api?.count();
```

プラグインどうしをつなぐときは、なるべくコンストラクターで渡して
ください。`getPluginApi` はそれができないときの手段です。

## 文脈で使えるもの

`onInstall` は `PluginContext` を受け取ります。プラグインが
インスタンスを操作する手段は、この文脈だけです。

- `draw` はインスタンスそのものです。公開 API と拡張点
  (`registerMode`、`registerFeatureHandler`、
  `addOverlayRenderer` など) に使います
- 読み取りの API。`getFeature`、`getAllFeatures`、`getLayer`、
  `getSelection`、`getMode` などがあります
- 書き込みの API。`addFeatures`、`updateFeature`、
  `deleteFeatures`、`createLayer`、`createGroup`、`setSelection`
  などがあります。1 回の呼び出しが Store の 1 つのトランザク
  ションになります。`batch(fn)` を使うと、複数の書き込みを 1 つ
  にまとめられます
- イベントの `on`、`off`、`emit`
- `setMode`。モードが拒まれたときは false を返します
- `getStore()`。書き込みのメソッドを含む Store そのものです。
  文書を直接扱うプラグインが使います
- `autoNameGenerator`。インスタンスの自動の名前付けです。利用者が
  入力した名前を持たない地物、レイヤー、グループを作るプラグインは、
  ここで名前を付けます (`generateName(type)`、`generateLayerName()`、
  `generateGroupName()`)。こうすると、名前の語はホストの `autoName`
  オプションから取られます ([自動の名前](drawing.ja.md#自動の名前))
- `invalidateFeatures(type)`、`computeBoundingBox(feature)`、
  地形のアンカー。独自の地物の型で使います
  ([独自の型](custom-types.ja.md) を参照してください)

文脈のイベントには、`draw.` の接頭辞を除いた名前を使います。
`ctx.on('feature.create', ...)` は
`draw.on('draw.feature.create', ...)` と同じイベントです。
どちらも購読を解除する関数を返します。

すべてのデータセットを相手にするプラグイン (その地物に
自分で何かを描くものなど) は、`dataset.add` と `dataset.remove`
でデータセットの追加と削除を追います。プラグインを入れた時点で
すでにデータセットがあることもあるので、`onInstall` で
`ctx.draw.getDatasets()` も一度読みます。データセット
の順に描くプラグインは、後ろから前の順の id を持つ
`dataset.reorder` も聞きます。

<!-- docs-check:
declare const ctx: PluginContext;
declare function follow(datasetId: string): void;
declare function forget(datasetId: string): void;
-->

```ts
for (const dataset of ctx.draw.getDatasets()) follow(dataset.id);
ctx.on('dataset.add', ({ datasetId }) => follow(datasetId));
ctx.on('dataset.remove', ({ datasetId }) => forget(datasetId));
```

書き込みの API はどれも、最後の引数に省略可能な `source` を取り
ます。これが変更通知の出どころになる (省くと `'local'`) ので、
フックや `draw.features.change` で、誰が変更したかを見分けられ
ます。

<!-- docs-check:
declare const ctx: PluginContext;
declare const id: string;
-->

```ts
ctx.deleteFeatures([id], 'remote');
```

もう存在しない id を指定した書き込みは無視されます。プラグイン
は変更の後に反応することが多く、その時点で対象がすでに無いこと
があるからです。Store が読み取り専用の間は、書き込みをしても
何も変わらず、`addFeatures` は空の配列を返します。

## フック

`hooks` を使うと、Store を購読しなくても変更に反応できます。

```ts
const audit: Plugin = {
  name: 'audit',
  hooks: {
    'feature:afterCreate': (features, ctx) => {
      console.log('created', features.map((f) => f.id), ctx.source);
    },
    'feature:afterUpdate': (updated, original) => {
      console.log('updated', updated.length, 'of', original.length);
    },
  },
};
```

| フック | 引数 |
| --- | --- |
| `feature:afterCreate`、`feature:afterDelete` | 地物の配列、ctx |
| `feature:afterUpdate` | 更新後、更新前、ctx |
| `group:` と `layer:` の同じ 3 つ | 1 件 (と更新前) |
| `selection:afterChange` | 新しい id、前の id、ctx |
| `drag:start`、`drag:end` | `{ featureIds }`、ctx |

- 変更のフックは、変更が起きた後に実行されます。どこからの
  書き込みでも実行されます。公開 API、描画モード、ドラッグ、
  Delete キー、読み込み、プラグイン、自分で渡した Store に適用
  された変更のどれでも同じです
- 1 つのトランザクションで実行されるフックは、同じ
  `ctx.source` と `ctx.batchId` を受け取ります
- ドラッグの途中の更新は知らせません。ドラッグを終えたときの
  更新は知らせます
- Store が拒んだ書き込み (読み取り専用のとき) では、フックは
  実行されません
- `drag:start` と `drag:end` は、選択モードでの移動、拡縮、
  回転、頂点のドラッグ、半径のドラッグの前後に実行されます
- 変更の前に実行されるフックはありません。フックで変更を止め
  たり書き換えたりはできません

## 独自のモード

モードは、有効になっている間の入力を受け取ります。
`draw.registerMode(name, factory)` で登録するか、プラグインの
`modes` に書いて、プラグインと一緒に登録と削除が行われるように
します。ファクトリーは `ModeHandler` を返し、`onStart` が
`ModeContext` を受け取ります。

```ts
import type { ModeContext, ModeHandler } from '@sakuzu/maplibre-gl-draw';

function createStampMode(): ModeHandler {
  let ctx: ModeContext;
  return {
    modeName: 'stamp',
    writesFeatures: true,
    onStart(context) {
      ctx = context;
    },
    onClick(event) {
      const layerId = ctx.getCurrentLayerId();
      if (layerId === '') {
        ctx.setMode('select');
        return;
      }
      ctx.store.createFeature({
        id: ctx.generateFeatureId(),
        type: 'Point',
        coordinates: [event.lngLat.lng, event.lngLat.lat],
        layerId,
        properties: {},
        locked: false,
        visible: true,
      });
    },
    onKeyDown(event) {
      if (event.key === 'Escape') ctx.setMode('select');
    },
  };
}

draw.registerMode('stamp', createStampMode);
draw.setMode('stamp');
```

Escape を押すまで、クリックするたびに現在のレイヤーへ点が追加
されます。

- `writesFeatures: true` にすると、組み込みの描画モードと同じ
  ように、書き込めるレイヤーが無い間は `setMode` がそのモードを
  拒みます
- モードが有効な間に、レイヤーが書き込めなくなることがあります
  (削除、ロック、非表示)。確定するときに `getCurrentLayerId()`
  を読み直してください。空文字列なら地物を作らず、描きかけの形
  を捨てて (`store.setTentative(null)`)、`select` に戻ります
- `onDragCancel` は、押した指やボタンを離さないまま押下が終わった
  とき (2 本目の指が触れた、タッチが取り消されたなど) に届き
  ます。何も確定せず、押下で変えたものを元に戻し、
  `map.dragPan` を止めていたなら有効に戻してください
- ダブルクリックやキー (矢印、`+`、`-`) を地図の側でも処理させ
  たくないときは、`onDoubleClick` か `onKeyDown` で
  `event.originalEvent.preventDefault()` を呼びます

## 登録の取り消し

登録はどれも、その登録を取り消す関数を返します。対象は
`addPlugin`、`registerMode`、`registerFeatureHandler`、
`addOverlayRenderer`、`registerAuxiliaryHandleProvider`、
`registerFeatureCompanionProvider`、`snapping.register` です。
`remove...` という名前のメソッドはありません。

- プラグインの登録を取り消すと、その `modes` のモードが削除され
  (そのどれかが有効なら、先に `select` に切り替わります)、
  `onUninstall` が実行されます
- 有効になっているモードを削除すると、先に `select` に切り替わり
  ます
- 同じ名前や型がその後で登録し直されている場合、前の取り消しの
  関数を呼んでも、後の登録はそのまま残ります
- 登録は、登録したインスタンスだけのものです。同じページにある
  別の draw のインスタンスからは見えません
- `destroy()` は、すべてのプラグインの登録を取り消し
  (`onUninstall` が実行されます)、インスタンスのすべての登録を
  消します。破棄したインスタンスへの登録は無視され、何もしない
  関数が返ります

## 関連する例

- [examples/plugin/](../../examples/plugin/) では、フック
  を持つロガーのプラグインと独自のモードを登録し、また取り消し
  ます

## リファレンス

- [Plugin](../reference/api/interfaces/index.Plugin.html)
- [PluginContext](../reference/api/interfaces/index.PluginContext.html)
- [Hooks](../reference/api/interfaces/index.Hooks.html) と
  [MutationContext](../reference/api/interfaces/index.MutationContext.html)
- [ModeHandler](../reference/api/interfaces/index.ModeHandler.html) と
  [ModeContext](../reference/api/interfaces/index.ModeContext.html)
- 文脈のイベントの名前については
  [EventMap](../reference/api/interfaces/index.EventMap.html)
