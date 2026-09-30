// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GIS Panel
 *
 * The contents of the GIS tab of the right panel. It gathers the features that do not depend
 * on the feature selection: snapping, topology, entering points by coordinates and
 * large-volume display.
 *
 * Large-volume display only stacks the demo data as an underlay; managing it afterwards
 * (toggling visibility, removing it) belongs to the Underlays section of the Layers panel.
 *
 * PropertyPanel is rebuilt with innerHTML, so this panel keeps a single DOM node of its own
 * and has it re-inserted on every re-render. The values of the input fields and the event
 * listeners survive along with the node.
 */

import type { Draw } from '@sakuzu/maplibre-gl-draw';
import type * as maplibregl from 'maplibre-gl';

import { DEMO_DATASET_ID, DEMO_DATASET_NAME, DEMO_GRID, SNAP_TOLERANCE_PX } from '../constants';
import { createGridFeatures, DEMO_GRID_BASE_STYLE, DEMO_GRID_STYLE_RULE } from './demo-data';
import type { Toast } from './toast';
import type { UnderlayRegistry } from './underlay';

/** Labels for the kinds of snap target */
const SNAP_TARGET_LABELS: Record<string, string> = {
  vertex: 'vertex',
  edge: 'edge',
  intersection: 'intersection',
  guide: 'guide',
};

/** Labels for the modes */
const MODE_LABELS: Record<string, string> = {
  draw_point: 'Point',
  draw_line: 'Line',
  draw_polygon: 'Polygon',
  draw_circle: 'Circle',
  draw_freehand: 'Freehand',
  draw_image: 'Image',
};

/** Total number of grid cells */
const GRID_COUNT = DEMO_GRID.cols * DEMO_GRID.rows;

/**
 * Panel of the GIS tab
 */
export class GisPanel {
  private draw: Draw;
  private map: maplibregl.Map;
  private toast: Toast;
  private underlays: UnderlayRegistry;
  private element: HTMLElement;

  constructor(draw: Draw, map: maplibregl.Map, toast: Toast, underlays: UnderlayRegistry) {
    this.draw = draw;
    this.map = map;
    this.toast = toast;
    this.underlays = underlays;

    this.element = document.createElement('div');
    this.element.className = 'gis-tab';
    this.element.innerHTML = this.renderHtml();

    this.attachEventListeners();
    this.subscribeEvents();
    this.syncSnapSection();
    this.syncTopologySection();
    this.syncInputSection();
  }

  /**
   * The DOM node inserted into the tab.
   */
  getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Markup
   */
  private renderHtml(): string {
    return `
      <section class="gis-section">
        <h3 class="gis-section-title">Snapping</h3>
        <label class="gis-check">
          <input type="checkbox" id="gis-snap-enabled">
          <span>Enable snapping</span>
        </label>
        <div class="gis-row">
          <span class="gis-row-label">Tolerance</span>
          <span class="gis-row-value">${SNAP_TOLERANCE_PX} px</span>
        </div>
        <div class="gis-row">
          <span class="gis-row-label">Snap target</span>
          <span class="gis-row-value" id="gis-snap-status">—</span>
        </div>
        <p class="gis-hint">
          Holding Alt disables it temporarily. The marker for the snap target is shown on the map.
        </p>
      </section>

      <section class="gis-section">
        <h3 class="gis-section-title">Topology</h3>
        <label class="gis-check">
          <input type="checkbox" id="gis-shared-vertex">
          <span>Move shared vertices together</span>
        </label>
        <p class="gis-hint">
          Moves vertices that adjacent features share at the same coordinates, all at once in a
          single drag.
        </p>
      </section>

      <section class="gis-section">
        <h3 class="gis-section-title">Enter coordinates</h3>
        <div class="gis-field-row">
          <label class="gis-field">
            <span class="gis-field-label">Longitude</span>
            <input type="number" class="gis-input" id="gis-input-lng" step="0.0005">
          </label>
          <label class="gis-field">
            <span class="gis-field-label">Latitude</span>
            <input type="number" class="gis-input" id="gis-input-lat" step="0.0005">
          </label>
        </div>
        <div class="gis-btn-row">
          <button type="button" class="gis-btn" id="gis-input-add">Add point</button>
          <button type="button" class="gis-btn" id="gis-input-commit">Finish</button>
          <button type="button" class="gis-btn" id="gis-input-cancel">Cancel</button>
        </div>
        <p class="gis-hint" id="gis-input-hint"></p>
      </section>

      <section class="gis-section">
        <h3 class="gis-section-title">Large-volume display</h3>
        <button type="button" class="gis-btn gis-btn-block" id="gis-display-add">
          Add the demo data
        </button>
        <p class="gis-hint">
          Stacks ${GRID_COUNT.toLocaleString()} grid polygons at the very back of the map as
          an underlay (display only). They are colored by a graduated rule, and clicking one
          shows its attributes. Toggling their visibility and removing them afterwards is
          done in Underlays of the Layers panel.
        </p>
      </section>
    `;
  }

  /**
   * A small helper that gets an element.
   */
  private query<T extends HTMLElement>(selector: string): T {
    return this.element.querySelector(selector) as T;
  }

  /**
   * Sets up the event listeners.
   */
  private attachEventListeners(): void {
    this.query<HTMLInputElement>('#gis-snap-enabled').addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      this.draw.options.update({ snapping: { enabled } });
      this.syncSnapSection();
    });

    this.query<HTMLInputElement>('#gis-shared-vertex').addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      this.draw.options.update({ topology: { sharedVertexDrag: enabled } });
      this.toast.show(
        enabled
          ? 'Enabled moving shared vertices together'
          : 'Disabled moving shared vertices together',
      );
    });

    this.query<HTMLButtonElement>('#gis-input-add').addEventListener('click', () => {
      this.clickAtCoordinates();
    });

    this.query<HTMLButtonElement>('#gis-input-commit').addEventListener('click', () => {
      this.pressKey('Enter');
    });

    this.query<HTMLButtonElement>('#gis-input-cancel').addEventListener('click', () => {
      this.pressKey('Escape');
    });

    for (const id of ['#gis-input-lng', '#gis-input-lat']) {
      this.query<HTMLInputElement>(id).addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key !== 'Enter') return;
        e.preventDefault();
        this.pressKey('Enter');
      });
    }

    this.query<HTMLButtonElement>('#gis-display-add').addEventListener('click', () => {
      this.addDemoUnderlay();
    });
  }

  /**
   * Subscribes to the draw events.
   */
  private subscribeEvents(): void {
    this.draw.on('snap.changed', ({ result }) => {
      const status = this.query<HTMLElement>('#gis-snap-status');
      const kind = result?.target?.kind;
      status.textContent = kind ? `Snapping to ${SNAP_TARGET_LABELS[kind] ?? kind}` : '—';
    });

    this.draw.on('mode.changed', () => {
      this.syncInputSection();
    });
  }

  /**
   * Puts down one point at the coordinates of the fields.
   *
   * The library takes its input from the map, so the page clicks the map where the
   * coordinates are: a move and a click on the canvas at the projected position, as a mouse
   * would make them. Snapping applies as it does to a real click.
   */
  private clickAtCoordinates(): void {
    const lng = Number.parseFloat(this.query<HTMLInputElement>('#gis-input-lng').value);
    const lat = Number.parseFloat(this.query<HTMLInputElement>('#gis-input-lat').value);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      this.toast.show('Enter numbers for the longitude and the latitude', 'warn');
      return;
    }
    const canvas = this.map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const { x, y } = this.map.project([lng, lat]);
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + x,
      clientY: rect.top + y,
      button: 0,
    };
    canvas.dispatchEvent(new MouseEvent('mousemove', init));
    canvas.dispatchEvent(new MouseEvent('click', init));
  }

  /**
   * Presses a key on the map, as the keyboard would while the map has the focus.
   */
  private pressKey(key: string): void {
    this.map
      .getCanvas()
      .dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }));
  }

  /**
   * Syncs the display of the snapping section.
   */
  private syncSnapSection(): void {
    this.query<HTMLInputElement>('#gis-snap-enabled').checked =
      this.draw.options.get().snapping?.enabled !== false;
  }

  /**
   * Syncs the display of the topology section.
   */
  private syncTopologySection(): void {
    this.query<HTMLInputElement>('#gis-shared-vertex').checked =
      this.draw.options.get().topology?.sharedVertexDrag === true;
  }

  /**
   * Syncs the enabled state of the section that enters points by coordinates.
   */
  private syncInputSection(): void {
    const mode = this.draw.getMode();
    const drawing = mode.startsWith('draw_');

    const lngInput = this.query<HTMLInputElement>('#gis-input-lng');
    const latInput = this.query<HTMLInputElement>('#gis-input-lat');

    for (const el of [lngInput, latInput]) {
      el.disabled = !drawing;
    }
    for (const id of ['#gis-input-add', '#gis-input-commit', '#gis-input-cancel']) {
      this.query<HTMLButtonElement>(id).disabled = !drawing;
    }

    if (drawing && (lngInput.value === '' || latInput.value === '')) {
      const center = this.map.getCenter();
      lngInput.value = center.lng.toFixed(5);
      latInput.value = center.lat.toFixed(5);
    }

    const hint = this.query<HTMLElement>('#gis-input-hint');
    hint.textContent = drawing
      ? `Drawing a ${MODE_LABELS[mode] ?? mode}. Use "Add point" to put down one point, ` +
        'and "Finish" to end the drawing.'
      : 'Only available while a drawing mode is active. Choose one in the toolbar on the left.';
  }

  /**
   * Stacks the demo data as an underlay.
   *
   * Does nothing when it is already stacked (removing it belongs to the Layers panel).
   */
  private addDemoUnderlay(): void {
    if (this.underlays.has(DEMO_DATASET_ID)) {
      this.toast.show(
        'The demo data is already stacked. You can work with it in Underlays of the Layers panel',
      );
      return;
    }

    const center = this.map.getCenter();
    const started = performance.now();

    this.underlays.add({
      id: DEMO_DATASET_ID,
      name: DEMO_DATASET_NAME,
      features: createGridFeatures(center.lng, center.lat),
      styleRule: DEMO_GRID_STYLE_RULE,
      baseStyle: DEMO_GRID_BASE_STYLE,
    });

    const elapsed = Math.round(performance.now() - started);
    this.toast.show(`Stacked ${GRID_COUNT.toLocaleString()} demo features (${elapsed}ms)`);
  }
}
