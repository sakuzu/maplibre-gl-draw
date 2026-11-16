// 見本 8。地物の名前を、地図の上の HTML の札にして出し、drag の途中も図形について行かせる plugin。
// main の入口だけを使う。
//
// drag の間は document に何も書かれない。図形は sketch で動いた形に描かれる (自分の drag も、
// 頂点の drag も、ほかの plugin が足した sketch も)。札は draw.rendered で「今描かれている形」を
// 読むので、書かれる前から図形について行く。document の値 (draw.features) を読むと、離して
// 書かれるまで元の位置に残ってしまう。離した後は、sketch に isBeingWritten の印が付き、書き込みが届いた
// 地物から document の形で描かれる。rendered もその形を答えるので、札は飛ばない。
//
// 自分の drag の sketch は drag.changed の前に替わるので、drag.changed の中で読む rendered は
// その時の形である。
//
// 札を出すのは名前を持つ地物のうち、名指した物だけ (数件)。地図が描くたびに位置を読み直す。

import type { Feature, Plugin } from '@sakuzu/maplibre-gl-draw';
import type { Position } from 'geojson';

export function followingLabelsPlugin(options: {
  /** The element over the map that holds the labels */
  container: HTMLElement;
  /** The features that get a label */
  featureIds: readonly string[];
}): Plugin {
  const labels = new Map<string, HTMLElement>();
  let stop = () => {};
  return {
    name: 'followingLabels',
    onAdd(ctx) {
      const map = ctx.draw.getMap();
      const place = () => {
        // The shapes as they are drawn: moved by a drag, or by a sketch, before anything is written
        const features = ctx.draw.rendered.getMany(options.featureIds);
        features.forEach((feature, i) => {
          const id = options.featureIds[i];
          const name = feature?.properties.name;
          const label = labels.get(id) ?? newLabel(options.container, id, labels);
          if (!feature || typeof name !== 'string') {
            label.hidden = true;
            return;
          }
          const [x, y] = ctx.screen.project(anchorOf(feature));
          label.hidden = false;
          label.textContent = name;
          label.style.transform = `translate(${x}px, ${y}px)`;
        });
      };
      // Once per frame of the map, and at each move of a drag of this user
      map.on('render', place);
      ctx.on('drag.changed', place);
      stop = () => map.off('render', place);
      place();
    },
    onRemove() {
      stop();
      for (const label of labels.values()) label.remove();
      labels.clear();
    },
  };
}

function newLabel(container: HTMLElement, id: string, labels: Map<string, HTMLElement>): HTMLElement {
  const label = document.createElement('div');
  label.className = 'feature-label';
  container.append(label);
  labels.set(id, label);
  return label;
}

/** Where the label of a feature goes: its point, or the first position of its shape */
function anchorOf(feature: Feature): Position {
  const geometry = feature.geometry;
  switch (geometry.type) {
    case 'Point':
      return geometry.coordinates;
    case 'LineString':
    case 'MultiPoint':
      return geometry.coordinates[0];
    case 'Polygon':
    case 'MultiLineString':
      return geometry.coordinates[0][0];
    case 'MultiPolygon':
      return geometry.coordinates[0][0][0];
    default:
      return [0, 0];
  }
}
