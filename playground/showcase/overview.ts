// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The overview scene: the first picture of the README
 *
 * Loads `showcase.json` (a document in the native format: layers, groups, styles, a style
 * rule and an embedded image), adds a dataset of fine cells colored by a
 * graduated rule, shows a legend of both rules, selects a feature so that its frame and
 * handles show, and arranges the tree of the Layers panel.
 *
 * The four point shapes of the document are plain Points that name their shape in
 * `style.pointShape`, so nothing needs to be registered on the draw instance.
 */

import { type DatasetRow, deriveLegend, type StyleRule } from '@sakuzu/maplibre-gl-draw';
import type * as maplibregl from 'maplibre-gl';

import { nextFrame, type ShowcaseContext, type ShowcaseScene } from './scene';

/** A quiet basemap, so the colors of the drawing stand out */
export const QUIET_BASEMAP = 'https://tiles.openfreemap.org/styles/positron';

/** The feature that is selected, to show the frame and the handles */
export const SELECTED_FEATURE = 'courtyard';

/** The layer new drawings go into */
const ACTIVE_LAYER = 'layer-notes';

/** Tree items of the Layers panel to collapse (layers start expanded, groups collapsed) */
const COLLAPSE = ['layer-landuse', 'layer-draft', 'layer-routes'];

/** Tree items to expand */
const EXPAND = ['group-markers'];

/** The dataset of fine cells */
const GRID = {
  id: 'showcase-grid',
  name: 'Density',
  /** Center of the patch */
  center: [139.75925, 35.68062] as [number, number],
  /** Radius of the patch in degrees of longitude */
  radius: 0.00247,
  /** Circumradius of a hexagon in degrees of longitude */
  cell: 0.0001,
};

const GRID_RULE: StyleRule = {
  kind: 'graduated',
  property: 'density',
  breaks: [20, 40, 60, 80],
  colors: ['#ffffcc', '#a1dab4', '#41b6c4', '#2c7fb8', '#253494'],
  other: '#cccccc',
};

export const overviewScene: ShowcaseScene = {
  basemap: QUIET_BASEMAP,
  camera: { center: [139.766, 35.6822], zoom: 15 },
  load: loadDocument,
  async finish({ draw, map, layerPanel }) {
    draw.select(SELECTED_FEATURE);

    for (const id of [...COLLAPSE, ...EXPAND]) {
      await nextFrame();
      layerPanel
        .querySelector<HTMLButtonElement>(`[data-action="toggle-expand"][data-id="${id}"]`)
        ?.click();
    }

    addLegend(draw, map);
  },
};

/**
 * Loads the document and the dataset
 *
 * The tilted scene loads the same drawing.
 */
export async function loadDocument({ draw, underlays }: ShowcaseContext): Promise<void> {
  const { default: document } = await import('./showcase.json');
  await draw.load(document);
  draw.setActiveLayer(ACTIVE_LAYER);

  underlays.add({
    id: GRID.id,
    name: GRID.name,
    features: createGrid(),
    styleRule: GRID_RULE,
  });
}

/**
 * The legend of the two rules, in a card at the bottom left of the map
 */
function addLegend(draw: ShowcaseContext['draw'], map: maplibregl.Map): void {
  const sections: string[] = [];
  const landUse = draw.getAllLayers().find((layer) => layer.styleRule);
  if (landUse?.styleRule) {
    sections.push(legendSection(landUse.name, landUse.styleRule));
  }
  sections.push(legendSection(GRID.name, GRID_RULE));

  const card = document.createElement('div');
  card.className = 'showcase-legend';
  card.innerHTML = sections.join('');
  map.getContainer().appendChild(card);
}

function legendSection(title: string, rule: StyleRule): string {
  const items = deriveLegend(rule)
    .filter((entry) => entry.color !== ('other' in rule ? rule.other : ''))
    .map(
      (entry) =>
        `<li><span class="showcase-legend-swatch" style="background:${entry.color}"></span>${escapeHtml(entry.label)}</li>`,
    )
    .join('');
  return `<section><h2>${escapeHtml(title)}</h2><ul>${items}</ul></section>`;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Hexagonal cells over a round patch, with a smooth made-up density from 0 to 100
 */
function createGrid(): DatasetRow[] {
  const [lng0, lat0] = GRID.center;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const r = GRID.cell;
  const dx = Math.sqrt(3) * r;
  const dy = 1.5 * r;
  const features: DatasetRow[] = [];
  const n = Math.ceil(GRID.radius / dy) + 1;

  for (let row = -n; row <= n; row++) {
    const offset = row % 2 === 0 ? 0 : dx / 2;
    for (let col = -n; col <= n; col++) {
      const x = col * dx + offset;
      const y = row * dy;
      const d = Math.hypot(x, y) / GRID.radius;
      const angle = Math.atan2(y, x);
      // A wavy edge, so the patch does not read as a perfect disc
      const edge = 1 + 0.08 * Math.sin(angle * 3) + 0.05 * Math.cos(angle * 5);
      if (d > edge) continue;

      const u = x / GRID.radius;
      const v = y / GRID.radius;
      const density =
        48 +
        34 * Math.exp(-((u - 0.25) ** 2 + (v + 0.2) ** 2) * 3) +
        20 * Math.sin(u * 4.2) * Math.cos(v * 3.6) -
        30 * d * d;
      const ring: [number, number][] = [];
      for (let i = 0; i <= 6; i++) {
        const a = (Math.PI / 3) * (i % 6) + Math.PI / 6;
        ring.push([lng0 + x + r * 0.94 * Math.cos(a), lat0 + (y + r * 0.94 * Math.sin(a)) * k]);
      }
      features.push({
        type: 'Feature',
        id: `cell-${row}-${col}`,
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { density: Math.round(Math.min(100, Math.max(0, density))) },
        style: { fillOpacity: 0.8, strokeWidth: 0, strokeOpacity: 0 },
      });
    }
  }
  return features;
}
