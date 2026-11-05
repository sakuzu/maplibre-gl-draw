// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drawing: the renderers of custom feature types and overlays, the values they draw with,
 * and the shared renderers they can draw through
 */

import type { Position } from 'geojson';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { RowSpriteSource } from '../../view/renderers/rows/rows-format.js';
import type { Feature, FeatureStyleResolved, LineStyle, PointShape } from '../model.js';
import type { LayerTableView, RowHandle } from '../tables.js';
import type { ScreenContext, TerrainSurface } from './context.js';

/**
 * The shared renderer of lines. It only draws; the zoom, the projection and the terrain come
 * from the {@link RenderContext} it was taken from.
 *
 * The shared renderers read their colors as `parseCssColor` does: a color they cannot read
 * is drawn transparent, and told by a warning in the console, once for each part of each
 * renderer of an instance.
 */
export interface LineRenderer {
  /**
   * Draws a line.
   *
   * @param coordinates - The positions of the line
   * @param style - The width in pixels, the CSS color, the opacity from 0 to 1, the dash
   *   pattern, and a custom `[dash, gap]` in pixels
   * @param options - `closed` joins the last position to the first; `widthUnit` says whether
   *   the width is in CSS pixels (`'pixels'`, when it is left out) or in meters on the ground
   *   (`'meters'`: a length on the ground, drawn as the pixels it spans at the zoom and at the
   *   latitude of the middle of the line, so it follows the map); `referenceZoom` is the zoom at
   *   which a width in pixels is given, so that the line grows and shrinks with the zoom: it is
   *   drawn `2 ** (zoom - referenceZoom)` times as wide (the width stays the same at every zoom
   *   when it is left out). `referenceZoom` applies to a width in pixels only: a width in meters
   *   follows the map by itself and does not take it
   */
  draw(
    coordinates: readonly Position[],
    style: {
      width: number;
      color: string;
      opacity: number;
      lineStyle: LineStyle;
      dashArray?: number[];
    },
    options?: { closed?: boolean; widthUnit?: 'pixels' | 'meters'; referenceZoom?: number },
  ): void;
}

/**
 * The shared renderer of areas. It only draws; the zoom, the projection and the terrain come
 * from the {@link RenderContext} it was taken from.
 */
export interface FillRenderer {
  /**
   * Fills an area.
   *
   * @param rings - The outer ring first, then the holes
   * @param style - The CSS color and the opacity from 0 to 1
   */
  draw(rings: readonly (readonly Position[])[], style: { color: string; opacity: number }): void;
}

/**
 * The shared renderer of point markers. It only draws; the zoom, the projection and the
 * terrain come from the {@link RenderContext} it was taken from.
 */
export interface PointRenderer {
  /**
   * Draws a point marker.
   *
   * @param position - The position
   * @param style - The shape, the size in pixels, the fill and the outline (CSS colors,
   *   opacities from 0 to 1, the outline width in pixels). The size is the diameter of the
   *   marker, twice the `pointRadius` of a style: a marker drawn with the look a feature is drawn
   *   with (`RenderContext.appliedStyle`) takes `size: 2 * look.pointRadius`
   * @param options - `elevationMeters` places the marker at this height instead of on the
   *   ground; `referenceZoom` is the zoom at which the size and the outline width are given, so
   *   that the marker grows and shrinks with the zoom as a line does: it is drawn `2 ** (zoom -
   *   referenceZoom)` times as large (the same size at every zoom when it is left out)
   */
  draw(
    position: Position,
    style: {
      shape: PointShape;
      /** The diameter of the marker, in CSS pixels */
      size: number;
      fillColor: string;
      fillOpacity: number;
      strokeColor: string;
      strokeWidth: number;
      strokeOpacity: number;
    },
    options?: { elevationMeters?: number; referenceZoom?: number },
  ): void;
}

/**
 * Everything a renderer needs to draw: the shared renderers, the screen and the terrain of the
 * view being drawn. A renderer with shaders of its own reads the values of the GPU of that view
 * through `viewUniforms(ctx)` and `offsetUniformsAt(ctx, position)` of
 * `@sakuzu/maplibre-gl-draw/webgl`.
 */
export interface RenderContext {
  /** The WebGL context of the map */
  readonly gl: WebGL2RenderingContext;
  /**
   * The conversion between the map and the screen, its zoom and its pixel ratio, in the view
   * being drawn: the same object as `ctx.screen` of the context of an extension, which answers
   * for the view drawn last once the view is drawn
   */
  readonly screen: ScreenContext;
  /** The opacity of the layer being drawn, from 0 to 1 */
  readonly opacity: number;
  /**
   * The heights of the terrain and where it hides a position. The building blocks of the
   * `/webgl` entry that draw on the terrain take it, or the whole render context.
   */
  readonly terrain: TerrainSurface;
  /** The shared renderer of lines */
  readonly line: LineRenderer;
  /** The shared renderer of areas */
  readonly fill: FillRenderer;
  /** The shared renderer of point markers */
  readonly point: PointRenderer;
  /**
   * The look a feature is drawn with, put together as `draw.features.getAppliedStyle` puts it:
   * the look its type declares (`FeatureTypeDefinition.defaultStyle`, the defaults of its
   * geometry for a type that declares none), the color of the rule of its layer and the style of
   * the feature, put on top of each other by the library. It answers for the feature given, the
   * one the renderer draws with the sketches applied, where `getAppliedStyle` answers for the
   * values of the document. A renderer draws with it rather than reading `feature.style` and
   * defaults of its own, so that what it draws is what the library answers.
   *
   * It is put together once for a feature as it is: reading it again, in the same draw or in the
   * next one, gives the same object until the feature, the rule of its layer or the `style`
   * option changes. Do not change the object.
   */
  appliedStyle(feature: Feature): FeatureStyleResolved;
}

/**
 * How the features of a custom type are drawn. The methods take their arguments in the order
 * of a custom layer of the map.
 */
export interface FeatureRenderer {
  /** Called when the renderer is added to the map; create the programs and buffers here. */
  onAdd(map: MaplibreMap, gl: WebGL2RenderingContext): void;
  /** Draws one feature. */
  draw(feature: Feature, ctx: RenderContext): void;
  /** Called when the renderer is removed; release what `onAdd` created. */
  onRemove(map: MaplibreMap, gl: WebGL2RenderingContext): void;
  /**
   * How it draws the rows of a layer held as rows, without making features of them. Its type is
   * in `@sakuzu/maplibre-gl-draw/kasane`.
   *
   * @experimental
   */
  readonly rows?: FeatureRendererRows;
}

/**
 * How a renderer of a feature type draws the rows of a layer held as rows
 * (`FeatureRenderer.rows`), without making features of them
 *
 * @experimental
 */
export interface FeatureRendererRows {
  /**
   * The pictures it draws its points with: a point it takes whose style has a picture here is
   * drawn with the other rows of its layer, in their order and in their draw, from the texture
   * and the picture given, rather than by `draw` one at a time (a point whose style has none is
   * drawn by `draw`). Without it, every feature it takes is drawn by `draw`.
   */
  readonly sprites?: RowSpriteSource;
  /**
   * How it holds the rows it draws on the GPU: the rows it takes that have no companion are
   * given to it once, and every frame it draws a range of them, in the order of the layer, with
   * no work for each row. Without it, the instance makes the features of the rows (keeping them
   * up to a limit) and draws them by `FeatureRenderer.draw`.
   *
   * Types that give the same object have their rows in one range, also where the rows of the
   * types alternate. Given with `sprites`, it is the one used.
   */
  readonly gpu?: GpuRowsSource;
}

/**
 * Makes what holds a range of rows of a layer on the GPU (`FeatureRendererRows.gpu`)
 *
 * @experimental
 */
export interface GpuRowsSource {
  /**
   * Makes what holds one range of the rows of a layer, empty. A layer has as many as it has ranges
   * of such rows between the rows drawn otherwise.
   *
   * @param view - The rows of the layer
   */
  create(view: LayerTableView): GpuRows;
}

/**
 * What a write changed of a row held on the GPU (`GpuRows.update`)
 *
 * @experimental
 */
export interface GpuRowChange {
  /** Whether its geometry changed */
  readonly geometry: boolean;
  /** Whether its style changed */
  readonly style: boolean;
  /** Whether its attributes changed */
  readonly values: boolean;
}

/**
 * A range of rows of a layer an extension holds on the GPU and draws (`GpuRowsSource.create`)
 *
 * It owns the memory it holds: it records it as rows (`ExtensionContext.gpu`, `rows` true: it is
 * out of the limit of the instance) and keeps it under the limit it sets itself, by taking fewer
 * rows. It lets go of everything in `release`, also of what a call that throws had made. A row it does not take, and a row of a frame it does
 * not draw, is drawn by `FeatureRenderer.draw`, in its place in the order: taking fewer rows
 * makes a frame slower, and changes nothing of the picture. What it holds can be made again from
 * the rows, so the instance may release it at any time.
 *
 * A row is named by its index: the rows it took, counted from 0 in the order it took them.
 *
 * @experimental
 */
export interface GpuRows {
  /**
   * Takes rows, after the ones it took. They are in the order of the layer; a row without a
   * geometry is among them, takes its index, and draws nothing.
   *
   * A row taken draws as it reads now, with the state `setStates` gives right after this call.
   * When it takes fewer rows than it is given, the ones left are given again in a later frame
   * while {@link GpuRows.hasPendingWork} is true. When that is false it refused them: they are
   * drawn by `FeatureRenderer.draw`, and given again once the instance released something.
   *
   * @param rows - The rows, read during the call only
   * @param stopAtMilliseconds - When to stop, on the clock of `performance.now()` (`Infinity` for
   *   no limit): this is how the work of a frame stays within its budget. Taking a row past it is
   *   allowed, so that a call always takes one when it can.
   * @returns The number of rows it took, the first ones of `rows`
   */
  add(rows: Int32Array, stopAtMilliseconds: number): number;
  /**
   * Takes a row as it was written, in the frame that shows the write. A write of a row out of view
   * comes here too.
   *
   * @param index - The index of the row
   * @param row - The row
   * @param change - What was written
   * @returns false when it cannot hold the row as written: the row is drawn from elsewhere, in the
   *   same place in the order, and `setStates` hides the row at this index
   */
  update(index: number, row: RowHandle, change: GpuRowChange): boolean;
  /**
   * Takes the state of rows: the byte `ROW_STATE_GLSL` of `@sakuzu/maplibre-gl-draw/webgl` reads
   * for each row, from whether the row is hidden and how it moves. The rows of a range are given
   * together, once when they are taken, and once for every change of the state of the rows around
   * them.
   *
   * @param from - The index of the first row
   * @param states - One byte per row, read during the call only
   */
  setStates(from: number, states: Uint8Array): void;
  /**
   * Draws the rows `[from, to)` in their order, at the place of the order this call has among
   * what the layer draws. The hidden rows are among them, and the rows out of view. It may be
   * called more than once in a frame: for the parts of a range with other rows between them, and
   * for each copy of the world.
   *
   * @param from - The index of the first row
   * @param to - The end of the rows (exclusive)
   * @param ctx - The context of the frame
   * @returns false when it did not draw them: they are drawn by `FeatureRenderer.draw`, in this
   *   frame
   */
  draw(from: number, to: number, ctx: RenderContext): boolean;
  /** Whether some of its work has not finished yet, so that another frame is needed. */
  hasPendingWork(): boolean;
  /**
   * Releases what it holds. Nothing is called on it after this. It may come after
   * `FeatureRenderer.onRemove`, and after the context was lost, so the renderer must keep it safe
   * to call then, and take what it holds out of `ExtensionContext.gpu`.
   */
  release(): void;
}

/**
 * A renderer that draws above the features, or between the layers.
 */
export interface OverlayRenderer {
  /** The name it is registered under */
  readonly name: string;
  /**
   * The order among the overlays: a lower one is drawn first, below a higher one. Overlays of
   * the same order are drawn in the order they were added; 0 when it is left out.
   */
  readonly order?: number;
  /** Called when the renderer is added to the map; create the programs and buffers here. */
  onAdd(map: MaplibreMap, gl: WebGL2RenderingContext): void;
  /** Draws above every layer. */
  draw(ctx: RenderContext): void;
  /** Draws just above one layer, for an overlay drawn between the layers. */
  drawForLayer?(layerId: string, ctx: RenderContext): void;
  /**
   * Draws the vertices of what the overlay shows, above the features of every layer and the
   * selection, so that they stay visible over a layer further back.
   */
  drawVertices?(ctx: RenderContext): void;
  /** Whether some of its drawing has not finished yet. */
  hasPendingWork?(): boolean;
  /** Called when the renderer is removed; release what `onAdd` created. */
  onRemove(map: MaplibreMap, gl: WebGL2RenderingContext): void;
}
