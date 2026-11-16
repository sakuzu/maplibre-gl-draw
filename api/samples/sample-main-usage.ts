// 見本 1。main の入口の使い方を 1 つのファイルにまとめた物 (第 3 稿の宣言に合わせた)。
//
// main の入口だけを使う。Store の入口は import しない。`map` は maplibre-gl の地図、`idA` と
// `idB` は地物の id、`layerId` と `otherLayerId` は layer の id、`file` は利用者が選んだファイル、
// `showInfoPanel` と `writeChunk` はアプリの関数とする。

import {
  createDraw,
  createIdSet,
  DrawError,
  type FeatureInput,
  type FeatureRenderer,
  type ModeFactory,
  type Plugin,
  type Position,
} from '@sakuzu/maplibre-gl-draw';
import type { Polygon } from 'geojson';
import type { Map as MaplibreMap } from 'maplibre-gl';

declare const map: MaplibreMap;
declare const idA: string;
declare const idB: string;
declare const layerId: string;
declare const otherLayerId: string;
declare const file: File;
declare function showInfoPanel(features: unknown[]): void;
declare function writeChunk(text: string): Promise<void>;

export async function examples(): Promise<void> {
  // 1. 最初の例。mode の名前は camelCase
  const draw = createDraw(map);
  draw.setMode('drawPolygon');
  draw.on('feature.created', ({ feature }) => {
    console.log('created', feature.id, feature.type);
  });

  // 2. 地物を作って、更新して、消す。1 件の書き込みは返った時に終わっている
  const point = draw.features.create({
    type: 'Point',
    geometry: { type: 'Point', coordinates: [139.767, 35.681] },
    properties: { name: 'Tokyo' },
  });
  if (point) {
    draw.features.update(point.id, { style: { pointColor: '#e11d48' } });
    // 地物ごとに違う patch を、全部か無しで 1 回に書く (main の updateMany)
    draw.features.updateMany([
      { id: point.id, patch: { properties: { name: 'Tokyo Station' } } },
      { id: idA, patch: { visible: false } },
    ]);
    draw.features.delete(point.id);
  }
  try {
    draw.features.delete('no-such-id');
  } catch (error) {
    if (error instanceof DrawError && error.code === 'notFound') {
      console.warn('already gone');
    }
  }

  // 3. layer と group。中の id は件数と範囲 (start から end の手前まで) で読む
  const layer = draw.layers.create({ name: 'Sites' });
  if (layer) {
    draw.layers.setActive(layer.id);
    console.log(draw.layers.countItems(layer.id));
  }
  const site = draw.groups.create({ featureIds: [idA, idB], name: 'Site' });
  if (site) {
    const n = draw.groups.countFeatures(site.id);
    console.log(draw.groups.listFeatureIds(site.id, { start: 0, end: n }));
  }

  // 4. 選択。id は配列でなく id の集まり (IdSet) で読む。いくつもの layer の地物を配列なしで選べる
  draw.selection.set('feature', [idA, idB]);
  const selected = draw.selection.features();
  const { ids } = draw.selection.get();
  console.log(selected.length, ids.count(), ids.has(idA));
  draw.selection.set('feature', { layerIds: [layerId, otherLayerId] });
  await draw.selection.delete();

  // 5. 読み込み。10 万件でも分けて書くので、画面は止まらない。結果は件数で返る
  const saved = localStorage.getItem('drawing');
  if (saved !== null) {
    const loaded = await draw.document.load(JSON.parse(saved));
    if (loaded) console.log(`${loaded.changedCount} loaded, stopped: ${loaded.stopped}`);
  }

  // 6. read-only の viewer。選択が 10,000 件を超えうる画面は、件数を見てから配列を読む
  draw.setInteractionLocked(true);
  draw.setReadOnly(true);
  draw.on('selection.changed', ({ selection }) => {
    if (selection.ids.count() <= 10_000) showInfoPanel(draw.selection.features());
  });
  draw.hidden.add(layerId);
  console.log(draw.hidden.list().count());
  draw.setReadOnly(false);
  draw.setInteractionLocked(false);

  // 7. plugin。画像を読めなかった時の event は image.failed。選べる物を id の集まりで絞る
  const logger: Plugin = {
    name: 'logger',
    onAdd(ctx) {
      ctx.on('feature.created', ({ feature, source }) => {
        console.log('created', feature.id, feature.type, source);
      });
      ctx.on('image.failed', ({ error }) => console.warn(error.code));
    },
    interaction: {
      // 名前が「固定」で始まる地物は選ばせない。候補の集まりを配列にせずに読み、地物を作らずに
      // 属性を 1 つだけ読んで絞る (10 万件の箱の選択でも地物を 10 万個作らない)
      filterSelection(candidates) {
        const isFixed = (id: string) => {
          const name = draw.features.getProperty(id, 'name');
          return typeof name === 'string' && name.startsWith('固定');
        };
        for (const id of candidates.iterate()) {
          // 1 件でも外す物があれば、残す物だけの集まりを作る (配列は作らない)
          if (isFixed(id)) return createIdSet(kept(candidates.iterate(), isFixed));
        }
        return candidates;
      },
    },
  };
  draw.extensions.plugins.add(logger);

  // 7. mode を足す。名前は camelCase
  const rectangle = (a: Position, b: Position): FeatureInput => ({
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]],
    },
  });
  const drawRectangle: ModeFactory = (ctx) => {
    let first: Position | null = null;
    return {
      writes: true,
      onClick(event) {
        if (!first) {
          first = event.snapped.lngLat;
          return true;
        }
        ctx.commitFeature(rectangle(first, event.snapped.lngLat));
        first = null;
        return true;
      },
    };
  };
  draw.extensions.modes.add('drawRectangle', drawRectangle);
  draw.setMode('drawRectangle');

  // 7. 組み込みの mode を置き換える。plugin を外すと組み込みの drawPoint に戻る
  const namedPoints: Plugin = {
    name: 'namedPoints',
    onAdd(ctx) {
      ctx.extensions.modes.override('drawPoint', (modeCtx) => ({
        writes: true,
        onClick(event) {
          modeCtx.commitFeature({
            type: 'Point',
            geometry: { type: 'Point', coordinates: event.snapped.lngLat },
          });
          return true;
        },
      }));
    },
  };
  const removeNamedPoints = draw.extensions.plugins.add(namedPoints);
  removeNamedPoints();

  // 7. 型を足す。回転の角を持つ看板の型は、回る欄と大きさの欄を宣言する
  const zoneRenderer: FeatureRenderer = {
    onAdd() {},
    draw(feature, ctx) {
      const rings = (feature.geometry as Polygon).coordinates;
      ctx.fill.draw(rings, { color: '#2563eb', opacity: 0.2 * ctx.opacity });
    },
    onRemove() {},
  };
  draw.extensions.featureTypes.add({
    type: 'Signboard',
    geometry: 'Polygon',
    renderer: zoneRenderer,
    transformFields: { rotationDegreesKey: 'boardAngle', sizeKey: 'boardScale', isScaledUniformly: true },
  });

  // 8. 10 万件を読み込んで、全部を 30 度回す。layer を対象にして 1 行で回す
  const result = await draw.document.load(file, { layer: { name: 'Buildings' } });
  if (result?.layerId) {
    console.log(`${result.featureIds.count()} read`);
    const { lng, lat } = map.getCenter();
    const turned = await draw.features.rotate(
      { layerIds: [result.layerId] },
      { center: [lng, lat], counterclockwiseDegrees: 30 },
    );
    if (turned) console.log(`${turned.changedCount} turned, ${turned.lockedCount} locked, ${turned.missingCount} missing`);
    // 位置から位置への移動と、東と北の倍率の拡大。対象は選択でもよい
    draw.selection.set('feature', [idA]);
    await draw.features.translate({ selection: true }, { from: [lng, lat], to: [lng + 0.001, lat] });
    await draw.features.scale([idA], { center: [lng, lat], eastFactor: 2, northFactor: 2, sizeFactor: 2 });
    // 同じ値をまとめて書く、写す、消す。どれも同じ形の結果
    await draw.features.updateAll({ layerIds: [result.layerId] }, { style: { fillColor: '#f97316' } });
    const copies = await draw.features.duplicate([idA, idB], {
      offset: { from: [lng, lat], to: [lng, lat + 0.001] },
    });
    if (copies?.createdIds) console.log(`${copies.createdIds.count()} copies`);
    await draw.features.deleteMany(copies?.createdIds ?? []);
  }

  // 9. layer の中身を 1 件ずつ読む。iterate は始めた時の地物を読み、途中で書かれても飛ばさず
  //    2 度読まない (位置の範囲で読む listItemIds は、間に書かれると位置がずれる)
  for (const feature of draw.features.iterate({ layerId })) {
    console.log(feature.id);
  }

  // 10. 10 万件の文書を、部分ずつファイルに書き出す。1 つの時点の文書にするため、書き途中の
  //     編集を待ち、書く間は見るだけにする
  await draw.waitForWrites();
  draw.setReadOnly(true);
  try {
    for await (const part of draw.document.stringify('geojson', { featuresPerPart: 2_000 })) {
      await writeChunk(part);
    }
  } finally {
    draw.setReadOnly(false);
  }
}

/** The IDs that are not left out, one at a time */
function* kept(ids: Iterable<string>, isLeftOut: (id: string) => boolean): Generator<string> {
  for (const id of ids) if (!isLeftOut(id)) yield id;
}
