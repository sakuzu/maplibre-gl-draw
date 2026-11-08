# プラグイン

拡張は、draw のインスタンスに振る舞いを足すものです。プラグイン、
モード、地物の型、重ね描き、提供者があります。この手引きでは、
プラグインとモードを説明します。プラグインは、ほかの拡張を自分の状態と
一緒にまとめます。モードは、有効な間の入力を受け取ります。地物の型、重ね描き、提供者は
[独自の地物の型](custom-types.ja.md) で説明します。

## 最小のコード

作成、変更、削除された地物をすべてログに出すプラグインです。

```ts
import type { Plugin } from '@sakuzu/maplibre-gl-draw';

const logger: Plugin = {
  name: 'logger',
  onAdd(ctx) {
    ctx.on('change', ({ features, source }) => {
      for (const id of features.created) {
        console.log('created', id, ctx.draw.features.get(id)?.type, source);
      }
      for (const id of features.updated) console.log('changed', id);
      for (const id of features.deleted) console.log('deleted', id);
    });
  },
};

const removeLogger = draw.extensions.plugins.add(logger);
```

地物を描くと、コンソールに `created` と出ます。`removeLogger()` を
呼ぶとプラグインが外れ、ログが止まります。`ctx.on` で行った購読は、
プラグインと一緒に終わります。

## 拡張の種類

拡張の種類ごとに、`draw.extensions` の下にコレクションがあります。

| コレクション | 入れるもの |
| --- | --- |
| `plugins` | ほかの拡張と状態のまとまり |
| `modes` | 入力の受け方。`draw.setMode` で切り替えます |
| `featureTypes` | 自分の描き方と当たり判定を持つ地物の型 |
| `overlays` | 地物の上やレイヤーの間に描くもの |
| `snapProviders` | 独自の吸着の候補 |
| `handleProviders` | 選んだ地物に付ける独自のハンドル |
| `companionProviders` | 地物の 1 段下に描き、そこでクリックを受けるもの |

どのコレクションも同じメソッドを持ちます。`add` と `addMany` で登録し、
`remove(name)` と `removeMany(names)` で外します。`get`、`list`、
`count`、`has` で名前から引けます。`add` は、足したものを外す関数を
返します。

使われている名前を渡すと、コード `already-exists` の `DrawError` が
投げられます。無い名前を `remove` に渡すと `not-found` です。
`addMany` と `removeMany` は、全部を行うか何も行わないかのどちらかです。

## Plugin オブジェクト

プラグインはふつうのオブジェクトです。`name` と `onAdd` が必須で、
名前はインスタンスの中で一意にします。

| メンバー | 用途 |
| --- | --- |
| `onAdd(ctx)` | 窓口を受け取ります。購読と拡張の追加はここで行います |
| `onRemove()` | 窓口の外で持っているものを解放します |
| `api` | `draw.extensions.plugins.getApi(name)` で読むもの |
| `input` | モードより先に呼ばれる入力の受け手 |
| `onFeatureCommit(feature)` | 描画モードが地物を作った |
| `selectMode` | 選択モードの地物のクリックのフック |
| `exclusive` | 排他的な操作。その間、選択モードは動きません |

### API を渡す

`api` を使うと、ページやほかのプラグインに関数を渡せます。`Plugin` の
型引数でその形を書きます。

```ts
import type { Plugin } from '@sakuzu/maplibre-gl-draw';

interface CounterApi {
  count(): number;
}

function createCounter(): Plugin<CounterApi> {
  let created = 0;
  return {
    name: 'counter',
    api: { count: () => created },
    onAdd(ctx) {
      ctx.on('change', ({ features }) => {
        created += features.created.length;
      });
    },
  };
}

draw.extensions.plugins.add(createCounter());
const counter = draw.extensions.plugins.getApi<CounterApi>('counter');
console.log(counter?.count());
```

両方のプラグインを自分で作るなら、一方をもう一方の工場関数に渡す方が
簡単です。`getApi` は、名前しか知らないコードのためのものです。

## 窓口が渡すもの

`onAdd` は `PluginContext` を受け取ります。プラグインがインスタンスに
触れる道はこれだけです。

- `draw` は公開 API の全体です。プラグインは、アプリケーションと同じ
  ようにこれを通して文書を読み書きします
- `store` は、文書とこの端末の状態を読むための窓口です。`subscribe`
  で、すべての変化を購読できます
- `on`、`off`、`once` はイベントのためのものです。ここで行った購読は、
  プラグインを外すと終わります
- `extensions` は `draw.extensions` と同じコレクションです。ここで
  足したものは、プラグインと一緒に外れます
- `names` はインスタンスの自動の名前です。`names.next('Layer')` は、
  オプション `autoName` のとおりに次の名前を返します
  ([自動の名前](drawing.ja.md#自動の名前))
- `screen` は、最後に描いた画面での、地図の位置と画面の点の変換、
  ズーム、ピクセル比、1 ピクセルのメートルです
- `terrain` は、このインスタンスの地形の上の位置と高さです
  ([地形](terrain.ja.md))
- `invalidate` は、文書の外の何かが見た目を変えたときに、地物を描き
  直させます
- `webgl` は、WebGL を自分で使って描くためのものです。GPU に持つものは
  プラグインと一緒に無くなります
  ([自分のシェーダー](custom-types.ja.md#自分のシェーダー))

描いている途中の形は、アプリケーションと同じく `ctx.draw.drawing` です。
地図からの入力と同じように頂点を置き、プレビューを動かし、形を描き終えます
(`addVertex`、`moveTo`、`finish`)。最後の頂点を取り除き、また戻します
(`undoVertex`、`redoVertex`)。Escape と同じようにその形を取り消し、
モードは離れません (`cancel`)。描画モードが描いているかを答えます
(`isActive`、`isDrawing`)
([描画と編集](drawing.ja.md#描画モードをコードから動かす))。

### 文書に書く

プラグインは、アプリケーションと同じメソッドで書き込みます。いくつかの
書き込みを 1 つの変化にするには `transact` で包みます。`source` を
渡すと、受け手は変化の出どころを見分けられます。

<!-- docs-check:
declare const ctx: import('@sakuzu/maplibre-gl-draw').PluginContext;
-->

```ts
ctx.draw.transact(
  () => {
    const layer = ctx.draw.layers.create({ name: ctx.names.next('Layer') });
    if (layer) {
      ctx.draw.features.create({
        type: 'Point',
        geometry: { type: 'Point', coordinates: [139.767, 35.681] },
        layerId: layer.id,
      });
    }
  },
  { source: 'my-plugin' },
);
```

決まりはインスタンスと同じです。もう無い ID のような誤った引数は
`DrawError` を投げます。読み取り専用やロックのために拒まれた書き込みは
`null` か `false` を返します。どちらの場合も何も変わりません。変化の
後に反応するプラグインは、対象がもう無いかもしれないので、先に `has`
で確かめます。

取り消しのように、自分の記録から変化を当て直すプラグインは、変化の後に
ロックされた地物にも書き込む必要があります。そのときは `transact` に
`ignoreLocks: true` を渡します。その中の書き込みは、地物、グループ、
レイヤーのロックを無視します。読み取り専用は無視しません。また、
利用者がロックされた地物を動かせないことは変わりません。

<!-- docs-check:
declare const ctx: import('@sakuzu/maplibre-gl-draw').PluginContext;
declare const id: string;
-->

```ts
ctx.draw.transact(
  () => ctx.draw.features.update(id, { properties: { name: 'Before' } }),
  { source: 'my-plugin', ignoreLocks: true },
);
```

### イベント

プラグインは、`draw.on` と同じ名前のイベントで変化に反応します
([イベント](../reference/events.md))。イベントは変化の後に届き、何が
書き込んだかを問いません。API、描画モード、ドラッグ、Delete キー、
読み込み、ほかのプラグイン、差し替えた Store のどれでも届きます。

- `change` は、文書を変えた取引ごとに 1 回、その取引で変わったもの
  すべての ID と `source` を持って届きます
- この端末の時間で変わる値 (選択、モード、下書き、データセットなど) は
  その資源の `Observable` で、`subscribe` で追います
  ([時間で変わる値](../reference/events.md#values-that-change-over-time)
  (英語))
- ドラッグは何を編集しても離したときに 1 度だけ書き込まれます。途中に
  見えるのは下書きです (`draw.rendered`)
- `drag.started` と `drag.ended` は、選択モードの移動、拡縮、回転、
  頂点のドラッグの前後に届きます
- 受け手は変化を止めることも書き換えることもできません。変化を起こさ
  せたくないときは、地物かレイヤーをロックするか、描画を読み取り専用に
  します ([読み取り専用](read-only.ja.md))

すべてのデータセットを扱うプラグインは、`draw.datasets` で追いかけます。
その `subscribe` は、プラグインを足した時点ですでにあるデータセットで
渡した関数をすぐに 1 回呼び、データセットが追加されたとき、取り除かれた
とき、順が変わったときにまた呼びます。`Observable` の購読は窓口の購読
ではないので、プラグインが `onRemove` で止めます。

<!-- docs-check:
declare const ctx: import('@sakuzu/maplibre-gl-draw').PluginContext;
declare function follow(datasetIds: ReadonlySet<string>): void;
-->

```ts
const stop = ctx.draw.datasets.subscribe((datasets) => {
  follow(new Set(datasets.map((dataset) => dataset.id)));
});
// onRemove で
stop();
```

### 描かれているもの

地物の周りに何かを描くプラグインや、地物がどこにあるかを読むプラグインは、
描かれている地物を `ctx.draw.rendered` から読みます。下書き
(`draw.sketches`) が文書の上に当てられ、たくさんの選択のドラッグの行は
描かれている所へ動いた、書く前の編集の途中の形です。
`rendered.getSelectionBox(id)` は、その選択の枠 (外形に余白を足したもの)
を、最後に描いた画面でライブラリーが描いて当てるとおりに渡します。
`rendered.getFootprint(id)` は、余白の無い外形、つまりライブラリーが
選択の枠を作る元の箱 (描かれている画像の 4 隅など) を渡します。
`rendered.changed` は、形が変わった地物を、それを描く 1 回を描き終えた
ときに知らせます。その値は最後に知らせた ID です。見た目の変化と、
画面に合わせて変わる選択の枠は知らせないので、描くたびに読んでください。
書くものは文書 `ctx.draw.features` を読みます。

<!-- docs-check:
declare const ctx: import('@sakuzu/maplibre-gl-draw').PluginContext;
declare function follow(feature: import('@sakuzu/maplibre-gl-draw').Feature): void;
-->

```ts
ctx.draw.rendered.changed.subscribe((ids) => {
  for (const feature of ctx.draw.rendered.getMany(ids)) {
    if (feature) follow(feature);
  }
});
```

### プラグインの文言

自分の語を見せるプラグインは、その語をライブラリーの 1 つの文言の表に
入れます。そうすると、アプリは同じオプション `messages` で翻訳できます。
プラグインは、自分の鍵を宣言の併合で `Messages` に宣言し、その英語の
既定を `defineMessages` に渡します。オプションでその鍵を指定する
インスタンスを作る前 (プラグインを作るときなど) に渡してください。
見せるときに、インスタンスの表 `ctx.messages` から読みます。オプションで
変わることがあるからです。どこにも定められていない鍵は、これまでどおり
オプションが拒みます。

<!-- docs-check:
declare const map: import('maplibre-gl').Map;
-->

```ts
import { createDraw, defineMessages, type Plugin } from '@sakuzu/maplibre-gl-draw';

declare module '@sakuzu/maplibre-gl-draw' {
  interface Messages {
    pinLabel: string;
  }
}

defineMessages({ pinLabel: 'Pin' });

const pins: Plugin = {
  name: 'pins',
  onAdd(ctx) {
    console.log(ctx.messages.pinLabel);
  },
};

const draw = createDraw(map, { messages: { pinLabel: 'Épingle' } });
draw.extensions.plugins.add(pins);
```

### プラグインの値

イベントを送るのはライブラリーだけです。プラグインの時間で変わる値は、
プラグインが返す API に `Observable` を置いてアプリケーションに渡します。
`value` で今の値を読み、`subscribe` は渡した関数を今の値ですぐに 1 回
呼び、値が変わるたびにまた呼びます。アプリケーションとほかの
プラグインは、ライブラリーの値と同じようにこれを追います。

```ts
import type { Observable, Plugin } from '@sakuzu/maplibre-gl-draw';

interface CounterApi {
  /** 数えた、変わった地物の数 */
  readonly count: Observable<number>;
}

function createCounter(): Plugin<CounterApi> {
  let count = 0;
  const runs = new Set<(value: number) => void>();
  const observable: Observable<number> = {
    get value() {
      return count;
    },
    subscribe(run) {
      runs.add(run);
      run(count);
      return () => {
        runs.delete(run);
      };
    },
  };
  return {
    name: 'counter',
    api: { count: observable },
    onAdd(ctx) {
      ctx.on('change', ({ features }) => {
        if (features.updated.length === 0) return;
        count += features.updated.length;
        for (const run of [...runs]) run(count);
      });
    },
  };
}

draw.extensions.plugins.add(createCounter());
draw.extensions.plugins
  .getApi<CounterApi>('counter')
  ?.count.subscribe((count) => console.log(count));
```

## 入力

`input` は、どのモードのときでも、モードより先にポインターとキーを
受け取ります。受け手はモードと同じもの (`onPointerDown`、
`onPointerMove`、`onClick`、`onDragStart`、`onKeyDown` など) で、true
を返すとイベントを消費します。後から足したプラグインとモードには
届きません。

キーでモードを切り替えるプラグインです。

```ts
import type { Plugin, PluginContext } from '@sakuzu/maplibre-gl-draw';

function createShortcuts(): Plugin {
  let ctx: PluginContext | null = null;
  return {
    name: 'shortcuts',
    onAdd(context) {
      ctx = context;
    },
    onRemove() {
      ctx = null;
    },
    input: {
      onKeyDown(event) {
        if (!ctx || event.modifiers.ctrl || event.modifiers.meta) return false;
        if (event.key === 'p') return ctx.draw.setMode('draw_point');
        if (event.key === 'l') return ctx.draw.setMode('draw_line');
        return false;
      },
    },
  };
}

draw.extensions.plugins.add(createShortcuts());
```

- プラグインは、足した順に入力を受け取ります
- 消費した押し下げは地図に届かないので、地図はパンしません。消費した
  ダブルクリックで地図がズームすることもありません。`writes: true` の
  モードがいまのモードのあいだは、どのダブルクリックでもズームしません
- 消費したキーは既定の動作を止めます。そのため地図はそのキー (矢印、
  `+`、`-`) を使わず、キャンバスの外で同じキーを受け取るページは
  `defaultPrevented` で見分けられます。`onKeyDown` は、キーで何かを
  したときだけ true を返してください。消費しなかったキーは地図と
  ページに渡ります
- `onPointerLeave` は、ポインターが地図の外に出たときに届きます
- `select` で吸着するのはドラッグだけです。そこでのクリックと移動の
  `snapped.lngLat` は `lngLat` と同じです

## 選択モードのフック

`selectMode` を使うと、プラグインが選択モードのクリックに加われます。

- `onSelectedFeatureClick(feature, event)` は、選ばれている地物がもう一度
  クリックされたときに呼ばれます。true を返すと、プラグインがその
  クリックを処理したことになります
- `onFeatureDoubleClick(feature, event)` は、地物がダブルクリック
  されたときに、その地物を選んだ後で呼ばれます

`onFeatureCommit(feature)` は、描画モードが地物を作ったときに呼ばれます。
`ctx.commitFeature` の確定 (組み込みの描画モードもこれを使います) と、
`image.requested` の後の読み込みが置いた画像です。

### 排他的な操作

プラグインは、地図の上に出す入力欄のような、地物に対する自分の操作を
`exclusive` に持てます。`exclusive.isActive()` が true を返す間、
選択モードは動きません。ドラッグも選択もせず、Escape 以外のキーを
無視します。

- `container()` が返す要素の中の押し下げはプラグインに任され、地図は
  パンしません
- その要素の外をクリックすると `finish()` が呼ばれ、続けて通常の
  クリックとして扱われます。地物の上なら、その地物を選択し、何もない
  地図の上なら選択を解きます。選択中の地物を押しても `onSelectedFeatureClick`
  は呼ばれないので、操作を終えたクリックが次の操作を始めることは
  ありません
- Escape で `cancel()` が呼ばれます
- 選択モードを出ると `finish()` が呼ばれます

## モード

モードは、有効な間の入力を受け取ります。
`draw.extensions.modes.add(name, factory)` で足すか、プラグインと一緒
に外れるように `ctx.extensions.modes.add` で足し、`draw.setMode(name)`
で切り替えます。

工場関数は `ModeContext` を受け取り、`ModeHandler` を返します。工場
関数はモードに入るたびに呼ばれるので、クロージャーに持つ状態は毎回
新しく始まります。モードが窓口を通して行った購読は、モードを出ると
終わります。

2 回のクリックで長方形を描くモードです。

```ts
import type { FeatureInput, ModeFactory, Position } from '@sakuzu/maplibre-gl-draw';

function rectangle(a: Position, b: Position): FeatureInput {
  return {
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]],
    },
  };
}

const drawRectangle: ModeFactory = (ctx) => {
  let first: Position | null = null;
  const reset = () => {
    first = null;
    ctx.preview.clear();
  };

  return {
    writes: true,
    onEnter: () => ctx.cursor.set('crosshair'),
    onExit() {
      ctx.cursor.reset();
      reset();
    },
    onCancel: reset,
    onPointerMove(event) {
      if (first) ctx.preview.set(rectangle(first, event.snapped.lngLat));
    },
    onClick(event) {
      if (!first) {
        first = event.snapped.lngLat;
        return true;
      }
      const feature = ctx.commitFeature(rectangle(first, event.snapped.lngLat));
      reset();
      if (feature) ctx.draw.selection.set('feature', [feature.id]);
      return true;
    },
    // 素早い 2 回のクリックは 2 つの角で、地図はズームしない
    onDoubleClick: () => true,
    onKeyDown(event) {
      if (event.key !== 'Escape') return false;
      if (first) reset();
      else ctx.setMode('select');
      return true;
    },
  };
};

draw.extensions.modes.add('draw_rectangle', drawRectangle);
draw.setMode('draw_rectangle');
```

1 回目のクリックで角を置き、ポインターに合わせて長方形が見え、2 回目の
クリックで作ります。Escape で描いている長方形を捨て、もう一度 Escape を
押すと `select` に戻ります。

### ハンドラー

`ModeHandler` のメンバーはすべて省けます。

| メンバー | 用途 |
| --- | --- |
| `onEnter`、`onExit` | モードに入るときと出るとき |
| `onCancel` | 描いているものを捨ててモードに留まる |
| 入力の受け手 | `input` と同じです。true でイベントを消費します |
| `writes` | 新しい地物を受けるレイヤーがあるときだけ入れます |
| `snapPreference` | どの入力を吸着させ、何を優先するか |
| `onUndoVertex`、`onRedoVertex` | 最後の頂点を取り除き、また戻す |

`onCancel` は、プラグインもモードも消費しなかった Escape と、Store が
文書の全部を置き換えたとき (`reset: true` の通知) に呼ばれます。
モードは描いていたものを捨て、今のモードのまま留まります。この Escape は
使ったキーとして扱い、モードが消費したキーと同じく既定の動作を止めます。

モードは、ライブラリーのモードと同じようにキーに答えます。`onKeyDown`
は、キーで何かをしたとき (Enter で形を確定した、Backspace で頂点を
消した、Escape で形を捨てたかモードを出た) に true を返し、それ以外
(頂点が足りないときの Enter、頂点が無いときの Backspace) では false を
返します。こうすると、モードが使わなかったキーはページに届きます。

### 窓口が足すもの

`ModeContext` は、プラグインの窓口のうち `extensions` 以外をすべて
持ち、モードに要るものを足します。

- `commitFeature(input)` は、組み込みのモードと同じように地物を作り
  ます。受けられるレイヤーに入れ、新しい ID、自動の名前、基準の
  ズームを付けます。書き込みが拒まれると `null` を返します
- `preview.set(feature, options)` は描いている途中の形を見せ、
  `preview.clear()` は隠します。`confirmedVertices` は、その頂点まで
  の線を実線に、残りを破線にします。`highlightVertex` は、面を閉じる
  最初の頂点のような頂点を目立たせます。形はこの端末の `create` の
  編集を持つ下書き (`draw.sketches`) で、`commitFeature` は書き込む
  地物と一緒にそれを終えます
- `hitTest(point)` は画面の点にある一番手前の地物かデータセットの行を
  返し、`snap(point)` はその点が吸着する先を返します
- `cursor.set(cursor)` と `cursor.reset()` は地図のカーソルを変えます。
  `reset` はモードが `onEnter` で決めたカーソルに戻し、モードが決めた
  カーソルはモードを出るときに外れます
- `writableLayer()` は新しい地物が入るレイヤーを返します。受けられる
  レイヤーが無ければ `null` です
- `listTraceRows(bbox)` は、形がなぞれるデータセットの行を返します
- `setMode(mode)` はモードを変え、`selectionStyle` は選択の見た目を
  返します

モードが有効な間に、レイヤーが地物を受けられなくなることがあります。
削除、ロック、非表示のときです。そのとき `commitFeature` は描いている
途中の形を捨てて `select` に戻り、`null` を返します。

### 吸着

ポインターのイベントは 2 つの位置を持ちます。`lngLat` はポインターの
ある位置で、`snapped.lngLat` は吸着した先です。頂点になる位置には `snapped` を使います。
`snapPreference` で吸着を絞れます。

- `unsnapped` には、位置を吸着させない受け手の名前を並べます。ドラッグ
  で引く線は `onDrag` を外します。こうすると内側の点はポインターに
  付いていき、両端は吸着します
- `prefer` には、同じ距離に候補があるときに優先する地物を書きます。
  なぞり始めた境界などです

描いている途中で好みが変わるモードは、`snapPreference` をゲッターで
書きます。入力のたびに読まれます。

吸着はモードの入力のものです。モードを抜けたとき、`onCancel` を
受けたとき、`unsnapped` で外した入力のときは、エンジンが吸着を
取り返します。地図に記号は残らず、`snap.changed` が `null` で
発火します。

### ドラッグ

ドラッグで描くモードは、ポインターが下りたときに地図のパンを止め、
ドラッグが終わったら戻します。

- `onPointerDown` で `ctx.draw.getMap().dragPan.disable()` を呼び、
  `onDragStart`、`onDrag`、`onDragEnd` で描きます
- `onDragCancel` は、離さずに押し下げが終わったとき (2 本目の指、
  取り消されたタッチ) に届きます。何も作らず、押し下げで始めたものを
  捨てます
- パンは `onDragEnd`、`onDragCancel`、`onExit` で戻します

## 拡張を外す

`add` が返す関数は足したものを外します。2 回目以降に呼んでも何も
起きません。`remove(name)` は同じことを名前で行います。

- プラグインを外すと、まず `onRemove` が呼ばれ、次に
  `ctx.extensions` と `ctx.webgl` で足したものが外れ、GPU に持っていた
  ものが返され、購読が終わります
- 有効なモードを外すと、先に `select` に入ります
- 組み込みのモードと地物の型の名前は使われているので、`add` はそれら
  に `already-exists` を投げます
- 拡張は、足したインスタンスに属します。ページにあるほかの draw の
  インスタンスからは見えません
- `draw.destroy()` は、先にプラグインを外し、それからほかの拡張を
  すべて外します

## 関連する例

- [Plugins](../examples/plugins.ja.md) では、独自のモード、受け取る
  イベント、API を持つプラグインを足し、そのための道具と節を標準の UI に
  足します。キーで、それらをまとめて取り除き、また足します

## リファレンス

- [Plugin](../api/maplibre-gl-draw/interfaces/Plugin.md) と
  [PluginContext](../api/maplibre-gl-draw/interfaces/PluginContext.md)
- [ExtensionContext](../api/maplibre-gl-draw/interfaces/ExtensionContext.md)
- [ExtensionsCollections](../api/maplibre-gl-draw/interfaces/ExtensionsCollections.md)
  と [PluginsCollection](../api/maplibre-gl-draw/interfaces/PluginsCollection.md)
- [ModeFactory](../api/maplibre-gl-draw/type-aliases/ModeFactory.md)、
  [ModeHandler](../api/maplibre-gl-draw/interfaces/ModeHandler.md)、
  [ModeContext](../api/maplibre-gl-draw/interfaces/ModeContext.md)
- [InputHandlers](../api/maplibre-gl-draw/interfaces/InputHandlers.md)、
  [DrawPointerEvent](../api/maplibre-gl-draw/interfaces/DrawPointerEvent.md)、
  [DrawKeyEvent](../api/maplibre-gl-draw/interfaces/DrawKeyEvent.md)
- [SnapPreference](../api/maplibre-gl-draw/interfaces/SnapPreference.md)
- イベントの名前は [DrawEvents](../api/maplibre-gl-draw/interfaces/DrawEvents.md)
