// 見本 7。自分の drag を小さな値にして送り、ほかの人の drag の値を受けて、図形そのものを動かして
// 描く plugin。main の入口だけを使う。
//
// 送る側。drag の event (drag.changed、drag.ended) を聞く。値は、動かし方 (operation) と対象か、
// 頂点の drag なら動かしている頂点 (midpoint の drag なら足す頂点) と今の位置の組の一覧
// (drag.changed の vertices)、handle の drag (付箋の大きさ、円の半径) なら handle が作る途中の
// patch (drag.changed の patch) である。対象は
// 選択の形で名指す。layer を選んでいれば layer の id だけ、地物を選んでいれば id を送る (1,000 件を
// 超える時は送らない)。10 万件の layer を drag しても、値の大きさは件数に比例しない。形の丸ごとは
// 送らない。
//
// 受ける側。受けた値を draw.sketches に足す。document は変えずに、その地物そのものが動いた形で
// 描かれる (元の位置に図形は残らない)。足す人が見た目を決める (人ごとの色)。頂点の drag は、
// 手元の document の形に、名指した頂点だけを置いて描く。相手が離したら sketch に isBeingWritten の印を
// 付ける。相手の書き込みが届いた地物から、sketch を当てずに document の形で描かれるので、2 重に
// 動かず、元の位置にも戻らない。この見本は相手の書き込みが届き終わった事を知らないので、時間で
// 外す (印の後に残っても、書かれた地物には当たらない)。drag をやめた (cancelled) 時はすぐ外す。
//
// 同じ地物を 2 人が掴んだ時。後から掴んだ人が奪う。誰が後から掴んだかを、どの画面でも同じに
// 決めるのはアプリ (takesOver) で、この見本は決めない。奪われた地物と頂点は、自分の drag から
// draw.drag.remove で外す。別々の頂点を 2 人が動かすのは奪い合いにしない (どちらの sketch も
// 当たる)。
//
// 送り方 (send) と受け方 (onMessage) はアプリが渡す。

import type { FeaturePatch, IdSet, Plugin, PluginContext, Selection, SketchEdit, TransformOperation, VertexPlacement } from '@sakuzu/maplibre-gl-draw';

/** What one user is doing now, as a small value */
export type ActivityMessage =
  | {
      readonly kind: 'moving';
      /** Who it is, as the application names its users */
      readonly user: string;
      /** The features: layers, or their IDs */
      readonly target: { readonly layerIds: readonly string[] } | { readonly ids: readonly string[] };
      /** The move, the rotation or the scaling so far */
      readonly operation: TransformOperation;
    }
  | {
      readonly kind: 'placingVertices';
      readonly user: string;
      /** The vertices dragged (or added) and where they are now: never the whole shape */
      readonly vertices: readonly VertexPlacement[];
    }
  | {
      readonly kind: 'updating';
      readonly user: string;
      /** The feature whose handle is dragged (the size of a note, the radius of a circle) */
      readonly featureId: string;
      /** The patch the handle gives now: never the whole feature */
      readonly patch: FeaturePatch;
    }
  /** The drag was let go of: its writes follow */
  | { readonly kind: 'released'; readonly user: string }
  /** Nothing is dragged (the drag was cancelled) */
  | { readonly kind: 'idle'; readonly user: string };

/** The IDs and layers sent at most for one drag */
const MAX_IDS = 1_000;

/** How long a sketch marked `isBeingWritten` stays, when the end of the writes is not known */
const WRITING_MS = 10_000;

export function activityPlugin(options: {
  /** Who this user is */
  user: string;
  /** The color the features another user moves are drawn in */
  colorOf: (user: string) => string;
  /** Sends a message to the other users */
  send: (message: ActivityMessage) => void;
  /** Receives the messages of the other users; returns the function that stops it */
  onMessage: (listener: (message: ActivityMessage) => void) => () => void;
  /**
   * Whether the user of a message grabbed what it moves after this user grabbed it, decided the
   * same way on every screen (the application decides it)
   */
  takesOver: (message: ActivityMessage) => boolean;
}): Plugin {
  let stop = () => {};
  let context: PluginContext | undefined;
  /** The sketches this plugin shows, by their IDs, with the timer of those marked */
  const shown = new Map<string, ReturnType<typeof setTimeout> | undefined>();
  /** The features of the drag of this user going on, as `drag.changed` names them */
  let dragging: IdSet | null = null;

  const remove = (id: string) => {
    clearTimeout(shown.get(id));
    context?.draw.sketches.remove(id);
    shown.delete(id);
  };

  return {
    name: 'activity',
    onAdd(ctx) {
      context = ctx;
      // What this user does: the subscriptions end by themselves when the plugin is removed
      ctx.on('drag.started', ({ featureIds }) => (dragging = featureIds));
      ctx.on('drag.changed', ({ kind, selection, featureIds, operation, vertices, patch }) => {
        dragging = featureIds;
        const message = messageOf(options.user, kind, selection, featureIds, operation, vertices, patch);
        if (message) options.send(message);
      });
      ctx.on('drag.ended', ({ cancelled }) => {
        dragging = null;
        options.send({ kind: cancelled ? 'idle' : 'released', user: options.user });
      });
      // What the others do: their features are drawn moved, in their color
      stop = options.onMessage((message) => {
        if (message.user === options.user) return;
        const id = `activity:${message.user}`;
        if (message.kind === 'idle') {
          remove(id);
          return;
        }
        if (message.kind === 'released') {
          const sketch = ctx.draw.sketches.get(id);
          if (!sketch) return;
          // The writes of that user follow: the features already written are drawn from the document
          ctx.draw.sketches.add({ id, edit: sketch.edit, style: sketch.style, isBeingWritten: true });
          clearTimeout(shown.get(id));
          shown.set(id, setTimeout(() => remove(id), WRITING_MS));
          return;
        }
        if (dragging && options.takesOver(message)) takeOver(ctx, dragging, message);
        const edit: SketchEdit =
          message.kind === 'moving'
            ? { kind: 'transform', target: 'layerIds' in message.target ? message.target : message.target.ids, operation: message.operation }
            : message.kind === 'updating'
              ? { kind: 'update', featureId: message.featureId, patch: message.patch }
              : { kind: 'placeVertices', vertices: message.vertices };
        // The same ID each time: the sketch follows the drag of that user, frame after frame
        ctx.draw.sketches.add({ id, edit, style: { strokeColor: options.colorOf(message.user), lineStyle: 'dashed' } });
        clearTimeout(shown.get(id));
        shown.set(id, undefined);
      });
    },
    onRemove() {
      stop();
      // The sketches an extension adds are not removed by themselves
      for (const id of [...shown.keys()]) remove(id);
    },
  };
}

/** The message of a drag of this user, or `null` when there is nothing small enough to send */
function messageOf(
  user: string,
  kind: 'feature' | 'vertex' | 'handle',
  selection: Selection,
  featureIds: IdSet,
  operation: TransformOperation | null,
  vertices: readonly VertexPlacement[] | null,
  patch: FeaturePatch | null,
): ActivityMessage | null {
  if (kind === 'vertex' && vertices) return { kind: 'placingVertices', user, vertices };
  // A drag of a handle that gives a patch: the patch is sent, never the whole feature
  if (kind === 'handle' && patch && featureIds.count() === 1) {
    const [featureId] = featureIds.iterate();
    return { kind: 'updating', user, featureId, patch };
  }
  if (kind !== 'feature' || !operation || selection.ids.count() > MAX_IDS) return null;
  if (selection.type === 'layer') return { kind: 'moving', user, target: { layerIds: selection.ids.toArray() }, operation };
  if (selection.type === 'feature') return { kind: 'moving', user, target: { ids: selection.ids.toArray() }, operation };
  return null;
}

/** Takes out of the drag of this user what the user of the message grabbed after this user */
function takeOver(ctx: PluginContext, dragging: IdSet, message: ActivityMessage): void {
  const { draw } = ctx;
  if (message.kind === 'placingVertices') {
    // The same vertex only: different vertices of one feature are moved by both, and a vertex
    // the other user adds is a new one
    for (const { featureId, vertex, added } of message.vertices) {
      if (!added && dragging.has(featureId)) draw.drag.remove({ featureId, vertices: [vertex] });
    }
    return;
  }
  if (message.kind === 'updating') {
    // A feature whose handle is grabbed is taken out whole
    if (dragging.has(message.featureId)) draw.drag.remove([message.featureId]);
    return;
  }
  if (message.kind !== 'moving') return;
  // A feature grabbed whole is taken out whole, also from a drag of its vertices
  const ids =
    'ids' in message.target
      ? message.target.ids.filter((id) => dragging.has(id))
      : // A drag of this user is a few features most of the time: their layers are read one by one
        [...dragging.iterate()].filter((id) => {
          const layerId = draw.features.get(id)?.layerId;
          return layerId !== undefined && 'layerIds' in message.target && message.target.layerIds.includes(layerId);
        });
  if (ids.length > 0) draw.drag.remove(ids);
}
