// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The options: `DrawOptions` when the instance is created, and the part of them that
 * `draw.options` changes while it runs
 */

import type { Messages } from '../messages.js';
import type { Store } from './extension/store.js';
import type { FeatureStyle, FeatureType, LineStyle } from './model.js';
import type { Mode } from './state.js';

/** The options of snapping to vertices, edges, intersections and guides. */
export interface SnappingOptions {
  /** Whether snapping is on; true when it is left out */
  enabled?: boolean;
  /** How close the pointer must come to a candidate, in screen pixels; 10 when it is left out */
  tolerancePx?: number;
  /** The key that turns snapping off while it is held; `alt` when it is left out */
  disableKey?: 'alt' | 'shift' | 'ctrl' | 'meta' | 'none';
  /** Whether each kind of candidate is on; a kind left out is on */
  kinds?: Partial<Record<'vertex' | 'edge' | 'intersection' | 'guide', boolean>>;
  /** Whether the rows of datasets are candidates; true when it is left out */
  datasets?: boolean;
  /** The angle between the guides from north, in degrees; 45 when it is left out */
  guideStepDegrees?: number;
  /**
   * The mark drawn at the snapped point, per kind of target; the keys given replace those of
   * the default. By default every mark is `#00C7BE`: `vertex` an outlined circle of 14 px,
   * `edge` an outlined square of 12 px, `intersection` a filled circle of 8 px and `guide` an
   * outlined circle of 10 px. A kind of a snap provider's own takes the mark of `vertex`
   */
  indicator?: {
    /** The mark of a vertex */
    vertex?: {
      /** The shape */
      shape?: 'circle' | 'square' | 'triangle' | 'star';
      /** The size in CSS pixels */
      size?: number;
      /** The fill color (a CSS color) */
      fillColor?: string;
      /** The opacity of the fill, from 0 to 1 */
      fillOpacity?: number;
      /** The color of the outline (a CSS color) */
      strokeColor?: string;
      /** The width of the outline in CSS pixels (0 for none) */
      strokeWidth?: number;
      /** The opacity of the outline, from 0 to 1 */
      strokeOpacity?: number;
    };
    /** The mark of a point on an edge */
    edge?: {
      /** The shape */
      shape?: 'circle' | 'square' | 'triangle' | 'star';
      /** The size in CSS pixels */
      size?: number;
      /** The fill color (a CSS color) */
      fillColor?: string;
      /** The opacity of the fill, from 0 to 1 */
      fillOpacity?: number;
      /** The color of the outline (a CSS color) */
      strokeColor?: string;
      /** The width of the outline in CSS pixels (0 for none) */
      strokeWidth?: number;
      /** The opacity of the outline, from 0 to 1 */
      strokeOpacity?: number;
    };
    /** The mark of an intersection of edges */
    intersection?: {
      /** The shape */
      shape?: 'circle' | 'square' | 'triangle' | 'star';
      /** The size in CSS pixels */
      size?: number;
      /** The fill color (a CSS color) */
      fillColor?: string;
      /** The opacity of the fill, from 0 to 1 */
      fillOpacity?: number;
      /** The color of the outline (a CSS color) */
      strokeColor?: string;
      /** The width of the outline in CSS pixels (0 for none) */
      strokeWidth?: number;
      /** The opacity of the outline, from 0 to 1 */
      strokeOpacity?: number;
    };
    /** The mark of a point on a guide */
    guide?: {
      /** The shape */
      shape?: 'circle' | 'square' | 'triangle' | 'star';
      /** The size in CSS pixels */
      size?: number;
      /** The fill color (a CSS color) */
      fillColor?: string;
      /** The opacity of the fill, from 0 to 1 */
      fillOpacity?: number;
      /** The color of the outline (a CSS color) */
      strokeColor?: string;
      /** The width of the outline in CSS pixels (0 for none) */
      strokeWidth?: number;
      /** The opacity of the outline, from 0 to 1 */
      strokeOpacity?: number;
    };
  };
  /**
   * The line drawn along a guide while the pointer snaps to it; the keys given replace those
   * of the default, a 1 px `#00C7BE` line dashed `[4, 4]`
   */
  guideLine?: {
    /** The width in CSS pixels */
    width?: number;
    /** The color (a CSS color) */
    color?: string;
    /** The opacity, from 0 to 1 */
    opacity?: number;
    /** The dash pattern */
    lineStyle?: LineStyle;
    /** A dash pattern in CSS pixels, `[dash, gap]`, instead of that of `lineStyle` */
    dashArray?: number[];
  };
}

/** The options of tracing the boundary of an existing feature while drawing. */
export interface TracingOptions {
  /** Whether tracing is on; true when it is left out */
  enabled?: boolean;
}

/** The options of moving the vertices that features share. */
export interface TopologyOptions {
  /** Whether dragging a vertex also moves the vertices of other features at the same position */
  sharedVertexDrag?: boolean;
}

/** The switches of the drawing. */
export interface RenderingOptions {
  /**
   * The factor for the sizes this library draws in screen pixels (line widths, point sizes);
   * 0.5 while the map is shown at half size. 1 when it is left out
   */
  renderScale?: number;
  /** The pixel ratio to draw with; that of the map when it is left out */
  pixelRatio?: number;
  /**
   * Whether the geometry of the features that do not change is kept between drawings; true
   * when it is left out
   */
  cacheGeometry?: boolean;
  /** Whether work that does not fit in one drawing is spread over the next ones; true when it is left out */
  timeSlicing?: boolean;
}

/**
 * The look of the box around the selected features and of their handles. Each part given
 * replaces the default of that part. Colors are CSS colors, and sizes and widths are in CSS
 * pixels.
 */
export interface SelectionStyleOptions {
  /** The box around the selection */
  boundingBox?: {
    /** The line of the box */
    stroke: {
      /** The width in CSS pixels */
      width: number;
      /** The color (a CSS color) */
      color: string;
      /** The opacity, from 0 to 1 */
      opacity: number;
      /** The dash pattern */
      lineStyle: LineStyle;
      /** A dash pattern in CSS pixels, `[dash, gap]`, instead of that of `lineStyle` */
      dashArray?: number[];
    };
    /** The gap between the features and the box, in CSS pixels */
    margin: number;
  };
  /** The resize handles at the corners of the box */
  resizeHandle?: {
    /** The handle */
    point: {
      /** The shape */
      shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
      /** The size in CSS pixels */
      size: number;
      /** The fill color (a CSS color) */
      fillColor: string;
      /** The opacity of the fill, from 0 to 1 */
      fillOpacity: number;
      /** The color of the outline (a CSS color) */
      strokeColor: string;
      /** The width of the outline in CSS pixels (0 for none) */
      strokeWidth: number;
      /** The opacity of the outline, from 0 to 1 */
      strokeOpacity: number;
      /** The icon, for the `icon` shape */
      iconId?: string;
    };
  };
  /** The rotate handle above the box */
  rotateHandle?: {
    /** The handle */
    point: {
      /** The shape */
      shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
      /** The size in CSS pixels */
      size: number;
      /** The fill color (a CSS color) */
      fillColor: string;
      /** The opacity of the fill, from 0 to 1 */
      fillOpacity: number;
      /** The color of the outline (a CSS color) */
      strokeColor: string;
      /** The width of the outline in CSS pixels (0 for none) */
      strokeWidth: number;
      /** The opacity of the outline, from 0 to 1 */
      strokeOpacity: number;
      /** The icon, for the `icon` shape */
      iconId?: string;
    };
    /** The distance between the handle and the box, in CSS pixels */
    distance: number;
    /** The line that joins the handle to the box */
    connector: {
      /** The width in CSS pixels */
      width: number;
      /** The color (a CSS color) */
      color: string;
      /** The opacity, from 0 to 1 */
      opacity: number;
      /** The dash pattern */
      lineStyle: LineStyle;
      /** A dash pattern in CSS pixels, `[dash, gap]`, instead of that of `lineStyle` */
      dashArray?: number[];
    };
  };
  /** The vertex handles */
  vertexHandle?: {
    /** A vertex handle */
    point: {
      /** The shape */
      shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
      /** The size in CSS pixels */
      size: number;
      /** The fill color (a CSS color) */
      fillColor: string;
      /** The opacity of the fill, from 0 to 1 */
      fillOpacity: number;
      /** The color of the outline (a CSS color) */
      strokeColor: string;
      /** The width of the outline in CSS pixels (0 for none) */
      strokeWidth: number;
      /** The opacity of the outline, from 0 to 1 */
      strokeOpacity: number;
      /** The icon, for the `icon` shape */
      iconId?: string;
    };
    /** A selected vertex */
    selected: {
      /** The shape */
      shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
      /** The size in CSS pixels */
      size: number;
      /** The fill color (a CSS color) */
      fillColor: string;
      /** The opacity of the fill, from 0 to 1 */
      fillOpacity: number;
      /** The color of the outline (a CSS color) */
      strokeColor: string;
      /** The width of the outline in CSS pixels (0 for none) */
      strokeWidth: number;
      /** The opacity of the outline, from 0 to 1 */
      strokeOpacity: number;
      /** The icon, for the `icon` shape */
      iconId?: string;
    };
    /** A vertex of another feature that moves along with a shared vertex */
    followed: {
      /** The shape */
      shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
      /** The size in CSS pixels */
      size: number;
      /** The fill color (a CSS color) */
      fillColor: string;
      /** The opacity of the fill, from 0 to 1 */
      fillOpacity: number;
      /** The color of the outline (a CSS color) */
      strokeColor: string;
      /** The width of the outline in CSS pixels (0 for none) */
      strokeWidth: number;
      /** The opacity of the outline, from 0 to 1 */
      strokeOpacity: number;
      /** The icon, for the `icon` shape */
      iconId?: string;
    };
  };
  /** The midpoint handles, which add a vertex when dragged */
  midpointHandle?: {
    /** The handle */
    point: {
      /** The shape */
      shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
      /** The size in CSS pixels */
      size: number;
      /** The fill color (a CSS color) */
      fillColor: string;
      /** The opacity of the fill, from 0 to 1 */
      fillOpacity: number;
      /** The color of the outline (a CSS color) */
      strokeColor: string;
      /** The width of the outline in CSS pixels (0 for none) */
      strokeWidth: number;
      /** The opacity of the outline, from 0 to 1 */
      strokeOpacity: number;
      /** The icon, for the `icon` shape */
      iconId?: string;
    };
  };
  /** The radius handle of a circle */
  radiusHandle?: {
    /** The handle */
    point: {
      /** The shape */
      shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
      /** The size in CSS pixels */
      size: number;
      /** The fill color (a CSS color) */
      fillColor: string;
      /** The opacity of the fill, from 0 to 1 */
      fillOpacity: number;
      /** The color of the outline (a CSS color) */
      strokeColor: string;
      /** The width of the outline in CSS pixels (0 for none) */
      strokeWidth: number;
      /** The opacity of the outline, from 0 to 1 */
      strokeOpacity: number;
      /** The icon, for the `icon` shape */
      iconId?: string;
    };
  };
  /** The center marker of a circle */
  centerMarker?: {
    /** The marker */
    point: {
      /** The shape */
      shape: 'circle' | 'square' | 'triangle' | 'star' | 'icon';
      /** The size in CSS pixels */
      size: number;
      /** The fill color (a CSS color) */
      fillColor: string;
      /** The opacity of the fill, from 0 to 1 */
      fillOpacity: number;
      /** The color of the outline (a CSS color) */
      strokeColor: string;
      /** The width of the outline in CSS pixels (0 for none) */
      strokeWidth: number;
      /** The opacity of the outline, from 0 to 1 */
      strokeOpacity: number;
      /** The icon, for the `icon` shape */
      iconId?: string;
    };
  };
  /** The rectangle of a box selection (Shift and a drag) */
  boxSelection?: {
    /** The fill color (a CSS color) */
    fillColor: string;
    /** The opacity of the fill, from 0 to 1 */
    fillOpacity: number;
    /** The color of the outline (a CSS color) */
    strokeColor: string;
    /** The width of the outline in CSS pixels */
    strokeWidth: number;
  };
  /** The line from the center of a circle to its radius handle */
  radiusLine?: {
    /** The line */
    stroke: {
      /** The width in CSS pixels */
      width: number;
      /** The color (a CSS color) */
      color: string;
      /** The opacity, from 0 to 1 */
      opacity: number;
      /** The dash pattern */
      lineStyle: LineStyle;
      /** A dash pattern in CSS pixels, `[dash, gap]`, instead of that of `lineStyle` */
      dashArray?: number[];
    };
  };
}

/** How new features, layers and groups are named ("Point 1", "Layer 2"). */
export interface AutoNameOptions {
  /** The word used for each type in the name */
  typeNames?: Partial<Record<FeatureType | 'Layer' | 'Group', string>>;
  /** Builds the name from the word of the type and the number */
  formatter?: (typeName: string, number: number) => string;
}

/**
 * The options that can change while the instance runs, with `draw.options.update`: every
 * option but `defaultMode`, `store` and `initDefaultLayer`.
 */
export interface RuntimeOptions {
  /** Replaces the words the library shows */
  messages?: Partial<Messages>;
  /** The names of new features; `false` turns them off */
  autoName?: AutoNameOptions | false;
  /**
   * The default look of each type, with the same keys and CSS colors as the style of a
   * feature
   */
  style?: {
    point?: FeatureStyle;
    line?: FeatureStyle;
    polygon?: FeatureStyle;
    circle?: FeatureStyle;
    image?: FeatureStyle;
  };
  /**
   * The look of the geometry being drawn, with the keys of the style of a feature: the stroke
   * keys give its lines and the outlines of its vertices, the point keys its vertices
   */
  previewStyle?: Partial<FeatureStyle>;
  /** The look of the box and the handles of the selection */
  selectionStyle?: SelectionStyleOptions;
  /**
   * Whether a feature grows and shrinks with the zoom from its look at its reference zoom;
   * true when it is left out
   */
  scaleWithZoom?: boolean;
  /** Snapping */
  snapping?: SnappingOptions;
  /** Tracing of boundaries */
  tracing?: TracingOptions;
  /** Moving shared vertices together */
  topology?: TopologyOptions;
  /** How far the pointer may move and still click, in pixels */
  clickTolerance?: number;
  /** How far the pointer must move to start a drag, in pixels */
  dragThreshold?: number;
  /** The switches of the drawing */
  rendering?: RenderingOptions;
  /**
   * Whether an entry of the stacking order comes from outside the document, such as a layer
   * of the base map; the stacking order is divided at those entries
   */
  isExternalEntry?: (id: string) => boolean;
}

/**
 * The options given when the instance is created.
 */
export interface DrawOptions extends RuntimeOptions {
  /** The mode to start in */
  defaultMode?: Mode;
  /** The Store that keeps the document, instead of the built-in one; only at creation */
  store?: Store;
  /** Whether a layer is created when there is none; only at creation */
  initDefaultLayer?: boolean;
}

/**
 * The options that can change while the instance runs.
 */
export interface OptionsResource {
  /** The current values. */
  get(): Readonly<RuntimeOptions>;
  /**
   * Changes the options given: snapping, tracing, shared vertices, the scale of the drawing
   * and the rest of {@link RuntimeOptions}.
   *
   * @throws `DrawError` with the code `invalid-input` when a value has the wrong type
   */
  update(patch: Partial<RuntimeOptions>): void;
}
