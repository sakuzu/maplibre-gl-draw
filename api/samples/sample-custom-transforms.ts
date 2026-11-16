// 見本 6。座標の計算を 1 つ置いて、移動と回転 (と拡大) を自分の式で行う plugin。main の入口だけを
// 使う。
//
// 地球を球とみなし、移動は「from を to へ運ぶ球の回転」、回転は「中心を軸にした球の
// 回転」で計算する。どちらも形を保つ。拡大は中心の正距方位の平面の上で行う。
// 数の配列のまま受けて配列のまま返すので、10 万件でも地物ごとの object を作らない。
//
// 組み込みの計算 (WGS 84 の楕円体の東と北の軸、ENU) と同じ操作を、別の決まりで計算する例で
// ある。drag の途中は組み込みの式で描かれ、離した時にこの計算で書かれる。球と楕円体の差は
// 小さな範囲では画素より小さいが、大陸ほどの範囲を動かすと、離した時に形が少し動いて見える。
// 計算できない操作 (値が有限でない物) は accepts で断る。plugin を外すと組み込みの計算に戻る。

import type { Plugin, TransformInput, TransformOperation, TransformOutput, TransformProvider } from '@sakuzu/maplibre-gl-draw';

const RADIUS_METERS = 6_371_008.8;
const RAD = Math.PI / 180;

type Vector = [number, number, number];

const toVector = (lng: number, lat: number): Vector => [
  Math.cos(lat * RAD) * Math.cos(lng * RAD),
  Math.cos(lat * RAD) * Math.sin(lng * RAD),
  Math.sin(lat * RAD),
];

const cross = (a: Vector, b: Vector): Vector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A rotation of the sphere about a unit axis, by an angle in radians (Rodrigues) */
function rotation(axis: Vector, angle: number) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (v: Vector): Vector => {
    const k = cross(axis, v);
    const d = dot(axis, v) * (1 - cos);
    return [
      v[0] * cos + k[0] * sin + axis[0] * d,
      v[1] * cos + k[1] * sin + axis[1] * d,
      v[2] * cos + k[2] * sin + axis[2] * d,
    ];
  };
}

/** Distance in meters and bearing in radians (clockwise from the north) from `a` to `b` */
function polar(a: [number, number], b: [number, number]) {
  const [lng1, lat1, lng2, lat2] = [a[0] * RAD, a[1] * RAD, b[0] * RAD, b[1] * RAD];
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2;
  const distance = 2 * RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
  return { distance, bearing: Math.atan2(y, x) };
}

/** The point at a distance in meters and a bearing in radians from `a` */
function destination(a: [number, number], distance: number, bearing: number): [number, number] {
  const [lng1, lat1] = [a[0] * RAD, a[1] * RAD];
  const d = distance / RADIUS_METERS;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
  const lng2 = lng1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [lng2 / RAD, lat2 / RAD];
}

const angle360 = (degrees: number) => ((degrees % 360) + 360) % 360;

/** What moves one position: `[longitude, latitude]` in, `[longitude, latitude]` out */
function positionMover(operation: TransformOperation, uniform: boolean): (lng: number, lat: number) => [number, number] {
  const viaVector = (turn: (v: Vector) => Vector) => (lng: number, lat: number): [number, number] => {
    const v = turn(toVector(lng, lat));
    return [Math.atan2(v[1], v[0]) / RAD, Math.asin(Math.max(-1, Math.min(1, v[2]))) / RAD];
  };
  switch (operation.kind) {
    case 'translate': {
      const from = toVector(operation.from[0], operation.from[1]);
      const to = toVector(operation.to[0], operation.to[1]);
      const axis = cross(from, to);
      const length = Math.hypot(...axis);
      if (length === 0) return (lng, lat) => [lng, lat];
      return viaVector(rotation([axis[0] / length, axis[1] / length, axis[2] / length], Math.atan2(length, dot(from, to))));
    }
    case 'rotate':
      // Counterclockwise seen from above is a positive turn about the axis out of the center
      return viaVector(rotation(toVector(operation.center[0], operation.center[1]), operation.counterclockwiseDegrees * RAD));
    case 'scale': {
      const center: [number, number] = [operation.center[0], operation.center[1]];
      const east = uniform ? operation.sizeFactor : operation.eastFactor;
      const north = uniform ? operation.sizeFactor : operation.northFactor;
      return (lng, lat) => {
        const { distance, bearing } = polar(center, [lng, lat]);
        const e = distance * Math.sin(bearing) * east;
        const n = distance * Math.cos(bearing) * north;
        return destination(center, Math.hypot(e, n), Math.atan2(e, n));
      };
    }
  }
}

export const sphereTransforms: TransformProvider = {
  name: 'sphere',
  accepts(operation) {
    const numbers =
      operation.kind === 'translate'
        ? [...operation.from, ...operation.to]
        : operation.kind === 'rotate'
          ? [...operation.center, operation.counterclockwiseDegrees]
          : [...operation.center, operation.eastFactor, operation.northFactor, operation.sizeFactor];
    return numbers.every(Number.isFinite);
  },
  apply(operation: TransformOperation, input: TransformInput, output: TransformOutput) {
    const { coordinates, valuesPerPosition: n, positionStarts } = input;
    const movers = [positionMover(operation, false), positionMover(operation, true)];
    const turn = operation.kind === 'rotate' ? operation.counterclockwiseDegrees : 0;
    for (let feature = 0; feature < input.featureCount; feature += 1) {
      const move = movers[input.isScaledUniformly?.[feature] ?? 0];
      for (let at = positionStarts[feature] * n; at < positionStarts[feature + 1] * n; at += n) {
        const [lng, lat] = move(coordinates[at], coordinates[at + 1]);
        output.coordinates[at] = lng;
        output.coordinates[at + 1] = lat;
        for (let k = 2; k < n; k += 1) output.coordinates[at + k] = coordinates[at + k];
      }
      if (input.rotationDegrees && output.rotationDegrees) {
        const angle = input.rotationDegrees[feature];
        output.rotationDegrees[feature] = turn === 0 ? angle : angle360((Number.isNaN(angle) ? 0 : angle) + turn);
      }
      if (input.bearingDegrees && output.bearingDegrees) {
        output.bearingDegrees[feature] = angle360(input.bearingDegrees[feature] - turn); // NaN stays NaN
      }
      if (input.size && output.size) {
        const size = input.size[feature];
        output.size[feature] = operation.kind === 'scale' ? (Number.isNaN(size) ? 1 : size) * operation.sizeFactor : size;
      }
    }
  },
};

/** The plugin: what moves, rotates and scales the features is computed on the sphere */
export function sphereTransformsPlugin(): Plugin {
  return {
    name: 'sphereTransforms',
    onAdd(ctx) {
      // Taken back with the plugin, as everything it sets through its context
      ctx.extensions.setTransformProvider(sphereTransforms);
    },
  };
}
