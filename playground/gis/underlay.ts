// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Registry of underlays (datasets)
 *
 * Dataset is the route for stacking a large number of features that are not being
 * edited, and the library itself does not hold a display name. Here, for the examples, we
 * only remember the mapping from dataset ID to display name, and gather adding,
 * removing, toggling visibility and reordering in one place. The Underlays section of the
 * Layers panel looks at this registry.
 *
 * The stacking order is owned by the library (getDatasets returns them in display
 * order). The registry does not keep an order of its own, and delegates reordering to
 * moveDataset.
 *
 * The attribute popup on click is also taken care of here. Every underlay goes through this
 * registry, so demo data and imported files feel exactly the same.
 */

import type {
  Dataset,
  DatasetOrder,
  DatasetRow,
  MapLibreGLDraw,
  StyleRule,
} from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';

/**
 * Information about one entry shown in the list
 */
export interface UnderlayEntry {
  /** Dataset ID */
  id: string;
  /** Display name */
  name: string;
  /** Whether it is currently shown */
  visible: boolean;
  /** Number of features it holds */
  count: number;
  /** Whether it sits in front of or behind the objects of the Store */
  order: DatasetOrder;
}

/**
 * Options for adding an underlay
 */
export interface UnderlayAddOptions {
  /** Dataset ID (must be unique) */
  id: string;
  /** Display name shown in the list */
  name: string;
  /** Features to display */
  features: DatasetRow[];
  /** Style rule (the default color is used when omitted) */
  styleRule?: StyleRule;
}

/**
 * Registry of underlays
 */
export class UnderlayRegistry {
  private draw: MapLibreGLDraw;
  private map: maplibregl.Map;
  /** Dataset ID to display name (no order is kept) */
  private names = new Map<string, string>();
  private listeners = new Set<() => void>();
  private popup: maplibregl.Popup | null = null;
  /** Serial number for the dataset IDs created by import */
  private seq = 0;

  constructor(draw: MapLibreGLDraw, map: maplibregl.Map) {
    this.draw = draw;
    this.map = map;
  }

  /**
   * Adds an underlay.
   *
   * It is always interactive and placed at the very back. Clicking it shows the attributes.
   */
  add(options: UnderlayAddOptions): Dataset {
    const dataset = this.draw.addDataset({
      id: options.id,
      rows: options.features,
      styleRule: options.styleRule,
      interactive: true,
      order: 'below-store',
    });

    dataset.on('click', ({ feature, lngLat }) => {
      this.showFeaturePopup(feature.properties, lngLat);
    });

    this.names.set(options.id, options.name);
    this.notify();

    return dataset;
  }

  /**
   * Creates an unused dataset ID for an import.
   */
  nextId(): string {
    let id = `underlay-${++this.seq}`;
    while (this.names.has(id)) {
      id = `underlay-${++this.seq}`;
    }
    return id;
  }

  /**
   * Whether it is registered.
   */
  has(id: string): boolean {
    return this.names.has(id);
  }

  /**
   * The list (in display order, from back to front).
   *
   * The order is the library display order as is. It starts at the back (the very back of
   * below-store) and ends at the front (the very front of above-store).
   */
  list(): UnderlayEntry[] {
    const datasets = this.draw.getDatasets();
    const alive = new Set(datasets.map((dataset) => dataset.id));

    // If it is gone on the library side, drop it from the registry too
    for (const id of [...this.names.keys()]) {
      if (!alive.has(id)) this.names.delete(id);
    }

    const entries: UnderlayEntry[] = [];
    for (const dataset of datasets) {
      const name = this.names.get(dataset.id);
      if (name === undefined) continue;
      entries.push({
        id: dataset.id,
        name,
        visible: dataset.visible,
        count: dataset.getFeatures().length,
        order: dataset.order,
      });
    }

    return entries;
  }

  /**
   * Moves it one step to the front or the back within the same side.
   *
   * @param delta 1 to move to the front, -1 to move to the back
   * @returns true when it moved (false when it is at an end and cannot move)
   */
  move(id: string, delta: number): boolean {
    const dataset = this.draw.getDataset(id);
    if (!dataset) return false;

    // The position is counted among all datasets on the same side (so it does not jump
    // over an underlay that is outside the registry)
    const side = this.draw.getDatasets().filter((other) => other.order === dataset.order);
    const index = side.findIndex((other) => other.id === id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= side.length) return false;

    this.draw.moveDataset(id, { index: next });
    this.notify();

    return true;
  }

  /**
   * Toggles whether it is in front of or behind the objects (front <-> back).
   *
   * @returns The side after toggling (null when it does not exist)
   */
  toggleOrder(id: string): DatasetOrder | null {
    const dataset = this.draw.getDataset(id);
    if (!dataset) return null;

    const next: DatasetOrder = dataset.order === 'below-store' ? 'above-store' : 'below-store';
    this.draw.moveDataset(id, { order: next });
    this.notify();

    return next;
  }

  /**
   * Toggles visibility.
   *
   * @returns The state after toggling (null when it does not exist)
   */
  toggleVisible(id: string): boolean | null {
    const dataset = this.draw.getDataset(id);
    if (!dataset) return null;

    const next = !dataset.visible;
    dataset.setVisible(next);
    if (!next) {
      // Do not leave the attributes of something invisible on screen
      this.closePopup();
    }
    this.notify();

    return next;
  }

  /**
   * Removes an underlay.
   *
   * @returns The display name of the removed underlay (null when it does not exist)
   */
  remove(id: string): string | null {
    const name = this.names.get(id);
    if (name === undefined) return null;

    this.draw.removeDataset(id);
    this.names.delete(id);
    this.closePopup();
    this.notify();

    return name;
  }

  /**
   * Subscribes to changes of the list.
   *
   * @returns A function that unsubscribes
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Notifies of a change.
   */
  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  /**
   * Shows the attribute popup.
   */
  private showFeaturePopup(properties: Record<string, unknown>, lngLat: [number, number]): void {
    this.closePopup();

    const rows = Object.entries(properties)
      .map(
        ([key, value]) =>
          `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(String(value))}</td></tr>`,
      )
      .join('');

    this.popup = new maplibregl.Popup({ closeOnClick: true, maxWidth: '240px' })
      .setLngLat(lngLat)
      .setHTML(`<table class="display-popup">${rows}</table>`)
      .addTo(this.map);
  }

  /**
   * Closes the popup.
   */
  private closePopup(): void {
    this.popup?.remove();
    this.popup = null;
  }
}

/**
 * Converts GeoJSON into features for an underlay.
 *
 * They do not go into the Store, so only the geometry and the attributes are copied. A
 * feature without an id is given a serial number prefixed with the dataset ID (so ids do
 * not collide between underlays). Unsupported geometries (GeometryCollection and null
 * geometry) are skipped.
 */
export function geojsonToDisplayFeatures(geojson: unknown, datasetId: string): DatasetRow[] {
  const features = toGeoJsonFeatures(geojson);
  const result: DatasetRow[] = [];

  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry || !SUPPORTED_GEOMETRY_TYPES.has(geometry.type)) continue;
    if (!Array.isArray(geometry.coordinates)) continue;

    const rawId = feature.id;
    const id =
      typeof rawId === 'string' || typeof rawId === 'number'
        ? String(rawId)
        : `${datasetId}-${result.length}`;

    result.push({
      type: 'Feature',
      id,
      geometry: geometry as DatasetRow['geometry'],
      properties: (feature.properties ?? {}) as Record<string, unknown>,
    });
  }

  return result;
}

/** Geometries that can be drawn as an underlay */
const SUPPORTED_GEOMETRY_TYPES = new Set([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
]);

/** The minimal shape of GeoJSON */
interface GeoJsonFeature {
  id?: unknown;
  properties?: unknown;
  geometry?: { type: string; coordinates?: unknown } | null;
}

/**
 * Flattens a FeatureCollection, a Feature or a bare geometry into an array of Features.
 */
function toGeoJsonFeatures(geojson: unknown): GeoJsonFeature[] {
  if (typeof geojson !== 'object' || geojson === null) return [];

  const value = geojson as { type?: string; features?: unknown; geometry?: unknown };

  if (value.type === 'FeatureCollection' && Array.isArray(value.features)) {
    return value.features as GeoJsonFeature[];
  }
  if (value.type === 'Feature') {
    return [value as GeoJsonFeature];
  }
  if (typeof value.type === 'string' && SUPPORTED_GEOMETRY_TYPES.has(value.type)) {
    return [{ geometry: value as { type: string; coordinates?: unknown } }];
  }

  return [];
}

/**
 * HTML escaping
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
