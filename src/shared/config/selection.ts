// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Selection UI configuration
 *
 * Configuration related to rendering the UI of the selected state.
 */

import type { PointStyle, StrokeStyle } from '../types/style.js';

/**
 * How the box around the selection looks (part of {@link SelectionUIConfig})
 */
export interface BoundingBoxStyle {
  /**
   * The line of the box
   *
   * @defaultValue `#FF2D55`, 2 px, solid
   */
  stroke: StrokeStyle;
  /**
   * The gap between the selected features and the box, in CSS pixels
   *
   * @defaultValue `10`
   */
  margin: number;
}

/**
 * How the four corner handles that resize the selection look (part of
 * {@link SelectionUIConfig})
 */
export interface ResizeHandleStyle {
  /**
   * The handle
   *
   * @defaultValue a 10 px `#FF2D55` square without an outline
   */
  point: PointStyle;
}

/**
 * How the handle that rotates the selection looks (part of {@link SelectionUIConfig})
 *
 * The handle sits above the middle of the top edge of the box, joined to it by a line.
 */
export interface RotateHandleStyle {
  /**
   * The handle
   *
   * @defaultValue a 10 px `#FF2D55` circle without an outline
   */
  point: PointStyle;
  /**
   * The distance between the handle and the box, in CSS pixels
   *
   * @defaultValue `10`
   */
  distance: number;
  /**
   * The line that joins the handle to the box
   *
   * @defaultValue `#FF2D55`, 2 px, solid
   */
  connector: StrokeStyle;
}

/**
 * How the vertex handles of the selected line or polygon look (part of
 * {@link SelectionUIConfig})
 */
export interface VertexHandleStyle {
  /**
   * A vertex handle
   *
   * @defaultValue a 12 px white circle with a 2 px `#FF2D55` outline
   */
  point: PointStyle;
  /**
   * A selected vertex
   *
   * @defaultValue a 12 px white circle with a 3 px `#FF2D55` outline
   */
  selected: PointStyle;
  /**
   * A vertex of another feature that follows along while shared vertices move together
   *
   * They are distinguished by inverting the fill while staying in the same color family as the
   * selection (#FF2D55). No other hue is used, so that they are not confused with the snapping
   * indicator (#00C7BE).
   *
   * @defaultValue a 12 px `#FF2D55` circle with a 2 px white outline
   */
  followed: PointStyle;
}

/**
 * How the midpoint handles look: the handles at the middle of each edge, which add a vertex
 * when dragged (part of {@link SelectionUIConfig})
 */
export interface MidpointHandleStyle {
  /**
   * A midpoint handle
   *
   * @defaultValue an 8 px white circle with a 1.5 px `#FF2D55` outline
   */
  point: PointStyle;
}

/**
 * How the handle that changes the radius of a selected Circle looks (part of
 * {@link SelectionUIConfig})
 */
export interface RadiusHandleStyle {
  /**
   * The handle
   *
   * @defaultValue a 10 px white circle with a 1 px `#FF2D55` outline
   */
  point: PointStyle;
}

/**
 * How the marker at the center of a selected Circle looks (part of
 * {@link SelectionUIConfig})
 */
export interface CenterMarkerStyle {
  /**
   * The marker
   *
   * @defaultValue a 6 px white circle with a 1 px `#FF2D55` outline
   */
  point: PointStyle;
}

/**
 * How the line from the center of a selected Circle to its radius handle looks (part of
 * {@link SelectionUIConfig})
 */
export interface RadiusLineStyle {
  /**
   * The line
   *
   * @defaultValue `#FF2D55`, 1 px, dashed with a 3 px dash and a 3 px gap
   */
  stroke: StrokeStyle;
}

/**
 * How the selection UI looks: the box around the selection and its handles
 *
 * Give the parts to change through the `selectionStyle` option of `createMapLibreGLDraw`;
 * the parts left out keep their defaults. Sizes and widths are in CSS pixels and stay the
 * same at every zoom.
 *
 * A single selection shows the box with the resize handles at its corners and the rotate
 * handle above it; a line or a polygon also shows its vertex and midpoint handles, and a Circle
 * its center marker, radius line and radius handle. A multiple selection shows one box around
 * every selected feature, with the resize and rotate handles, and a box without handles around
 * each feature. A locked feature shows the box without handles.
 *
 * @example
 * ```ts
 * const draw = createMapLibreGLDraw(map, {
 *   selectionStyle: {
 *     boundingBox: {
 *       stroke: { width: 1, color: [0, 0.4, 1, 1], opacity: 1, lineStyle: 'solid' },
 *       margin: 6,
 *     },
 *   },
 * });
 * ```
 */
export interface SelectionUIConfig {
  /**
   * The box around the selection
   *
   * @defaultValue `#FF2D55`, 2 px, solid, 10 px from the features
   */
  boundingBox: BoundingBoxStyle;
  /**
   * The resize handles at the four corners of the box
   *
   * @defaultValue 10 px `#FF2D55` squares without an outline
   */
  resizeHandle: ResizeHandleStyle;
  /**
   * The rotate handle above the box
   *
   * @defaultValue a 10 px `#FF2D55` circle, 10 px above the box, joined by a 2 px line
   */
  rotateHandle: RotateHandleStyle;
  /**
   * The vertex handles
   *
   * @defaultValue 12 px white circles with a 2 px `#FF2D55` outline (3 px when selected)
   */
  vertexHandle: VertexHandleStyle;
  /**
   * The midpoint handles
   *
   * @defaultValue 8 px white circles with a 1.5 px `#FF2D55` outline
   */
  midpointHandle: MidpointHandleStyle;
  /**
   * For a Circle: the radius handle
   *
   * @defaultValue a 10 px white circle with a 1 px `#FF2D55` outline
   */
  radiusHandle: RadiusHandleStyle;
  /**
   * For a Circle: the center marker
   *
   * @defaultValue a 6 px white circle with a 1 px `#FF2D55` outline
   */
  centerMarker: CenterMarkerStyle;
  /**
   * For a Circle: the radius line (the dashed line from the center to the radius handle)
   *
   * @defaultValue `#FF2D55`, 1 px, dashed 3 px / 3 px
   */
  radiusLine: RadiusLineStyle;
}

/**
 * Default selection UI configuration
 */
export const DEFAULT_SELECTION_CONFIG: SelectionUIConfig = {
  boundingBox: {
    stroke: {
      // 2px for better visibility (the documented specification is 1px, but that is too thin
      // on high DPI)
      width: 2,
      color: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      opacity: 1.0,
      lineStyle: 'solid',
    },
    margin: 10, // Documented specification: default 10px
  },
  resizeHandle: {
    point: {
      shape: 'square',
      size: 10,
      fillColor: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      fillOpacity: 1.0,
      strokeColor: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      strokeWidth: 0, // Documented specification: no border
      strokeOpacity: 1.0,
    },
  },
  rotateHandle: {
    point: {
      shape: 'circle',
      size: 10,
      fillColor: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      fillOpacity: 1.0,
      strokeColor: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      strokeWidth: 0,
      strokeOpacity: 1.0,
    },
    distance: 10, // Documented specification: default 10px
    connector: {
      width: 2, // Unified with the same width as the bounding box
      color: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      opacity: 1.0,
      lineStyle: 'solid',
    },
  },
  vertexHandle: {
    point: {
      shape: 'circle',
      size: 12, // 12px for better visibility (the documented specification is 10px)
      fillColor: [1.0, 1.0, 1.0, 1.0],
      fillOpacity: 1.0,
      strokeColor: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      strokeWidth: 2, // 2px for better visibility (the documented specification is 1px)
      strokeOpacity: 1.0,
    },
    selected: {
      shape: 'circle',
      size: 12, // The same size as the normal state
      fillColor: [1.0, 1.0, 1.0, 1.0], // white (the same as the normal state)
      fillOpacity: 1.0,
      strokeColor: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      strokeWidth: 3, // A slightly thicker line (normally 2px)
      strokeOpacity: 1.0,
    },
    // Following vertices: the fill is inverted (#FF2D55 fill + white border). They are
    // distinguishable at a glance from selected vertices (white fill + #FF2D55 border), while
    // the color family is kept the same as the selection.
    followed: {
      shape: 'circle',
      size: 12, // The same size as the normal and selected states
      fillColor: [1.0, 0.176, 0.333, 1.0], // #FF2D55 (fill)
      fillOpacity: 1.0,
      strokeColor: [1.0, 1.0, 1.0, 1.0], // white
      strokeWidth: 2,
      strokeOpacity: 1.0,
    },
  },
  midpointHandle: {
    point: {
      shape: 'circle',
      // 8px for better visibility and easier manipulation (the documented specification is 5px)
      size: 8,
      fillColor: [1.0, 1.0, 1.0, 1.0],
      fillOpacity: 1.0,
      strokeColor: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      strokeWidth: 1.5, // 1.5px for better visibility (the documented specification is 1px)
      strokeOpacity: 1.0,
    },
  },
  // For Circle: radius handle
  // Specification: a 10px diameter circle, white fill, pink border (#FF2D55), 1px wide
  radiusHandle: {
    point: {
      shape: 'circle',
      size: 10,
      fillColor: [1.0, 1.0, 1.0, 1.0], // white
      fillOpacity: 1.0,
      strokeColor: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      strokeWidth: 1,
      strokeOpacity: 1.0,
    },
  },
  // For Circle: center marker
  // Specification: a 6px diameter circle, white fill, pink border (#FF2D55), 1px wide
  centerMarker: {
    point: {
      shape: 'circle',
      size: 6,
      fillColor: [1.0, 1.0, 1.0, 1.0], // white
      fillOpacity: 1.0,
      strokeColor: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      strokeWidth: 1,
      strokeOpacity: 1.0,
    },
  },
  // For Circle: radius line
  // Specification: a pink (#FF2D55) dotted line, 1px wide, with a pattern of a 3px dash and a
  // 3px gap
  radiusLine: {
    stroke: {
      width: 1,
      color: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      opacity: 1.0,
      lineStyle: 'dashed',
      dashArray: [3, 3],
    },
  },
};

/**
 * Style changes on hover
 */
export const HOVER_STYLE_MODIFIERS = {
  /** Enlargement factor for the size */
  sizeMultiplier: 1.2,
  /** Increase in opacity */
  opacityIncrease: 0.2,
};

/**
 * Style changes while dragging
 */
export const DRAGGING_STYLE_MODIFIERS = {
  /** Reduction factor for the size */
  sizeMultiplier: 0.9,
  /** Opacity */
  opacity: 0.8,
};

/**
 * Threshold at which handle thinning kicks in
 *
 * Only features whose total number of vertex handles and midpoint handles exceeds this are
 * thinned. Features at or below it do not run the thinning computation at all and show every
 * handle, just as before.
 */
export const HANDLE_THINNING_THRESHOLD = 400;

/**
 * Minimum screen distance from an already adopted handle (pixels)
 *
 * A greedy algorithm adopts only the vertices that are at least this far from "the vertex
 * adopted just before".
 */
export const MIN_HANDLE_SPACING_PX = 14;

/**
 * Minimum screen length of an edge that gets a midpoint handle (pixels)
 *
 * An edge shorter than this cannot be grabbed even if its midpoint is shown, so no midpoint is
 * shown for it while thinning.
 */
export const MIDPOINT_MIN_EDGE_PX = 32;

/**
 * Debounce from the camera coming to rest until the thinning is recomputed (milliseconds)
 *
 * While the camera is moving, the old set is drawn as is; once it has been at rest for this
 * long, the set is rebuilt.
 */
export const THINNING_REFRESH_DEBOUNCE_MS = 150;

/**
 * Margin of the viewport pre-filtering (pixels)
 *
 * Including vertices just outside the screen prevents the handles at the edge from
 * disappearing on a slight pan.
 */
export const THINNING_VIEWPORT_MARGIN_PX = 100;

/**
 * Helper function that merges configurations
 */
export function mergeSelectionUIConfig(
  base: SelectionUIConfig,
  override: Partial<SelectionUIConfig>,
): SelectionUIConfig {
  return {
    boundingBox: {
      ...base.boundingBox,
      ...override.boundingBox,
      stroke: {
        ...base.boundingBox.stroke,
        ...override.boundingBox?.stroke,
      },
    },
    resizeHandle: {
      ...base.resizeHandle,
      ...override.resizeHandle,
      point: {
        ...base.resizeHandle.point,
        ...override.resizeHandle?.point,
      },
    },
    rotateHandle: {
      ...base.rotateHandle,
      ...override.rotateHandle,
      point: {
        ...base.rotateHandle.point,
        ...override.rotateHandle?.point,
      },
      connector: {
        ...base.rotateHandle.connector,
        ...override.rotateHandle?.connector,
      },
    },
    vertexHandle: {
      ...base.vertexHandle,
      ...override.vertexHandle,
      point: {
        ...base.vertexHandle.point,
        ...override.vertexHandle?.point,
      },
      selected: {
        ...base.vertexHandle.selected,
        ...override.vertexHandle?.selected,
      },
      followed: {
        ...base.vertexHandle.followed,
        ...override.vertexHandle?.followed,
      },
    },
    midpointHandle: {
      ...base.midpointHandle,
      ...override.midpointHandle,
      point: {
        ...base.midpointHandle.point,
        ...override.midpointHandle?.point,
      },
    },
    radiusHandle: {
      ...base.radiusHandle,
      ...override.radiusHandle,
      point: {
        ...base.radiusHandle.point,
        ...override.radiusHandle?.point,
      },
    },
    centerMarker: {
      ...base.centerMarker,
      ...override.centerMarker,
      point: {
        ...base.centerMarker.point,
        ...override.centerMarker?.point,
      },
    },
    radiusLine: {
      ...base.radiusLine,
      ...override.radiusLine,
      stroke: {
        ...base.radiusLine.stroke,
        ...override.radiusLine?.stroke,
      },
    },
  };
}
