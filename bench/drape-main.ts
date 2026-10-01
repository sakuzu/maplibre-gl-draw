// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Benchmark page for lines painted on the terrain by the analytic drape
 *
 * Rows of zigzag lines cover the view of a pitched camera over a flat terrain, and the same
 * frame is drawn again and again. Each frame waits for the GPU (a read of one pixel), so the
 * time of a frame is the time the drape takes to paint it. Compare `style=solid` with
 * `style=dashed` (or `dotted`) at the same number of edges: a dashed line works out its dashes
 * for every edge near a pixel.
 *
 * The terrain is served in the page (a flat terrarium tile made once), so nothing is fetched
 * from the network.
 *
 * URL parameters:
 *   - `edges` : total number of edges of the lines (default 20000)
 *   - `style` : `solid`, `dashed` or `dotted` (default `solid`)
 *   - `width` : line width in CSS pixels (default 3)
 *   - `frames`: number of frames measured (default 60)
 *
 * The following are exposed on window for automation.
 *   - `window.drapeReady`: a Promise that settles once the lines are on the drape
 *   - `window.runDrapeBench()`: runs one measurement and returns the statistics
 */

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import type { Feature, Geometry } from 'geojson';
import * as maplibregl from 'maplibre-gl';

// Worker URL setup for v6 (side effect). Required before the Map is created.
import './maplibre-setup';

/** The camera of the measurement */
const CENTER: [number, number] = [139.55, 35.75];
const ZOOM = 15;
const PITCH = 60;

/** The protocol of the flat terrain */
const DEM_PROTOCOL = 'bench-dem';

/** The number of vertices per line (the lines are made as many as the edges need) */
const VERTICES_PER_LINE = 101;

interface DrapeBenchStats {
  frames: number;
  avgMs: number;
  p50: number;
  p90: number;
  worst: number;
  /** The diagnostics of the drape in the last frame measured */
  drape: { used: boolean; reason: string; edgeCount: number; maxEdgesPerCell: number };
}

declare global {
  interface Window {
    drapeReady: Promise<void>;
    runDrapeBench: () => Promise<DrapeBenchStats>;
    drapeError?: string;
  }
}

const params = new URLSearchParams(location.search);
const edgeTotal = Number(params.get('edges') ?? '20000');
const style =
  (['solid', 'dashed', 'dotted'] as const).find((s) => s === params.get('style')) ?? 'solid';
const width = Number(params.get('width') ?? '3');
const frameCount = Number(params.get('frames') ?? '60');

const statusEl = document.getElementById('status') as HTMLElement;
const setStatus = (text: string): void => {
  statusEl.textContent = text;
};

/** One flat terrarium tile (0 m everywhere), made once and served for every tile */
let flatTile: Promise<ArrayBuffer> | null = null;
function flatDemTile(): Promise<ArrayBuffer> {
  flatTile ??= (async () => {
    const size = 256;
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      // 32768 = 0 m in the terrarium encoding
      pixels[i * 4] = 128;
      pixels[i * 4 + 1] = 0;
      pixels[i * 4 + 2] = 0;
      pixels[i * 4 + 3] = 255;
    }
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context for the terrain');
    context.putImageData(new ImageData(pixels, size, size), 0, 0);
    return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  })();
  return flatTile;
}
maplibregl.addProtocol(DEM_PROTOCOL, async () => ({ data: await flatDemTile() }));

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef0f4' } }],
  },
  center: CENTER,
  zoom: ZOOM,
  pitch: PITCH,
  maxPitch: 85,
  attributionControl: false,
  fadeDuration: 0,
  // The frame is read back after it is drawn
  canvasContextAttributes: { preserveDrawingBuffer: true },
});

const draw = createDraw(map, { defaultMode: 'select', autoName: false });

/**
 * The lines: rows of zigzags across the ground the camera sees
 *
 * The rows are spread over the visible ground (from the bottom of the screen to two thirds up),
 * so the edges are shared out among the tiles of the view.
 */
function buildLines(): Array<Feature<Geometry, Record<string, unknown>>> {
  const rows = Math.max(1, Math.round(edgeTotal / (VERTICES_PER_LINE - 1)));
  const canvas = map.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const bottomLeft = map.unproject([0, h]);
  const topRight = map.unproject([w, h / 3]);
  const west = bottomLeft.lng;
  const east = topRight.lng;
  const south = bottomLeft.lat;
  const north = topRight.lat;
  const rowStep = (north - south) / rows;
  const features: Array<Feature<Geometry, Record<string, unknown>>> = [];
  for (let r = 0; r < rows; r++) {
    const lat = south + (r + 0.5) * rowStep;
    const coordinates: [number, number][] = [];
    for (let v = 0; v < VERTICES_PER_LINE; v++) {
      const t = v / (VERTICES_PER_LINE - 1);
      coordinates.push([west + (east - west) * t, lat + (v % 2 === 0 ? 0 : rowStep * 0.4)]);
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: {
        'maplibre-gl-draw:id': `l-${r}`,
        'maplibre-gl-draw:style': { strokeColor: '#d9480f', strokeWidth: width, lineStyle: style },
      },
    });
  }
  return features;
}

/** Statistics (percentiles use the nearest-rank method) */
function summarize(deltas: number[]): Omit<DrapeBenchStats, 'drape'> {
  const sorted = [...deltas].sort((a, b) => a - b);
  const pct = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    frames: deltas.length,
    avgMs: deltas.reduce((s, v) => s + v, 0) / deltas.length,
    p50: pct(0.5),
    p90: pct(0.9),
    worst: Math.max(...deltas),
  };
}

/** Draws one frame and waits until the GPU has finished it */
function drawFrame(): Promise<number> {
  return new Promise((resolve) => {
    const started = performance.now();
    map.once('render', () => {
      const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      resolve(performance.now() - started);
    });
    map.triggerRepaint();
  });
}

/** One measurement run (the frames are drawn back to back with the camera at rest) */
async function runDrapeBench(): Promise<DrapeBenchStats> {
  for (let i = 0; i < 5; i++) await drawFrame();
  const deltas: number[] = [];
  for (let i = 0; i < frameCount; i++) deltas.push(await drawFrame());
  const debug = draw.debug.terrain().drape;
  return {
    ...summarize(deltas),
    drape: {
      used: debug.used,
      reason: String(debug.reason),
      edgeCount: debug.edgeCount,
      maxEdgesPerCell: debug.maxEdgesPerCell,
    },
  };
}

window.runDrapeBench = runDrapeBench;

window.drapeReady = (async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    if (map.loaded()) resolve();
    else map.once('load', () => resolve());
  });
  map.addSource('dem', {
    type: 'raster-dem',
    tiles: [`${DEM_PROTOCOL}://{z}/{x}/{y}`],
    tileSize: 256,
    maxzoom: 12,
    encoding: 'terrarium',
  });
  map.setTerrain({ source: 'dem', exaggeration: 1 });

  const result = await draw.document.load({ type: 'FeatureCollection', features: buildLines() });
  if (!result) throw new Error('The document is read-only');

  // Draw until every tile is in and the drape has settled on its index
  for (let i = 0; i < 300; i++) {
    await drawFrame();
    if (i > 30 && map.areTilesLoaded() && draw.debug.terrain().drape.used) break;
  }
  const debug = draw.debug.terrain().drape;
  setStatus(
    `edges=${edgeTotal} style=${style} width=${width}\n` +
      `drape used=${debug.used} (${String(debug.reason)}) edges=${debug.edgeCount}`,
  );
})();

window.drapeReady.catch((error: unknown) => {
  window.drapeError = error instanceof Error ? error.message : String(error);
  setStatus(`ERROR: ${window.drapeError}`);
});
