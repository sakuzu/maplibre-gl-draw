// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugins: what a plugin is (`draw.use`, the `plugins` option) and what it adds through its
 * context
 *
 * A plugin can do what an application can: `ctx.draw` is the same instance and `ctx.map` is the
 * map. Its context adds only what needs the inside of the library: a type of feature, a mode, a
 * companion of every type, an overlay of shapes, the shapes as they are drawn, the conversion
 * between the map and the screen in the frame drawn last, the automatic names, and drawing with
 * WebGL of its own. What it adds goes when it is removed: no part of it has a counterpart that
 * removes it.
 */

import type { Position } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Draw } from '../draw.js';
import type { Observable } from '../events.js';
import type { Webgl } from '../extension/webgl.js';
import type {
  Feature,
  FeatureGeometry,
  FeaturePatch,
  FeatureRow,
  FeatureStyle,
  FeatureStyleResolved,
  LineStyle,
  PointShape,
  Properties,
} from '../model.js';
import type { SelectionStyleOptions } from '../options.js';

/**
 * A plugin, given to `draw.use` or to the `plugins` option of `createDraw`.
 *
 * @typeParam Api - What `setup` returns, which `draw.use` returns as it is
 */
export interface Plugin<Api = void, P extends object = Properties> {
  /**
   * A name no other plugin of the instance has: it is told with the failures of the plugin and
   * holds what it allocates on the GPU
   */
  readonly name: string;
  /**
   * Called once, at once, when the plugin is added; what it returns is what `draw.use` returns.
   * When it throws, what it added is taken back and `draw.use` throws the same failure. The
   * document may not be open yet: do not write in it here.
   */
  setup(context: PluginContext<P>): Api;
}

/**
 * What a plugin adds through. The functions that add (`add...` and `setOverlay`) may be called
 * until the plugin is removed, and fail with `invalidState` after.
 */
export interface PluginContext<P extends object = Properties> {
  /** The same instance as the application has */
  readonly draw: Draw;
  /** The map: read the state of the map from it, but not what is on the screen (`screen`) */
  readonly map: MapLibreMap;
  /**
   * Aborted when the plugin is removed: give it to the listeners the plugin adds itself (to the
   * map, to the page)
   */
  readonly signal: AbortSignal;
  /**
   * Adds a type of feature.
   *
   * @throws `DrawError` with the code `alreadyExists` for the name of a type there is, and
   *   `invalidInput` for a definition that is not one, or a name that starts with
   *   `maplibre-gl-draw:`
   */
  addFeatureType(definition: FeatureTypeDefinition<P>): void;
  /**
   * Adds a mode, which `draw.mode.set` enters by its name.
   *
   * @throws `DrawError` as {@link PluginContext.addFeatureType} does
   */
  addMode(definition: ModeDefinition): void;
  /**
   * Adds what goes with the features of every type that has it: what is drawn just below a
   * feature, hit there, and the handles of the feature.
   *
   * @throws `DrawError` as {@link PluginContext.addFeatureType} does
   */
  addCompanion(source: CompanionSource<P>): void;
  /**
   * Replaces the shapes the plugin shows above the features: lines of a measure, the marks of a
   * candidate. They are not in the document: no undo, nothing saved, nothing in an image of the
   * map. Drawn in the next frame; the last call of a frame is what is drawn. An empty array
   * clears them.
   *
   * @throws `DrawError` with the code `tooLarge` for more than 1,000 shapes or 10,000 positions
   *   in all, and `invalidInput` for a shape that is not one
   */
  setOverlay(shapes: readonly OverlayShape[]): void;
  /**
   * The features as they are drawn, the sketches and the features being moved together applied:
   * `draw.features` reads the values of the document
   */
  readonly rendered: Rendered<P>;
  /**
   * The conversion between the map and the screen, in the frame drawn last: on the terrain where
   * it is on
   */
  readonly screen: ScreenProjection;
  /** The automatic names, by the rules of the built-in modes */
  readonly names: NameGenerator;
  /**
   * Measures again and draws again what changed for a reason outside the document (a font that
   * arrived), the features of one type or all of them.
   */
  invalidate(filter?: { readonly featureType?: string }): void;
  /** Drawing with WebGL of its own: what follows is the contract of `/webgl` */
  readonly webgl: Webgl;
}

/**
 * The handles of a selected feature, which a type and a companion give the same way. For a
 * companion, a handle of no feature (`globalHandles`) is given `null`.
 */
export interface HandleSource<
  P extends object = Properties,
  F extends Feature<P> | null = Feature<P>,
> {
  /**
   * The handles of a feature selected alone. Placed from `selectionBox`, they sit on the box
   * drawn.
   */
  handles?(feature: Feature<P>, context: HandleContext): readonly Handle[];
  /** Draws the marks of the `custom` handles, and what is shown only with the handles */
  drawHandles?(feature: F, handles: readonly CustomHandle[], context: RenderContext): void;
  /** False refuses the drag: nothing more is called for it */
  onHandleDragStart?(feature: F, handle: Handle, input: PointerInput): boolean;
  /**
   * Called at every move and when the pointer is let go. The change of a move is shown by a
   * sketch, and the change of the end is written. `null` is no change.
   */
  onHandleDrag?(feature: F, handle: Handle, input: PointerInput): FeaturePatch<P> | null;
  /**
   * Called once for each drag that started, also one cut short. The feature is `null` once it
   * is gone.
   */
  onHandleDragEnd?(feature: Feature<P> | null, handle: Handle, input: PointerInput): void;
}

/** What the handles of a feature are placed with */
export interface HandleContext {
  readonly screen: ScreenProjection;
  /**
   * The box drawn around the feature, its margin added. `null` for a handle of no feature
   */
  readonly selectionBox: Footprint | null;
  /** The look of the selection: the box, and the size and look of each kind of handle */
  readonly selectionStyle: Required<SelectionStyleOptions>;
}

/**
 * A type of feature. Its features are features of the document with a geometry and keys of
 * their own; what they cover on the map (`footprint`) is measured, not kept.
 */
export interface FeatureTypeDefinition<P extends object = Properties> extends HandleSource<P> {
  /**
   * The name kept in the `maplibre-gl-draw:featureType` of its features. `acme:range` is the
   * form suggested for a plugin of another party.
   */
  readonly name: string;
  /**
   * What a feature covers. A geometry gives its extent to the library; `null` is nothing to
   * draw. It reads the feature and the measures of the plugin only, and keeps nothing of its
   * argument.
   */
  footprint(feature: Feature<P>): Footprint | FeatureGeometry | null;
  /**
   * Draws a feature at its place in the order with the shared renderers. Without it, and
   * without a renderer of its own (`ctx.webgl.addFeatureRenderer`), the footprint is drawn.
   */
  render?(feature: Feature<P>, context: RenderContext): void;
  /**
   * The distance of a point to a feature, in pixels, or `null` when it misses. Without it, the
   * footprint is hit.
   */
  hitTest?(feature: Feature<P>, pointer: ScreenPointContext): number | null;
  /** The candidates a feature offers to snap to. Without them, those of its footprint */
  snapCandidates?(feature: Feature<P>, pointer: ScreenPointContext): readonly SnapCandidate[];
  /**
   * The keys a rotation and a resize change with the geometry. Without them, the geometry
   * alone changes.
   */
  readonly transformFields?: TransformFields;
  /** The look of a key the style of a feature and the rule of its layer leave out */
  readonly defaultStyle?: FeatureStyle;
  /**
   * The key of the look the color of a layer rule goes to. Without it, the geometry of the
   * feature in the document decides.
   */
  readonly styleRuleChannel?: 'fill' | 'stroke' | 'point';
}

/** The keys a rotation and a resize change with the geometry */
export interface TransformFields {
  /** The key of the angle, in degrees */
  readonly angleDegreesKey?: string;
  /** The key of the size, multiplied by the scale of a resize */
  readonly scaleKey?: string;
  /** Whether a resize scales the position by the same ratio too, so the shape stays the same */
  readonly uniformScale?: boolean;
}

/** A position to snap to */
export interface SnapCandidate {
  readonly position: Position;
  readonly kind: 'vertex' | 'edge' | 'intersection' | 'guide' | (string & {});
  /** Among candidates as near, the one of the higher priority wins */
  readonly priority?: number;
}

/** Four corners on the map, or a box of a fixed size on the screen */
export type Footprint = GroundFootprint | ScreenFootprint;

/**
 * Four corners on the map, in the order top left, top right, bottom right, bottom left of the
 * shape unturned. A type that gives them has the resize and rotate handles.
 */
export interface GroundFootprint {
  readonly kind: 'ground';
  readonly corners: {
    readonly topLeft: Position;
    readonly topRight: Position;
    readonly bottomRight: Position;
    readonly bottomLeft: Position;
  };
  /**
   * The candidates to snap to: the center, the corners and the edges (`box`, when it is left
   * out), or the center alone (`center`)
   */
  readonly snap?: 'box' | 'center';
}

/** A box of a fixed size on the screen around a position */
export interface ScreenFootprint {
  readonly kind: 'screen';
  readonly position: Position;
  readonly halfWidthPixels: number;
  readonly halfHeightPixels: number;
}

/** A point on the screen being tested */
export interface ScreenPointContext {
  readonly screenPoint: readonly [number, number];
  /** The position on the map at the point */
  readonly position: Position;
  readonly tolerancePixels: number;
}

/** A handle drawn and hit as the built-in resize handles are */
export interface ResizeHandle {
  readonly kind: 'resize';
  /** Unique within the feature */
  readonly id: string;
  readonly position: Position;
  readonly cursor?: string;
}

/** A handle the plugin draws (`drawHandles`), hit within a square of `sizePixels` */
export interface CustomHandle {
  readonly kind: 'custom';
  readonly id: string;
  readonly position: Position;
  readonly sizePixels: number;
  readonly cursor?: string;
}

export type Handle = ResizeHandle | CustomHandle;

/** What goes with the features of every type that has it: a drawing, a hit, handles */
export interface CompanionSource<P extends object = Properties>
  extends HandleSource<P, Feature<P> | null> {
  readonly name: string;
  /** Answers at once, from the row alone: it makes no feature */
  has(row: FeatureRow<P>): boolean;
  /** The keys `has` reads: a write of another key does not ask again */
  readonly dependsOnProperties?: readonly string[];
  /** Draws just below the feature */
  render?(feature: Feature<P>, context: RenderContext): void;
  /** Asked, just below the feature, when the feature itself misses */
  hitTest?(
    feature: Feature<P>,
    pointer: ScreenPointContext,
  ): { readonly id: string; readonly distancePixels: number } | null;
  /** True takes the click: the selection does not change */
  onClick?(feature: Feature<P>, id: string, input: PointerInput): boolean;
  /** Handles of no feature: their drags are given `null` */
  globalHandles?(context: HandleContext): readonly Handle[];
}

/** What a type and a companion draw with. It holds no WebGL */
export interface RenderContext {
  readonly screen: ScreenProjection;
  readonly terrain: TerrainSurface;
  /** The opacity of the layer drawn */
  readonly opacity: number;
  readonly line: LineRenderer;
  readonly fill: FillRenderer;
  readonly point: PointRenderer;
  /** The look the feature is drawn with: the default of its type, the rule, its style */
  appliedStyle(feature: Feature): FeatureStyleResolved;
}

/** In the frame drawn last; while a frame is drawn, in that frame */
export interface ScreenProjection {
  project(at: Position): readonly [number, number];
  unproject(screenPoint: readonly [number, number]): Position;
  /** The meters a CSS pixel spans at a position */
  metersPerPixel(at: Position): number;
  readonly zoom: number;
  /** The ratio drawn with: that of an image of the map while it is made */
  readonly pixelRatio: number;
}

/** The heights of the terrain, and where it hides a position */
export interface TerrainSurface {
  /** In meters; 0 without terrain */
  elevation(at: Position): number;
  /** From 0 to 1: lower where a slope hides the position from the camera */
  occlusionOpacity(at: Position): number;
  /** A number that changes when the heights may have */
  elevationVersion(): number;
}

/** The shared renderer of lines */
export interface LineRenderer {
  draw(
    coordinates: readonly Position[],
    style: {
      readonly width: number;
      readonly color: string;
      readonly opacity: number;
      readonly lineStyle: LineStyle;
    },
    options?: {
      readonly closed?: boolean;
      readonly widthUnit?: 'pixels' | 'meters';
      readonly referenceZoom?: number;
    },
  ): void;
}

/** The shared renderer of areas: the outer ring first, then the holes */
export interface FillRenderer {
  draw(
    rings: readonly (readonly Position[])[],
    style: { readonly color: string; readonly opacity: number },
  ): void;
}

/** The shared renderer of point marks */
export interface PointRenderer {
  draw(
    at: Position,
    style: {
      readonly shape: PointShape;
      /** The diameter of the mark */
      readonly sizePixels: number;
      readonly fillColor: string;
      readonly fillOpacity: number;
      readonly strokeColor: string;
      readonly strokeWidth: number;
      readonly strokeOpacity: number;
    },
    options?: { readonly referenceZoom?: number },
  ): void;
}

/** The features as they were drawn in the last frame */
export interface Rendered<P extends object = Properties> {
  /** With the sketches and the features being moved together applied */
  get(id: string): Feature<P> | undefined;
  getMany(ids: readonly string[]): readonly (Feature<P> | undefined)[];
  getFootprint(id: string): Footprint | null;
  /** The footprint with the margin of the selection box added: the box drawn */
  getSelectionBox(id: string): Footprint | null;
  /**
   * Once a frame is drawn, the features whose shape changed in it. `value` is the last told,
   * empty at first.
   */
  readonly changed: Observable<readonly string[]>;
}

/** The automatic names */
export interface NameGenerator {
  /** `undefined` when automatic names are off */
  next(featureType: string): string | undefined;
}

/** A mode */
export interface ModeDefinition {
  /**
   * The name `draw.mode.set` takes. `acme:distance` is the form suggested for a plugin of
   * another party.
   */
  readonly name: string;
  readonly cursor?: string;
  enter?(options: { readonly repeat: boolean }): void;
  exit?(): void;
  /**
   * True takes the input: the map and the library do nothing with it. A promise counts as true,
   * and its failure is told in `status.problems`.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: a receiver that returns nothing takes nothing
  input(input: ModeInput): boolean | void | Promise<unknown>;
}

/** An open union: a reader has a default */
export type ModeInput = PointerInput | KeyInput;

/** An input of the pointer */
export interface PointerInput {
  readonly type: 'pointerdown' | 'pointermove' | 'pointerup' | 'click' | 'dblclick';
  /** Before snapping */
  readonly position: Position;
  /** After snapping: `position` when nothing is snapped to */
  readonly snapped: Position;
  readonly screenPoint: readonly [number, number];
  readonly original: MouseEvent | TouchEvent;
}

/** A key pressed */
export interface KeyInput {
  readonly type: 'keydown';
  readonly key: string;
  readonly original: KeyboardEvent;
}

/** A shape of an overlay */
export interface OverlayShape {
  readonly geometry: FeatureGeometry;
  readonly style?: FeatureStyle;
}
