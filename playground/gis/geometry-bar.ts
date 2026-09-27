// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Geometry Bar
 *
 * A geometry-operation toolbar overlaid on the map. It handles boolean operations
 * (merge / subtract / intersect) and buffering on the selected features.
 *
 * Each operation returns what it made (null or an empty array when nothing changed), which
 * the bar reports. An operation that cannot run (fewer than two polygons, for example) is
 * blocked in advance by disabling its button.
 */

import type { Draw } from '@sakuzu/maplibre-gl-draw';

import type { Toast } from './toast';

/** Polygon-like types that boolean operations can target */
const AREA_TYPES = new Set(['Polygon', 'MultiPolygon', 'Circle']);

/**
 * Geometry operation toolbar
 */
export class GeometryBar {
  private draw: Draw;
  private toast: Toast;
  private unionBtn: HTMLButtonElement;
  private subtractBtn: HTMLButtonElement;
  private intersectBtn: HTMLButtonElement;
  private bufferBtn: HTMLButtonElement;
  private bufferInput: HTMLInputElement;
  private statusEl: HTMLElement | null;

  constructor(root: HTMLElement, draw: Draw, toast: Toast) {
    this.draw = draw;
    this.toast = toast;

    this.unionBtn = root.querySelector('#geom-union') as HTMLButtonElement;
    this.subtractBtn = root.querySelector('#geom-subtract') as HTMLButtonElement;
    this.intersectBtn = root.querySelector('#geom-intersect') as HTMLButtonElement;
    this.bufferBtn = root.querySelector('#geom-buffer') as HTMLButtonElement;
    this.bufferInput = root.querySelector('#geom-buffer-distance') as HTMLInputElement;
    this.statusEl = root.querySelector('#geom-status');

    this.attachEventListeners();
    this.subscribeEvents();
    this.updateState();
  }

  /**
   * Updates the enabled state of the buttons.
   */
  updateState(): void {
    const features = this.selectedFeatures();
    const areaCount = features.filter((feature) => AREA_TYPES.has(feature.type)).length;

    const booleanDisabled = areaCount < 2;
    this.unionBtn.disabled = booleanDisabled;
    this.subtractBtn.disabled = booleanDisabled;
    this.intersectBtn.disabled = booleanDisabled;
    this.bufferBtn.disabled = features.length === 0;

    if (this.statusEl) {
      this.statusEl.textContent =
        features.length === 0
          ? 'Select a feature'
          : `${features.length} selected / ${areaCount} polygons`;
    }
  }

  /** The selected features, in stacking order from the back */
  private selectedFeatures() {
    const selection = this.draw.selection.get();
    if (selection.type !== 'feature') return [];
    const selected = new Set(selection.ids);
    return this.draw.features.list().filter((feature) => selected.has(feature.id));
  }

  /** The IDs of the selected polygons, from the back */
  private selectedAreaIds(): string[] {
    return this.selectedFeatures()
      .filter((feature) => AREA_TYPES.has(feature.type))
      .map((feature) => feature.id);
  }

  /**
   * Sets up the event listeners.
   */
  private attachEventListeners(): void {
    this.unionBtn.addEventListener('click', () => {
      const ids = this.selectedAreaIds();
      this.report('Merge', ids.length, this.draw.features.union(ids));
    });

    this.subtractBtn.addEventListener('click', () => {
      // The backmost polygon is the one the others are subtracted from
      const [subject, ...others] = this.selectedAreaIds();
      if (subject === undefined) return;
      this.report('Subtract', others.length + 1, this.draw.features.difference(subject, others));
    });

    this.intersectBtn.addEventListener('click', () => {
      const ids = this.selectedAreaIds();
      this.report('Intersect', ids.length, this.draw.features.intersection(ids));
    });

    this.bufferBtn.addEventListener('click', () => {
      this.runBuffer();
    });

    this.bufferInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        this.runBuffer();
      }
    });
  }

  /**
   * Runs the buffer operation.
   */
  private runBuffer(): void {
    const distanceMeters = Number.parseFloat(this.bufferInput.value);
    if (!Number.isFinite(distanceMeters) || distanceMeters === 0) {
      this.toast.show('Enter a non-zero number for the buffer distance', 'warn');
      return;
    }
    const ids = this.selectedFeatures().map((feature) => feature.id);
    this.report('Buffer', ids.length, this.draw.features.buffer(ids, { distanceMeters }));
  }

  /** Reports the result of an operation */
  private report(label: string, inputCount: number, result: object | object[] | null): void {
    const results = result === null ? [] : Array.isArray(result) ? result : [result];
    if (results.length === 0) {
      this.toast.show(`${label}: the result was empty, so nothing was changed`, 'warn');
      return;
    }
    this.toast.show(`${label}: created ${results.length} feature(s) from ${inputCount}`);
  }

  /**
   * Subscribes to the draw events.
   */
  private subscribeEvents(): void {
    this.draw.on('selection.changed', () => {
      this.updateState();
    });

    this.draw.on('feature.deleted', () => {
      this.updateState();
    });
  }
}
