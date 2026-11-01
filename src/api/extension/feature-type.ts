// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Custom feature types: the one definition that says how a type is drawn, hit, selected and
 * resized
 */

import type { Geometry, Position } from 'geojson';
import type { BBox } from '../../geometry/types.js';
import type { ScreenPoint } from '../events.js';
import type { Feature, FeaturePatch, FeatureStyle } from '../model.js';
import type { LayerTableView, RowHandle } from '../tables.js';
import type { HandleContext, PointContext, ScreenContext } from './context.js';
import type { DrawPointerEvent } from './mode.js';
import type { Hit, SnapCandidate } from './provider.js';
import type { FeatureRenderer, RenderContext } from './render.js';
import type { TransformFields } from './store.js';

/**
 * A handle the library draws as it draws the resize handles at the corners of the selection box
 * (`selectionStyle.resizeHandle`), and hits at the size it draws it, such as a handle in the middle
 * of an edge that changes the width of a box. It has the look of a resize handle only: its drag
 * goes to the extension that gave it (`onHandleDrag` of a type, `onDrag` of a provider), which
 * says what it changes, not to the edit `scale` of the library, which the resize handles at the
 * corners make.
 */
export interface ResizeHandle {
  /** A handle drawn and hit as the resize handles are */
  kind: 'resize';
  /** The ID of the handle, unique within the feature; the extension tells its handles apart by it */
  id: string;
  /** The position of the handle on the map */
  position: Position;
  /** The CSS cursor over the handle; `pointer` when it is left out */
  cursor?: string;
}

/**
 * A handle the extension draws itself (in `drawHandles` of a type or of a provider), such as a
 * mark on the end of a line. The library does not draw it, and hits it within a square of `sizePx`
 * CSS pixels around its position: give it the diameter of the mark drawn. Its drag goes to the
 * extension that gave it.
 */
export interface CustomHandle {
  /** A handle the extension draws */
  kind: 'custom';
  /** The ID of the handle, unique within the feature; the extension tells its handles apart by it */
  id: string;
  /** The position of the handle on the map */
  position: Position;
  /**
   * The size of the mark the extension draws (its diameter), in CSS pixels, a finite number above
   * 0: the side of the square the handle is hit in
   */
  sizePx: number;
  /** The CSS cursor over the handle; `pointer` when it is left out */
  cursor?: string;
}

/**
 * One handle an extension adds to a selected feature: one the library draws as a resize handle
 * (`kind: 'resize'`), or one the extension draws itself (`kind: 'custom'`).
 *
 * The library decides when the handles are shown, hit and dragged, for every extension alike:
 * while one feature only is selected, the document is not read-only nor under the interaction
 * lock, the feature is not locked, and no other handle of the selection (a resize, rotate or
 * vertex handle) is dragged. An extension does not test these itself. A handle of another kind,
 * or a custom one whose `sizePx` is not a finite number above 0, is left out, with a warning in
 * the console once for each kind and extension.
 */
export type Handle = ResizeHandle | CustomHandle;

/**
 * What a definition of a feature type answers from the rows of a layer held as rows
 * (`FeatureTypeDefinition.rows`), without making features of them
 *
 * @experimental
 */
export interface FeatureTypeRows {
  /**
   * Whether the definition takes the feature of a row: the answer `appliesTo` gives for the
   * feature of the row (the two must agree). It is read with `appliesTo` only, and as it, only in
   * a definition that overrides a built-in type. Without it, a feature is made from each row of
   * the type to ask `appliesTo` whenever the rows are classified for the drawing, so a type of many
   * rows should have it.
   */
  appliesTo(view: LayerTableView, handle: RowHandle): boolean;
}

/**
 * A footprint laid on the map (`FeatureTypeDefinition.footprint`): four corners on the map, in
 * the order top left, top right, bottom right, bottom left of the shape as it stands unturned.
 * The word `ground` names the plane of the map here, not the surface of the terrain.
 */
export interface GroundFootprint {
  /** A footprint laid on the map */
  kind: 'ground';
  /** The four corners, as positions on the map */
  corners: {
    topLeft: Position;
    topRight: Position;
    bottomRight: Position;
    bottomLeft: Position;
  };
}

/**
 * A footprint of a fixed size on the screen (`FeatureTypeDefinition.footprint`): a box around a
 * position on the map, the half of its width and height in pixels.
 */
export interface ScreenFootprint {
  /** A footprint of a fixed size on the screen */
  kind: 'screen';
  /** The position on the map the box is around */
  position: Position;
  /** Half the width of the box, in CSS pixels */
  halfWidthPx: number;
  /** Half the height of the box, in CSS pixels */
  halfHeightPx: number;
}

/**
 * What a feature covers, as its type declares it (`FeatureTypeDefinition.footprint`): four
 * corners laid on the map, or a box of a fixed size on the screen around a position.
 */
export type Footprint = GroundFootprint | ScreenFootprint;

/**
 * The definition of a custom feature type. Its handles and snapping candidates are written
 * here; a provider is only for the types an extension does not define.
 */
export interface FeatureTypeDefinition {
  /** The name of the type; it is registered under this name */
  readonly type: string;
  /** The kind of GeoJSON geometry the features of this type have; one kind per type */
  readonly geometry: Geometry['type'];
  /**
   * How far beyond its geometry a feature of this type can be hit, in pixels, such as the
   * half size of an icon drawn on a point. The candidates of a hit test are gathered this much
   * farther out; 0 when it is left out.
   */
  readonly hitPaddingPx?: number;
  /** How the features of this type are drawn */
  readonly renderer: FeatureRenderer;
  /**
   * The look of a feature of this type whose style and layer rule leave a key out, in place of
   * the defaults of its geometry (the `style` option), which still fill the keys it leaves out.
   * `draw.features.getAppliedStyle` and the render context (`ctx.appliedStyle(feature)`) put the
   * color of the layer rule and the style of the feature over it, so a renderer that draws with
   * that answer draws what the library answers. The rule colors the fill of a custom type
   * (`fillColor`, see `getStyleRuleChannel`), whatever its geometry, and the style of a feature
   * wins over the rule.
   *
   * It is checked as the style of a feature is, and copied when the type is added. A definition
   * given to `override` cannot have it (a built-in type keeps the defaults of the `style`
   * option): `override` throws `invalid-input`.
   */
  readonly defaultStyle?: FeatureStyle;
  /**
   * Which features of the type the definition takes, for a definition that overrides a
   * built-in type (`extensions.featureTypes.override`). A feature for which it returns false
   * keeps the built-in type: its built-in drawing (drawn in batches with the other features),
   * hit test, box selection, selection frame, handles, snapping candidates and extent. The
   * others are drawn, hit and framed by this definition. Every feature of the type is taken
   * when it is left out.
   *
   * It is asked again whenever a feature changes, so its answer must follow from the feature
   * (its properties, its geometry, its style) and nothing outside it. It is ignored in a
   * definition given to `add`: a custom type takes every feature of its type.
   */
  appliesTo?(feature: Feature): boolean;
  /**
   * What the definition answers from the rows of a layer held as rows, without making features of
   * them. Its type is in `@sakuzu/maplibre-gl-draw/kasane`.
   *
   * @experimental
   */
  readonly rows?: FeatureTypeRows;
  /**
   * The extent of a feature on the map, `[west, south, east, north]` in degrees, for a type
   * that draws beyond its geometry by a distance on the ground. The spatial index takes it:
   * it gathers the candidates of a hit test and of a box selection, answers
   * `features.list({ bbox })`, and decides which features are near enough to the view to be
   * drawn. The extent of the geometry is used when it is left out, and when it returns an
   * extent that is not four finite numbers from the west and south to the east and north.
   *
   * It is measured when a feature changes; call `invalidate({ type })` when it depends on
   * something outside the document. A reach in pixels belongs in `hitPaddingPx`.
   */
  bbox?(feature: Feature): BBox;
  /**
   * Hit tests a feature of this type; the geometry is hit tested when it is left out.
   *
   * @returns What was hit, or `null`
   */
  hitTest?(feature: Feature, ctx: PointContext): Hit | null;
  /**
   * Whether a box selection takes a feature of this type.
   *
   * @param boxPx - The corners of the box on the screen, in pixels
   */
  boxSelect?(
    feature: Feature,
    boxPx: { min: ScreenPoint; max: ScreenPoint },
    ctx: PointContext,
  ): boolean;
  /**
   * The footprint of a feature: what it covers, without the margin of the selection box, which
   * the engine adds (`selectionStyle.box.margin`) to draw the selection box, hit it and place
   * the handles. Either four corners laid on the map (`kind: 'ground'`), for a shape drawn on
   * the map, turned as it is, or a box of a fixed size on the screen around a position on the map
   * (`kind: 'screen'`), for a mark that keeps its size on the screen. The kind decides how the
   * selection box is drawn and hit, whatever the geometry: a box on the map is drawn and hit on
   * the map, and has the resize handles on its corners and the rotate handle above it, joined to
   * it by a line, drawn and hit as those of a built-in shape (with `selectionStyle`) and dragged
   * by the edits `scale` and `rotate` (which write the geometry and the fields of
   * `transformFields`), for one feature selected or many; a box on the screen is drawn and hit on the screen, around its position,
   * and has none of them.
   *
   * A type without it, or a footprint that is not one of the two (corners that are not four
   * finite positions, sizes that are not finite numbers of 0 or more), has the footprint of its
   * geometry: the extent of its positions, or a point the size of a point marker around it.
   *
   * @returns The footprint, or `null` when the feature has nothing to draw
   */
  footprint?(feature: Feature, ctx: ScreenContext): Footprint | null;
  /**
   * The fields of its features that the resize and the rotation change with their geometry: the
   * key of `properties` of their rotation and of their size, and whether a scaling keeps their
   * shape. The edits `scale` and `rotate` write them, whether they come from the resize handles at
   * the corners of the selection box and the rotate handle above it (which a type with a footprint
   * laid on the map has), for one feature selected or many, or from a Store edit
   * (`Store.applyEdits`). A feature without a key of them starts from 0 for the rotation and 1 for
   * the size. A rotation of a single feature of a `Point` geometry, of a type that declares
   * `angleDegreesKey`, turns it around its position.
   *
   * Without it, the resize and the rotation change the geometry of the features only, whatever
   * keys they have. A definition given to `override` cannot have it (a built-in type keeps its own
   * fields): `override` throws `invalid-input`.
   */
  readonly transformFields?: TransformFields;
  /**
   * The handles an extension adds to a selected feature, besides the resize and rotate handles
   * the library gives a footprint laid on the map: handles the library draws as resize handles
   * (`kind: 'resize'`), and handles the type draws itself in `drawHandles` (`kind: 'custom'`).
   * Their drags go to `onHandleDrag`. The library asks for them while one feature only is
   * selected, and shows them under the conditions told on {@link Handle}. Place them from the
   * selection box of the context (`ctx.selectionBox`), so that they sit on the box the library
   * draws.
   */
  handles?(feature: Feature, ctx: HandleContext): Handle[];
  /**
   * Draws the custom handles of a selected feature (`kind: 'custom'` of `handles`), with the
   * shared renderers of the frame. The library calls it, after drawing the selection, exactly
   * when it shows the handles of the feature (see {@link Handle}), so a type draws its marks here
   * and tests nothing; it is not called when the feature has no custom handle shown. Draw each
   * mark `sizePx` wide, the size it is hit at.
   *
   * @param handles - The custom handles `handles` gave, in their order
   */
  drawHandles?(feature: Feature, handles: readonly CustomHandle[], ctx: RenderContext): void;
  /**
   * The change a drag of one of its handles makes.
   *
   * @returns The patch to apply to the feature, or `null` for no change
   */
  onHandleDrag?(feature: Feature, handle: Handle, event: DrawPointerEvent): FeaturePatch | null;
  /**
   * A drag of one of its handles is about to start, before the first `onHandleDrag`.
   *
   * @returns False to refuse the drag; no `onHandleDrag` nor `onHandleDragEnd` follows then
   */
  onHandleDragStart?(feature: Feature, handle: Handle, event: DrawPointerEvent): boolean;
  /**
   * A drag of one of its handles ended, after the last `onHandleDrag` and its patch. It is
   * called once for every drag that started, also when the drag is cut short.
   *
   * @param feature - The feature as it is now, or `null` when it is gone
   */
  onHandleDragEnd?(feature: Feature | null, handle: Handle, event: DrawPointerEvent): void;
  /** The snapping candidates a feature of this type offers. */
  snapCandidates?(feature: Feature, ctx: PointContext): SnapCandidate[];
}
