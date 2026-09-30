// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Property Panel
 *
 * A panel for editing the properties of the selected feature, group or layer
 */

import {
  type Draw,
  type Feature as DrawFeature,
  type Group as DrawGroup,
  type Layer as DrawLayer,
  deriveLegend,
  type FeatureStyle,
} from '@sakuzu/maplibre-gl-draw';

import {
  BASEMAP_OPTIONS,
  DEFAULT_BASEMAP,
  DEFAULT_STYLES,
  DRAWING_PALETTE,
  LINE_STYLE_OPTIONS,
  STYLE_RULE_KIND_OPTIONS,
  STYLE_RULE_PALETTES,
} from '../constants';
import type { StyleRuleDraft, StyleRuleKind } from '../gis/style-rule';
import { buildStyleRule, toStyleRuleDraft } from '../gis/style-rule';

// Selection type
type SelectionType = 'layer' | 'group' | 'feature' | null;

// Tab type
type TabType = 'map' | 'feature' | 'gis';

/**
 * Options for PropertyPanel
 */
export interface PropertyPanelOptions {
  /** DOM node inserted into the GIS tab (when omitted, the GIS tab is not shown) */
  gisTabElement?: HTMLElement;
  /** Notification of the result of an operation */
  notify?: (message: string, kind?: 'info' | 'warn') => void;
}

/**
 * PropertyPanel class
 */
export class PropertyPanel {
  private container: HTMLElement;
  private draw: Draw;
  private activeTab: TabType = 'map';
  private selectionType: SelectionType = null;
  private selectedLayerId: string | null = null;
  private selectedGroupId: string | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isSliderDragging = false;
  private isTextEditing = false;
  private currentBasemap: string = DEFAULT_BASEMAP;
  /** Whether an import is treated as an underlay (a dataset) */
  private importAsUnderlay = false;
  private gisTabElement: HTMLElement | null;
  private notify: (message: string, kind?: 'info' | 'warn') => void;
  private styleRuleDraft: StyleRuleDraft = {
    kind: 'none',
    property: '',
    palette: STYLE_RULE_PALETTES[0].value,
  };

  constructor(container: HTMLElement, draw: Draw, options: PropertyPanelOptions = {}) {
    this.container = container;
    this.draw = draw;
    this.gisTabElement = options.gisTabElement ?? null;
    this.notify = options.notify ?? (() => {});

    // Initial render
    this.render();

    // Subscribe to events
    this.subscribeEvents();
  }

  /**
   * Clean up
   */
  destroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }

  /**
   * Re-render (called from the outside, for example after an import)
   */
  refresh(): void {
    this.render();
  }

  /**
   * Subscribe to events
   */
  private subscribeEvents(): void {
    this.draw.on('selection.changed', ({ selection }) => {
      // Handle only the case of a feature selection
      if (selection.type === 'feature') {
        this.onFeatureSelectionChange([...selection.ids]);
      } else {
        // A selection of any other type is treated as an empty array
        this.onFeatureSelectionChange([]);
      }
    });

    this.draw.on('feature.updated', () => {
      // Do not re-render while a slider is being dragged or text is being edited
      if (this.selectionType === 'feature' && !this.isSliderDragging && !this.isTextEditing) {
        this.render();
      }
    });

    this.draw.on('layer.updated', () => {
      if (this.selectionType === 'layer' && !this.isSliderDragging && !this.isTextEditing) {
        this.render();
      }
    });

    this.draw.on('group.updated', () => {
      if (this.selectionType === 'group' && !this.isSliderDragging && !this.isTextEditing) {
        this.render();
      }
    });

    // Re-render when the metadata changes (remote sync and the like)
    this.draw.on('metadata.updated', () => {
      if (this.activeTab === 'map' && !this.isTextEditing) {
        this.render();
      }
    });
  }

  /**
   * Handler for a change of the feature selection
   */
  onFeatureSelectionChange(selectedIds: string[]): void {
    if (selectedIds.length > 0) {
      this.selectionType = 'feature';
      this.selectedLayerId = null;
      this.selectedGroupId = null;
      // While the GIS tab is open, a selection does not switch the tab
      if (this.activeTab !== 'gis') {
        this.activeTab = 'feature';
      }
    } else if (!this.selectedLayerId && !this.selectedGroupId) {
      this.selectionType = null;
    }
    this.render();
  }

  /**
   * Handler for a layer being selected
   */
  onLayerSelected(id: string): void {
    this.selectionType = 'layer';
    this.selectedLayerId = id;
    this.selectedGroupId = null;
    this.activeTab = 'feature';

    // Reflect the rule of the selected layer in the style rule UI
    const layer = this.draw.layers.get(id);
    this.styleRuleDraft = toStyleRuleDraft(layer?.styleRule, this.styleRuleDraft.palette);

    this.render();
  }

  /**
   * Handler for a group being selected
   */
  onGroupSelected(id: string): void {
    this.selectionType = 'group';
    this.selectedLayerId = null;
    this.selectedGroupId = id;
    this.activeTab = 'feature';
    this.render();
  }

  /**
   * Set the basemap (used when importing)
   */
  setBasemap(basemap: string): void {
    this.currentBasemap = basemap;
    if (this.activeTab === 'map') {
      this.render();
    }
  }

  /**
   * Get the current basemap
   */
  getBasemap(): string {
    return this.currentBasemap;
  }

  /**
   * Whether an import is treated as an underlay (a dataset)
   *
   * The import handling (main.ts) reads this on every drop and file selection.
   */
  isImportAsUnderlay(): boolean {
    return this.importAsUnderlay;
  }

  /**
   * Render
   */
  private render(): void {
    // Save the scroll position
    const tabContent = this.container.querySelector('.tab-content');
    const scrollTop = tabContent?.scrollTop ?? 0;

    const tabHeaderHtml = this.renderTabHeader();
    const tabContentHtml = this.renderTabContent();

    // The GIS tab has many items, so make it a little taller
    const panelClass =
      this.activeTab === 'gis' ? 'property-panel property-panel-tall' : 'property-panel';

    this.container.innerHTML = `
      <div class="${panelClass}">
        ${tabHeaderHtml}
        <div class="tab-content">
          ${tabContentHtml}
        </div>
      </div>
    `;

    this.attachEventListeners();

    // The contents of the GIS tab are a DOM node of its own, so they are inserted
    // after the listeners have been attached.
    // That way they are not picked up by PropertyPanel's selectors and the values
    // in the input fields survive.
    if (this.activeTab === 'gis' && this.gisTabElement) {
      this.container.querySelector('.gis-tab-host')?.appendChild(this.gisTabElement);
    }

    // Restore the scroll position
    const newTabContent = this.container.querySelector('.tab-content');
    if (newTabContent && scrollTop > 0) {
      newTabContent.scrollTop = scrollTop;
    }
  }

  /**
   * Render the contents of the tab
   */
  private renderTabContent(): string {
    switch (this.activeTab) {
      case 'map':
        return this.renderMapTab();
      case 'gis':
        return '<div class="gis-tab-host"></div>';
      default:
        return this.renderFeatureTab();
    }
  }

  /**
   * Render the tab header
   */
  private renderTabHeader(): string {
    const gisTab = this.gisTabElement
      ? `<button class="tab-btn ${this.activeTab === 'gis' ? 'active' : ''}" data-tab="gis">GIS</button>`
      : '';

    return `
      <div class="tab-header">
        <button class="tab-btn ${this.activeTab === 'map' ? 'active' : ''}" data-tab="map">Map</button>
        <button class="tab-btn ${this.activeTab === 'feature' ? 'active' : ''}" data-tab="feature">Feature</button>
        ${gisTab}
      </div>
    `;
  }

  /**
   * Render the map tab
   */
  private renderMapTab(): string {
    const metadata = this.draw.metadata.get();
    const currentBasemap = metadata.basemap || this.currentBasemap;

    const basemapOptions = BASEMAP_OPTIONS.map(
      (opt) =>
        `<option value="${opt.value}" ${opt.value === currentBasemap ? 'selected' : ''}>${opt.label}</option>`,
    ).join('');

    return `
      <div class="map-tab">
        <div class="editor-section">
          <label class="editor-label">Title</label>
          <input type="text" class="editor-input" data-map-prop="title"
            value="${this.escapeHtml(metadata.title || '')}" placeholder="Enter a title">
        </div>
        <div class="editor-section">
          <label class="editor-label">Description</label>
          <textarea class="editor-textarea" data-map-prop="description"
            placeholder="Enter a description">${this.escapeHtml(metadata.description || '')}</textarea>
        </div>
        <div class="editor-section">
          <label class="editor-label">Basemap</label>
          <select class="basemap-selector" data-map-prop="basemap">
            ${basemapOptions}
          </select>
        </div>
        <div class="editor-section">
          <label class="editor-label">Import</label>
          <label class="gis-check import-check">
            <input type="checkbox" id="import-as-underlay"
              ${this.importAsUnderlay ? 'checked' : ''}>
            <span>Load as a dataset (an underlay)</span>
          </label>
          <div class="drop-zone" id="drop-zone">
            <div>Drop a file here</div>
            <div>or click to choose one</div>
            <div class="drop-zone-hint">Supported formats: JSON, GeoJSON</div>
            <input type="file" class="file-input-hidden" accept=".json,.geojson" id="file-input">
          </div>
          <button type="button" class="sample-btn" data-action="load-sample">
            <span>+</span> Load the sample
          </button>
          <p class="gis-hint">
            Loads a donut (with a hole), exclaves (MultiPolygon), point groups
            (MultiPoint), routes (MultiLineString) and a set of polygons with
            attributes all at once. Loaded as an underlay they cannot be edited,
            but a large number of features can be stacked without adding to what
            is edited. Toggling visibility and removing are done in the
            "Underlays" section of the Layers panel.
          </p>
        </div>
        <div class="editor-section">
          <button type="button" class="export-btn" data-action="export">
            <span>↓</span> Export
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Render the feature tab
   */
  private renderFeatureTab(): string {
    if (this.selectionType === 'layer' && this.selectedLayerId) {
      return this.renderLayerEditor();
    }

    if (this.selectionType === 'group' && this.selectedGroupId) {
      return this.renderGroupEditor();
    }

    if (this.selectionType === 'feature') {
      const selectedIds = this.selectedIds();

      if (selectedIds.length === 0) {
        return this.renderNoSelection();
      }

      if (selectedIds.length === 1) {
        const feature = this.draw.features.get(selectedIds[0]);
        if (feature) {
          return this.renderFeatureEditor(feature);
        }
      }

      return this.renderMultipleSelection(selectedIds.length);
    }

    return this.renderNoSelection();
  }

  /**
   * The display when nothing is selected
   */
  private renderNoSelection(): string {
    return `
      <div class="no-selection">
        <p>No feature is selected</p>
      </div>
    `;
  }

  /**
   * The display when several items are selected
   */
  private renderMultipleSelection(count: number): string {
    return `
      <div class="multiple-selection">
        <p>${count} features are selected</p>
      </div>
    `;
  }

  /**
   * Render the layer editor
   */
  private renderLayerEditor(): string {
    const layer = this.draw.layers.get(this.selectedLayerId!) as DrawLayer;
    if (!layer) return this.renderNoSelection();

    return `
      <div class="layer-editor editor-stack">
        <div class="editor-section">
          <label class="editor-label">Layer name</label>
          <input type="text" class="editor-input" id="layer-name" value="${this.escapeHtml(layer.name)}">
        </div>
        <div class="editor-section">
          <label class="editor-label">Opacity</label>
          <div class="slider-container">
            <input type="range" class="editor-slider" id="layer-opacity"
                   min="0" max="100" value="${Math.round(layer.opacity * 100)}">
            <span class="slider-value">${Math.round(layer.opacity * 100)}%</span>
          </div>
        </div>
        ${this.renderStyleRuleEditor(layer)}
      </div>
    `;
  }

  /**
   * Render the style rule editor
   */
  private renderStyleRuleEditor(layer: DrawLayer): string {
    const draft = this.styleRuleDraft;
    const needsProperty = draft.kind !== 'none' && draft.kind !== 'single';
    const needsPalette = draft.kind !== 'none' && draft.kind !== 'categorical';

    const kindOptions = STYLE_RULE_KIND_OPTIONS.map(
      (opt) =>
        `<option value="${opt.value}" ${opt.value === draft.kind ? 'selected' : ''}>${opt.label}</option>`,
    ).join('');

    const paletteOptions = STYLE_RULE_PALETTES.map(
      (opt) =>
        `<option value="${opt.value}" ${opt.value === draft.palette ? 'selected' : ''}>${opt.label}</option>`,
    ).join('');

    const propertySection = needsProperty
      ? `
        <div class="editor-section">
          <label class="editor-label" for="style-rule-property">Property name</label>
          <input type="text" class="gis-input" id="style-rule-property"
                 value="${this.escapeHtml(draft.property)}" placeholder="e.g. population">
        </div>
      `
      : '';

    const paletteSection = needsPalette
      ? `
        <div class="editor-section">
          <label class="editor-label" for="style-rule-palette">Color scheme</label>
          <select class="gis-select" id="style-rule-palette">${paletteOptions}</select>
        </div>
      `
      : '';

    return `
      <div class="editor-section">
        <label class="editor-label" for="style-rule-kind">Style rule</label>
        <select class="gis-select" id="style-rule-kind">${kindOptions}</select>
      </div>
      ${propertySection}
      ${paletteSection}
      <div class="gis-btn-row">
        <button type="button" class="gis-btn" data-action="apply-style-rule">Apply</button>
        <button type="button" class="gis-btn" data-action="clear-style-rule">Clear</button>
      </div>
      <p class="gis-hint">
        Attribute values are aggregated automatically from the features in the layer
        (Categorical uses at most 8 entries, and Graduated builds its breaks by quantiles).
      </p>
      ${this.renderLegend(layer)}
    `;
  }

  /**
   * Render the legend
   */
  private renderLegend(layer: DrawLayer): string {
    if (!layer.styleRule) {
      return '<p class="gis-hint">This layer currently has no rule.</p>';
    }

    const entries = deriveLegend(layer.styleRule)
      .map(
        (entry) => `
        <div class="legend-item">
          <span class="legend-swatch" style="background-color: ${entry.color}"></span>
          <span class="legend-label">${this.escapeHtml(entry.label)}</span>
        </div>
      `,
      )
      .join('');

    return `
      <div class="editor-section">
        <label class="editor-label">Legend</label>
        <div class="style-rule-legend">${entries}</div>
      </div>
    `;
  }

  /**
   * Apply the style rule
   */
  private applyStyleRule(): void {
    const layerId = this.selectedLayerId;
    if (!layerId) return;

    if (this.styleRuleDraft.kind === 'none') {
      this.clearStyleRule();
      return;
    }

    const values = this.draw.features
      .list({ layerId })
      .map((feature) => feature.properties?.[this.styleRuleDraft.property.trim()]);

    const result = buildStyleRule(this.styleRuleDraft, values);
    if ('error' in result) {
      this.notify(result.error, 'warn');
      return;
    }

    this.draw.layers.update(layerId, { styleRule: result.rule });
    this.notify('Applied the style rule');
  }

  /**
   * Clear the style rule
   */
  private clearStyleRule(): void {
    const layerId = this.selectedLayerId;
    if (!layerId) return;

    this.styleRuleDraft = { ...this.styleRuleDraft, kind: 'none' };
    this.draw.layers.update(layerId, { styleRule: undefined });
    this.notify('Cleared the style rule');
    this.render();
  }

  /**
   * Render the group editor
   */
  private renderGroupEditor(): string {
    const group = this.draw.groups.get(this.selectedGroupId!) as DrawGroup;
    if (!group) return this.renderNoSelection();

    return `
      <div class="group-editor editor-stack">
        <div class="editor-section">
          <label class="editor-label">Group name</label>
          <input type="text" class="editor-input" id="group-name" value="${this.escapeHtml(group.name)}">
        </div>
      </div>
    `;
  }

  /**
   * Render the feature editor
   */
  private renderFeatureEditor(feature: DrawFeature): string {
    const name = (feature.properties?.name as string) || '';
    const description = (feature.properties?.description as string) || '';

    const commonSection = `
      <div class="editor-section">
        <label class="editor-label">Name</label>
        <input type="text" class="editor-input" id="feature-name" value="${this.escapeHtml(name)}">
      </div>
      <div class="editor-section">
        <label class="editor-label">Description</label>
        <textarea class="editor-textarea" id="feature-description">${this.escapeHtml(description)}</textarea>
      </div>
    `;

    let styleSection = '';

    switch (feature.type) {
      case 'Point':
        styleSection = this.renderPointStyleEditor(feature);
        break;
      case 'LineString':
        styleSection = this.renderLineStyleEditor(feature);
        break;
      case 'Polygon':
        styleSection = this.renderPolygonStyleEditor(feature);
        break;
      case 'Image':
        styleSection = this.renderImageStyleEditor(feature);
        break;
      case 'Circle':
        styleSection = this.renderCircleStyleEditor(feature);
        break;
      case 'Freehand':
        styleSection = this.renderFreehandStyleEditor(feature);
        break;
    }

    return `
      <div class="feature-editor editor-stack">
        ${commonSection}
        ${styleSection}
      </div>
    `;
  }

  /**
   * Point style editor
   */
  private renderPointStyleEditor(feature: DrawFeature): string {
    const style = (feature.style || {}) as FeatureStyle;
    const pointColor = style.pointColor || DEFAULT_STYLES.strokeColor;
    const pointRadius = style.pointRadius ?? 6; // Default radius of 6px

    return `
      ${this.renderColorPalette('point-color', 'Color', pointColor)}
      ${this.renderSlider('point-radius', 'Size', pointRadius, 3, 20, 'px')}
    `;
  }

  /**
   * Line style editor
   */
  private renderLineStyleEditor(feature: DrawFeature): string {
    const style = (feature.style || {}) as FeatureStyle;
    const strokeColor = style.strokeColor || DEFAULT_STYLES.strokeColor;
    const strokeOpacity = style.strokeOpacity ?? DEFAULT_STYLES.strokeOpacity;
    const strokeWidth = style.strokeWidth ?? DEFAULT_STYLES.strokeWidth;
    const lineStyle = (style as { lineStyle?: string }).lineStyle || DEFAULT_STYLES.lineStyle;

    return `
      ${this.renderColorPalette('stroke-color', 'Color', strokeColor)}
      ${this.renderSlider('stroke-opacity', 'Opacity', strokeOpacity * 100, 0, 100, '%')}
      ${this.renderSlider('stroke-width', 'Line width', strokeWidth, 1, 10, 'px')}
      ${this.renderSelect('line-style', 'Line style', lineStyle, LINE_STYLE_OPTIONS)}
    `;
  }

  /**
   * Polygon style editor
   */
  private renderPolygonStyleEditor(feature: DrawFeature): string {
    const style = (feature.style || {}) as FeatureStyle;
    const strokeColor = style.strokeColor || DEFAULT_STYLES.strokeColor;
    const strokeOpacity = style.strokeOpacity ?? DEFAULT_STYLES.strokeOpacity;
    const strokeWidth = style.strokeWidth ?? DEFAULT_STYLES.strokeWidth;
    const lineStyle = (style as { lineStyle?: string }).lineStyle || DEFAULT_STYLES.lineStyle;
    const fillColor = style.fillColor || DEFAULT_STYLES.fillColor;
    const fillOpacity = style.fillOpacity ?? DEFAULT_STYLES.fillOpacity;

    return `
      ${this.renderColorPalette('stroke-color', 'Line color', strokeColor)}
      ${this.renderSlider('stroke-opacity', 'Line opacity', strokeOpacity * 100, 0, 100, '%')}
      ${this.renderSlider('stroke-width', 'Line width', strokeWidth, 1, 10, 'px')}
      ${this.renderSelect('line-style', 'Line style', lineStyle, LINE_STYLE_OPTIONS)}
      ${this.renderColorPalette('fill-color', 'Fill color', fillColor)}
      ${this.renderSlider('fill-opacity', 'Fill opacity', fillOpacity * 100, 0, 100, '%')}
    `;
  }

  /**
   * Image style editor
   */
  private renderImageStyleEditor(feature: DrawFeature): string {
    const style = (feature.style || {}) as FeatureStyle;
    const imageOpacity = style.imageOpacity ?? DEFAULT_STYLES.imageOpacity;

    return `
      ${this.renderSlider('image-opacity', 'Image opacity', imageOpacity * 100, 0, 100, '%')}
    `;
  }

  /**
   * Circle style editor
   */
  private renderCircleStyleEditor(feature: DrawFeature): string {
    const style = (feature.style || {}) as FeatureStyle;
    const strokeColor = style.strokeColor || DEFAULT_STYLES.strokeColor;
    const strokeOpacity = style.strokeOpacity ?? DEFAULT_STYLES.strokeOpacity;
    const strokeWidth = style.strokeWidth ?? DEFAULT_STYLES.strokeWidth;
    const lineStyle = (style as { lineStyle?: string }).lineStyle || DEFAULT_STYLES.lineStyle;
    const fillColor = style.fillColor || DEFAULT_STYLES.fillColor;
    const fillOpacity = style.fillOpacity ?? DEFAULT_STYLES.fillOpacity;

    // Radius (in meters)
    const radiusMeters = (feature.properties?.['maplibre-gl-draw:radiusMeters'] as number) ?? 100;

    return `
      <div class="editor-section">
        <label class="editor-label">Radius</label>
        <div class="slider-container">
          <input type="number" class="editor-input" id="circle-radius"
                 value="${Math.round(radiusMeters)}" min="1" step="1">
          <span class="slider-value">m</span>
        </div>
      </div>
      ${this.renderColorPalette('stroke-color', 'Line color', strokeColor)}
      ${this.renderSlider('stroke-opacity', 'Line opacity', strokeOpacity * 100, 0, 100, '%')}
      ${this.renderSlider('stroke-width', 'Line width', strokeWidth, 1, 10, 'px')}
      ${this.renderSelect('line-style', 'Line style', lineStyle, LINE_STYLE_OPTIONS)}
      ${this.renderColorPalette('fill-color', 'Fill color', fillColor)}
      ${this.renderSlider('fill-opacity', 'Fill opacity', fillOpacity * 100, 0, 100, '%')}
    `;
  }

  /**
   * Freehand style editor
   */
  private renderFreehandStyleEditor(feature: DrawFeature): string {
    const style = (feature.style || {}) as FeatureStyle;
    // Same default color as LineString
    const strokeColor = style.strokeColor || DEFAULT_STYLES.strokeColor;
    const strokeOpacity = style.strokeOpacity ?? DEFAULT_STYLES.strokeOpacity;
    const strokeWidth = style.strokeWidth ?? 3; // The default for Freehand is 3px
    const lineStyle = (style as { lineStyle?: string }).lineStyle || DEFAULT_STYLES.lineStyle;

    return `
      ${this.renderColorPalette('stroke-color', 'Color', strokeColor)}
      ${this.renderSlider('stroke-opacity', 'Opacity', strokeOpacity * 100, 0, 100, '%')}
      ${this.renderSlider('stroke-width', 'Line width', strokeWidth, 1, 10, 'px')}
      ${this.renderSelect('line-style', 'Line style', lineStyle, LINE_STYLE_OPTIONS)}
    `;
  }

  /**
   * Render the color palette
   */
  private renderColorPalette(id: string, label: string, currentColor: string): string {
    const colors = DRAWING_PALETTE.map(
      (color) => `
      <button class="color-swatch ${color === currentColor ? 'active' : ''}"
              data-color="${color}"
              data-target="${id}"
              style="background-color: ${color}">
      </button>
    `,
    ).join('');

    return `
      <div class="editor-section">
        <label class="editor-label">${label}</label>
        <div class="color-palette">${colors}</div>
      </div>
    `;
  }

  /**
   * Render the slider
   */
  private renderSlider(
    id: string,
    label: string,
    value: number,
    min: number,
    max: number,
    unit: string,
  ): string {
    return `
      <div class="editor-section">
        <label class="editor-label">${label}</label>
        <div class="slider-container">
          <input type="range" class="editor-slider" id="${id}"
                 min="${min}" max="${max}" value="${Math.round(value)}">
          <span class="slider-value">${Math.round(value)}${unit}</span>
        </div>
      </div>
    `;
  }

  /**
   * Render the select
   */
  private renderSelect(
    id: string,
    label: string,
    currentValue: string,
    options: ReadonlyArray<{ value: string; label: string }>,
  ): string {
    const optionsHtml = options
      .map(
        (opt) =>
          `<option value="${opt.value}" ${opt.value === currentValue ? 'selected' : ''}>${opt.label}</option>`,
      )
      .join('');

    return `
      <div class="editor-section">
        <label class="editor-label">${label}</label>
        <select class="editor-select" id="${id}">${optionsHtml}</select>
      </div>
    `;
  }

  /**
   * Escape HTML
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Attach the event listeners
   */
  private attachEventListeners(): void {
    // Tab switching
    this.container.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = (btn as HTMLElement).dataset.tab as TabType;
        if (tab) {
          this.activeTab = tab;
          this.render();
        }
      });
    });

    // Destination of an import (Store / underlay)
    const underlayCheck = this.container.querySelector('#import-as-underlay');
    underlayCheck?.addEventListener('change', (e) => {
      this.importAsUnderlay = (e.target as HTMLInputElement).checked;
    });

    // Color palette
    this.container.querySelectorAll('.color-swatch').forEach((swatch) => {
      swatch.addEventListener('click', () => {
        const el = swatch as HTMLElement;
        const color = el.dataset.color;
        const target = el.dataset.target;
        if (color && target) {
          this.handleColorChange(target, color);
        }
      });
    });

    // Sliders
    this.container.querySelectorAll('.editor-slider').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        this.isSliderDragging = true;
        const el = e.target as HTMLInputElement;
        const valueSpan = el.parentElement?.querySelector('.slider-value');
        if (valueSpan) {
          const unit = valueSpan.textContent?.match(/[^0-9]+$/)?.[0] || '';
          valueSpan.textContent = `${el.value}${unit}`;
        }
        this.handleSliderInput(el.id, parseInt(el.value, 10));
      });

      slider.addEventListener('change', (e) => {
        this.isSliderDragging = false;
        const el = e.target as HTMLInputElement;
        this.handleSliderChange(el.id, parseInt(el.value, 10));
      });
    });

    // Text inputs
    this.container.querySelectorAll('.editor-input, .editor-textarea').forEach((input) => {
      input.addEventListener('focus', () => {
        this.isTextEditing = true;
      });

      input.addEventListener('blur', () => {
        this.isTextEditing = false;
      });

      input.addEventListener('input', (e) => {
        const el = e.target as HTMLInputElement | HTMLTextAreaElement;
        this.handleTextInputDebounced(el.id, el.value);
      });
    });

    // Selects
    this.container.querySelectorAll('.editor-select').forEach((select) => {
      select.addEventListener('change', (e) => {
        const el = e.target as HTMLSelectElement;
        this.handleSelectChange(el.id, el.value);
      });
    });

    // Style rule (kind, property name, color scheme)
    const kindSelect = this.container.querySelector<HTMLSelectElement>('#style-rule-kind');
    kindSelect?.addEventListener('change', () => {
      this.styleRuleDraft = { ...this.styleRuleDraft, kind: kindSelect.value as StyleRuleKind };
      this.render();
    });

    const paletteSelect = this.container.querySelector<HTMLSelectElement>('#style-rule-palette');
    paletteSelect?.addEventListener('change', () => {
      this.styleRuleDraft = { ...this.styleRuleDraft, palette: paletteSelect.value };
    });

    const propertyInput = this.container.querySelector<HTMLInputElement>('#style-rule-property');
    propertyInput?.addEventListener('input', () => {
      this.styleRuleDraft = { ...this.styleRuleDraft, property: propertyInput.value };
    });

    this.container
      .querySelector<HTMLButtonElement>('[data-action="apply-style-rule"]')
      ?.addEventListener('click', () => {
        this.applyStyleRule();
      });

    this.container
      .querySelector<HTMLButtonElement>('[data-action="clear-style-rule"]')
      ?.addEventListener('click', () => {
        this.clearStyleRule();
      });

    // Map metadata inputs (elements that have the data-map-prop attribute)
    this.container.querySelectorAll('[data-map-prop]').forEach((el) => {
      const propName = (el as HTMLElement).dataset.mapProp;
      if (!propName) return;

      const handleChange = () => {
        const value = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
        this.draw.metadata.update({ [propName]: value });

        // Dispatch a custom event when the basemap changes
        if (propName === 'basemap') {
          this.currentBasemap = value;
          this.container.dispatchEvent(
            new CustomEvent('property-panel:basemap-change', {
              bubbles: true,
              detail: { basemap: value },
            }),
          );
        }
      };

      if (el.tagName === 'SELECT') {
        el.addEventListener('change', handleChange);
      } else {
        el.addEventListener('input', () => {
          if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
          }
          this.debounceTimer = setTimeout(handleChange, 300);
        });
      }
    });
  }

  /**
   * Color change handler
   */
  private handleColorChange(target: string, color: string): void {
    const selectedIds = this.selectedIds();
    if (selectedIds.length !== 1) return;

    const feature = this.draw.features.get(selectedIds[0]);
    if (!feature) return;

    const existingStyle = (feature.style || {}) as FeatureStyle;
    const style = { ...existingStyle } as FeatureStyle;

    switch (target) {
      case 'point-color':
        style.pointColor = color;
        break;
      case 'stroke-color':
        style.strokeColor = color;
        // When strokeOpacity is undefined, set the default value explicitly
        if (style.strokeOpacity === undefined) {
          style.strokeOpacity = DEFAULT_STYLES.strokeOpacity;
        }
        break;
      case 'fill-color':
        style.fillColor = color;
        // When fillOpacity is undefined, set the default value explicitly
        if (style.fillOpacity === undefined) {
          style.fillOpacity = DEFAULT_STYLES.fillOpacity;
        }
        break;
    }

    this.draw.features.update(selectedIds[0], { style });
  }

  /**
   * Slider input handler (while dragging)
   */
  private handleSliderInput(_id: string, _value: number): void {
    // While dragging, only the UI is updated; the API is not called
    // The actual update is done on the change event
  }

  /**
   * Slider change handler (drag finished)
   */
  private handleSliderChange(id: string, value: number): void {
    if (this.selectionType === 'layer' && this.selectedLayerId) {
      if (id === 'layer-opacity') {
        this.draw.layers.update(this.selectedLayerId, { opacity: value / 100 });
      }
      return;
    }

    const selectedIds = this.selectedIds();
    if (selectedIds.length !== 1) return;

    const feature = this.draw.features.get(selectedIds[0]);
    if (!feature) return;

    const style = { ...(feature.style || {}) } as FeatureStyle;

    switch (id) {
      case 'point-radius':
        style.pointRadius = value;
        break;
      case 'stroke-opacity':
        style.strokeOpacity = value / 100;
        break;
      case 'stroke-width':
        style.strokeWidth = value;
        break;
      case 'fill-opacity':
        style.fillOpacity = value / 100;
        break;
      case 'image-opacity':
        style.imageOpacity = value / 100;
        break;
    }

    this.draw.features.update(selectedIds[0], { style });
  }

  /**
   * Text input handler (debounced)
   */
  private handleTextInputDebounced(id: string, value: string): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.handleTextInput(id, value);
    }, 300);
  }

  /**
   * Text input handler
   */
  private handleTextInput(id: string, value: string): void {
    if (this.selectionType === 'layer' && this.selectedLayerId) {
      if (id === 'layer-name') {
        this.draw.layers.update(this.selectedLayerId, { name: value });
      }
      return;
    }

    if (this.selectionType === 'group' && this.selectedGroupId) {
      if (id === 'group-name') {
        this.draw.groups.update(this.selectedGroupId, { name: value });
      }
      return;
    }

    const selectedIds = this.selectedIds();
    if (selectedIds.length !== 1) return;

    const feature = this.draw.features.get(selectedIds[0]);
    if (!feature) return;

    switch (id) {
      case 'feature-name':
        this.draw.features.update(selectedIds[0], {
          properties: { ...feature.properties, name: value },
        });
        break;
      case 'feature-description':
        this.draw.features.update(selectedIds[0], {
          properties: { ...feature.properties, description: value },
        });
        break;
      case 'circle-radius': {
        const radiusMeters = parseFloat(value);
        if (!Number.isNaN(radiusMeters) && radiusMeters > 0) {
          this.draw.features.update(selectedIds[0], {
            properties: { ...feature.properties, 'maplibre-gl-draw:radiusMeters': radiusMeters },
          });
        }
        break;
      }
    }
  }

  /**
   * Select change handler
   */
  private handleSelectChange(id: string, value: string): void {
    const selectedIds = this.selectedIds();
    if (selectedIds.length !== 1) return;

    const feature = this.draw.features.get(selectedIds[0]);
    if (!feature) return;

    const style = { ...(feature.style || {}) } as Record<string, unknown>;

    switch (id) {
      case 'line-style':
        style.lineStyle = value;
        break;
    }

    this.draw.features.update(selectedIds[0], { style: style as FeatureStyle });
  }

  /**
   * The IDs of the selection
   */
  private selectedIds(): string[] {
    return [...this.draw.selection.get().ids];
  }
}
