// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import type { Draw, LoadOptions, Mode } from '@sakuzu/maplibre-gl-draw';
import { createDraw } from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
// The stylesheet of the installed maplibre-gl first, then the demo's own styles on top of it.
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

// Worker URL setup for v6 (side effect). Required before the Map is created.
import './maplibre-setup';

import {
  BASEMAP_OPTIONS,
  DEFAULT_BASEMAP,
  SAMPLE_DATA_URL,
  SAMPLE_DATA_VIEW,
  SNAP_TOLERANCE_PX,
} from './constants';
import { GeometryBar } from './gis/geometry-bar';
import { GisPanel } from './gis/gis-panel';
import { Toast } from './gis/toast';
import { geojsonToDisplayFeatures, UnderlayRegistry } from './gis/underlay';
import { LayerPanel } from './layer-panel/layer-panel';
import { PropertyPanel } from './property-panel/property-panel';
import { createLoggerPlugin } from './sample-plugin';
import {
  finishShowcase,
  getShowcaseScene,
  loadShowcase,
  prepareShowcase,
} from './showcase/showcase';

// `?showcase` opens the overview scene of the README images and `?showcase=<scene>` one of
// the others (showcase/showcase.ts). The GitHub Pages build opens the overview by default and
// the plain playground with `?plain`
const scene = getShowcaseScene();
const showcase = scene !== null;
setUpHeaderLinks();
if (scene) {
  prepareShowcase(scene);
}

/** Points the header's scene link at the other scene and shows the links of the site build */
function setUpHeaderLinks() {
  const site = import.meta.env.VITE_SITE === '1';
  const sceneLink = document.getElementById('scene-link') as HTMLAnchorElement | null;
  if (sceneLink) {
    sceneLink.textContent = showcase ? 'Blank' : 'Showcase';
    sceneLink.title = showcase ? 'Open the playground without the showcase' : 'Open the showcase';
    if (site) sceneLink.href = showcase ? '?plain' : './';
    else sceneLink.href = showcase ? './' : '?showcase';
  }
  if (site) {
    for (const link of document.querySelectorAll<HTMLElement>('[data-site-only]')) {
      link.hidden = false;
    }
  }
}

// Create the map
const map = new maplibregl.Map({
  container: 'map',
  style: scene ? scene.basemap : DEFAULT_BASEMAP,
  center: scene ? scene.camera.center : [139.75, 35.69],
  zoom: scene ? scene.camera.zoom : 14,
  pitch: scene?.camera.pitch ?? 0,
  bearing: scene?.camera.bearing ?? 0,
  ...(scene?.maxPitch !== undefined && { maxPitch: scene.maxPitch }),
});

// Add the standard controls
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.GlobeControl(), 'top-right');

// Create the draw instance
const draw = createDraw(map, {
  defaultMode: 'select',
  // The showcase document brings its own layers
  initDefaultLayer: !showcase,
  snapping: { enabled: true, tolerancePx: SNAP_TOLERANCE_PX, disableKey: 'alt' },
});

// Add the sample plugin (sample-plugin.ts). It only writes to the console, so it shows that a
// plugin runs without adding anything to the page
draw.extensions.plugins.add(createLoggerPlugin());

// Update the state of the delete button
function updateDeleteButtonState() {
  const deleteBtn = document.getElementById('delete-btn') as HTMLButtonElement;
  if (!deleteBtn) return;

  const selectedVertices = draw.vertexSelection.get();
  const selection = draw.selection.get();

  deleteBtn.disabled = !(
    (selectedVertices && selectedVertices.vertices.length > 0) ||
    (selection.type === 'feature' && selection.ids.length > 0)
  );
}

// Set up the event listeners
draw.on('selection.changed', () => {
  updateDeleteButtonState();
});
draw.on('vertexSelection.changed', () => {
  updateDeleteButtonState();
});

draw.on('mode.changed', ({ mode }) => {
  updateToolbarActiveState(mode);
});

// Handler for image selection requests (registered early)
draw.on('image.requested', ({ lngLat, zoom, layerId }) => {
  openImageFileSelector(draw, [lngLat[0], lngLat[1]], zoom, layerId);
});

// Toolbar setup
function setupToolbar(draw: Draw) {
  const toolbar = document.getElementById('draw-toolbar');
  if (!toolbar) return;

  // Mode switching buttons
  const modeButtons = toolbar.querySelectorAll<HTMLButtonElement>('[data-mode]');
  for (const btn of modeButtons) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode as Mode | undefined;
      if (mode) {
        draw.setMode(mode);
      }
    });
  }

  // Delete button
  const deleteBtn = document.getElementById('delete-btn') as HTMLButtonElement;
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      // The same deletion as the Delete key: the selected vertices first, otherwise the
      // selected features, groups or layers
      if (!draw.vertexSelection.delete()) draw.selection.delete();
    });
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ignore while typing text
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }

    // Ignore when a modifier key is held (so it does not get in the way of shortcuts such
    // as Cmd+G)
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'v':
        draw.setMode('select');
        break;
      case 'p':
        draw.setMode('draw_point');
        break;
      case 'l':
        draw.setMode('draw_line');
        break;
      case 'g':
        draw.setMode('draw_polygon');
        break;
      case 'c':
        draw.setMode('draw_circle');
        break;
      case 'f':
        draw.setMode('draw_freehand');
        break;
      case 'i':
        draw.setMode('draw_image');
        break;
    }
  });
}

// Update the active state of the toolbar
function updateToolbarActiveState(mode: Mode) {
  const toolbar = document.getElementById('draw-toolbar');
  if (!toolbar) return;

  const buttons = toolbar.querySelectorAll<HTMLButtonElement>('[data-mode]');
  for (const btn of buttons) {
    if (btn.dataset.mode === mode) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  }
}

// Setup of the import feature (using event delegation)
// The event listeners are attached to the container element so that the events keep
// working even when the PropertyPanel is re-rendered
function setupImportExport(draw: Draw) {
  const propertyContainer = document.getElementById('property-panel');
  if (!propertyContainer) return;

  // Open the file selection dialog on click / export (event delegation)
  propertyContainer.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Clicks on the export / load sample buttons
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'export') {
      handleExport(draw);
      return;
    }
    if (action === 'load-sample') {
      handleSampleLoad(draw);
      return;
    }

    // Clicks on the drop zone
    const dropZone = target.closest('#drop-zone');
    if (dropZone && !target.closest('#file-input')) {
      const fileInput = dropZone.querySelector('#file-input') as HTMLInputElement;
      if (fileInput) {
        fileInput.click();
      }
    }
  });

  // File selection event (event delegation)
  propertyContainer.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.id === 'file-input' && target.files && target.files.length > 0) {
      handleFileImport(target.files[0], draw);
      target.value = ''; // Reset
    }
  });

  // Drag over (event delegation)
  propertyContainer.addEventListener('dragover', (e) => {
    const target = e.target as HTMLElement;
    const dropZone = target.closest('#drop-zone');
    if (dropZone) {
      e.preventDefault();
      dropZone.classList.add('active');
    }
  });

  // Drag leave (event delegation)
  propertyContainer.addEventListener('dragleave', (e) => {
    const target = e.target as HTMLElement;
    const dropZone = target.closest('#drop-zone');
    if (dropZone) {
      dropZone.classList.remove('active');
    }
  });

  // Drop (event delegation)
  propertyContainer.addEventListener('drop', (e) => {
    const target = e.target as HTMLElement;
    const dropZone = target.closest('#drop-zone');
    if (dropZone) {
      e.preventDefault();
      dropZone.classList.remove('active');

      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        handleFileImport(e.dataTransfer.files[0], draw);
      }
    }
  });
}

// File export handling
function handleExport(draw: Draw): void {
  // Remove the existing dialog if there is one
  const existingDialog = document.getElementById('export-dialog');
  if (existingDialog) {
    existingDialog.remove();
  }

  // Create the dialog
  const dialog = document.createElement('dialog');
  dialog.id = 'export-dialog';
  dialog.className = 'export-dialog';
  dialog.innerHTML = `
    <div class="export-dialog-content">
      <h3 class="export-dialog-title">Choose an export format</h3>
      <div class="export-dialog-options">
        <label class="export-option">
          <input type="radio" name="export-format" value="native" checked>
          <span class="export-option-label">Native format</span>
          <span class="export-option-desc">Keeps the complete data. Can be edited again.</span>
        </label>
        <label class="export-option">
          <input type="radio" name="export-format" value="geojson">
          <span class="export-option-label">GeoJSON format</span>
          <span class="export-option-desc">Compatible with other GIS tools.</span>
        </label>
      </div>
      <div class="export-dialog-actions">
        <button type="button" class="export-dialog-btn export-dialog-cancel">Cancel</button>
        <button type="button" class="export-dialog-btn export-dialog-confirm">Download</button>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);
  dialog.showModal();

  // Cancel button
  dialog.querySelector('.export-dialog-cancel')?.addEventListener('click', () => {
    dialog.close();
    dialog.remove();
  });

  // When it was closed with the Esc key
  dialog.addEventListener('close', () => {
    dialog.remove();
  });

  // Close on a click on the backdrop
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      dialog.close();
      dialog.remove();
    }
  });

  // Download button
  dialog.querySelector('.export-dialog-confirm')?.addEventListener('click', () => {
    const formatInput = dialog.querySelector(
      'input[name="export-format"]:checked',
    ) as HTMLInputElement;
    const format = formatInput?.value || 'native';

    const native = format !== 'geojson';
    const data = native ? draw.document.toJSON() : draw.document.toGeoJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: native ? 'application/json' : 'application/geo+json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${draw.metadata.get().title || 'drawing'}${native ? '.json' : '.geojson'}`;
    a.click();
    URL.revokeObjectURL(url);

    dialog.close();
    dialog.remove();
  });
}

// File import handling
async function handleFileImport(file: File, draw: Draw, placement?: LoadOptions) {
  // When "Load as an underlay (display only)" is checked, do not put it into the Store
  if (propertyPanel?.isImportAsUnderlay()) {
    await handleUnderlayImport(file);
    return;
  }

  try {
    console.log(`Importing file: ${file.name}`);
    const startTime = performance.now();

    const result = await draw.document.load(file, placement);
    if (!result) {
      toast?.show('Nothing is loaded while the document is read-only', 'warn');
      return;
    }

    const endTime = performance.now();
    console.log(`Import completed:`);
    console.log(`  - Format: ${result.format}`);
    console.log(`  - Features: ${result.featureIds.length}`);
    console.log(`  - Replaced: ${result.replaced}`);
    console.log(`  - Time: ${(endTime - startTime).toFixed(2)}ms`);

    // Apply the basemap from the imported metadata
    const metadata = draw.metadata.get();
    if (metadata.basemap) {
      const basemap = metadata.basemap;
      // Apply it only when the URL exists in BASEMAP_OPTIONS
      const isValidBasemap = BASEMAP_OPTIONS.some((opt) => opt.value === basemap);
      if (isValidBasemap) {
        changeBasemap(basemap);
        console.log(`  - Basemap: ${basemap}`);
      } else {
        console.log(`  - Basemap: ${basemap} (skipped - not in options)`);
      }
    }

    // Re-render the PropertyPanel (to reflect the metadata)
    propertyPanel?.refresh();

    // Redraw the map
    map.triggerRepaint();
  } catch (error) {
    console.error('Import failed:', error);
    toast?.show(
      `Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'warn',
    );
  }
}

// Files dropped on the map
//
// The library does not take drops, so the page listens to them on the map's container, turns
// the position into a coordinate and loads each file there: an image is centered where it was
// dropped, and a data file keeps its own positions.
function setupMapDrop(draw: Draw): void {
  const container = map.getContainer();
  container.addEventListener('dragover', (e) => e.preventDefault());
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (draw.isReadOnly() || draw.isInteractionLocked()) {
      toast?.show('Dropped files are not loaded while editing is off', 'warn');
      return;
    }
    const rect = container.getBoundingClientRect();
    const { lng, lat } = map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
    for (const file of e.dataTransfer?.files ?? []) {
      await handleFileImport(file, draw, {
        coordinate: [lng, lat],
        zoom: map.getZoom(),
        layerId: draw.layers.getActive()?.id,
      });
    }
  });
}

// Import as an underlay (dataset)
//
// Nothing goes into the Store; the file name becomes the display name and it is stacked at
// the very back. It is drawn with the default color and clicking it shows the attributes
// (no styleRule is attached).
async function handleUnderlayImport(file: File): Promise<void> {
  if (!underlays) return;

  try {
    const geojson = JSON.parse(await file.text());
    const id = underlays.nextId();
    const features = geojsonToDisplayFeatures(geojson, id);

    if (features.length === 0) {
      toast?.show('There was no feature that could be used as an underlay', 'warn');
      return;
    }

    underlays.add({ id, name: file.name, features });
    toast?.show(`Loaded ${file.name} as an underlay (${features.length} features)`);
  } catch (error) {
    console.error('Underlay import failed:', error);
    toast?.show('Failed to load the underlay', 'warn');
  }
}

// Loading of the sample data
async function handleSampleLoad(draw: Draw): Promise<void> {
  try {
    const response = await fetch(SAMPLE_DATA_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const geojson = await response.json();
    const result = await draw.document.load(geojson);
    if (!result) {
      toast?.show('Nothing is loaded while the document is read-only', 'warn');
      return;
    }

    map.jumpTo({ center: SAMPLE_DATA_VIEW.center, zoom: SAMPLE_DATA_VIEW.zoom });
    propertyPanel?.refresh();

    toast?.show(`Loaded the sample (${result.featureIds.length} features)`);
  } catch (error) {
    console.error('Sample load failed:', error);
    toast?.show('Failed to load the sample', 'warn');
  }
}

// Open the image file selection dialog
function openImageFileSelector(
  draw: Draw,
  coordinate: [number, number],
  zoom: number,
  layerId: string,
): void {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';

  const handleFileSelect = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];

    if (file) {
      try {
        // load determines the file type internally and handles it appropriately
        await draw.document.load(file, { coordinate, zoom, layerId });
      } catch (error) {
        console.error('Failed to load file:', error);
      }
    }

    cleanup();
  };

  const handleCancel = () => {
    cleanup();
  };

  const cleanup = () => {
    fileInput.removeEventListener('change', handleFileSelect);
    fileInput.removeEventListener('cancel', handleCancel);
    fileInput.remove();
    map.getCanvas().focus();
  };

  fileInput.addEventListener('change', handleFileSelect);
  fileInput.addEventListener('cancel', handleCancel);

  // Append it to map.getContainer() (not to document.body)
  map.getContainer().appendChild(fileInput);
  fileInput.click();
}

// Panel instances (initialized later)
let layerPanel: LayerPanel | null = null;
let propertyPanel: PropertyPanel | null = null;
let gisPanel: GisPanel | null = null;
let geometryBar: GeometryBar | null = null;
let toast: Toast | null = null;
let underlays: UnderlayRegistry | null = null;

// Basemap change
function changeBasemap(styleUrl: string): void {
  map.setStyle(styleUrl, { diff: false });
}

// Set up the toolbar and the panels once the map has finished loading
map.on('load', async () => {
  setupToolbar(draw);
  updateToolbarActiveState('select');

  // Initialize the toast notifications (prepared before each panel)
  const toastContainer = document.getElementById('toast-container');
  if (toastContainer) {
    toast = new Toast(toastContainer);
  }

  // Registry of underlays (datasets)
  underlays = new UnderlayRegistry(draw, map);

  // The showcase document replaces the document before the panels are built
  if (scene) {
    await loadShowcase(scene, draw, map, underlays);
  }

  // Create the default layer
  if (draw.layers.count() === 0) {
    draw.layers.create({ name: 'Layer 1' });
  }

  // LayerPanel initialization
  const layerContainer = document.getElementById('layer-panel');
  if (layerContainer) {
    layerPanel = new LayerPanel(layerContainer, draw, underlays);

    // LayerPanel -> PropertyPanel event wiring
    layerContainer.addEventListener('layer-panel:layer-selected', ((e: CustomEvent) => {
      propertyPanel?.onLayerSelected(e.detail.id);
    }) as EventListener);

    layerContainer.addEventListener('layer-panel:group-selected', ((e: CustomEvent) => {
      propertyPanel?.onGroupSelected(e.detail.id);
    }) as EventListener);
  }

  // Initialization of the geometry operation bar
  const geometryBarEl = document.getElementById('geometry-bar');
  if (geometryBarEl && toast) {
    geometryBar = new GeometryBar(geometryBarEl, draw, toast);
  }

  // Initialization of the GIS panel (inserted into the GIS tab of the PropertyPanel)
  if (toast) {
    gisPanel = new GisPanel(draw, map, toast, underlays);
  }

  // PropertyPanel initialization
  const propertyContainer = document.getElementById('property-panel');
  if (propertyContainer) {
    propertyPanel = new PropertyPanel(propertyContainer, draw, {
      gisTabElement: gisPanel?.getElement(),
      notify: (message, kind) => toast?.show(message, kind),
    });

    // PropertyPanel -> basemap change
    propertyContainer.addEventListener('property-panel:basemap-change', ((e: CustomEvent) => {
      changeBasemap(e.detail.basemap);
    }) as EventListener);
  }

  // Set up after the PropertyPanel has created the drop-zone and the file-input
  setupImportExport(draw);
  setupMapDrop(draw);

  // Update the references used for debugging
  window.layerPanel = layerPanel;
  window.propertyPanel = propertyPanel;
  window.gisPanel = gisPanel;
  window.geometryBar = geometryBar;
  window.underlays = underlays;

  if (scene && layerContainer) {
    await finishShowcase(scene, draw, map, underlays, layerContainer);
  }
});

// Exposed globally for debugging
declare global {
  interface Window {
    draw: Draw;
    map: maplibregl.Map;
    layerPanel: LayerPanel | null;
    propertyPanel: PropertyPanel | null;
    gisPanel: GisPanel | null;
    geometryBar: GeometryBar | null;
    underlays: UnderlayRegistry | null;
  }
}
window.draw = draw;
window.map = map;
window.layerPanel = layerPanel;
window.propertyPanel = propertyPanel;
window.gisPanel = gisPanel;
window.geometryBar = geometryBar;
window.underlays = underlays;
