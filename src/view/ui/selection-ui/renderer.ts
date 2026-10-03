// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SelectionUIRenderer
 *
 * Draws the visual feedback of the selection state (the BoundingBox + the OBB while rotating).
 * The BoundingBox computation logic itself is separated into ./bounding-box.ts, and this
 * file concentrates on orchestrating the rendering and the application of the margin.
 */

import type { ProjectionData } from 'maplibre-gl';
import type { SelectionUIConfig } from '../../../shared/config/selection.js';
import { isOnVisibleSideOfGlobe } from '../../../shared/math/globe-visibility.js';
import {
  applyMarginToBoundingBox,
  type CoordinateTransform,
  type ScreenPoint,
} from '../../../shared/math/index.js';
import type { Coordinate, DragState, Feature } from '../../../store/types.js';
import type { AnchoredOutlineRenderer, OutlineOffset } from '../../renderers/anchored-outline.js';
import type { StrokeRenderer } from '../../renderers/stroke.js';
import { anchorElevationMeters, isAnchorActive, projectAnchorAt } from '../../terrain/anchor.js';
import { TerrainContext } from '../../terrain/context.js';
import { anchorGhostOpacity } from '../../terrain/occlusion.js';
import {
  computeBoundingBox,
  computeCombinedBoundingBox,
  hasZeroArea,
  rotateBoundingBox,
} from './bounding-box.js';
import type { SelectionExtensionRegistry } from './extension-registry.js';
import type { BoundingBoxCoords, FramePoint } from './types.js';

/**
 * A position the frame is laid around on the screen: the anchor of an outline of
 * AnchoredOutlineRenderer, and where the CPU projects it
 */
interface FrameAnchor {
  /** The position, `[lng, lat]` */
  anchor: Coordinate;
  /** Its height, in meters (0 without terrain) */
  elevationMeters: number;
  /** Its point on the screen, in CSS px */
  center: ScreenPoint;
}

/** The frame of a single-coordinate feature: the corners on the screen around its anchor */
interface PointFrame extends FrameAnchor {
  /** The corners of the frame on the screen, in CSS px (not closed) */
  corners: FramePoint[];
}

export class SelectionUIRenderer {
  readonly #strokeRenderer: StrokeRenderer;
  /** Draws the frames that are figures of the screen (a point's, and the combined one) */
  readonly #outlineRenderer: AnchoredOutlineRenderer;
  /** The Selection UI extension points of the draw instance this renderer belongs to */
  readonly #extensions: SelectionExtensionRegistry;
  /** The terrain state of the draw instance (an inactive one projects with the map) */
  readonly #terrain: TerrainContext;
  #config: SelectionUIConfig;
  #transform: CoordinateTransform | null = null;
  #projectionData: ProjectionData | null = null;

  constructor(
    strokeRenderer: StrokeRenderer,
    outlineRenderer: AnchoredOutlineRenderer,
    config: SelectionUIConfig,
    extensions: SelectionExtensionRegistry,
    terrain: TerrainContext = new TerrainContext(),
  ) {
    this.#strokeRenderer = strokeRenderer;
    this.#outlineRenderer = outlineRenderer;
    this.#config = config;
    this.#extensions = extensions;
    this.#terrain = terrain;
  }

  /** Compute the BoundingBox of a feature (also usable from outside) */
  computeFeatureBoundingBox(feature: Feature): BoundingBoxCoords | null {
    return computeBoundingBox(feature, this.#extensions);
  }

  /** Compute the combined BoundingBox of several features (also usable from outside) */
  computeCombinedFeatureBoundingBox(features: Feature[]): BoundingBoxCoords | null {
    return computeCombinedBoundingBox(features, this.#extensions);
  }

  setTransform(transform: CoordinateTransform): void {
    this.#transform = transform;
  }

  setProjectionData(projectionData: ProjectionData): void {
    this.#projectionData = projectionData;
  }

  updateConfig(config: SelectionUIConfig): void {
    this.#config = config;
  }

  /**
   * Draw the UI of the selected features
   */
  draw(features: Feature[], zoom: number, dragState?: DragState | null): void {
    if (features.length === 0) return;

    // While rotating, the rotated BoundingBox is drawn
    if (dragState?.operation === 'rotate' && dragState.rotateInfo) {
      this.#drawRotatingBoundingBox(features, zoom, dragState);
      return;
    }

    // A single selection
    if (features.length === 1) {
      const feature = features[0];
      const bbox = computeBoundingBox(feature, this.#extensions);
      if (bbox && hasZeroArea(bbox)) {
        this.#drawPointBoundingBox(feature, bbox.center, zoom);
      } else {
        this.#drawBoundingBoxWithMargin([feature], zoom);
      }
      return;
    }

    // A multi-selection: the individual bboxes + the combined bbox
    for (const feature of features) {
      const bbox = computeBoundingBox(feature, this.#extensions);
      if (bbox && hasZeroArea(bbox)) {
        this.#drawPointBoundingBox(feature, bbox.center, zoom);
      } else {
        this.#drawIndividualBoundingBox(feature, zoom);
      }
    }
    this.#drawCombinedBoundingBox(features, zoom);
  }

  /**
   * Draw the BoundingBox while rotating
   *
   * Rotates the AABB from when the rotation started by the current rotation angle and draws it.
   * In a multi-selection the individual feature bboxes are also rotated about the center
   * of the combined bbox.
   */
  #drawRotatingBoundingBox(features: Feature[], zoom: number, dragState: DragState): void {
    // When dragState.operation === 'rotate', rotateInfo always exists
    const rotateInfo = dragState.rotateInfo;
    if (!rotateInfo) return;
    const { initialBbox, initialFeatureBboxes, currentAngle } = rotateInfo;
    const rotationCenter = initialBbox.center;

    if (features.length > 1 && initialFeatureBboxes) {
      for (const feature of features) {
        const featureInitialBbox = initialFeatureBboxes.get(feature.id);
        if (!featureInitialBbox) continue;
        const rotatedFeatureBbox = rotateBoundingBox(
          featureInitialBbox,
          currentAngle,
          rotationCenter,
        );
        const marginedBbox = this.#applyMargin(rotatedFeatureBbox, zoom);
        this.#strokeBoundingBox(marginedBbox, zoom);
      }
    }

    const rotatedBbox = rotateBoundingBox(initialBbox, currentAngle);
    const marginedBbox = this.#applyMargin(rotatedBbox, zoom);
    this.#strokeBoundingBox(marginedBbox, zoom);
  }

  /**
   * Draw the BoundingBox of an individual feature (for a multi-selection)
   */
  #drawIndividualBoundingBox(feature: Feature, zoom: number): void {
    const bbox = computeBoundingBox(feature, this.#extensions);
    if (!bbox) return;
    this.#strokeBoundingBox(this.#applyMargin(bbox, zoom), zoom);
  }

  /**
   * Draw the combined BoundingBox of a multi-selection
   *
   * The frame is made on the screen from the extent of the projected corners of every feature:
   * the corners of the frame of a single-coordinate feature (#pointFrame), and the corners of
   * the margin-applied bbox of the others, projected as they are drawn. A corner the camera
   * cannot see (on the far side of the globe, or behind the camera) is left out. The rectangle
   * is drawn as a figure of the screen laid around the first corner seen.
   */
  #drawCombinedBoundingBox(features: Feature[], zoom: number): void {
    if (!this.#transform) {
      // The fallback when there is no transform (without a margin)
      const bbox = computeCombinedBoundingBox(features, this.#extensions);
      if (bbox) this.#strokeBoundingBox(bbox, zoom);
      return;
    }
    const projectionData = this.#projectionData;
    if (!projectionData) return;

    const margin = this.#config.boundingBox.margin;
    const transform = this.#transform;
    const terrain = this.#terrain;
    const anchored = isAnchorActive(terrain);
    let reference: FrameAnchor | null = null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const extend = (points: readonly FramePoint[]) => {
      for (const { x, y } of points) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    };

    for (const feature of features) {
      const bbox = computeBoundingBox(feature, this.#extensions);
      if (!bbox) continue;

      // A single-coordinate feature (such as Point) gives the corners of its own frame. The
      // coordinate used is the center of the bbox (features other than Point can be zero-area
      // too, e.g. a MultiPoint with a single point)
      if (hasZeroArea(bbox)) {
        const frame = this.#pointFrame(feature, bbox.center);
        if (!frame || !this.#isSeen(frame)) continue;
        reference ??= frame;
        extend(frame.corners);
        continue;
      }

      const marginedBbox = applyMarginToBoundingBox(bbox, margin, transform, zoom);
      for (const corner of [
        marginedBbox.topLeft,
        marginedBbox.topRight,
        marginedBbox.bottomRight,
        marginedBbox.bottomLeft,
      ]) {
        // Projected as the frame of the feature is drawn: on the ground under the corner
        const elevationMeters = anchorElevationMeters(terrain, corner[0], corner[1]);
        const center = anchored
          ? projectAnchorAt(terrain, corner[0], corner[1], elevationMeters)
          : transform.project(corner);
        if (!center) continue;
        const seen: FrameAnchor = { anchor: corner, elevationMeters, center };
        if (!this.#isSeen(seen)) continue;
        reference ??= seen;
        extend([center]);
      }
    }

    if (!reference) return;
    const { x, y } = reference.center;
    const corners: OutlineOffset[] = [
      { x: minX - x, y: minY - y },
      { x: maxX - x, y: minY - y },
      { x: maxX - x, y: maxY - y },
      { x: minX - x, y: maxY - y },
    ];
    this.#outlineRenderer.draw(
      [reference.anchor[0], reference.anchor[1]],
      reference.elevationMeters,
      corners,
      this.#config.boundingBox.stroke,
      1,
      zoom,
      projectionData,
    );
  }

  /** Whether the camera sees an anchor: not on the far side of the globe */
  #isSeen({ anchor, elevationMeters }: FrameAnchor): boolean {
    const projectionData = this.#projectionData;
    return (
      !projectionData ||
      isOnVisibleSideOfGlobe(anchor[0], anchor[1], elevationMeters, projectionData)
    );
  }

  /**
   * Draw the BoundingBox with a margin (for a single selection)
   */
  #drawBoundingBoxWithMargin(features: Feature[], zoom: number): void {
    const bbox = computeCombinedBoundingBox(features, this.#extensions);
    if (!bbox) return;
    this.#strokeBoundingBox(this.#applyMargin(bbox, zoom), zoom);
  }

  /**
   * Draw the BoundingBox of a single-coordinate feature (expanding the extent of the
   * point frame by the margin)
   *
   * The half width and half height of the frame can be registered per type
   * (SelectionExtensionRegistry.resolvePointFrameCorners), as an outline or as an extent.
   * Without a registration it is the extent of the marker of a built-in point, else a 12px
   * square. The
   * zero-area treatment itself does not change, so no resize / rotate handle appears for
   * a feature that passes through here.
   *
   * The coordinate received is the center of the bbox (features other than Point can be
   * zero-area too, e.g. a MultiPoint with a single point, so coordinates must not be
   * treated as a Coordinate).
   *
   * The frame is a figure of the screen laid around the point as its marker is (see
   * #pointFrame): it is seen where the marker is seen, and faint where the terrain makes the
   * marker faint.
   */
  #drawPointBoundingBox(feature: Feature, coord: Coordinate, zoom: number): void {
    const frame = this.#pointFrame(feature, coord);
    const projectionData = this.#projectionData;
    if (!frame || !projectionData) return;
    const { x, y } = frame.center;
    this.#outlineRenderer.draw(
      [coord[0], coord[1]],
      frame.elevationMeters,
      frame.corners.map((corner) => ({ x: corner.x - x, y: corner.y - y })),
      this.#config.boundingBox.stroke,
      anchorGhostOpacity(this.#terrain, coord[0], coord[1]),
      zoom,
      projectionData,
    );
  }

  /**
   * The frame of a single-coordinate feature: the extent of its marker + the margin, on the
   * screen around the point
   *
   * The center is projected on the CPU as the marker is drawn: at the elevation of the point
   * (`anchorElevationMeters`), with the anchor projection while the terrain is on and with the
   * map's projection otherwise. The corners stay on the screen; the frame is drawn around the
   * point projected in the shader, the way the marker is, so it is never carried back onto the
   * map.
   *
   * @returns null when the point cannot be projected (behind the camera)
   */
  #pointFrame(feature: Feature, coord: Coordinate): PointFrame | null {
    const transform = this.#transform;
    if (!transform) return null;
    const terrain = this.#terrain;
    const elevationMeters = anchorElevationMeters(terrain, coord[0], coord[1]);
    const center = isAnchorActive(terrain)
      ? projectAnchorAt(terrain, coord[0], coord[1], elevationMeters)
      : transform.project(coord);
    if (!center) return null;
    const margin = this.#config.boundingBox.margin;
    const corners = this.#extensions.resolvePointFrameCorners(feature, center, margin);
    return { anchor: coord, elevationMeters, center, corners };
  }

  // ---------------- helpers ----------------

  #applyMargin(bbox: BoundingBoxCoords, zoom: number): BoundingBoxCoords {
    if (!this.#transform) return bbox;
    const margin = this.#config.boundingBox.margin;
    return {
      ...applyMarginToBoundingBox(bbox, margin, this.#transform, zoom),
      center: bbox.center,
    };
  }

  #strokeBoundingBox(bbox: BoundingBoxCoords, zoom: number): void {
    const corners: Coordinate[] = [bbox.topLeft, bbox.topRight, bbox.bottomRight, bbox.bottomLeft];
    this.#strokePath([...corners, bbox.topLeft], zoom);
  }

  /**
   * Draw the frame
   *
   * The frame follows the ground: the elevation of every point of the path is looked up with
   * the same function as the handles, so the corners of the frame match the corner handles and
   * never drift from the position that can be grabbed.
   */
  #strokePath(coords: Coordinate[], zoom: number): void {
    this.#strokeRenderer.draw(
      coords,
      this.#config.boundingBox.stroke,
      { widthUnit: 'pixels', closed: true, followTerrain: true },
      zoom,
      this.#projectionData ?? undefined,
    );
  }
}
