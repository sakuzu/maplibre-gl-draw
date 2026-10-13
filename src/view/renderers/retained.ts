// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The set of renderers for retained mode
 *
 * Rendering that is not rebuilt every frame, such as a
 * dataset, calls batch building (creating GPU resources) and drawing
 * (bind + uniforms + draw call) separately. This module gathers just those
 * entry points, so that the drawing side does not depend on the internal
 * structure of BatchManager.
 *
 * The builders from packed typed arrays (`buildRetainedPacked` and `buildRetainedPackedBatch`)
 * are optional: a set without them gets the same data as arrays of objects. So are the batches of
 * rows held as columns (built from their arrays, drawn a range of rows at a time); a set without
 * them does not draw such rows.
 *
 * The immediate-mode API (drawAll / drawBatch) is not part of this type. A
 * retained-mode batch does not share resources with the shared buffers and
 * shared textures of immediate mode.
 */

import type { RetainedDrawRun } from './draw-run.js';
import type { FeatureDrawer } from './drawer.js';
import type { SDFLineRenderer } from './line/sdf-line.js';
import type { PointInstanceRenderer } from './point/point-instance.js';
import type { SDFPolygonRenderer } from './polygon/sdf-polygon.js';

/** Retained-mode API for lines */
export type RetainedLineRenderer = Pick<
  SDFLineRenderer,
  'buildRetainedBatch' | 'drawRetainedBatch' | 'disposeRetainedBatch'
> &
  Partial<
    Pick<SDFLineRenderer, 'buildRetainedPackedBatch' | 'buildRetainedRows' | 'drawRetainedRange'>
  >;

/** Retained-mode API for polygons */
export type RetainedPolygonRenderer = Pick<
  SDFPolygonRenderer,
  'buildRetained' | 'drawRetained' | 'disposeRetained'
> &
  Partial<
    Pick<SDFPolygonRenderer, 'createRetainedRows' | 'writeRetainedRows' | 'drawRetainedRange'>
  >;

/** Retained-mode API for points */
export type RetainedPointRenderer = Pick<
  PointInstanceRenderer,
  'buildRetained' | 'drawRetained' | 'disposeRetained'
> &
  Partial<
    Pick<PointInstanceRenderer, 'buildRetainedPacked' | 'buildRetainedRows' | 'drawRetainedRange'>
  >;

/** Style resolution (used only once, at build time) */
export type RetainedStyleResolver = Pick<
  FeatureDrawer,
  'getPointStyle' | 'getLineStringStrokeStyle' | 'getPolygonStyles'
>;

/**
 * The set of renderers needed for retained-mode rendering
 */
export interface RetainedRendererSet {
  /** Lines (only solid ones are used, since dashed polygon outlines go to immediate mode) */
  line: RetainedLineRenderer;
  /** Polygons (fill + solid outline) */
  polygon: RetainedPolygonRenderer;
  /** Points (instanced circles, squares, triangles and stars) */
  point: RetainedPointRenderer;
  /** Style resolution */
  styles: RetainedStyleResolver;
  /** Pixel size of the render target [width, height] */
  viewport(): [number, number];
  /**
   * The run of the retained draws of the context of the renderers. The side that draws a layer's
   * batches one after another opens a run around them, forgets it before anything else draws in
   * between, and ends it (`draw-run.ts`). Without it every draw sets its whole state, as alone
   */
  readonly run?: RetainedDrawRun;
}
