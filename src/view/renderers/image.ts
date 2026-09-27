// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ImageRenderer
 *
 * A renderer that draws image features.
 * It draws images using TextureCache and QuadShader.
 * The image data is obtained from the FileData of the Store.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import {
  getMetersPerPixel,
  metersToDegreesLat,
  metersToDegreesLng,
} from '../../shared/math/index.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { getTileSize } from '../../shared/utils/map.js';
import { getImageProperties } from '../../shared/utils/property.js';
import type { Coordinate, Feature, FileData } from '../../store/types.js';
import type { TextureCache } from '../cache/texture.js';
import { computeQuadVertices, type QuadShader } from '../shaders/quad.js';

/**
 * The type of the function that obtains file data
 *
 * @internal
 */
export type GetFileDataFn = (fileId: string) => FileData | undefined;

/**
 * The type of the function told that the image of an Image feature failed to load
 *
 * It is called once per feature and image: every feature that draws an image that failed is
 * reported, even when several features share the image, and a feature is not reported again
 * every frame (a failed image is not retried).
 *
 * @internal
 */
export type ImageErrorFn = (featureId: string, error: Error) => void;

/**
 * ImageRenderer
 *
 * @internal
 */
export class ImageRenderer {
  private map: MapLibreMap;
  private textureCache: TextureCache;
  private quadShader: QuadShader;
  private getFileData: GetFileDataFn;
  private onError: ImageErrorFn | undefined;
  /** Features drawn while their image was decoding, by dataURL (reported if it fails) */
  private waitingFeatures = new Map<string, Set<string>>();
  /** The dataURL each feature was last reported for, by feature ID */
  private reportedFailures = new Map<string, string>();

  constructor(
    map: MapLibreMap,
    _gl: WebGL2RenderingContext,
    textureCache: TextureCache,
    quadShader: QuadShader,
    getFileData: GetFileDataFn,
    onError?: ImageErrorFn,
  ) {
    this.map = map;
    this.textureCache = textureCache;
    this.quadShader = quadShader;
    this.getFileData = getFileData;
    this.onError = onError;
  }

  /**
   * Get the tile size
   */
  private getMapTileSize(): number {
    return getTileSize(this.map);
  }

  /**
   * Draw an image feature
   *
   * @param feature The image feature
   * @param projectionData MapLibre's ProjectionData
   * @param zoom The current zoom level
   * @param onNeedRedraw Callback for when a redraw is needed
   * @param opacityFactor Multiplied into the opacity of the image (the opacity of its layer)
   */
  draw(
    feature: Feature,
    projectionData: ProjectionData,
    zoom: number,
    onNeedRedraw?: () => void,
    opacityFactor = 1,
  ): void {
    if (feature.type !== 'Image') return;

    const properties = getImageProperties(feature);
    if (!properties.imageFileId) return;

    // Obtain the FileData from the Store
    const fileData = this.getFileData(properties.imageFileId);
    // No FileData yet: a transient state (in a shared document the feature can arrive before
    // its file), so the feature is drawn without its image and nothing is logged.
    if (!fileData) return;

    const coord = coordinatesOf(feature) as Coordinate;
    const latitude = coord[1];

    // The texture is keyed by the dataURL. While the image is decoding nothing is drawn; the
    // decode (shared per dataURL) requests a redraw when it finishes, and that frame uploads it
    const imageFileId = properties.imageFileId;
    const src = fileData.dataURL;
    const textureInfo = this.textureCache.acquireImageTexture(
      src,
      () => {
        this.waitingFeatures.delete(src);
        onNeedRedraw?.();
      },
      (error) => {
        console.error(`Failed to load image: ${imageFileId}`, error);
        this.reportFailure(src, error);
      },
    );
    if (!textureInfo) {
      this.noteMissingImage(feature.id, src);
      return;
    }

    // The size in pixels at the created zoom: the size of the feature, or else of the image
    const displayWidth = properties.imageWidth || textureInfo.width;
    const displayHeight = properties.imageHeight || textureInfo.height;

    // Scale relative to how it is displayed at createdZoom
    // At createdZoom the image is displayed at its original pixel size
    const createdZoom = properties.createdZoom || zoom;
    const scale = properties.scale || 1;

    // Pixel -> meter conversion at createdZoom
    const tileSize = this.getMapTileSize();
    const metersPerPixel = getMetersPerPixel(latitude, createdZoom, tileSize);
    const widthMeters = displayWidth * scale * metersPerPixel;
    const heightMeters = displayHeight * scale * metersPerPixel;

    // Convert meters -> degrees
    const widthDeg = metersToDegreesLng(widthMeters, latitude);
    const heightDeg = metersToDegreesLat(heightMeters);

    // Rotation angle (degrees -> radians)
    const rotationRad = ((properties.rotation || 0) * Math.PI) / 180;

    // Compute the quad vertices
    const vertices = computeQuadVertices(coord[0], coord[1], widthDeg, heightDeg, rotationRad);

    // Draw
    const opacity = (feature.style.imageOpacity ?? 1.0) * opacityFactor;
    this.quadShader.draw(vertices, textureInfo.texture, opacity, projectionData, zoom);
  }

  /**
   * Records a feature whose image is not drawn: reports it at once when the image has failed,
   * otherwise waits for the decode (the cache tells only the caller that started it)
   */
  private noteMissingImage(featureId: string, src: string): void {
    const error = this.textureCache.getImageError(src);
    if (error) {
      this.reportFeature(featureId, src, error);
      return;
    }
    let waiting = this.waitingFeatures.get(src);
    if (!waiting) {
      waiting = new Set();
      this.waitingFeatures.set(src, waiting);
    }
    waiting.add(featureId);
  }

  /** Reports every feature that was waiting for an image that failed */
  private reportFailure(src: string, error: Error): void {
    const waiting = this.waitingFeatures.get(src);
    this.waitingFeatures.delete(src);
    for (const featureId of waiting ?? []) this.reportFeature(featureId, src, error);
  }

  /** Reports a feature once per image */
  private reportFeature(featureId: string, src: string, error: Error): void {
    if (this.reportedFailures.get(featureId) === src) return;
    this.reportedFailures.set(featureId, src);
    this.onError?.(featureId, error);
  }

  /**
   * Compute the bounding box of an image (in degrees)
   *
   * @param feature The image feature
   * @param zoom The current zoom level
   * @returns The bounding box { minX, minY, maxX, maxY }
   */
  computeBounds(
    feature: Feature,
    zoom: number,
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (feature.type !== 'Image') return null;

    const properties = getImageProperties(feature);
    if (!properties.imageFileId) return null;

    const coord = coordinatesOf(feature) as Coordinate;
    const latitude = coord[1];

    // The size in pixels at the created zoom
    const displayWidth = properties.imageWidth;
    const displayHeight = properties.imageHeight;

    // Scale relative to how it is displayed at createdZoom
    const createdZoom = properties.createdZoom || zoom;
    const scale = properties.scale || 1;

    // Pixel -> meter conversion at createdZoom
    const tileSize = this.getMapTileSize();
    const metersPerPixel = getMetersPerPixel(latitude, createdZoom, tileSize);
    const widthMeters = displayWidth * scale * metersPerPixel;
    const heightMeters = displayHeight * scale * metersPerPixel;

    // Convert meters -> degrees
    const widthDeg = metersToDegreesLng(widthMeters, latitude);
    const heightDeg = metersToDegreesLat(heightMeters);

    // Rotation angle
    const rotationRad = ((properties.rotation || 0) * Math.PI) / 180;

    // Compute the quad vertices
    const vertices = computeQuadVertices(coord[0], coord[1], widthDeg, heightDeg, rotationRad);

    // Compute the bounding box
    const lngs = [
      this.mercatorToLng(vertices.topLeft[0]),
      this.mercatorToLng(vertices.topRight[0]),
      this.mercatorToLng(vertices.bottomLeft[0]),
      this.mercatorToLng(vertices.bottomRight[0]),
    ];
    const lats = [
      this.mercatorToLat(vertices.topLeft[1]),
      this.mercatorToLat(vertices.topRight[1]),
      this.mercatorToLat(vertices.bottomLeft[1]),
      this.mercatorToLat(vertices.bottomRight[1]),
    ];

    return {
      minX: Math.min(...lngs),
      minY: Math.min(...lats),
      maxX: Math.max(...lngs),
      maxY: Math.max(...lats),
    };
  }

  /**
   * Convert a Mercator X coordinate to longitude
   */
  private mercatorToLng(x: number): number {
    return x * 360 - 180;
  }

  /**
   * Convert a Mercator Y coordinate to latitude
   */
  private mercatorToLat(y: number): number {
    const n = Math.PI - 2 * Math.PI * y;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
}
