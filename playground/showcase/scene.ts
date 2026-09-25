// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a scene of the showcase is made of
 *
 * Each scene is one picture of the README. `showcase.ts` picks the scene from the address of
 * the page, and the playground creates its map from the scene's basemap and camera.
 */

import type { Data, Feature, FileData, MapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';
import type * as maplibregl from 'maplibre-gl';

import type { UnderlayRegistry } from '../gis/underlay';

/** The camera a scene opens with */
export interface ShowcaseCamera {
  center: [number, number];
  zoom: number;
  pitch?: number;
  bearing?: number;
}

/** What a scene is given when it loads and when it finishes */
export interface ShowcaseContext {
  draw: MapLibreGLDraw;
  map: maplibregl.Map;
  underlays: UnderlayRegistry;
}

export interface ShowcaseScene {
  /** The style of the basemap */
  basemap: string;
  camera: ShowcaseCamera;
  /** The largest pitch of the map, when the camera is tilted beyond the default 60 degrees */
  maxPitch?: number;
  /**
   * Whether the map takes the whole width of the page (the sidebar is hidden), for a scene
   * that is about how the drawing looks rather than about the panels
   */
  mapOnly?: boolean;
  /**
   * Loads the drawing and sets up the map. Called on the map's load, before the panels are
   * built, so that they start from the drawing
   */
  load(context: ShowcaseContext): Promise<void>;
  /** Selects a feature, arranges the panels and adds the legend, once the panels are built */
  finish?(context: ShowcaseContext & { layerPanel: HTMLElement }): Promise<void>;
}

/** A feature of a scene's document: the fields a scene sets */
export type SceneFeature = Pick<Feature, 'id' | 'type' | 'coordinates' | 'style' | 'properties'>;

/** A layer of a scene's document, with its features from the back */
export interface SceneLayer {
  id: string;
  name: string;
  features: SceneFeature[];
}

/**
 * Builds a document in the native format from layers listed from the back, for a scene that
 * makes its drawing in code
 */
export function buildDocument(title: string, layers: SceneLayer[], files: FileData[] = []): Data {
  return {
    version: '2.0.0',
    metadata: { title },
    layerOrder: layers.map((layer) => layer.id),
    layers: layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      visible: true,
      locked: false,
      opacity: 1,
      order: layer.features.map((feature) => feature.id),
    })),
    features: layers.flatMap((layer) =>
      layer.features.map((feature) => ({
        ...feature,
        layerId: layer.id,
        visible: true,
        locked: false,
      })),
    ),
    files: Object.fromEntries(files.map((file) => [file.id, file])),
  };
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Makes an image in a canvas and returns it as a data URL, for a scene that brings its own
 * picture
 */
export function drawImage(
  width: number,
  height: number,
  paint: (context: CanvasRenderingContext2D) => void,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas');
  paint(context);
  return canvas.toDataURL('image/png');
}

/**
 * The points of a great circle from `from` to `to`, one every `stepDegrees` of arc at most
 *
 * A long line is given as many short segments so that it follows the shortest path over the
 * globe.
 */
export function greatCircle(
  from: [number, number],
  to: [number, number],
  stepDegrees = 2,
): [number, number][] {
  const rad = Math.PI / 180;
  const toVector = ([lng, lat]: [number, number]) => [
    Math.cos(lat * rad) * Math.cos(lng * rad),
    Math.cos(lat * rad) * Math.sin(lng * rad),
    Math.sin(lat * rad),
  ];
  const a = toVector(from);
  const b = toVector(to);
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const angle = Math.acos(dot);
  const steps = Math.max(1, Math.ceil(angle / rad / stepDegrees));
  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s = Math.sin(angle);
    const ka = Math.sin((1 - t) * angle) / s;
    const kb = Math.sin(t * angle) / s;
    const x = ka * a[0] + kb * b[0];
    const y = ka * a[1] + kb * b[1];
    const z = ka * a[2] + kb * b[2];
    points.push([round(Math.atan2(y, x) / rad), round(Math.atan2(z, Math.hypot(x, y)) / rad)]);
  }
  return points;
}

function round(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}
