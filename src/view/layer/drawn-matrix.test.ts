// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of what is drawn: every kind of feature and every edit, on a Store of objects and on
 * a Store of rows, compared by what reaches the renderers
 *
 * A row is a kind of feature and a list of steps (create, change the line style, the colors and
 * the width, move, delete, write the values before back and again, hide and show, select and
 * clear the selection, a write from elsewhere). After each step both instances draw a frame, and
 * what each drew is read in the order it was drawn, as the primitives a renderer is given:
 *
 * - the Store of objects (what the others are compared with) is drawn by the layer loop of
 *   `render.ts` in immediate mode: every feature to display goes to `processFeature` of the
 *   target, or to the renderer of its custom type, and is read as the batches of `BatchManager`
 *   make it (`primitivesOf`)
 * - the Store of rows is drawn by the drawing of the layers held as rows (`TableLayerRenderer`,
 *   wired to the tables as an instance wires it) with the renderer of the rows on a GL that keeps
 *   what is written to its buffers and textures (`memoryGL`): every range of rows drawn in one
 *   draw is read back from what the GPU holds (the instances, the coordinates, the styles of the
 *   rows and of the layer, the state of the rows), and the rows drawn at once as features
 *
 * The frames are drawn as a map draws them: one when the instance asked for one (a change of
 * its Store, rows written or waiting, a change of a delta, a build left), and what a cell reads
 * is what the last frame drew, once nothing asks for another. Besides the primitives, what the
 * program reads of every row (all the values of its style, its style texel, the range and the
 * length before of each instance) is compared with a drawing of the rows made afresh.
 *
 * The features are drawn among others (every kind with the styles the rows give, so the numbers
 * of the styles are shared), in a view around them. A row is run four ways: the feature made
 * after the others or with them (the rows of a Store of rows then given as row blocks built
 * elsewhere, as a copy of a document gives them), not selected (its row as it is) or selected
 * from its creation on (its row opened). A cell that differs is written with the first step that
 * differs and the primitives of both, and whether a drawing made afresh draws the same. The cells
 * that differ now are listed with their causes in `KNOWN_DIFFERENCES`. With `DRAWN_MATRIX_OUT`
 * set to a path, the table is written there as Markdown (`DRAWN_MATRIX_TRACE` writes what each
 * step drew).
 */

import { writeFileSync } from 'node:fs';
import type { Geometry, Point } from 'geojson';
import type { ProjectionData } from 'maplibre-gl';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraw, type Draw } from '../../api/draw.js';
import type { DocumentChange } from '../../api/events.js';
import type { FeatureTypeDefinition } from '../../api/extension/feature-type.js';
import type { FeaturePatch, FeatureStyle } from '../../api/model.js';
import type { FeatureTypeHandler, FrameDrawContext } from '../../extension/index.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import type { RowGroup } from '../../feature-table/layer-table.js';
import { rowFeatureToRead } from '../../feature-table/row-read.js';
import { generateCirclePolygon } from '../../geometry/circle.js';
import { createRowBlockBuilder, createRowValues } from '../../kasane/index.js';
import { drawPropertyKey } from '../../shared/properties.js';
import { getCircleRadius, getCreatedZoom } from '../../shared/utils/property.js';
import { RELEASE_DELAY_MS } from '../../store/draw-store.js';
import { getDisplayFeatures } from '../../store/local-visibility.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Coordinate, Feature, Layer } from '../../store/types.js';
import { createMapStub, createTestDrawer, memoryGL } from '../../test-utils.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { GpuLedger } from '../gpu-ledger.js';
import { toPointInstanceData } from '../renderers/batch-manager.js';
import { retainedDrawRun } from '../renderers/draw-run.js';
import type { FeatureDrawer } from '../renderers/drawer.js';
import { dashSegmentLength } from '../renderers/line/dash.js';
import { toLineInstanceColor } from '../renderers/line/line-geometry.js';
import { pointShapeCode, toInstancedPointShape } from '../renderers/point/point-instance.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import type { RowStateBinding } from '../renderers/row-state.js';
import {
  ROWS_DASH,
  ROWS_KIND,
  ROWS_STYLE_FLOATS,
  readRowsInstance,
} from '../renderers/rows/rows-format.js';
import { type RowsChunk, RowsRenderer } from '../renderers/rows/rows-renderer.js';
import { beginRenderFrame } from '../shaders/frame.js';
import { TerrainContext } from '../terrain/context.js';
import { renderLayers } from './render.js';
import type { Renderers } from './renderers.js';
import type { StoreImmediateTarget } from './store-retained-immediate.js';
import { TableLayerRenderer } from './table-retained.js';

const PROJECTION = {
  mainMatrix: new Float32Array(16),
  projectionTransition: 0,
} as unknown as ProjectionData;

const ZOOM = 10;
const CREATED_ZOOM = drawPropertyKey('createdZoom');
const RADIUS = drawPropertyKey('radiusMeters');

// ============================================================================
// The primitives drawn
// ============================================================================

/** A coordinate as it is written (the comparison allows for float32, `sameLine`) */
function at(x: number, y: number): string {
  return `${round(x, 1e7)},${round(y, 1e7)}`;
}

function round(value: number, scale: number): number {
  const r = Math.round(value * scale) / scale;
  return Object.is(r, -0) ? 0 : r;
}

function color(c: ArrayLike<number>): string {
  return `rgba(${[c[0], c[1], c[2], c[3]].map((v) => round(v, 1e3)).join(',')})`;
}

const DASH_NAMES = ['solid', 'dashed', 'dotted'] as const;

/** A ring without the position that closes it */
function openRing(ring: readonly Coordinate[]): Coordinate[] {
  const n = ring.length;
  if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) {
    return ring.slice(0, n - 1);
  }
  return [...ring];
}

function ringArea(ring: readonly Coordinate[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

/** The corners of a fill, by their longitudes then their latitudes */
function sortedCorners(corners: Set<string>): string {
  const pairs = [...corners].map((c) => c.split(',').map(Number) as [number, number]);
  // Corners closer than the float32 offsets are one corner
  const kept: Array<[number, number]> = [];
  for (const p of pairs) {
    if (!kept.some((k) => Math.abs(k[0] - p[0]) < 1e-5 && Math.abs(k[1] - p[1]) < 1e-5)) {
      kept.push(p);
    }
  }
  kept.sort((a, b) => (Math.abs(a[0] - b[0]) < 1e-5 ? a[1] - b[1] : a[0] - b[0]));
  return kept.map((p) => `${p[0]},${p[1]}`).join(' ');
}

/** A fill as it is compared: its color, its area and the positions of its corners */
function fillOf(id: string, fill: ArrayLike<number>, area: number, corners: Set<string>): string {
  return `${id} fill ${color(fill)} area=${Number(area.toPrecision(7))} corners=${sortedCorners(corners)}`;
}

function strokeOf(
  id: string,
  kind: 'line' | 'outline',
  positions: readonly string[],
  stroke: ArrayLike<number>,
  width: number,
  dash: string,
  createdZoom: number | null,
  pieces: string,
): string {
  return `${id} ${kind} ${color(stroke)} w=${round(width, 1e3)} ${dash} cz=${createdZoom ?? '-'} [${positions.join(' ')}] ${pieces}`;
}

/**
 * The pieces of a stroke as the drawing cuts it: for each segment, whether it joins one before
 * and one after (`<` and `>`, `|` for an end), and for a dashed one the length before it (CSS px
 * at zoom 0) where its dashes start
 */
function piecesOf(ends: string[], before: number[] | null): string {
  const lengths = before ? ` at=${before.map((b) => Number(b.toPrecision(4))).join(',')}` : '';
  return `${ends.join('')}${lengths}`;
}

/**
 * The pieces a path is drawn with: a line (open) from its first position to its last, a solid
 * ring all joined, a dashed ring as a line around back to its first position
 */
function piecesOfPath(coords: readonly Coordinate[], ring: boolean, dashed: boolean): string {
  const n = ring ? coords.length : coords.length - 1;
  const ends: string[] = [];
  const before: number[] = [];
  let length = 0;
  for (let s = 0; s < n; s++) {
    const joined = ring && !dashed;
    ends.push(`${joined || s > 0 ? '<' : '|'}${joined || s < n - 1 ? '>' : '|'}`);
    before.push(length);
    const a = coords[s];
    const b = coords[(s + 1) % coords.length];
    length += dashSegmentLength(a[0], a[1], b[0], b[1], 0);
  }
  return piecesOf(ends, dashed ? before : null);
}

/**
 * The primitives a feature is drawn with by `BatchManager` (`processFeature`): a point, a line,
 * and for a polygon each part, its fill (when its color is seen) then the outline of each of its
 * rings (when it has one: seen and wider than nothing), solid or dashed
 */
function primitivesOf(feature: Feature, layer: Layer | undefined, drawer: FeatureDrawer): string[] {
  if (!feature.visible) return [];
  const id = feature.id;
  const createdZoom = getCreatedZoom(feature) ?? null;
  const geometry = feature.geometry as Geometry;
  const out: string[] = [];
  const point = (coord: Coordinate): void => {
    const style = drawer.getPointStyle(feature, layer);
    const shape = toInstancedPointShape(style.shape);
    if (!shape) {
      out.push(`${id} point-at-once ${at(coord[0], coord[1])}`);
      return;
    }
    const d = toPointInstanceData(coord, style);
    out.push(
      `${id} point ${at(coord[0], coord[1])} ${color(d.fillColor)} ${color(d.strokeColor)} r=${round(d.fillSize, 1e3)} sw=${round(d.strokeWidth, 1e3)} shape=${pointShapeCode(shape)}`,
    );
  };
  const line = (coords: readonly Coordinate[]): void => {
    const style = drawer.getLineStringStrokeStyle(feature, layer);
    out.push(
      strokeOf(
        id,
        'line',
        coords.map((c) => at(c[0], c[1])),
        toLineInstanceColor(style.color, style.opacity),
        style.width,
        style.lineStyle,
        createdZoom,
        piecesOfPath(coords, false, style.lineStyle !== 'solid'),
      ),
    );
  };
  const polygon = (rings: readonly Coordinate[][]): void => {
    if (!rings[0] || rings[0].length < 3) return;
    const { fillColor, strokeStyle } = drawer.getPolygonStyles(feature, layer);
    if (fillColor[3] > 0) {
      const corners = new Set<string>();
      let area = 0;
      rings.forEach((ring, k) => {
        const open = openRing(ring);
        for (const c of open) corners.add(at(c[0], c[1]));
        area += k === 0 ? ringArea(open) : -ringArea(open);
      });
      out.push(fillOf(id, fillColor, area, corners));
    }
    if (strokeStyle.opacity > 0 && strokeStyle.width > 0) {
      const dashed = strokeStyle.lineStyle !== 'solid';
      for (const ring of rings) {
        if (ring.length < 3) continue;
        out.push(
          strokeOf(
            id,
            'outline',
            openRing(ring).map((c) => at(c[0], c[1])),
            dashed
              ? toLineInstanceColor(strokeStyle.color, strokeStyle.opacity)
              : strokeStyle.color,
            strokeStyle.width,
            strokeStyle.lineStyle,
            createdZoom,
            piecesOfPath(openRing(ring), true, dashed),
          ),
        );
      }
    }
  };
  switch (feature.type) {
    case 'Point':
      point((geometry as Point).coordinates as Coordinate);
      break;
    case 'MultiPoint':
      for (const c of (geometry as unknown as { coordinates: Coordinate[] }).coordinates) point(c);
      break;
    case 'LineString':
    case 'Freehand':
      line((geometry as unknown as { coordinates: Coordinate[] }).coordinates);
      break;
    case 'MultiLineString':
      for (const c of (geometry as unknown as { coordinates: Coordinate[][] }).coordinates) line(c);
      break;
    case 'Polygon':
      polygon((geometry as unknown as { coordinates: Coordinate[][] }).coordinates);
      break;
    case 'MultiPolygon':
      for (const part of (geometry as unknown as { coordinates: Coordinate[][][] }).coordinates) {
        polygon(part);
      }
      break;
    case 'Circle': {
      const radius = getCircleRadius(feature);
      if (!radius || radius <= 0) break;
      polygon([generateCirclePolygon((geometry as Point).coordinates as Coordinate, radius)]);
      break;
    }
    default:
      out.push(`${id} at-once ${feature.type}`);
  }
  return out;
}

/** What the renderer of a custom type is given: its feature as it is */
function customOf(feature: Feature): string {
  const coords = JSON.stringify((feature.geometry as Point).coordinates, (_k, v) =>
    typeof v === 'number' ? round(v, 1e6) : v,
  );
  return `${feature.id} custom ${feature.type} ${coords} style=${JSON.stringify(sortedKeys(feature.style))} visible=${feature.visible}`;
}

function sortedKeys(value: object | undefined): object {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value ?? {}).sort())
    out[key] = (value as Record<string, unknown>)[key];
  return out;
}

/**
 * Reads back the rows `[fromRow, toRow)` of a chunk drawn in one draw from what the GPU holds, as
 * primitives (the rows hidden by their state left out)
 */
function readRowsDrawn(
  mock: ReturnType<typeof memoryGL>,
  chunk: RowsChunk,
  fromRow: number,
  toRow: number,
  binding: RowStateBinding,
  idOf: (row: number) => string,
  raw: string[],
): string[] {
  const data = chunk.data;
  const instances = mock.buffers.get(chunk.instanceBuffer as object);
  const coords = mock.textures.get(chunk.coords?.texture as object);
  const rowStyles = mock.textures.get(chunk.rowStyles?.texture as object);
  const palette = mock.textures.get(data.palette.gpu?.texture as object);
  const state = mock.textures.get(binding.texture.texture as object);
  if (!instances || !coords || !rowStyles || !palette || !state) {
    return [`chunk ${data.rowBase} not on the GPU`];
  }
  const out: string[] = [];
  for (let r = fromRow; r < toRow; r++) {
    const row = data.rowBase + r;
    const gpuState = state.data[row];
    if ((gpuState & 1) !== 0) continue;
    const move = (gpuState >> 1) & 3;
    const dx = binding.translations[move * 2];
    const dy = binding.translations[move * 2 + 1];
    const position = (index: number): [number, number] => [
      coords.data[index * 2] + data.origin[0] + dx,
      coords.data[index * 2 + 1] + data.origin[1] + dy,
    ];
    const pos = (index: number): string => {
      const [x, y] = position(index);
      return at(x, y);
    };
    const texel = rowStyles.data.subarray(r * 4, r * 4 + 4);
    const n = texel[0];
    const v = palette.data.subarray(n * ROWS_STYLE_FLOATS, (n + 1) * ROWS_STYLE_FLOATS);
    const createdZoom = texel[2] > 0 ? texel[1] : null;
    const id = idOf(row);
    // Everything else the program reads of the row: the values of its style, its style texel,
    // and the range and the length before of each instance that draws
    const drawnInstances: string[] = [];
    for (let i = data.rowFirst[r]; i < data.rowFirst[r + 1]; i++) {
      const instance = readRowsInstance(instances, i);
      const [a, b, c, d] = instance.indices;
      if (instance.kind === ROWS_KIND.fill && a === b && b === c && c === d) continue;
      drawnInstances.push(
        `${instance.kind}:${instance.t0}:${instance.t1}:${Number(instance.extra.toPrecision(5))}`,
      );
    }
    raw.push(
      `${id} style=${Array.from(v, (x) => round(x, 1e4)).join(',')} texel=${texel[1]},${texel[2]},${texel[3]} ${drawnInstances.join(' ')}`,
    );
    // The instances of the row, a run of one kind at a time
    let fill: { corners: Set<string>; area: number } | null = null;
    let stroke: {
      kind: number;
      positions: string[];
      first: number;
      last: number;
      ends: string[];
      before: number[];
    } | null = null;
    const endFill = (): void => {
      if (fill) out.push(fillOf(id, v.subarray(0, 4), fill.area, fill.corners));
      fill = null;
    };
    const endStroke = (): void => {
      if (!stroke) return;
      const s = stroke;
      if (s.kind === ROWS_KIND.segment) {
        out.push(
          strokeOf(
            id,
            'line',
            s.positions,
            v.subarray(0, 4),
            v[6],
            DASH_NAMES[v[7]],
            createdZoom,
            piecesOf(s.ends, v[7] !== ROWS_DASH.solid ? s.before : null),
          ),
        );
      } else {
        const dashed = s.kind === ROWS_KIND.dashedOutline;
        // A ring ends on its first position, which it does not repeat
        const positions = s.last === s.first ? s.positions.slice(0, -1) : s.positions;
        out.push(
          strokeOf(
            id,
            'outline',
            positions,
            dashed ? v.subarray(12, 16) : v.subarray(4, 8),
            v[10],
            dashed ? DASH_NAMES[v[11]] : 'solid',
            createdZoom,
            piecesOf(s.ends, dashed ? s.before : null),
          ),
        );
      }
      stroke = null;
    };
    for (let i = data.rowFirst[r]; i < data.rowFirst[r + 1]; i++) {
      const instance = readRowsInstance(instances, i);
      const [a, b, c, d] = instance.indices;
      if (instance.kind === ROWS_KIND.fill) {
        // An instance that draws nothing
        if (a === b && b === c && c === d) continue;
        endStroke();
        fill ??= { corners: new Set(), area: 0 };
        const triangle = (p: number, q: number, s: number): void => {
          const [x0, y0] = position(p);
          const [x1, y1] = position(q);
          const [x2, y2] = position(s);
          (fill as { area: number }).area +=
            Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) / 2;
          for (const k of [p, q, s]) (fill as { corners: Set<string> }).corners.add(pos(k));
        };
        triangle(a, b, c);
        if (d !== c) triangle(c, b, d);
        continue;
      }
      endFill();
      if (instance.kind === ROWS_KIND.point) {
        endStroke();
        out.push(
          `${id} point ${pos(a)} ${color(v.subarray(0, 4))} ${color(v.subarray(4, 8))} r=${round(v[8], 1e3)} sw=${round(v[9], 1e3)} shape=${v[10]}`,
        );
        continue;
      }
      if (instance.kind === ROWS_KIND.sprite) {
        endStroke();
        out.push(`${id} sprite ${pos(a)}`);
        continue;
      }
      // A segment or an edge: [before, start, end, after]; it goes on the stroke it continues
      if (!stroke || stroke.kind !== instance.kind || stroke.last !== b) {
        endStroke();
        stroke = {
          kind: instance.kind,
          positions: [pos(b)],
          first: b,
          last: b,
          ends: [],
          before: [],
        };
      }
      stroke.positions.push(pos(c));
      stroke.last = c;
      stroke.ends.push(`${a >= 0 ? '<' : '|'}${d >= 0 ? '>' : '|'}`);
      stroke.before.push(instance.extra);
    }
    endFill();
    endStroke();
  }
  return out;
}

// ============================================================================
// The instances
// ============================================================================

/** The custom types drawn at once by their renderers (a box and a caption on a point) */
const CUSTOM_TYPES = ['box', 'caption'] as const;

function customType(type: string): FeatureTypeDefinition {
  return {
    type,
    geometry: 'Point',
    render: vi.fn(),
    bbox: (feature) => {
      const [x, y] = (feature.geometry as Point).coordinates as [number, number];
      return [x - 0.002, y - 0.001, x + 0.002, y + 0.001];
    },
  };
}

type StoreKind = 'object' | 'table';

/** An instance and the drawing of its Store */
interface Client {
  readonly kind: StoreKind;
  readonly draw: Draw;
  readonly store: Store;
  /** Writes values of rows as a write from elsewhere does (a Store of rows only) */
  readonly writer: ReturnType<typeof createTableStore>['writer'] | null;
  /** Draws frames until nothing is left to build, and returns what the last one drew */
  frame(): string[];
  /** What a drawing made afresh from the Store draws (the Store of rows only) */
  fresh(): string[];
  /**
   * What the program reads besides the primitives (the values of the styles, the instances), as
   * the last frame drew it and as a drawing made afresh draws it (the Store of rows only)
   */
  raw(): { readonly live: string[]; readonly fresh: string[] };
  dispose(): void;
}

/** The target of the immediate drawing: the primitives of each feature, in order */
class Recorder implements StoreImmediateTarget {
  layer: Layer | undefined;
  constructor(
    private readonly out: string[],
    private readonly drawer: FeatureDrawer,
    private readonly renderers?: RetainedRendererSet,
  ) {}
  beginFrame(_p: ProjectionData, _z: number, layer?: Layer): void {
    this.layer = layer;
  }
  processFeature(feature: Feature): boolean {
    this.out.push(...primitivesOf(feature, this.layer, this.drawer));
    return false;
  }
  endFrame(): void {}
  getRetainedRenderers(): RetainedRendererSet | undefined {
    return this.renderers;
  }
}

/** The renderers of the custom types, writing what they are given */
function customRenderersOf(out: string[]): Map<string, FeatureTypeHandler['renderer']> {
  const map = new Map<string, FeatureTypeHandler['renderer']>();
  for (const type of CUSTOM_TYPES) {
    map.set(type, {
      onAdd: () => {},
      onRemove: () => {},
      draw: (feature: Feature) => {
        out.push(customOf(feature));
      },
    } as unknown as FeatureTypeHandler['renderer']);
  }
  return map;
}

const CONTEXT = { opacity: 1 } as unknown as FrameDrawContext;

/** A drawing of the layers held as rows of a Store, as an instance wires it */
function tableDrawing(store: Store, drawer: FeatureDrawer, repaint: Repaint) {
  const tables = featureTablesInternals(store.tables);
  if (!tables) throw new Error('not a Store of rows');
  const mock = memoryGL();
  const terrain = new TerrainContext();
  const rows = new RowsRenderer(null, mock.gl, new GpuLedger(), 1, terrain);
  rows.ensureShader({ vertexShaderPrelude: '', define: '', variantName: 'mercator' });
  const out: string[] = [];
  const rawOut: string[] = [];
  let shownRaw: string[] = [];
  const renderer = new TableLayerRenderer({
    ledger: new GpuLedger(),
    gl: mock.gl,
    terrain,
    requestRepaint: () => repaint.request(),
    buildBudgetMs: Number.POSITIVE_INFINITY,
    pixelRatio: 1,
  });
  // What the drawing is drawing (the layer and the group, or the delta of the layer)
  const pass = (renderer as unknown as { pass: PassView }).pass;
  const drawRange = rows.drawRange.bind(rows);
  rows.drawRange = (chunk, fromRow, toRow, zoom, projectionData, binding, factors) => {
    drawRange(chunk, fromRow, toRow, zoom, projectionData, binding, factors);
    const group = binding === pass.binding ? pass.group : pass.deltaGroup;
    const layerId = pass.layerId;
    out.push(
      ...readRowsDrawn(
        mock,
        chunk,
        fromRow,
        toRow,
        binding,
        (row) => (group ? rowFeatureToRead(tables.readContext, layerId, group, row).id : '?'),
        rawOut,
      ),
    );
  };
  const renderers = {
    point: {},
    line: {},
    polygon: {},
    styles: drawer,
    viewport: () => [800, 600],
    run: retainedDrawRun(mock.gl),
    rows,
  } as unknown as RetainedRendererSet;
  // As an instance: a frame is asked for when rows wait, are written, or the deltas change
  const unwatchWrites = tables.onRowsWritten((layerId, writes) => {
    renderer.rowsWritten(layerId, writes);
    repaint.request();
  });
  const unwatchWork = tables.onPendingWork(() => repaint.request());
  const unwatchDelta = tables.onDeltaChanged(() => repaint.request());
  const unwatch = (): void => {
    unwatchWrites();
    unwatchWork();
    unwatchDelta();
  };
  /** What the last frame drawn drew */
  let shown: string[] = [];
  const recorder = new Recorder(out, drawer, renderers);
  const r = {
    batchManager: recorder,
    tentativeRenderer: { drawGeometry: () => {} },
    // The view: a range around every feature, as the expanded viewport of an instance gives it
    viewportFilter: {
      getBounds: () => ({ minX: -20, minY: -20, maxX: 20, maxY: 20 }),
      getVisibleIds: () => new Set(getDisplayFeatures(store).map((f) => f.id)),
    },
  } as unknown as Renderers;
  const custom = customRenderersOf(out);
  const companions = createFeatureCompanionRegistry();
  const once = (): string[] => {
    out.length = 0;
    rawOut.length = 0;
    renderer.prerender();
    beginRenderFrame();
    renderer.beginFrame();
    renderer.advanceTables(tables);
    renderLayers(
      r,
      store,
      [],
      new Set(),
      PROJECTION,
      ZOOM,
      custom,
      CONTEXT,
      companions,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      renderer,
    );
    renderer.endFrame();
    shown = [...out];
    shownRaw = [...rawOut];
    return shown;
  };
  return {
    once,
    /** What the program reads besides the primitives, as the last frame drew it */
    raw: (): string[] => shownRaw,
    /**
     * Draws the frames asked for, as the map does (a frame when one was asked for since the last,
     * the timers going on between them), and returns what the last one drew: what is on the
     * screen once nothing asks for another
     */
    frame(): string[] {
      for (let i = 0; i < 2000; i++) {
        vi.advanceTimersByTime(20);
        if (!repaint.take()) {
          if (i > 5) break;
          continue;
        }
        once();
      }
      return shown;
    },
    dispose(): void {
      unwatch();
      renderer.dispose(renderers);
    },
  };
}

/** The frames asked for of a map */
class Repaint {
  private asked = true;
  request(): void {
    this.asked = true;
  }
  /** Whether a frame was asked for since the last call (forgotten then) */
  take(): boolean {
    const asked = this.asked;
    this.asked = false;
    return asked;
  }
}

/** What the drawing reads while it draws a range of rows */
interface PassView {
  readonly layerId: string;
  readonly group: RowGroup | null;
  readonly deltaGroup: RowGroup | null;
  readonly binding: RowStateBinding | null;
}

function client(kind: StoreKind): Client {
  const made = kind === 'table' ? createTableStore() : null;
  const repaint = new Repaint();
  const stub = createMapStub();
  // The frames the instance asks for (a change of its Store, a mode)
  (stub.map as unknown as { triggerRepaint: () => void }).triggerRepaint = () => repaint.request();
  const draw = createDraw(stub.map, {
    ...(made && { store: made.store }),
    initDefaultLayer: false,
  });
  for (const type of CUSTOM_TYPES) draw.extensions.featureTypes.add(customType(type));
  draw.layers.create({ name: 'Layer 1' });
  // The Store of the instance (the drawing reads it as the instance does)
  const store = draw.getStore() as unknown as Store;
  const drawer = createTestDrawer();
  if (kind === 'table') {
    let drawing = tableDrawing(store, drawer, repaint);
    return {
      kind,
      draw,
      store,
      writer: made?.writer ?? null,
      frame: () => drawing.frame(),
      raw: () => {
        const afresh = tableDrawing(store, drawer, new Repaint());
        afresh.frame();
        const fresh = afresh.raw();
        afresh.dispose();
        return { live: drawing.raw(), fresh };
      },
      fresh: () => {
        drawing.dispose();
        drawing = tableDrawing(store, drawer, new Repaint());
        return drawing.frame();
      },
      dispose: () => {
        drawing.dispose();
        draw.destroy();
      },
    };
  }
  const out: string[] = [];
  const recorder = new Recorder(out, drawer);
  const r = {
    batchManager: recorder,
    tentativeRenderer: { drawGeometry: () => {} },
  } as unknown as Renderers;
  const custom = customRenderersOf(out);
  const companions = createFeatureCompanionRegistry();
  const frame = (): string[] => {
    out.length = 0;
    renderLayers(
      r,
      store,
      getDisplayFeatures(store),
      new Set(),
      PROJECTION,
      ZOOM,
      custom,
      CONTEXT,
      companions,
      [],
    );
    return [...out];
  };
  return {
    kind,
    draw,
    store,
    writer: null,
    frame,
    fresh: frame,
    raw: () => ({ live: [], fresh: [] }),
    dispose: () => draw.destroy(),
  };
}

// ============================================================================
// The kinds of features
// ============================================================================

type ShapeName =
  | 'Point'
  | 'LineString'
  | 'Polygon'
  | 'MultiPolygon'
  | 'Circle'
  | 'Freehand'
  | 'box'
  | 'caption';

const SHAPES: readonly ShapeName[] = [
  'Point',
  'LineString',
  'Polygon',
  'MultiPolygon',
  'Circle',
  'Freehand',
  'box',
  'caption',
];

function square(x: number, y: number, size: number): Coordinate[] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
}

/** The geometry of a kind, moved by an offset (degrees) */
function geometryOf(shape: ShapeName, dx = 0, dy = 0): Geometry {
  const shift = (c: Coordinate): Coordinate => [c[0] + dx, c[1] + dy];
  switch (shape) {
    case 'Point':
    case 'Circle':
    case 'box':
    case 'caption':
      return { type: 'Point', coordinates: shift([0.01, 0.01]) };
    case 'LineString':
      return {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0.01, 0.005],
          [0.02, 0],
        ].map((c) => shift(c as Coordinate)),
      };
    case 'Freehand':
      return {
        type: 'LineString',
        coordinates: Array.from({ length: 12 }, (_, i) =>
          shift([i * 0.002, Math.sin(i / 2) * 0.003]),
        ),
      };
    case 'Polygon':
      return { type: 'Polygon', coordinates: [square(0, 0, 0.01).map(shift)] };
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: [[square(0, 0, 0.01).map(shift)], [square(0.02, 0, 0.008).map(shift)]],
      };
  }
}

// ============================================================================
// The steps
// ============================================================================

/** What a row runs on a client */
interface Run {
  readonly client: Client;
  readonly shape: ShapeName;
  /** Whether the feature is selected from its creation on */
  readonly opened: boolean;
  /** Whether the feature is made with the features around it, before the steps */
  readonly loaded: boolean;
  /** The id of the feature */
  id: string;
  /** The names the features are compared by, by id (the ids differ from one Store to another) */
  readonly names: Map<string, string>;
  /** The changes of the document, from the last step (to write their values before back) */
  changes: DocumentChange[];
  /** What writes the last step back (`undo`) and again (`redo`) */
  undone: Array<() => void>;
  redone: Array<() => void>;
}

interface Step {
  readonly name: string;
  /** The style of the feature made (a step that makes it) */
  readonly style?: FeatureStyle;
  run(run: Run): void;
}

function styleOf(run: Run): FeatureStyle {
  return { ...(run.client.draw.features.get(run.id)?.style ?? {}) };
}

function setStyle(name: string, patch: FeatureStyle): Step {
  return {
    name,
    run: (run) => {
      run.client.draw.features.update(run.id, { style: { ...styleOf(run), ...patch } });
    },
  };
}

type FeatureInputOf = Parameters<Draw['features']['create']>[0];

/** The input of a feature of a kind, moved by an offset (degrees) */
function inputOf(
  shape: ShapeName,
  style: FeatureStyle,
  dx = 0,
  dy = 0,
  createdZoom: number | null = 12,
): FeatureInputOf {
  const properties: Record<string, unknown> =
    createdZoom === null ? {} : { [CREATED_ZOOM]: createdZoom };
  if (shape === 'Circle') properties[RADIUS] = 300;
  return { type: shape, geometry: geometryOf(shape, dx, dy), properties, style } as FeatureInputOf;
}

/**
 * The features around the one a row edits, made before it: every kind with the styles the rows
 * give (the same numbers of styles), and a few of their own
 */
const SCENE_STYLES: readonly FeatureStyle[] = [
  {},
  { lineStyle: 'dashed' },
  { fillColor: '#00aa00', pointColor: '#00aa00' },
  { lineStyle: 'dotted', strokeWidth: 20 },
  { strokeColor: '#3366ff', fillColor: '#ffcc00' },
];

function sceneInputs(): FeatureInputOf[] {
  const out: FeatureInputOf[] = [];
  SHAPES.forEach((shape, i) => {
    SCENE_STYLES.forEach((style, k) => {
      out.push(inputOf(shape, style, -0.05 - k * 0.04, 0.05 + i * 0.04));
    });
  });
  return out;
}

/** Makes the features around, and the feature of a row with them when it is made before */
function makeScene(run: Run, style: FeatureStyle | null): void {
  const { draw, writer } = run.client;
  const inputs = sceneInputs();
  if (style) inputs.push(inputOf(run.shape, style));
  if (writer && run.loaded) {
    // The rows given as row blocks built elsewhere, as a copy of a document gives them
    const layerId = draw.layers.list()[0].id;
    const builder = createRowBlockBuilder();
    inputs.forEach((input, i) => {
      const id = `b${String(i).padStart(6, '0')}`;
      builder.addRow({
        id,
        type: input.type,
        geometry: input.geometry,
        order: `a${String(i).padStart(6, '0')}`,
        style: input.style as Record<string, unknown>,
        properties: input.properties as Record<string, unknown>,
        visible: true,
        locked: false,
      });
      run.names.set(id, i < inputs.length - (style ? 1 : 0) ? `S${i}` : 'F');
      if (style && i === inputs.length - 1) run.id = id;
    });
    writer.addRowBlocks(layerId, builder.finish());
    return;
  }
  const made = draw.features.createMany(inputs);
  if (!made) throw new Error('the features around were not made');
  made.forEach((feature, i) => {
    run.names.set(feature.id, i < inputs.length - (style ? 1 : 0) ? `S${i}` : 'F');
  });
  if (style) run.id = made[made.length - 1].id;
}

function createStep(name: string, style: FeatureStyle = {}, createdZoom: number | null = 12): Step {
  return {
    name,
    style,
    run: (run) => {
      const { draw } = run.client;
      if (!run.loaded) {
        const created = draw.features.create(inputOf(run.shape, style, 0, 0, createdZoom));
        if (!created) throw new Error(`${run.shape} not created`);
        run.id = created.id;
        run.names.set(created.id, 'F');
      }
      if (run.opened) draw.selection.set('feature', [run.id]);
    },
  };
}

const create = createStep('create');

/** Draws the feature through its mode, as a person does (the kinds that have a mode) */
const drawThroughMode: Step = {
  name: 'draw through the mode',
  run: (run) => {
    const { draw } = run.client;
    const geometry = geometryOf(run.shape) as { type: string; coordinates: unknown };
    const mode =
      run.shape === 'Polygon' ? 'draw_polygon' : run.shape === 'LineString' ? 'draw_line' : null;
    if (!mode) throw new Error(`no mode for ${run.shape}`);
    let made: Feature | undefined;
    const off = draw.on('feature.created', ({ feature }) => {
      made ??= feature;
    });
    draw.setMode(mode);
    const coords = (
      run.shape === 'Polygon'
        ? (geometry.coordinates as Coordinate[][])[0].slice(0, -1)
        : (geometry.coordinates as Coordinate[])
    ) as Coordinate[];
    for (const c of coords) draw.drawing.addVertex([c[0], c[1]]);
    draw.drawing.finish();
    off();
    if (!made) throw new Error(`${run.shape} not drawn`);
    run.id = made.id;
    run.names.set(made.id, 'F');
  },
};
const createDashed = createStep('create dashed 20px', { lineStyle: 'dashed', strokeWidth: 20 });
const createDotted = createStep('create dotted 20px', { lineStyle: 'dotted', strokeWidth: 20 });
const createDottedFixed = createStep(
  'create dotted 20px, no created zoom',
  { lineStyle: 'dotted', strokeWidth: 20 },
  null,
);
const createFixed = createStep('create, no created zoom', {}, null);
const dashed = setStyle('dashed', { lineStyle: 'dashed' });
const dotted = setStyle('dotted', { lineStyle: 'dotted' });
const solid = setStyle('solid', { lineStyle: 'solid' });
const strokeColor = setStyle('stroke color and width', { strokeColor: '#ff0000', strokeWidth: 6 });
const fillColor = setStyle('fill color', { fillColor: '#00aa00', pointColor: '#00aa00' });

const move: Step = {
  name: 'move',
  run: (run) => {
    run.client.draw.features.update(run.id, { geometry: geometryOf(run.shape, 0.003, 0.002) });
  },
};

const remove: Step = {
  name: 'delete',
  run: (run) => {
    run.client.draw.features.delete(run.id);
  },
};

/** Selects the feature and deletes what is selected (the key Delete of the select mode) */
const deleteSelected: Step = {
  name: 'select and delete the selection',
  run: (run) => {
    run.client.draw.selection.set('feature', [run.id]);
    run.client.draw.selection.delete();
  },
};

/** The style changed through the selection, as an inspector of the selection writes it */
const dashedThroughSelection: Step = {
  name: 'dashed through the selection',
  run: (run) => {
    run.client.draw.selection.set('feature', [run.id]);
    run.client.draw.selection.update({ style: { lineStyle: 'dashed' } });
  },
};

const hide: Step = {
  name: 'hide',
  run: (run) => {
    run.client.draw.features.update(run.id, { visible: false });
  },
};

const show: Step = {
  name: 'show',
  run: (run) => {
    run.client.draw.features.update(run.id, { visible: true });
  },
};

const hideLayer: Step = {
  name: 'hide the layer',
  run: (run) => {
    const layer = run.client.draw.layers.list()[0];
    run.client.draw.layers.update(layer.id, { visible: false });
  },
};

const showLayer: Step = {
  name: 'show the layer',
  run: (run) => {
    const layer = run.client.draw.layers.list()[0];
    run.client.draw.layers.update(layer.id, { visible: true });
  },
};

const select: Step = {
  name: 'select',
  run: (run) => {
    run.client.draw.selection.set('feature', [run.id]);
  },
};

const clear: Step = {
  name: 'clear the selection',
  run: (run) => {
    run.client.draw.selection.clear();
    // The rows opened are let go of after a delay
    vi.advanceTimersByTime(RELEASE_DELAY_MS * 2);
  },
};

/**
 * Writes the values before of the changes of the last write back (as `features.restore`
 * documents it), keeping what writes them again
 */
const undo: Step = {
  name: 'write the values before back',
  run: (run) => {
    const { draw } = run.client;
    const changes = run.changes.splice(0);
    const back: Array<() => void> = [];
    const again: Array<() => void> = [];
    for (const change of changes) {
      const before = run.client.kind === 'table' ? change.previousValues : undefined;
      if (before) {
        back.push(() => {
          const after = draw.features.restore(before);
          if (after) again.push(() => draw.features.restore(after));
        });
        continue;
      }
      for (const f of change.features?.created ?? []) {
        back.push(() => draw.features.delete(f.id));
        again.push(() => draw.features.create(f));
      }
      for (const u of change.features?.updated ?? []) {
        if (u.isIntermediate) continue;
        back.push(() => draw.features.update(u.id, patchOf(u.feature, u.previous)));
        again.push(() => draw.features.update(u.id, patchOf(u.previous, u.feature)));
      }
      for (const f of change.features?.deleted ?? []) {
        back.push(() => draw.features.create(f));
        again.push(() => draw.features.delete(f.id));
      }
    }
    draw.transact(
      () => {
        for (const fn of back.reverse()) fn();
      },
      { ignoreLocks: true },
    );
    run.redone = again;
    run.changes.length = 0;
  },
};

const redo: Step = {
  name: 'write them again',
  run: (run) => {
    const { draw } = run.client;
    const again = run.redone.splice(0);
    draw.transact(
      () => {
        for (const fn of again.reverse()) fn();
      },
      { ignoreLocks: true },
    );
  },
};

/** The patch that makes a feature into another (the keys it does not have removed) */
function patchOf(from: Feature, to: Feature): FeaturePatch {
  const keys = (a: object, b: object): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...b };
    for (const key of Object.keys(a)) if (!(key in b)) out[key] = undefined;
    return out;
  };
  return {
    geometry: to.geometry,
    properties: keys(from.properties, to.properties) as FeaturePatch['properties'],
    style: keys(from.style, to.style) as FeatureStyle,
    visible: to.visible,
    locked: to.locked,
  };
}

/**
 * A write from elsewhere: the style made dashed, written to the rows as the values of another
 * writer are (`FeatureTablesWriter.apply`); the Store of objects is written through the instance
 */
const dashedFromElsewhere: Step = {
  name: 'dashed, written from elsewhere',
  run: (run) => {
    const { draw, writer } = run.client;
    const style = { ...styleOf(run), lineStyle: 'dashed' as const };
    if (!writer) {
      draw.features.update(run.id, { style });
      return;
    }
    const found = writer.lookup(run.id);
    if (!found) throw new Error('no row');
    writer.apply(
      createRowValues({
        handles: Int32Array.of(found.handle),
        fields: new Map([['style', [style]]]),
      }),
    );
  },
};

/** The operations: the steps of a row after its creation */
interface Operation {
  readonly name: string;
  readonly steps: readonly Step[];
  appliesTo?(shape: ShapeName): boolean;
}

const OPERATIONS: readonly Operation[] = [
  { name: 'create', steps: [create] },
  {
    name: 'drawn, fill color then dashed',
    steps: [drawThroughMode, fillColor, dashed],
    appliesTo: (shape) => shape === 'Polygon' || shape === 'LineString',
  },
  {
    name: 'drawn, dashed, deleted',
    steps: [drawThroughMode, fillColor, dashed, remove],
    appliesTo: (shape) => shape === 'Polygon' || shape === 'LineString',
  },
  { name: 'create dashed', steps: [createDashed] },
  { name: 'create dotted', steps: [createDotted] },
  { name: 'create dotted, no created zoom', steps: [createDottedFixed] },
  { name: 'fill color then dashed, no created zoom', steps: [createFixed, fillColor, dashed] },
  { name: 'delete a dashed, no created zoom', steps: [createDottedFixed, remove] },
  { name: 'line styles', steps: [create, dashed, dotted, solid] },
  { name: 'stroke color and width', steps: [create, strokeColor] },
  { name: 'stroke color of a dashed', steps: [createDashed, strokeColor] },
  { name: 'fill color then dashed', steps: [create, fillColor, dashed] },
  { name: 'fill color then dotted', steps: [create, fillColor, dotted] },
  { name: 'move', steps: [create, move] },
  { name: 'move a dashed', steps: [createDashed, move] },
  { name: 'delete', steps: [create, remove] },
  { name: 'delete a dashed', steps: [createDashed, remove] },
  { name: 'delete a dashed made from a solid', steps: [create, fillColor, dashed, remove] },
  { name: 'delete the selection of a dashed', steps: [createDashed, deleteSelected] },
  {
    name: 'fill color, dashed through the selection, delete the selection',
    steps: [create, fillColor, dashedThroughSelection, deleteSelected],
  },
  { name: 'write back a style', steps: [create, dashed, undo, redo] },
  { name: 'write back a move', steps: [createDashed, move, undo, redo] },
  { name: 'write back a deletion', steps: [createDashed, remove, undo, redo] },
  { name: 'hide and show', steps: [create, hide, show] },
  { name: 'hide and show a dashed', steps: [createDashed, hide, show] },
  { name: 'hide and show the layer', steps: [createDashed, hideLayer, showLayer] },
  { name: 'select and clear', steps: [createDashed, select, clear] },
  { name: 'dashed from elsewhere', steps: [create, dashedFromElsewhere] },
];

// ============================================================================
// The table
// ============================================================================

const VARIANTS = [
  ['row', 'made after the others, its row as it is'],
  ['opened', 'made after the others, opened (selected)'],
  ['loaded', 'made with the others, its row as it is'],
  ['loaded-opened', 'made with the others, opened (selected)'],
] as const;

type Variant = (typeof VARIANTS)[number][0];

/** What a cell found (empty: the same as the Store of objects) */
interface CellResult {
  readonly differences: string[];
  /** Whether a drawing made afresh from the rows draws what the Store of objects draws */
  readonly freshSame: boolean;
}

/** The cells that differ now, and why */
interface KnownDifference {
  readonly cause: string;
  readonly op: string;
  readonly shapes: readonly ShapeName[];
  readonly variants: readonly Variant[];
}

const KNOWN_DIFFERENCES: readonly KnownDifference[] = [];

function knownCause(shape: ShapeName, op: string, variant: Variant): string | undefined {
  return KNOWN_DIFFERENCES.find(
    (k) => k.op === op && k.shapes.includes(shape) && k.variants.includes(variant),
  )?.cause;
}

/** The first line where two lists of primitives differ */
function firstDifference(expected: readonly string[], actual: readonly string[]): string | null {
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    if (!sameLine(expected[i], actual[i])) {
      return `#${i}: expected ${expected[i] ?? '(nothing)'} / drawn ${actual[i] ?? '(nothing)'}`;
    }
  }
  return null;
}

const NUMBER = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;

/**
 * Whether two primitives are the same: the same words, and numbers the same within what float32
 * keeps of them (the drawing holds positions as float32 offsets from the origin of a chunk)
 */
function sameLine(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.replace(NUMBER, '#') !== b.replace(NUMBER, '#')) return false;
  const x = a.match(NUMBER) ?? [];
  const y = b.match(NUMBER) ?? [];
  return x.every((v, i) => {
    const p = Number(v);
    const q = Number(y[i]);
    return Math.abs(p - q) <= 2e-5 + 1e-4 * Math.max(Math.abs(p), Math.abs(q));
  });
}

/** Runs a row on both Stores, step by step */
function runRow(shape: ShapeName, op: Operation, variant: Variant): CellResult {
  const object = client('object');
  const table = client('table');
  const runs: Run[] = [object, table].map((c) => ({
    client: c,
    shape,
    opened: variant === 'opened' || variant === 'loaded-opened',
    loaded: variant === 'loaded' || variant === 'loaded-opened',
    id: '',
    names: new Map(),
    changes: [],
    undone: [],
    redone: [],
  }));
  for (const run of runs) {
    run.client.draw.on('document.changed', (change) => {
      run.changes.push(change);
    });
  }
  const differences: string[] = [];
  let freshSame = true;
  const named = (run: Run, lines: string[]): string[] =>
    lines.map((line) => {
      const space = line.indexOf(' ');
      const name = run.names.get(line.slice(0, space));
      return name === undefined ? line : `${name}${line.slice(space)}`;
    });
  try {
    for (const run of runs) makeScene(run, run.loaded ? (op.steps[0].style ?? {}) : null);
    for (const run of runs) run.client.frame();
    for (const step of op.steps) {
      for (const run of runs) {
        if (step !== undo) run.changes.length = 0;
        step.run(run);
      }
      const expected = named(runs[0], object.frame());
      const drawn = named(runs[1], table.frame());
      if (process.env.DRAWN_MATRIX_TRACE) {
        console.log(
          `${shape} ${op.name} ${variant} ${step.name}\n${expected.join('\n')}\n--\n${drawn.join('\n')}`,
        );
      }
      let diff = firstDifference(expected, drawn);
      if (!diff) {
        const raw = table.raw();
        const rawDiff = firstDifference(named(runs[1], raw.fresh), named(runs[1], raw.live));
        if (rawDiff) diff = `what the program reads, against a drawing made afresh ${rawDiff}`;
      }
      if (diff) {
        differences.push(`${step.name}: ${diff}`);
        const fresh = named(runs[1], table.fresh());
        if (firstDifference(expected, fresh) !== null) freshSame = false;
        break;
      }
    }
  } catch (error) {
    differences.push(`threw: ${(error as Error).message}`);
  } finally {
    object.dispose();
    table.dispose();
  }
  return { differences, freshSame };
}

const results = new Map<string, CellResult>();
const keyOf = (shape: ShapeName, op: string, variant: Variant): string =>
  `${shape}\u0000${op}\u0000${variant}`;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('what is drawn, on a Store of rows and on a Store of objects', () => {
  for (const op of OPERATIONS) {
    for (const shape of SHAPES) {
      if (op.appliesTo && !op.appliesTo(shape)) continue;
      for (const [variant] of VARIANTS) {
        it(`${op.name} of a ${shape}, ${variant}`, () => {
          const result = runRow(shape, op, variant);
          results.set(keyOf(shape, op.name, variant), result);
          const cause = knownCause(shape, op.name, variant);
          if (cause) {
            expect(result.differences, `listed as ${cause}`).not.toEqual([]);
          } else {
            expect(result.differences).toEqual([]);
          }
        });
      }
    }
  }
});

afterAll(() => {
  const out = process.env.DRAWN_MATRIX_OUT;
  if (!out) return;
  const lines: string[] = [];
  let rows = 0;
  let differing = 0;
  lines.push('# 描く物の総当たりの表');
  lines.push('');
  lines.push(
    `種類 ${SHAPES.length} × 操作 ${OPERATIONS.length} × 列 ${VARIANTS.length} (周りの地物の後から作るか一緒に作るか、行のままか選んで開いた行か)。`,
  );
  lines.push('');
  for (const op of OPERATIONS) {
    lines.push(`## ${op.name}`);
    lines.push('');
    lines.push(`手順: ${op.steps.map((s) => s.name).join(' → ')}`);
    lines.push('');
    lines.push(
      '| 種類 | 後から作る、行のまま | 後から作る、開いた行 | 一緒に作る、行のまま | 一緒に作る、開いた行 |',
    );
    lines.push('| ---- | ---- | ---- | ---- | ---- |');
    for (const shape of SHAPES) {
      const cells = VARIANTS.map(([variant]) => {
        const result = results.get(keyOf(shape, op.name, variant));
        if (!result) return '-';
        rows++;
        if (result.differences.length === 0) return 'OK';
        differing++;
        const fresh = result.freshSame ? '作り直すと同じ' : '作り直しても違う';
        return `違う (${fresh}) ${result.differences.join(' ').replace(/\|/g, '/')}`;
      });
      lines.push(`| ${shape} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  lines.push(`全 ${rows} セル、基準と違う ${differing} セル。`);
  lines.push('');
  writeFileSync(out, `${lines.join('\n')}`);
});
