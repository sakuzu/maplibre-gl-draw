// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values of the GPU of a frame, as a renderer with shaders of its own reads them from the
 * render context of its draw call
 *
 * The render context of the contract carries the shared renderers, the screen and the terrain,
 * and nothing of the GPU. The engine binds each render context it hands out to the values of the
 * frame it was made for here, so that the main entry names none of them and a renderer of its own
 * shaders reads them through the second entry.
 */

import type { Position } from 'geojson';
import type { ProjectionData } from 'maplibre-gl';
import type { RenderContext } from '../../api/extension/render.js';
import { DrawError } from '../../shared/draw-error.js';
import {
  calculateOffsetUniforms,
  type OffsetUniforms,
  type ProjectionMatrices,
  type ShaderData,
} from './helpers.js';

/**
 * The values of the GPU of a view a shader of its own is compiled and drawn with: the prelude of
 * the projection of the view, its projection data, and the values for drawing positions relative
 * to the center of the view.
 */
export interface ViewUniforms {
  /** The shader prelude of the projection of the view, to compile programs with */
  readonly shader: ShaderData;
  /** The projection of the view, as the map passes it to a custom layer */
  readonly projection: ProjectionData;
  /** The values for drawing positions relative to the center of the view */
  readonly offset: OffsetUniforms;
}

/** What a render context stands for: the values of its frame, and the matrix of its copy */
interface BoundView extends ViewUniforms {
  /** The projection the CPU computes centers with, in float64 */
  readonly frame: ProjectionMatrices;
}

/** The values of the frame behind each render context the engine handed out */
const views = new WeakMap<object, BoundView>();

/**
 * Binds a render context to the values of the GPU of its frame
 *
 * @param frame - The projection of the frame in float64, the center of which the offsets are
 *   computed in
 * @internal
 */
export function bindViewUniforms(
  ctx: RenderContext,
  view: ViewUniforms & { frame: ProjectionMatrices },
): void {
  views.set(ctx, view);
}

/** The values of a render context, or the error of one the engine did not hand out */
function viewOf(ctx: RenderContext): BoundView {
  const view = views.get(ctx);
  if (!view) {
    throw new DrawError(
      'invalid-input',
      'The render context is not one the instance gave a renderer in a draw call',
    );
  }
  return view;
}

/**
 * The values of the GPU of the view a render context draws: the shader prelude to compile
 * programs with, the projection data, and the values for drawing positions relative to the
 * center of the view, which `ProjectionUniformManager.setUniforms` takes.
 *
 * @param ctx - The render context of the draw call
 * @throws `DrawError` with the code `invalid-input` when the render context is not one the
 *   instance gave a renderer
 */
export function viewUniforms(ctx: RenderContext): ViewUniforms {
  const { shader, projection, offset } = viewOf(ctx);
  return { shader, projection, offset };
}

/**
 * The values for drawing positions relative to a position rather than to the center of the view,
 * in the view a render context draws: the offsets of a shape around its own position, for a
 * shape far from the center drawn with the precision of 32-bit floats near it.
 *
 * @param ctx - The render context of the draw call
 * @param position - The position the offsets are taken from, `[lng, lat]` in degrees
 * @throws `DrawError` with the code `invalid-input` when the render context is not one the
 *   instance gave a renderer
 */
export function offsetUniformsAt(ctx: RenderContext, position: Position): OffsetUniforms {
  return calculateOffsetUniforms([position[0], position[1]], viewOf(ctx).frame);
}
