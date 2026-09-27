// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The options: `DrawOptions` when the instance is created, and the part of them that
 * `draw.options` changes while it runs
 */

import type { Messages } from '../../messages.js';
import type { Store } from './extension-placeholders.js';
import type { FeatureStyle, FeatureType } from './model.js';
import type { Mode } from './state.js';

/** The options of snapping to vertices, edges, intersections and guides. */
// TODO(api-2): confirm the fields (carried over)
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
}

/** The options of tracing the boundary of an existing feature while drawing. */
// TODO(api-2): confirm the fields (carried over)
export interface TracingOptions {
  /** Whether tracing is on; true when it is left out */
  enabled?: boolean;
}

/** The options of moving the vertices that features share. */
// TODO(api-2): confirm the fields (carried over)
export interface TopologyOptions {
  /** Whether dragging a vertex also moves the vertices of other features at the same position */
  sharedVertexDrag?: boolean;
}

/** The switches of the drawing. */
export interface RenderingOptions {
  /** The factor the drawing is scaled by */
  // TODO(api-2): confirm the type and the meaning of renderScale
  renderScale?: number;
  /** The device pixel ratio to draw with, or a function that returns it */
  // TODO(api-2): confirm the type (the previous type also took a provider object)
  pixelRatio?: number | (() => number);
  /** Whether the features that do not change are kept between drawings; true when it is left out */
  storeRetained?: boolean;
  /** Whether work that does not fit in one drawing is spread over the next ones; true when it is left out */
  timeSlicing?: boolean;
}

/**
 * The look of the box around the selected features and of their handles. Colors are CSS
 * colors, as in the style of a feature.
 */
// TODO(api-2): confirm the parts and their fields (the previous handle style types are not symbols of the entry)
export interface SelectionStyleOptions {
  /** The box around the selection */
  boundingBox?: FeatureStyle;
  /** The resize handles at the corners of the box */
  resizeHandle?: FeatureStyle;
  /** The rotate handle above the box */
  rotateHandle?: FeatureStyle;
  /** The vertex handles */
  vertexHandle?: FeatureStyle;
  /** The midpoint handles */
  midpointHandle?: FeatureStyle;
  /** The radius handle of a circle */
  radiusHandle?: FeatureStyle;
  /** The center marker of a circle */
  centerMarker?: FeatureStyle;
  /** The line from the center of a circle to its radius handle */
  radiusLine?: FeatureStyle;
}

/** How new features, layers and groups are named ("Point 1", "Layer 2"). */
// TODO(api-2): confirm the fields (carried over; enabled may be redundant beside `autoName: false`)
export interface AutoNameOptions {
  /** Whether names are generated; true when it is left out */
  enabled?: boolean;
  /** The word used for each type in the name */
  typeNames?: Partial<Record<FeatureType | 'Layer' | 'Group', string>>;
  /** Builds the name from the word of the type and the number */
  formatter?: (typeName: string, number: number) => string;
}

/**
 * The options that can change while the instance runs, with `draw.options.update`.
 */
// TODO(api-2): confirm which options can change at runtime (here every option but defaultMode, store and initDefaultLayer)
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
  /** Whether an entry of the layer order comes from outside the document and is not edited */
  // TODO(api-2): confirm whether the ID is an entry of the layer order or a feature
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
