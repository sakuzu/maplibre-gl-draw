// 見本 2。main の入口だけで書いた、小さな undo と redo の plugin。
//
// 記録は document の変更の通知から作る。変更前の値 (FeatureValues。中身は見ない) を、この
// client の編集の出どころにだけ求めて購読し、通知の物をそのまま持つ (写さない)。戻す時は
// draw.features.restore に渡す。restore は read-only を確かめ、ignoreLocks で lock された物も
// 戻し、分けて書く。Store には書かない。
//
// - 1 件の編集。1 つの操作 (operationId) が 1 段になる
// - 10 万件の移動。core が分けて書いた通知 (hasMoreParts) を、同じ operationId で 1 段にまとめる。
//   途中で止まった操作も、最後の通知 (stopped) で段を閉じる
// - drag。drag の間は何も書かれず、離した時の 1 つの操作が 1 段になる
// - 10 万件の削除と layer の削除。消した地物は変更前の値が取っておき、restore で元の場所に戻る。
//   layer は先に、変更が運ぶ並びの位置 (orderChanged.previous) に作り直す
// - 頂点の編集。restore は、その変更が動かした頂点、足した頂点、消した頂点だけを戻す。後から
//   ほかの編集が動かした別の頂点は残る
// - group は地物の入れ物で、restore が地物と一緒に戻す (作った、消した、動かした、値を
//   変えた、の全部)
// - layer の変更 (作った、変えた、消した layer と並び順) は、変更が運ぶ前の値 (object) を
//   draw.layers で書き戻す。metadata も同じく draw.metadata で書き戻す
// - 書き途中の編集がある時の undo。waitForWrites で書き終わるのを待ってから戻す
// - 変更前の値は、書き戻した分だけ使われる。redo と、もう 1 度の undo は、書き戻しの変更が運ぶ
//   新しい値を使う。断られた時 (null) は何も書かれず、段を戻す。途中で止まった時 (read-only) は、
//   段を手放さず undo の段に残す。次の undo は同じ値を渡し、残りが書かれる (続き)。止まった
//   書き戻しと、その続きの書き戻しの逆は、1 つのやり直しの段にまとめる
// - 持つ量の上限。FeatureValues.byteLength で数え、超えたら古い段から手放す。plugin を外す時は
//   持つ値を全部手放す (購読をやめても値は手放されない)
//
// 選択は戻さない (選択は instance の状態で、この見本の外)。

import type { DocumentChange, FeatureValues, Layer, Metadata, Plugin, PluginContext } from '@sakuzu/maplibre-gl-draw';

/** One step: what one edit changed, to be written back */
interface Step {
  /** The values the features had before, in the order the changes arrived */
  values: FeatureValues[];
  /** The layers, order and metadata before, in the order the changes arrived */
  others: DocumentChange[];
}

/** What the plugin offers (`draw.extensions.plugins.getApi<UndoApi>('undo')`) */
export interface UndoApi {
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  canUndo(): boolean;
  canRedo(): boolean;
}

/** The sources recorded: the edits of this client, and the writing back of this plugin */
const RECORDED = ['local', 'batch', 'undo', 'redo'] as const;

export function undoPlugin(options: { maxSteps?: number; maxBytes?: number } = {}): Plugin<UndoApi> {
  const maxSteps = options.maxSteps ?? 100;
  const maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
  let ctx: PluginContext;
  const undoSteps: Step[] = [];
  const redoSteps: Step[] = [];
  /** The step of the operation still being written, by its operationId */
  const open = new Map<number, Step>();
  /** The step the writing back of this plugin is gathering (one undo makes several operations) */
  let writing: { source: 'undo' | 'redo'; step: Step } | null = null;
  /**
   * For a step whose writing back stopped half way, the step gathered so far: the writing back
   * that goes on adds to it, so that the stopped part and the rest make one step the other way
   */
  const partial = new Map<Step, Step>();
  let unsubscribe = () => {};

  const release = (steps: Iterable<Step>) => {
    const all = [...steps];
    // A step that stopped half way lets go of what it gathered too; letting go of its values lets
    // go of the rest it did not write
    for (const step of all) {
      const gathered = partial.get(step);
      if (gathered) all.push(gathered);
      partial.delete(step);
    }
    ctx.draw.features.releaseValues(all.flatMap((step) => step.values));
  };
  const bytes = (steps: Step[]) =>
    steps.reduce((sum, step) => sum + step.values.reduce((n, values) => n + values.byteLength, 0), 0);
  const push = (steps: Step[], step: Step) => {
    steps.push(step);
    while (steps.length > maxSteps || (steps.length > 1 && bytes(steps) > maxBytes)) {
      release(steps.splice(0, 1));
    }
  };

  const record = (change: DocumentChange) => {
    if (change.reset) {
      // The whole document was replaced: nothing recorded applies to it any more
      release(undoSteps.splice(0));
      release(redoSteps.splice(0));
      release([...open.values()]);
      open.clear();
      return;
    }
    if (!(RECORDED as readonly string[]).includes(change.source)) {
      if (change.previousValues) ctx.draw.features.releaseValues([change.previousValues]);
      return;
    }
    // The writing back of this plugin goes to its own step, whatever its operations are
    const step = writing && change.source === writing.source ? writing.step : open.get(change.operationId) ?? newStep();
    if (change.previousValues) step.values.push(change.previousValues);
    // The layers, the order and the metadata (the groups come back with `restore`)
    if (change.layers || change.metadata) step.others.push(change);
    if (step === writing?.step) return;
    if (change.hasMoreParts) {
      open.set(change.operationId, step);
      return;
    }
    open.delete(change.operationId);
    if (step.values.length === 0 && step.others.length === 0) return;
    // A new edit of the user (or a redo) makes the steps that were undone useless
    if (change.source !== 'undo') {
      if (change.source !== 'redo') release(redoSteps.splice(0));
      push(undoSteps, step);
    } else push(redoSteps, step);
  };

  /**
   * Writes back one step, as one edit of the source given
   *
   * @returns The counts of the writing back of the features, or `null` when it was refused
   */
  const writeBack = async (step: Step, source: 'undo' | 'redo') => {
    const { draw } = ctx;
    const changes = [...step.others].reverse();
    const options = { source, ignoreLocks: true };
    // The layers the features go back to come first, at the place they had in the order
    draw.transact(() => {
      for (const change of changes) {
        const before = change.layers?.orderChanged?.previous ?? [];
        for (const layer of change.layers?.deleted ?? []) {
          // Made again before, by a writing back that stopped half way
          if (draw.layers.has(layer.id)) continue;
          const index = before.indexOf(layer.id);
          draw.layers.create({ ...layerInput(layer), ...(index >= 0 && { index }) });
        }
        for (const { id, previous } of change.layers?.updated ?? []) draw.layers.update(id, layerPatch(previous));
      }
    }, options);
    // The features (vertex by vertex for their geometries), with the groups that hold them
    // (every change of them), in parts
    const counts = await draw.features.restore(step.values, options);
    if (!counts || counts.stopped) return counts;
    // The metadata comes back, and the layers the step created go
    draw.transact(() => {
      for (const change of changes) {
        if (change.metadata) draw.metadata.update(metadataPatch(change.metadata.previous, change.metadata.keys));
      }
    }, options);
    for (const change of changes) {
      // Deleting a layer is a bulk edit of its own
      for (const layer of change.layers?.created ?? []) if (draw.layers.has(layer.id)) await draw.layers.delete(layer.id, options);
      if (change.layers?.orderChanged && !change.layers.created && !change.layers.deleted) {
        draw.transact(() => draw.layers.reorder(change.layers?.orderChanged?.previous ?? []), options);
      }
    }
    return counts;
  };

  const move = async (from: Step[], source: 'undo' | 'redo') => {
    const { draw } = ctx;
    if (writing || draw.isReadOnly() || draw.isInteractionLocked()) return false;
    // An edit still being written (a drag let go of a moment ago) ends first
    await draw.waitForWrites();
    const step = from.pop();
    if (!step) return false;
    // A step that stopped before goes on: what its writing back gathered so far is added to
    const done = partial.get(step) ?? newStep();
    partial.delete(step);
    writing = { source, step: done };
    let counts;
    try {
      counts = await writeBack(step, source);
    } finally {
      writing = null;
    }
    if (!counts || counts.stopped) {
      // Refused (nothing written), or stopped half way (read-only): the step stays, and the next
      // undo gives the same values, which write the rest. What was written back so far waits for
      // the rest, to make one step the other way with it
      if (done.values.length > 0 || done.others.length > 0) partial.set(step, done);
      from.push(step);
      return false;
    }
    if (done.values.length > 0 || done.others.length > 0) push(source === 'undo' ? redoSteps : undoSteps, done);
    // The features the step deleted are back: its values keep nothing that is needed
    release([step]);
    return true;
  };

  const api: UndoApi = {
    // A shape being drawn takes its last vertex back first (the drawing modes keep it)
    undo: async () => (ctx.drawing.isDrawing() ? ctx.drawing.undoVertex() : move(undoSteps, 'undo')),
    redo: async () => (ctx.drawing.isDrawing() ? ctx.drawing.redoVertex() : move(redoSteps, 'redo')),
    canUndo: () => undoSteps.length > 0,
    canRedo: () => redoSteps.length > 0,
  };

  return {
    name: 'undo',
    api,
    onAdd(context) {
      ctx = context;
      unsubscribe = context.draw.document.subscribe(record, { previousValues: RECORDED });
    },
    onRemove() {
      // Unsubscribing lets go of nothing: every value kept is let go of here
      unsubscribe();
      release(undoSteps.splice(0));
      release(redoSteps.splice(0));
      release(open.values());
      open.clear();
      if (writing) release([writing.step]);
      for (const gathered of partial.values()) ctx.draw.features.releaseValues(gathered.values);
      partial.clear();
    },
    input: {
      onKeyDown(event) {
        if (event.key.toLowerCase() !== 'z' || !(event.modifiers.ctrl || event.modifiers.meta)) return false;
        void (event.modifiers.shift ? api.redo() : api.undo());
        return true;
      },
    },
  };
}

function newStep(): Step {
  return { values: [], others: [] };
}

const layerInput = (layer: Layer) => ({
  id: layer.id,
  name: layer.name,
  visible: layer.visible,
  locked: layer.locked,
  opacity: layer.opacity,
  ...(layer.styleRule && { styleRule: layer.styleRule }),
  ...(layer.metadata && { metadata: layer.metadata }),
});

const layerPatch = (layer: Layer) => ({
  name: layer.name,
  visible: layer.visible,
  locked: layer.locked,
  opacity: layer.opacity,
  styleRule: layer.styleRule,
  ...(layer.metadata && { metadata: layer.metadata }),
});

/** The keys the change wrote, with the values they had before (`undefined` takes off a key it added) */
const metadataPatch = (previous: Metadata, keys: readonly string[]): Partial<Metadata> =>
  Object.fromEntries(keys.map((key) => [key, (previous as Record<string, unknown>)[key]])) as Partial<Metadata>;
