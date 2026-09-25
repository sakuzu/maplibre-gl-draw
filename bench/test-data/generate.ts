// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test data generation script
 *
 * Generates features at random around Tokyo (139.6-139.9, 35.5-35.8)
 * Point: 30%, LineString: 25%, Polygon: 20%, Sticker (a custom type): 25%
 *
 * Usage (the output is written next to this script and is not committed):
 *   node bench/test-data/generate.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Type definitions (the shapes of the native format, see src/shared/types/model.ts)
interface Coordinate {
  0: number;
  1: number;
}

type FeatureType = 'Point' | 'LineString' | 'Polygon' | 'Image' | 'Sticker';

interface DrawFeature {
  id: string;
  type: FeatureType;
  coordinates: Coordinate | Coordinate[] | Coordinate[][];
  layerId: string;
  groupId?: string;
  properties: Record<string, unknown>;
  style?: Record<string, unknown>;
  locked: boolean;
  visible: boolean;
}

interface DrawLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  order: string[];
  metadata?: Record<string, unknown>;
}

interface MapLibreGLDrawData {
  version: string;
  created?: string;
  modified?: string;
  metadata?: {
    title?: string;
    description?: string;
    basemap?: string;
  };
  layers?: DrawLayer[];
  groups?: never[];
  features: DrawFeature[];
  files?: Record<string, never>;
}

// Random number generation
function random(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

// Coordinate generation (around Tokyo)
function randomCoordinate(): [number, number] {
  const lng = random(139.6, 139.9);
  const lat = random(35.5, 35.8);
  return [lng, lat];
}

// Color palette (the same 18 colors as the demo screen of the prototype)
const COLOR_PALETTE = [
  '#FF0000',
  '#FF6000',
  '#FFA500',
  '#FFD700',
  '#FFFF00',
  '#AAFF00',
  '#00FF00',
  '#00FFAA',
  '#00FFFF',
  '#00AAFF',
  '#0055FF',
  '#0000FF',
  '#7700FF',
  '#AA00FF',
  '#FF00FF',
  '#FF0077',
  '#FFFFFF',
  '#000000',
];

// Color generation
function randomColor(): string {
  return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
}

// Generates two different colors
function randomTwoColors(): [string, string] {
  const color1 = randomColor();
  let color2 = randomColor();
  // Make sure they do not end up being the same color
  while (color2 === color1) {
    color2 = randomColor();
  }
  return [color1, color2];
}

// Point feature generation
function generatePoint(id: string, layerId: string): DrawFeature {
  return {
    id,
    type: 'Point',
    coordinates: randomCoordinate(),
    layerId,
    properties: {},
    style: {
      pointColor: randomColor(),
      pointRadius: random(4, 12),
    },
    locked: false,
    visible: true,
  };
}

// LineString feature generation
function generateLineString(id: string, layerId: string): DrawFeature {
  const pointCount = Math.floor(random(2, 6));
  const baseCoord = randomCoordinate();
  const coordinates: [number, number][] = [];

  for (let i = 0; i < pointCount; i++) {
    coordinates.push([baseCoord[0] + random(-0.02, 0.02), baseCoord[1] + random(-0.02, 0.02)]);
  }

  return {
    id,
    type: 'LineString',
    coordinates,
    layerId,
    properties: { createdZoom: 14 },
    style: {
      strokeColor: randomColor(),
      strokeWidth: Math.floor(random(1, 8)), // Random width of 1 to 7 px
      strokeOpacity: 1,
    },
    locked: false,
    visible: true,
  };
}

// Polygon feature generation
function generatePolygon(id: string, layerId: string): DrawFeature {
  const pointCount = Math.floor(random(3, 7));
  const baseCoord = randomCoordinate();
  const radius = random(0.005, 0.02);
  const coordinates: [number, number][] = [];

  // Generate a polygon close to a circle
  for (let i = 0; i < pointCount; i++) {
    const angle = (i / pointCount) * Math.PI * 2;
    const r = radius * random(0.7, 1.3);
    coordinates.push([baseCoord[0] + Math.cos(angle) * r, baseCoord[1] + Math.sin(angle) * r]);
  }
  // Close it
  coordinates.push(coordinates[0]);

  // Make the fill color and the stroke color different colors
  const [fillColor, strokeColor] = randomTwoColors();

  return {
    id,
    type: 'Polygon',
    coordinates: [coordinates],
    layerId,
    properties: { createdZoom: 14 },
    style: {
      fillColor,
      fillOpacity: 1, // Opaque
      strokeColor,
      strokeWidth: Math.floor(random(1, 5)), // Random width of 1 to 4 px
      strokeOpacity: 1,
    },
    locked: false,
    visible: true,
  };
}

// Generation of a feature of a custom type (core only stores it; drawing it is up to a
// registered custom renderer)
function generateSticker(id: string, layerId: string): DrawFeature {
  return {
    id,
    type: 'Sticker',
    coordinates: randomCoordinate(),
    layerId,
    properties: {
      createdZoom: 12,
    },
    style: {
      fillColor: randomColor(),
    },
    locked: false,
    visible: true,
  };
}

// Test data generation
function generateTestData(count: number): MapLibreGLDrawData {
  const layerId = 'layer-1';
  const features: DrawFeature[] = [];
  const order: string[] = [];

  for (let i = 0; i < count; i++) {
    const id = `feature-${i + 1}`;
    const rand = Math.random();

    let feature: DrawFeature;
    if (rand < 0.3) {
      // 30% Point
      feature = generatePoint(id, layerId);
    } else if (rand < 0.55) {
      // 25% LineString
      feature = generateLineString(id, layerId);
    } else if (rand < 0.75) {
      // 20% Polygon
      feature = generatePolygon(id, layerId);
    } else {
      // 25% Sticker (a custom type)
      feature = generateSticker(id, layerId);
    }

    features.push(feature);
    order.push(id);
  }

  return {
    version: '2.0.0',
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    metadata: {
      title: `Test data (${count} features)`,
      description: `${count} features for performance measurements`,
    },
    layers: [
      {
        id: layerId,
        name: 'Test layer',
        visible: true,
        locked: false,
        opacity: 1,
        order,
      },
    ],
    layerOrder: [layerId],
    groups: [],
    features,
    files: {},
  };
}

// File output
function writeTestData(count: number): void {
  const data = generateTestData(count);
  const filename = `test-data-${count}.json`;
  const filepath = path.join(__dirname, filename);

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`Generated: ${filepath}`);
  console.log(`  - Features: ${data.features.length}`);
  console.log(
    `  - Types: Point=${data.features.filter((f) => f.type === 'Point').length}, LineString=${data.features.filter((f) => f.type === 'LineString').length}, Polygon=${data.features.filter((f) => f.type === 'Polygon').length}, Sticker=${data.features.filter((f) => f.type === 'Sticker').length}`,
  );
}

// Main routine
console.log('Generating test data...\n');
writeTestData(1000);
writeTestData(10000);
console.log('\nDone!');
