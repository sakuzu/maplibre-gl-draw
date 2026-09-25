// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Geometry Bar
 *
 * A geometry-operation toolbar overlaid on the map. It handles boolean operations
 * (merge / subtract / intersect) and buffering on the selected features.
 *
 * Results are reported by subscribing to draw.geometry.applied. When the operation itself
 * was not performed (fewer than two targets, for example) no event fires, so we block it in
 * advance by disabling the button.
 */

import type { MapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

import type { Toast } from './toast';

/** Polygon-like types that boolean operations can target */
const AREA_TYPES = new Set(['Polygon', 'MultiPolygon', 'Circle']);

/** Operation names shown in notifications */
const OPERATION_LABELS: Record<string, string> = {
  union: 'Merge',
  subtract: 'Subtract',
  intersect: 'Intersect',
  buffer: 'Buffer',
};

/**
 * Geometry operation toolbar
 */
export class GeometryBar {
  private draw: MapLibreGLDraw;
  private toast: Toast;
  private unionBtn: HTMLButtonElement;
  private subtractBtn: HTMLButtonElement;
  private intersectBtn: HTMLButtonElement;
  private bufferBtn: HTMLButtonElement;
  private bufferInput: HTMLInputElement;
  private statusEl: HTMLElement | null;

  constructor(root: HTMLElement, draw: MapLibreGLDraw, toast: Toast) {
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
    const selection = this.draw.getSelection();
    const features = selection.type === 'feature' ? this.draw.getSelectedFeatures() : [];
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

  /**
   * Sets up the event listeners.
   */
  private attachEventListeners(): void {
    this.unionBtn.addEventListener('click', () => {
      this.draw.geometry.union();
    });

    this.subtractBtn.addEventListener('click', () => {
      this.draw.geometry.subtract();
    });

    this.intersectBtn.addEventListener('click', () => {
      this.draw.geometry.intersect();
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
    this.draw.geometry.buffer({ distanceMeters });
  }

  /**
   * Subscribes to the draw events.
   */
  private subscribeEvents(): void {
    this.draw.on('draw.selection.change', () => {
      this.updateState();
    });

    this.draw.on('draw.feature.delete', () => {
      this.updateState();
    });

    this.draw.on('draw.geometry.applied', ({ operation, status, inputIds, resultIds }) => {
      const label = OPERATION_LABELS[operation] ?? operation;
      if (status === 'empty') {
        this.toast.show(`${label}: the result was empty, so nothing was changed`, 'warn');
        return;
      }
      this.toast.show(`${label}: created ${resultIds.length} feature(s) from ${inputIds.length}`);
    });
  }
}
