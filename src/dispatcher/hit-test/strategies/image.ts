// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ImageHitTestStrategy
 *
 * Hit testing strategy for image features.
 * It tests using an OBB (Oriented Bounding Box).
 */

import {
  createOBB,
  DEFAULT_TILE_SIZE,
  distanceToOBB,
  getMetersPerPixel,
  metersToDegreesLat,
  metersToDegreesLng,
} from '../../../shared/math/index.js';
import { coordinatesOf } from '../../../shared/utils/coordinates.js';
import { getImageProperties } from '../../../shared/utils/property.js';
import type { Coordinate, Feature, ImageStyle } from '../../../store/types.js';
import type { HitTestStrategy } from './base.js';

/** The keys of an image style that drawing an image reads, with their defaults applied */
type ResolvedImageStyle = Required<
  Pick<ImageStyle, 'width' | 'height' | 'rotation' | 'opacity' | 'imageOpacity'>
>;

/**
 * Default image style
 * width/height: 0 = use the original size (the same as ImageRenderer)
 */
const DEFAULT_IMAGE_STYLE: ResolvedImageStyle = {
  width: 0,
  height: 0,
  rotation: 0,
  opacity: 1.0,
  imageOpacity: 1,
};

/**
 * ImageHitTestStrategy
 */
export class ImageHitTestStrategy implements HitTestStrategy {
  readonly geometryType = 'Image' as const;

  private tileSize: number;

  constructor(tileSize = DEFAULT_TILE_SIZE) {
    this.tileSize = tileSize;
  }

  /**
   * Updates the tile size
   */
  setTileSize(tileSize: number): void {
    this.tileSize = tileSize;
  }

  test(feature: Feature, coordinate: Coordinate, toleranceLngLat: number): boolean {
    if (feature.type !== 'Image') return false;

    const dims = this.computeDims(feature);
    if (!dims) return false;

    // The rendered image (computeQuadVertices) is rotated in latitude-normalized space.
    // Unless the hit test also rotates and tests in latitude-normalized space, rotating in
    // raw degree space shears the shape because of the real distance difference along the
    // longitude axis, and part of a rotated image becomes impossible to click.
    const { center, widthDeg, heightDeg, rotation } = dims;
    const latCos = Math.cos((center[1] * Math.PI) / 180);
    const dxNorm = (coordinate[0] - center[0]) * latCos;
    const dyNorm = coordinate[1] - center[1];

    const r = (-rotation * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const localX = dxNorm * cos - dyNorm * sin;
    const localY = dxNorm * sin + dyNorm * cos;

    const hwNorm = (widthDeg / 2) * latCos;
    const hhNorm = heightDeg / 2;
    const tolNorm = toleranceLngLat * latCos;

    return Math.abs(localX) <= hwNorm + tolNorm && Math.abs(localY) <= hhNorm + tolNorm;
  }

  distance(feature: Feature, coordinate: Coordinate): number {
    if (feature.type !== 'Image') return Infinity;

    const dims = this.computeDims(feature);
    if (!dims) return Infinity;

    // The distance is only used to decide which hit is in front (ordering). An OBB
    // approximation is enough.
    const obb = createOBB(
      dims.center[0],
      dims.center[1],
      dims.widthDeg,
      dims.heightDeg,
      dims.rotation,
    );
    return distanceToOBB(obb, coordinate);
  }

  /**
   * Computes the dimensions (in degrees) and the rotation of an image feature
   *
   * It uses the same size computation logic as ImageRenderer
   */
  private computeDims(
    feature: Feature,
  ): { center: Coordinate; widthDeg: number; heightDeg: number; rotation: number } | null {
    const properties = getImageProperties(feature);
    if (!properties.imageFileId) return null;

    const coord = coordinatesOf(feature) as Coordinate;
    const latitude = coord[1];
    const style = { ...DEFAULT_IMAGE_STYLE, ...(feature.style as ImageStyle) };

    // Get the image size (the same logic as ImageRenderer)
    // The size stored in ImageProperties takes precedence
    // 100 is used as the fallback (for when the image has not been loaded)
    const imageWidth = properties.imageWidth || 100;
    const imageHeight = properties.imageHeight || 100;

    // Use the size specified by the style, or the original size
    const displayWidth = style.width || imageWidth;
    const displayHeight = style.height || imageHeight;

    // Compute the size based on the display at createdZoom
    const createdZoom = properties.createdZoom || 14;
    const scale = properties.scale || 1;

    // Pixel to meter conversion at createdZoom
    const widthMeters =
      getMetersPerPixel(latitude, createdZoom, this.tileSize) * displayWidth * scale;
    const heightMeters =
      getMetersPerPixel(latitude, createdZoom, this.tileSize) * displayHeight * scale;

    // Convert meters to degrees
    const widthDeg = metersToDegreesLng(widthMeters, latitude);
    const heightDeg = metersToDegreesLat(heightMeters);

    // Rotation angle (the sum of both the style and the properties)
    const rotation = (style.rotation || 0) + (properties.rotation || 0);

    return { center: coord, widthDeg, heightDeg, rotation };
  }
}
