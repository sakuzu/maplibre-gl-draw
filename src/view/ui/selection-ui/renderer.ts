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
import {
  applyMarginToBoundingBox,
  type CoordinateTransform,
  type ScreenPoint,
} from '../../../shared/math/index.js';
import type { Coordinate, DragState, Feature } from '../../../store/types.js';
import type { StrokeRenderer } from '../../renderers/stroke.js';
import { anchorElevationMeters, isAnchorActive, projectAnchorAt } from '../../terrain/anchor.js';
import { TerrainContext } from '../../terrain/context.js';
import {
  computeBoundingBox,
  computeCombinedBoundingBox,
  hasZeroArea,
  rotateBoundingBox,
} from './bounding-box.js';
import type { SelectionExtensionRegistry } from './extension-registry.js';
import type { BoundingBoxCoords, FramePoint } from './types.js';

/** The frame of a single-coordinate feature, flat at the elevation of the feature */
interface PointFrame {
  /** The corners of the frame, closed (the first corner comes again at the end) */
  coords: Coordinate[];
  /** The elevation the frame lies at, in meters (0 without terrain) */
  elevationMeters: number;
}

/**
 * How far the positions differ that the scale of the screen around a point is measured
 * between, in pixels at the zoom of the frame
 */
const POINT_FRAME_PROBE_PX = 4;

export class SelectionUIRenderer {
  readonly #strokeRenderer: StrokeRenderer;
  /** The Selection UI extension points of the draw instance this renderer belongs to */
  readonly #extensions: SelectionExtensionRegistry;
  /** The terrain state of the draw instance (an inactive one projects with the map) */
  readonly #terrain: TerrainContext;
  #config: SelectionUIConfig;
  #transform: CoordinateTransform | null = null;
  #projectionData: ProjectionData | null = null;

  constructor(
    strokeRenderer: StrokeRenderer,
    config: SelectionUIConfig,
    extensions: SelectionExtensionRegistry,
    terrain: TerrainContext = new TerrainContext(),
  ) {
    this.#strokeRenderer = strokeRenderer;
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
      // point frame + the margin, as its own frame is (#pointFrame). The coordinate used is
      // the center of the bbox (features other than Point can be zero-area too, e.g. a
      // MultiPoint with a single point, so coordinates must not be treated as a Coordinate)
      if (hasZeroArea(bbox)) {
        const frame = this.#pointFrame(feature, bbox.center, zoom);
        for (const [lng, lat] of frame?.coords ?? []) {
          minLng = Math.min(minLng, lng);
          maxLng = Math.max(maxLng, lng);
          minLat = Math.min(minLat, lat);
          maxLat = Math.max(maxLat, lat);
        }
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
   * The frame lies flat at the elevation of the point (see #pointFrame).
   */
  #drawPointBoundingBox(feature: Feature, coord: Coordinate, zoom: number): void {
    const frame = this.#pointFrame(feature, coord, zoom);
    if (!frame) return;
    this.#strokePath(frame.coords, zoom, {
      elevationMeters: frame.elevationMeters,
      followTerrain: false,
    });
  }

  /**
   * The frame of a single-coordinate feature: the extent of its marker + the margin, on the
   * screen, carried back to positions on the plane at the elevation of the point
   *
   * The center is projected as the marker is drawn: at the elevation of the point
   * (`anchorElevationMeters`), with the anchor projection while the terrain is on and with the
   * map's projection otherwise.
   *
   * While the terrain is on, the corners of the frame on the screen are carried back to
   * positions with the scale of the screen around the point on the plane at its elevation (a
   * first order approximation), not by casting them onto the ground: on a tilted view the
   * ground behind the point is farther than the point and the ground in front is nearer, which
   * stretched the frame. Drawn flat at the same elevation, the corners land where they were put
   * on the screen. Without terrain the corners are cast onto the map, which is that plane (or
   * the sphere, where a frame at a low zoom spans too many degrees for a first order
   * approximation).
   *
   * @returns null when the point cannot be projected (behind the camera)
   */
  #pointFrame(feature: Feature, coord: Coordinate, zoom: number): PointFrame | null {
    const transform = this.#transform;
    if (!transform) return null;
    const terrain = this.#terrain;
    const elevationMeters = anchorElevationMeters(terrain, coord[0], coord[1]);
    const anchored = isAnchorActive(terrain);
    const project = (at: Coordinate): ScreenPoint | null =>
      anchored ? projectAnchorAt(terrain, at[0], at[1], elevationMeters) : transform.project(at);

    const center = project(coord);
    if (!center) return null;
    const margin = this.#config.boundingBox.margin;
    const corners = this.#extensions.resolvePointFrameCorners(feature, center, margin);
    const toPosition = anchored ? screenToPlane(project, coord, center, zoom) : null;
    const coords: Coordinate[] = corners.map((corner) => {
      const position = toPosition?.(corner);
      if (position) return position;
      // No terrain, or the plane seen edge on: the corner is cast onto the map
      const at = transform.unproject(corner);
      return [at.lng, at.lat];
    });
    coords.push(coords[0]);
    return { coords, elevationMeters };
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
   * By default the frame follows the ground: the elevation of every point of the path is
   * looked up with the same function as the handles, so the corners of the frame match the
   * corner handles and never drift from the position that can be grabbed.
   *
   * The frame of a single-coordinate feature is instead a flat plate at the elevation of the
   * point (`elevationMeters`, without following the ground): its corners were placed on the
   * screen around the marker, and a plate at the height of the marker keeps them there.
   */
  #strokePath(
    coords: Coordinate[],
    zoom: number,
    placement: { elevationMeters?: number; followTerrain: boolean } = { followTerrain: true },
  ): void {
    this.#strokeRenderer.draw(
      coords,
      this.#config.boundingBox.stroke,
      {
        widthUnit: 'pixels',
        closed: true,
        followTerrain: placement.followTerrain,
        ...(placement.elevationMeters !== undefined && {
          elevationMeters: placement.elevationMeters,
        }),
      },
      zoom,
      this.#projectionData ?? undefined,
    );
  }
}

/**
 * The inverse of a projection around a point, to the first order: a point of the screen near
 * `center` to the position whose projection it is
 *
 * The scale of the screen along the longitude and the latitude is measured by projecting
 * positions a few pixels to either side of `coord`.
 *
 * @returns null when the projection is degenerate there (seen edge on, or a probe behind the
 *   camera)
 */
function screenToPlane(
  project: (at: Coordinate) => ScreenPoint | null,
  coord: Coordinate,
  center: ScreenPoint,
  zoom: number,
): ((point: FramePoint) => Coordinate) | null {
  const [lng, lat] = coord;
  // Degrees of longitude per pixel at the zoom on a 512 px world, a few pixels' worth
  const step = (360 / (512 * 2 ** zoom)) * POINT_FRAME_PROBE_PX;
  const latStep = Math.min(step, Math.max(1e-9, (89.9 - Math.abs(lat)) / 2));
  const east = project([lng + step, lat]);
  const west = project([lng - step, lat]);
  const north = project([lng, lat + latStep]);
  const south = project([lng, lat - latStep]);
  if (!east || !west || !north || !south) return null;

  // The screen per degree of longitude (a, c) and of latitude (b, d)
  const a = (east.x - west.x) / (2 * step);
  const c = (east.y - west.y) / (2 * step);
  const b = (north.x - south.x) / (2 * latStep);
  const d = (north.y - south.y) / (2 * latStep);
  const det = a * d - b * c;
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-12 * scale * scale) return null;

  return (point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return [lng + (d * dx - b * dy) / det, lat + (a * dy - c * dx) / det];
  };
}
