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
import { applyMarginToBoundingBox, type CoordinateTransform } from '../../../shared/math/index.js';
import type { Coordinate, DragState, Feature } from '../../../store/types.js';
import type { StrokeRenderer } from '../../renderers/stroke.js';
import {
  computeBoundingBox,
  computeCombinedBoundingBox,
  hasZeroArea,
  rotateBoundingBox,
} from './bounding-box.js';
import type { SelectionExtensionRegistry } from './extension-registry.js';
import type { BoundingBoxCoords } from './types.js';

export class SelectionUIRenderer {
  readonly #strokeRenderer: StrokeRenderer;
  /** The Selection UI extension points of the draw instance this renderer belongs to */
  readonly #extensions: SelectionExtensionRegistry;
  #config: SelectionUIConfig;
  #transform: CoordinateTransform | null = null;
  #projectionData: ProjectionData | null = null;

  constructor(
    strokeRenderer: StrokeRenderer,
    config: SelectionUIConfig,
    extensions: SelectionExtensionRegistry,
  ) {
    this.#strokeRenderer = strokeRenderer;
    this.#config = config;
    this.#extensions = extensions;
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
   * Gathers the corners of the margin-applied bbox of each feature and draws the combined AABB.
   * This contains rotated OBBs (Text/Image) correctly after the margin is applied as well.
   */
  #drawCombinedBoundingBox(features: Feature[], zoom: number): void {
    if (!this.#transform) {
      // The fallback when there is no transform (without a margin)
      const bbox = computeCombinedBoundingBox(features, this.#extensions);
      if (bbox) this.#strokeBoundingBox(bbox, zoom);
      return;
    }

    const margin = this.#config.boundingBox.margin;
    const transform = this.#transform;
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;

    for (const feature of features) {
      const bbox = computeBoundingBox(feature, this.#extensions);
      if (!bbox) continue;

      // A single-coordinate feature (such as Point) is computed from the extent of the
      // point frame + the margin. The coordinate used is the center of the bbox (features
      // other than Point can be zero-area too, e.g. a MultiPoint with a single point, so
      // coordinates must not be treated as a Coordinate)
      if (hasZeroArea(bbox)) {
        const center = transform.project(bbox.center);
        const extent = this.#extensions.resolvePointFrameExtent(feature);
        const halfWidth = extent.halfWidth + margin;
        const halfHeight = extent.halfHeight + margin;
        const topLeft = transform.unproject({ x: center.x - halfWidth, y: center.y - halfHeight });
        const bottomRight = transform.unproject({
          x: center.x + halfWidth,
          y: center.y + halfHeight,
        });
        minLng = Math.min(minLng, topLeft.lng, bottomRight.lng);
        maxLng = Math.max(maxLng, topLeft.lng, bottomRight.lng);
        minLat = Math.min(minLat, topLeft.lat, bottomRight.lat);
        maxLat = Math.max(maxLat, topLeft.lat, bottomRight.lat);
        continue;
      }

      const marginedBbox = applyMarginToBoundingBox(bbox, margin, transform, zoom);
      const corners = [
        marginedBbox.topLeft,
        marginedBbox.topRight,
        marginedBbox.bottomRight,
        marginedBbox.bottomLeft,
      ];
      for (const corner of corners) {
        minLng = Math.min(minLng, corner[0]);
        maxLng = Math.max(maxLng, corner[0]);
        minLat = Math.min(minLat, corner[1]);
        maxLat = Math.max(maxLat, corner[1]);
      }
    }

    if (!Number.isFinite(minLng)) return;
    const coords: Coordinate[] = [
      [minLng, maxLat],
      [maxLng, maxLat],
      [maxLng, minLat],
      [minLng, minLat],
      [minLng, maxLat],
    ];
    this.#strokePath(coords, zoom);
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
   * (SelectionExtensionRegistry.resolvePointFrameExtent). Without a registration it is the former 12px square. The
   * zero-area treatment itself does not change, so no resize / rotate handle appears for
   * a feature that passes through here.
   *
   * The coordinate received is the center of the bbox (features other than Point can be
   * zero-area too, e.g. a MultiPoint with a single point, so coordinates must not be
   * treated as a Coordinate).
   */
  #drawPointBoundingBox(feature: Feature, coord: Coordinate, zoom: number): void {
    if (!this.#transform) return;

    const center = this.#transform.project(coord);
    const margin = this.#config.boundingBox.margin;
    const extent = this.#extensions.resolvePointFrameExtent(feature);
    const halfWidth = extent.halfWidth + margin;
    const halfHeight = extent.halfHeight + margin;

    const topLeft = this.#transform.unproject({
      x: center.x - halfWidth,
      y: center.y - halfHeight,
    });
    const topRight = this.#transform.unproject({
      x: center.x + halfWidth,
      y: center.y - halfHeight,
    });
    const bottomRight = this.#transform.unproject({
      x: center.x + halfWidth,
      y: center.y + halfHeight,
    });
    const bottomLeft = this.#transform.unproject({
      x: center.x - halfWidth,
      y: center.y + halfHeight,
    });

    const coords: Coordinate[] = [
      [topLeft.lng, topLeft.lat],
      [topRight.lng, topRight.lat],
      [bottomRight.lng, bottomRight.lat],
      [bottomLeft.lng, bottomLeft.lat],
      [topLeft.lng, topLeft.lat],
    ];
    this.#strokePath(coords, zoom);
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
   * The frame is a single plate enclosing the feature. If the ground elevation were picked
   * up per vertex, the two ends of an edge would sit at different heights and the plate
   * would twist in space, appearing in a tilted view as a quadrilateral stretching far away
   * from the feature. So a single ground elevation at the center of the frame is taken and
   * the whole plate is placed at that height. The corner handles use the same height
   * (`handles.ts`), so the frame and the handles always match.
   */
  #strokePath(coords: Coordinate[], zoom: number): void {
    this.#strokeRenderer.draw(
      coords,
      this.#config.boundingBox.stroke,
      {
        widthUnit: 'pixels',
        closed: true,
        // The frame follows the ground. The elevation comes from the same function as the
        // handles, so the corners of the frame always match the corner handles and never
        // drift from the position that can be grabbed
        followTerrain: true,
      },
      zoom,
      this.#projectionData ?? undefined,
    );
  }
}
