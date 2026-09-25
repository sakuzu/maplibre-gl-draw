// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerrainContext } from '../terrain/context.js';
import type { TerrainRenderState } from '../terrain/state.js';
import { type FrameRenderDeps, renderSegment } from './frame-render.js';
import type { FrameState } from './frame-state.js';

/** The GL state the layer rendering starts in, recorded by the mocked renderLayers */
const atLayers: GlState[] = [];

vi.mock('./render.js', () => ({
  renderLayers: (r: { gl: RecordingGl }) => {
    atLayers.push({ ...r.gl.state });
  },
}));

const DEPTH_TEST = 2929;
const POLYGON_OFFSET_FILL = 32823;
const LESS = 513;
const LEQUAL = 515;

interface GlState {
  depthTest: boolean;
  depthMask: boolean;
  depthFunc: number;
  polygonOffsetFill: boolean;
  polygonOffset: [number, number];
}

type RecordingGl = WebGL2RenderingContext & { state: GlState };

/** A GL that keeps the state the layer switches (maplibre hands over LEQUAL and writes on) */
function createGl(): RecordingGl {
  const state: GlState = {
    depthTest: true,
    depthMask: true,
    depthFunc: LEQUAL,
    polygonOffsetFill: false,
    polygonOffset: [0, 0],
  };
  const flag = (cap: number, on: boolean) => {
    if (cap === DEPTH_TEST) state.depthTest = on;
    if (cap === POLYGON_OFFSET_FILL) state.polygonOffsetFill = on;
  };
  return {
    state,
    DEPTH_TEST,
    POLYGON_OFFSET_FILL,
    LESS,
    LEQUAL,
    TEXTURE0: 33984,
    TEXTURE_2D: 3553,
    BLEND: 3042,
    enable: (cap: number) => flag(cap, true),
    disable: (cap: number) => flag(cap, false),
    isEnabled: (cap: number) => (cap === DEPTH_TEST ? state.depthTest : false),
    depthMask: (on: boolean) => {
      state.depthMask = on;
    },
    depthFunc: (func: number) => {
      state.depthFunc = func;
    },
    polygonOffset: (factor: number, units: number) => {
      state.polygonOffset = [factor, units];
    },
    activeTexture: () => {},
    bindTexture: () => {},
    blendFuncSeparate: () => {},
  } as unknown as RecordingGl;
}

const TERRAIN = { active: true, atlasTexture: null } as unknown as TerrainRenderState;

/** One slot of a frame on terrain, with or without the drape */
function setup(drapeUsable: boolean, wideFallback = false) {
  const gl = createGl();
  const atDrape: GlState[] = [];
  const terrainContext = new TerrainContext();
  terrainContext.renderState = TERRAIN;
  const copy = {
    projectionData: {},
    offsetUniforms: {},
    terrainState: TERRAIN,
    features: [],
    customRendererContext: {},
    view: null,
  };
  const frame = {
    terrainState: TERRAIN,
    drapeLight: { direction: [0, 0, 1], strength: 0.45 },
    drapeUsable,
    drapeReady: drapeUsable,
    wideFallback,
    quadDrapeFrame: null,
    restoreBlendState: () => {},
    segments: [{ from: 0, to: 1 }],
    layerOrder: ['layer'],
    drapeEntryStarts: new Map([['layer', 0]]),
    drapeAboveStoreStart: 1,
    drapeElementsTotal: 1,
    drapeTileDraws: [{ draw: {}, projection: {} }],
    pendingQuads: [],
    copies: [copy],
    baseCopy: copy,
    selectedIdSet: new Set(),
    zoom: 13,
    dpr: 1,
    layerAwareRenderers: [],
    useRetained: false,
  } as unknown as FrameState;
  const deps = {
    gl,
    // renderLayers receives the renderers first; the mock reads the GL from them
    renderers: {
      gl,
      shaderInitializer: { setProjectionData: () => {}, applyOffsetUniforms: () => {} },
    },
    store: {},
    terrainContext,
    drape: {
      renderer: { drawTile: () => atDrape.push({ ...gl.state }) },
      sourceFactors: new Float32Array(4),
      hasSelection: false,
    },
    customRenderers: new Map(),
    featureCompanions: {},
    storeRetainedCache: null,
    selectionScope: {},
  } as unknown as FrameRenderDeps;
  return { gl, frame, deps, atDrape };
}

beforeEach(() => {
  atLayers.length = 0;
});

describe('the depth state of the layer rendering', () => {
  it('is the same whether or not the drape was drawn before it', () => {
    const withDrape = setup(true);
    renderSegment(withDrape.deps, withDrape.frame, 0);
    const withoutDrape = setup(false);
    renderSegment(withoutDrape.deps, withoutDrape.frame, 0);

    // The drape itself: LEQUAL and no offset
    expect(withDrape.atDrape).toHaveLength(1);
    expect(withDrape.atDrape[0]).toMatchObject({ depthTest: true, polygonOffsetFill: false });

    // What the drape cannot paint (dashed lines, the geometry being drawn, the features of
    // extensions, the datasets not handed over to it) is hidden by the terrain after the
    // drape as well
    expect(atLayers).toHaveLength(2);
    expect(atLayers[0]).toEqual(atLayers[1]);
    expect(atLayers[0]).toMatchObject({
      depthTest: true,
      depthMask: false,
      depthFunc: LEQUAL,
      polygonOffsetFill: true,
    });
    expect(atLayers[0].polygonOffset[0]).toBeLessThan(0);
  });

  it('has no depth test in the zoomed-out fallback', () => {
    const { deps, frame } = setup(false, true);
    renderSegment(deps, frame, 0);
    expect(atLayers[0]).toMatchObject({ depthTest: false, polygonOffsetFill: false });
  });
});
