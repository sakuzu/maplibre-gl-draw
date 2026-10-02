// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests: the engine reads the same ground as maplibre on a known terrain
 *
 * The engine draws on the terrain with its own shaders and places its symbols with elevations
 * looked up on the CPU. Both copy or call something of maplibre (maplibre-coupling.md, items 2
 * and 8), and a maplibre release can move the ground under them without any unit test
 * noticing: the unit tests stub maplibre. Here a real maplibre draws a known DEM
 * (`dem-fixture.ts`: a steep peak, so half a DEM pixel is meters) and everything the engine
 * reads is held to `map.queryTerrainElevation`, maplibre's own elevation of the surface it
 * draws.
 *
 * - The symbols: the elevation a symbol is drawn at and the point it is projected to
 * - The drape (the fills and lines painted on the ground): `drape_get_elevation` evaluated on
 *   the GPU with the DEM textures maplibre renders with
 * - The DEM atlas (the vertex displacement path): the texels baked from the same textures
 */

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PluginContext } from '../index.js';
import { browserTimeout } from '../test-utils.js';
import {
  type Bundle,
  bundlePage,
  type Camera,
  type E2EWindow,
  launchBrowser,
  MAP_SIZE,
  openMapPage,
  settle,
} from './harness.js';

/**
 * A pitched view of the peak, so the drawn tiles span several zoom levels and most of them are
 * not the tile of `floor(zoom)` (the one maplibre 6.6 placed symbols with)
 */
const CAMERA: Camera = { center: [138.73, 35.36], zoom: 12.6, pitch: 60, bearing: 20 };

/** The vertical exaggeration of the terrain */
const EXAGGERATION = 1.5;

/** Meters the GPU may differ from maplibre (the 24-bit packing is 0.0039 m) */
const GPU_TOLERANCE_M = 0.05;

/** What the test page carries besides the map and the draw instance */
interface TerrainWindow extends E2EWindow {
  e2e: {
    maplibregl: typeof import('maplibre-gl');
    terrain: {
      addTestTerrain(map: import('maplibre-gl').Map, exaggeration: number): Promise<void>;
      testElevation(lng: number, lat: number): number;
    };
    internals: {
      DemAtlas: typeof import('../view/terrain/dem-atlas.js').DemAtlas;
      getMapTerrain: typeof import('../view/terrain/detect.js').getMapTerrain;
      getRenderableTerrainTiles: typeof import('../view/terrain/detect.js').getRenderableTerrainTiles;
      getTerrainTileData: typeof import('../view/terrain/detect.js').getTerrainTileData;
      TERRAIN_SAMPLE_GLSL: string;
    };
  };
  probe: PluginContext;
}

let browser: Browser;
let bundle: Bundle;
let page: Page;

beforeAll(async () => {
  bundle = await bundlePage();
  browser = await launchBrowser();
  page = await openMapPage(browser, bundle, CAMERA);
  await page.evaluate(async (exaggeration) => {
    const w = window as unknown as TerrainWindow;
    // A plugin that only keeps its context, the public way to read the anchors of the instance
    w.draw.extensions.plugins.add({
      name: 'terrain-probe',
      onAdd(context) {
        w.probe = context;
      },
    });
    await w.e2e.terrain.addTestTerrain(w.map, exaggeration);
    w.map.triggerRepaint();
  }, EXAGGERATION);
  await settle(page);
}, browserTimeout(90_000));

afterAll(async () => {
  await browser?.close();
});

/**
 * Points of the ground spread over the view, as longitude and latitude
 *
 * They are taken by unprojecting a grid of the canvas, so each lies on the drawn terrain.
 */
async function groundPoints(): Promise<Array<[number, number]>> {
  return page.evaluate((size) => {
    const map = (window as unknown as TerrainWindow).map;
    const points: Array<[number, number]> = [];
    for (let j = 1; j <= 5; j++) {
      for (let i = 1; i <= 6; i++) {
        const ll = map.unproject([(size.width * i) / 7, (size.height * j) / 6]);
        points.push([ll.lng, ll.lat]);
      }
    }
    return points;
  }, MAP_SIZE);
}

describe('the ground of the symbols', () => {
  it('the test terrain is loaded and exaggerated', async () => {
    const [peak, known] = await page.evaluate(() => {
      const w = window as unknown as TerrainWindow;
      return [
        w.map.queryTerrainElevation([138.73, 35.36]),
        w.e2e.terrain.testElevation(138.73, 35.36),
      ];
    });
    // Within a DEM pixel of the top of the peak
    expect(peak).not.toBeNull();
    expect(Math.abs((peak ?? 0) - known * EXAGGERATION)).toBeLessThan(50);
  });

  it('a symbol is drawn at the elevation maplibre gives the ground', async () => {
    const points = await groundPoints();
    const pairs = await page.evaluate((list) => {
      const w = window as unknown as TerrainWindow;
      return list.map(([lng, lat]) => [
        w.probe.terrain.elevation([lng, lat]),
        w.map.queryTerrainElevation([lng, lat]),
      ]);
    }, points);
    for (const [anchor, maplibre] of pairs) {
      expect(maplibre).not.toBeNull();
      expect(Math.abs((anchor ?? 0) - (maplibre ?? 0))).toBeLessThan(1e-6);
    }
  });

  it('a symbol is projected where map.project puts the ground', async () => {
    const points = await groundPoints();
    const offsets = await page.evaluate((list) => {
      const w = window as unknown as TerrainWindow;
      return list.map(([lng, lat]) => {
        const anchor = w.probe.terrain.project([lng, lat]);
        const maplibre = w.map.project([lng, lat]);
        return anchor ? Math.hypot(anchor[0] - maplibre.x, anchor[1] - maplibre.y) : null;
      });
    }, points);
    for (const offset of offsets) {
      expect(offset).not.toBeNull();
      expect(offset ?? Infinity).toBeLessThan(0.01);
    }
  });
});

describe('the ground of the fills (GPU)', () => {
  it('the drape reads the DEM textures where maplibre does', async () => {
    const points = await groundPoints();
    const pairs = await page.evaluate((list) => {
      const w = window as unknown as TerrainWindow;
      const { getMapTerrain, getRenderableTerrainTiles, getTerrainTileData, TERRAIN_SAMPLE_GLSL } =
        w.e2e.internals;
      const map = w.map;
      const painter = (map as unknown as { painter: { context: PainterContext } }).painter;
      const gl = painter.context.gl as WebGL2RenderingContext;
      const terrain = getMapTerrain(map);
      if (!terrain) throw new Error('no terrain');
      const tiles = getRenderableTerrainTiles(terrain).sort((a, b) => b.z - a.z);

      // One point per sample: drape_get_elevation in the vertex stage, packed like the atlas
      const vertex = `#version 300 es
precision highp float;
precision highp sampler2D;
${TERRAIN_SAMPLE_GLSL}
uniform vec2 u_pos;
uniform float u_index;
uniform float u_count;
flat out float v_elevation;
void main() {
    v_elevation = drape_get_elevation(u_pos);
    gl_Position = vec4((u_index + 0.5) / u_count * 2.0 - 1.0, 0.0, 0.0, 1.0);
    gl_PointSize = 1.0;
}`;
      const fragment = `#version 300 es
precision highp float;
flat in float v_elevation;
out vec4 fragColor;
void main() {
    float v = clamp((v_elevation + 32768.0) / 65536.0, 0.0, 0.99999994);
    float r = floor(v * 256.0);
    float g = floor((v * 256.0 - r) * 256.0);
    float b = floor(((v * 256.0 - r) * 256.0 - g) * 256.0);
    fragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
}`;
      const program = linkProgram(gl, vertex, fragment);
      const target = createTarget(gl, list.length, 1);
      gl.viewport(0, 0, list.length, 1);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.useProgram(program);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const at = (name: string) => gl.getUniformLocation(program, name);

      const expected: Array<number | null> = [];
      list.forEach(([lng, lat], index) => {
        const mx = (lng + 180) / 360;
        const my =
          (1 -
            Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) /
              Math.PI) /
          2;
        const tile = tiles.find(
          (t) => Math.floor(mx * 2 ** t.z) === t.x && Math.floor(my * 2 ** t.z) === t.y,
        );
        const data = tile ? getTerrainTileData(terrain, tile) : null;
        if (!tile || !data) {
          expected.push(null);
          return;
        }
        expected.push(map.queryTerrainElevation([lng, lat]));
        const pos = [(mx * 2 ** tile.z - tile.x) * 8192, (my * 2 ** tile.z - tile.y) * 8192];
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, data.texture);
        gl.uniform1i(at('u_terrain'), 0);
        gl.uniform1f(at('u_terrain_dim'), data.dim);
        gl.uniformMatrix4fv(at('u_terrain_matrix'), false, Float32Array.from(data.matrix));
        gl.uniform4f(
          at('u_terrain_unpack'),
          ...(Array.from(data.unpack) as [number, number, number, number]),
        );
        gl.uniform1f(at('u_terrain_exaggeration'), data.exaggeration);
        gl.uniform2f(at('u_pos'), pos[0], pos[1]);
        gl.uniform1f(at('u_index'), index);
        gl.uniform1f(at('u_count'), list.length);
        gl.drawArrays(gl.POINTS, 0, 1);
      });

      const pixels = new Uint8Array(list.length * 4);
      gl.readPixels(0, 0, list.length, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      releaseTarget(gl, target);
      gl.bindVertexArray(null);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      painter.context.setDirty();
      map.triggerRepaint();

      return expected.map((value, i): [number, number | null] => [decode(pixels, i), value]);

      interface PainterContext {
        gl: WebGL2RenderingContext;
        setDirty(): void;
      }
      function linkProgram(g: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
        const p = g.createProgram();
        for (const [type, source] of [
          [g.VERTEX_SHADER, vs],
          [g.FRAGMENT_SHADER, fs],
        ] as const) {
          const shader = g.createShader(type);
          if (!shader) throw new Error('no shader');
          g.shaderSource(shader, source);
          g.compileShader(shader);
          if (!g.getShaderParameter(shader, g.COMPILE_STATUS)) {
            throw new Error(String(g.getShaderInfoLog(shader)));
          }
          g.attachShader(p, shader);
        }
        g.linkProgram(p);
        if (!g.getProgramParameter(p, g.LINK_STATUS))
          throw new Error(String(g.getProgramInfoLog(p)));
        return p;
      }
      function createTarget(g: WebGL2RenderingContext, width: number, height: number) {
        const texture = g.createTexture();
        g.bindTexture(g.TEXTURE_2D, texture);
        g.texStorage2D(g.TEXTURE_2D, 1, g.RGBA8, width, height);
        const framebuffer = g.createFramebuffer();
        g.bindFramebuffer(g.FRAMEBUFFER, framebuffer);
        g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, texture, 0);
        g.clearColor(0, 0, 0, 0);
        g.clear(g.COLOR_BUFFER_BIT);
        return { texture, framebuffer };
      }
      function releaseTarget(
        g: WebGL2RenderingContext,
        t: { texture: WebGLTexture; framebuffer: WebGLFramebuffer },
      ): void {
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        g.deleteFramebuffer(t.framebuffer);
        g.deleteTexture(t.texture);
      }
      function decode(bytes: Uint8Array, i: number): number {
        const v = bytes[i * 4] / 256 + bytes[i * 4 + 1] / 65536 + bytes[i * 4 + 2] / 16777216;
        return v * 65536 - 32768;
      }
    }, points);

    let compared = 0;
    for (const [gpu, maplibre] of pairs) {
      if (maplibre === null) continue;
      compared++;
      expect(Math.abs(gpu - maplibre)).toBeLessThan(GPU_TOLERANCE_M);
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('the DEM atlas bakes the elevations maplibre gives', async () => {
    const points = await groundPoints();
    const pairs = await page.evaluate((list) => {
      const w = window as unknown as TerrainWindow;
      const { DemAtlas, getMapTerrain } = w.e2e.internals;
      const map = w.map;
      const painter = (
        map as unknown as {
          painter: { context: { gl: WebGL2RenderingContext; setDirty(): void } };
        }
      ).painter;
      const gl = painter.context.gl;
      const terrain = getMapTerrain(map);
      if (!terrain) throw new Error('no terrain');

      const atlas = new DemAtlas(gl);
      const center = map.getCenter();
      const result = atlas.build(terrain, (center.lng + 180) / 360, true);
      if (!result) throw new Error('the atlas was not built');
      const [x0, y0, invW, invH] = result.rect;
      const [width, height] = result.size;
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        result.texture,
        0,
      );

      const pixel = new Uint8Array(4);
      const out: Array<[number, number | null]> = [];
      for (const [lng, lat] of list) {
        const mx = (lng + 180) / 360;
        const my =
          (1 -
            Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) /
              Math.PI) /
          2;
        const u = (mx - x0) * invW;
        const v = (my - y0) * invH;
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        const column = Math.floor(u * width);
        const row = Math.floor(v * height);
        gl.readPixels(column, row, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const baked = (pixel[0] / 256 + pixel[1] / 65536 + pixel[2] / 16777216) * 65536 - 32768;
        // The texel holds the elevation at its center
        const centerX = x0 + (column + 0.5) / width / invW;
        const centerY = y0 + (row + 0.5) / height / invH;
        const centerLng = centerX * 360 - 180;
        const centerLat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * centerY))) * 180) / Math.PI;
        out.push([baked, map.queryTerrainElevation([centerLng, centerLat])]);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(framebuffer);
      atlas.dispose();
      painter.context.setDirty();
      map.triggerRepaint();
      return out;
    }, points);

    let compared = 0;
    for (const [baked, maplibre] of pairs) {
      if (maplibre === null) continue;
      compared++;
      expect(Math.abs(baked - maplibre)).toBeLessThan(GPU_TOLERANCE_M);
    }
    expect(compared).toBeGreaterThan(10);
  });
});

describe('the selection frame of a point on the terrain', () => {
  it('keeps the size of the marker and the margin on a pitched view (it is not stretched)', async () => {
    // A marker of radius 10 with an outline of 2 spans 24 px; the margin is 10 px on each side
    const expectedSide = 2 * (10 + 2) + 2 * 10;
    const frame = await page.evaluate(async (size) => {
      const w = window as unknown as TerrainWindow;
      const { map, draw } = w;
      // A point on the slope of the peak, below the middle of the view
      const ground = map.unproject([size.width / 2, size.height * 0.6]);
      const point = draw.features.create({
        type: 'Point',
        geometry: { type: 'Point', coordinates: [ground.lng, ground.lat] },
        style: { pointColor: '#00ff00', pointRadius: 10, pointStrokeWidth: 2 },
      });
      if (!point) throw new Error('no feature');
      draw.selection.set('feature', [point.id]);
      const frameReady = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));
      await frameReady();
      await frameReady();
      const extent = await new Promise<number[]>((resolve) => {
        map.once('render', () => {
          const gl = map.getCanvas().getContext('webgl2') as WebGL2RenderingContext;
          const width = gl.drawingBufferWidth;
          const height = gl.drawingBufferHeight;
          const pixels = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const ratio = width / map.getCanvas().clientWidth;
          // The pixels of the stroke of the frame (#FF2D55)
          const box = [Infinity, Infinity, -Infinity, -Infinity];
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 4;
              const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
              if (r < 200 || g > 100 || b < 50 || b > 130) continue;
              const sx = x / ratio;
              const sy = (height - 1 - y) / ratio;
              box[0] = Math.min(box[0], sx);
              box[1] = Math.min(box[1], sy);
              box[2] = Math.max(box[2], sx);
              box[3] = Math.max(box[3], sy);
            }
          }
          resolve(box);
        });
        map.triggerRepaint();
      });
      draw.features.delete(point.id);
      return extent;
    }, MAP_SIZE);

    // The outer edge of the 2 px stroke is 1 px outside the side of the frame. The pixels of
    // the stroke round its edges by up to a pixel, and the frame placed on the screen to the
    // first order lands within a pixel more on a view this pitched (a frame cast onto the
    // ground was 8 px taller here)
    const width = frame[2] - frame[0] + 1 - 2;
    const height = frame[3] - frame[1] + 1 - 2;
    expect(Math.abs(width - expectedSide)).toBeLessThanOrEqual(3);
    expect(Math.abs(height - expectedSide)).toBeLessThanOrEqual(3);
  });
});
