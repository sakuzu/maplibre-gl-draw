// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the snapping providers of datasets
 *
 * They verify the listing of the vertex, edge and intersection candidates (the
 * attachment of featureId and datasetId, and the vertex references of an edge),
 * turning snapping to the data on and off, the handling of hiding (of a dataset /
 * of a feature), the rebuilding of the index after the features are replaced, the
 * counterparts of an intersection (display x display and display x Store only), and
 * getFeature for tracing.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createDatasetManager, type DatasetManager } from '../../dataset/manager.js';
import type { Dataset, DatasetRow } from '../../dataset/types.js';
import { resolveMessages } from '../../messages.js';
import { coordinatesOf, geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { BoundingBox, Coordinate, Feature, FeatureCoordinates } from '../../store/types.js';
import { toRow } from '../../test-utils.js';
import type {
  SnapCandidate,
  SnapPointCandidate,
  SnapProviderContext,
  SnapSegmentCandidate,
} from '../types.js';
import { isSegmentCandidate } from '../types.js';
import { createDisplaySnapProviders, type DisplaySnapProviders } from './display.js';

const ZOOM = 14;
const WORLD: BoundingBox = { minX: -180, minY: -85, maxX: 180, maxY: 85 };
/** A bbox wide enough to contain every feature */
const WIDE_BBOX: BoundingBox = { minX: -1, minY: -1, maxX: 1, maxY: 1 };

let store: MemoryStore;
let spatialIndex: RBushSpatialIndex;
let datasets: DatasetManager;
let providers: DisplaySnapProviders;
let enabled: boolean;

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, items: [] });
  spatialIndex = new RBushSpatialIndex();
  datasets = createDatasetManager({
    getViewportBounds: () => WORLD,
    getZoom: () => ZOOM,
    onViewportChange: () => () => {},
    requestRepaint: () => {},
  });
  enabled = true;
  providers = createDisplaySnapProviders({
    datasets,
    store,
    spatialIndex,
    isEnabled: () => enabled,
  });
});

/** Adds one dataset */
function addDataset(id: string, rows: DatasetRow[]): Dataset {
  return datasets.add({ id, rows });
}

/** Adds one feature to the Store (used as the counterpart of an intersection) */
function addStoreFeature(id: string, type: string, coordinates: FeatureCoordinates): Feature {
  const feature: Feature = {
    id,
    type,
    geometry: geometryFromCoordinates(type, coordinates),
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
  store.createFeature(feature);
  const layer = store.getLayer('l1');
  if (layer) store.updateLayer(layer.id, { items: [...layer.items, id] });
  spatialIndex.insert(feature);
  return feature;
}

function providerContext(overrides: Partial<SnapProviderContext> = {}): SnapProviderContext {
  return {
    zoom: ZOOM,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    lngLat: { lng: 0, lat: 0 },
    point: { x: 0, y: 0 },
    tolerancePx: 10,
    toleranceLngDeg: 1,
    toleranceLatDeg: 1,
    ...overrides,
  };
}

function candidatesOf(index: number): SnapCandidate[] {
  return providers.providers[index].candidates(WIDE_BBOX, providerContext());
}

function vertexCandidates(): SnapPointCandidate[] {
  return candidatesOf(0).filter((c): c is SnapPointCandidate => !isSegmentCandidate(c));
}

function edgeCandidates(): SnapSegmentCandidate[] {
  return candidatesOf(1).filter(isSegmentCandidate);
}

function intersectionCandidates(): SnapPointCandidate[] {
  return candidatesOf(2).filter((c): c is SnapPointCandidate => !isSegmentCandidate(c));
}

/** The horizontal one of the lines that cross */
const H_LINE: Coordinate[] = [
  [-0.1, 0],
  [0.1, 0],
];
/** The vertical one of the lines that cross */
const V_LINE: Coordinate[] = [
  [0, -0.1],
  [0, 0.1],
];

describe('the vertex provider of datasets', () => {
  it('makes the vertices of the features of a dataset into candidates', () => {
    addDataset('data', [
      toRow({
        id: 'line',
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0.1, 0.1],
        ],
      }),
    ]);

    const candidates = vertexCandidates();

    expect(candidates).toHaveLength(2);
    expect(candidates[0].kind).toBe('vertex');
    expect(candidates[0].coordinate).toEqual([0, 0]);
    expect(candidates[0].vertex).toEqual({ ring: 0, index: 0 });
  });

  it('attaches featureId and datasetId to a candidate', () => {
    addDataset('data', [toRow({ id: 'p1', type: 'Point', coordinates: [0, 0] })]);

    const candidates = vertexCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].featureId).toBe('p1');
    expect(candidates[0].datasetId).toBe('data');
  });

  it('mixes the candidates of several datasets', () => {
    addDataset('a', [toRow({ id: 'p1', type: 'Point', coordinates: [0, 0] })]);
    addDataset('b', [toRow({ id: 'p2', type: 'Point', coordinates: [0.1, 0.1] })]);

    const ids = vertexCandidates().map((c) => `${c.datasetId}/${c.featureId}`);

    expect(ids.sort()).toEqual(['a/p1', 'b/p2']);
  });

  it('does not target types that do not originate from GeoJSON, such as Circle', () => {
    addDataset('data', [
      toRow({ id: 'c1', type: 'Circle', coordinates: [0, 0], properties: { radius: 100 } }),
    ]);

    expect(vertexCandidates()).toHaveLength(0);
  });

  it('returns no candidates when snapping to the data is disabled', () => {
    addDataset('data', [toRow({ id: 'p1', type: 'Point', coordinates: [0, 0] })]);
    enabled = false;

    expect(vertexCandidates()).toHaveLength(0);
  });
});

describe('the edge provider of datasets', () => {
  it('attaches the vertex references of both ends and the origin to an edge candidate', () => {
    addDataset('data', [
      toRow({
        id: 'line',
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0.1, 0],
        ],
      }),
    ]);

    const candidates = edgeCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('edge');
    expect(candidates[0].start).toEqual([0, 0]);
    expect(candidates[0].end).toEqual([0.1, 0]);
    expect(candidates[0].startRef).toEqual({ ring: 0, index: 0 });
    expect(candidates[0].endRef).toEqual({ ring: 0, index: 1 });
    expect(candidates[0].featureId).toBe('line');
    expect(candidates[0].datasetId).toBe('data');
  });

  it('makes the rings of a Polygon into edges as well', () => {
    addDataset('data', [
      toRow({
        id: 'poly',
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [0.1, 0],
            [0.1, 0.1],
            [0, 0],
          ],
        ],
      }),
    ]);

    expect(edgeCandidates()).toHaveLength(3);
  });

  it('has no edge candidate for a Point', () => {
    addDataset('data', [toRow({ id: 'p1', type: 'Point', coordinates: [0, 0] })]);

    expect(edgeCandidates()).toHaveLength(0);
  });

  it('returns no candidates when snapping to the data is disabled', () => {
    addDataset('data', [toRow({ id: 'line', type: 'LineString', coordinates: H_LINE })]);
    enabled = false;

    expect(edgeCandidates()).toHaveLength(0);
  });
});

describe('the hiding of datasets', () => {
  it('does not target a hidden dataset', () => {
    const dataset = addDataset('data', [toRow({ id: 'p1', type: 'Point', coordinates: [0, 0] })]);
    dataset.setVisible(false);

    expect(vertexCandidates()).toHaveLength(0);
    expect(edgeCandidates()).toHaveLength(0);
  });

  it('does not target a hidden feature', () => {
    addDataset('data', [
      toRow({ id: 'p1', type: 'Point', coordinates: [0, 0], visible: false }),
      toRow({ id: 'p2', type: 'Point', coordinates: [0.1, 0.1] }),
    ]);

    const candidates = vertexCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].featureId).toBe('p2');
  });

  it('makes it a target again when it is shown again', () => {
    const dataset = addDataset('data', [toRow({ id: 'p1', type: 'Point', coordinates: [0, 0] })]);
    dataset.setVisible(false);
    dataset.setVisible(true);

    expect(vertexCandidates()).toHaveLength(1);
  });

  it('does not make a point that was not drawn because of collision thinning a snapping target', () => {
    // 2 points stacked at the same position. Only the frontmost one is drawn
    const dataset = datasets.add({
      id: 'data',
      rows: [
        toRow({ id: 'loser', type: 'Point', coordinates: [0, 0] }),
        toRow({ id: 'winner', type: 'Point', coordinates: [0, 0] }),
      ],
      collisionThinning: { enabled: true },
    });

    expect(dataset.getVisibleFeatureIds()?.has('loser')).toBe(false);

    const candidates = vertexCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].featureId).toBe('winner');
  });
});

describe('the index of datasets', () => {
  it('rebuilds the index when the features are replaced', () => {
    const dataset = addDataset('data', [toRow({ id: 'p1', type: 'Point', coordinates: [0, 0] })]);
    expect(vertexCandidates().map((c) => c.featureId)).toEqual(['p1']);

    dataset.setRows([toRow({ id: 'p2', type: 'Point', coordinates: [0.1, 0.1] })]);

    expect(vertexCandidates().map((c) => c.featureId)).toEqual(['p2']);
  });

  it('drops a removed dataset from the targets', () => {
    addDataset('data', [toRow({ id: 'p1', type: 'Point', coordinates: [0, 0] })]);
    datasets.remove('data');

    expect(vertexCandidates()).toHaveLength(0);
  });
});

describe('the intersection provider of datasets', () => {
  it('returns the intersections of edges between two datasets', () => {
    addDataset('data', [
      toRow({ id: 'h', type: 'LineString', coordinates: H_LINE }),
      toRow({ id: 'v', type: 'LineString', coordinates: V_LINE }),
    ]);

    const candidates = intersectionCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('intersection');
    expect(candidates[0].coordinate[0]).toBeCloseTo(0, 12);
    expect(candidates[0].coordinate[1]).toBeCloseTo(0, 12);
    expect(candidates[0].featureId).toBe('h');
    expect(candidates[0].datasetId).toBe('data');
    expect(candidates[0].description).toBe('Intersection');
  });

  it('takes the description from the messages table given to it', () => {
    const localized = createDisplaySnapProviders({
      datasets,
      store,
      spatialIndex,
      isEnabled: () => enabled,
      messages: { snapIntersection: '交点' },
    });
    addDataset('data', [
      toRow({ id: 'h', type: 'LineString', coordinates: H_LINE }),
      toRow({ id: 'v', type: 'LineString', coordinates: V_LINE }),
    ]);

    const descriptions = localized.providers
      .flatMap((provider) => provider.candidates(WIDE_BBOX, providerContext()))
      .filter((c) => c.kind === 'intersection')
      .map((c) => c.description);

    expect(descriptions).toEqual(['交点']);
  });

  it('takes the description from a resolved table of an instance (Options.messages)', () => {
    // The draw instance passes the table it resolved from Options.messages
    const localized = createDisplaySnapProviders({
      datasets,
      store,
      spatialIndex,
      isEnabled: () => enabled,
      messages: resolveMessages({ snapIntersection: 'Kreuzung' }),
    });
    addDataset('data', [
      toRow({ id: 'h', type: 'LineString', coordinates: H_LINE }),
      toRow({ id: 'v', type: 'LineString', coordinates: V_LINE }),
    ]);

    const descriptions = localized.providers
      .flatMap((provider) => provider.candidates(WIDE_BBOX, providerContext()))
      .filter((c) => c.kind === 'intersection')
      .map((c) => c.description);

    expect(descriptions).toEqual(['Kreuzung']);
  });

  it('makes intersections with the edges of another dataset as well', () => {
    addDataset('a', [toRow({ id: 'h', type: 'LineString', coordinates: H_LINE })]);
    addDataset('b', [toRow({ id: 'v', type: 'LineString', coordinates: V_LINE })]);

    expect(intersectionCandidates()).toHaveLength(1);
  });

  it('returns an intersection between a display edge and a Store edge with the origin of the display side', () => {
    addDataset('data', [toRow({ id: 'h', type: 'LineString', coordinates: H_LINE })]);
    addStoreFeature('v', 'LineString', V_LINE);

    const candidates = intersectionCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].featureId).toBe('h');
    expect(candidates[0].datasetId).toBe('data');
  });

  it('does not compute intersections between two Store edges', () => {
    // Place one display line where it does not cross, and make the 2 Store lines cross
    // at the origin
    addDataset('data', [
      toRow({
        id: 'far',
        type: 'LineString',
        coordinates: [
          [0.5, 0.5],
          [0.6, 0.5],
        ],
      }),
    ]);
    addStoreFeature('h', 'LineString', H_LINE);
    addStoreFeature('v', 'LineString', V_LINE);

    expect(intersectionCandidates()).toHaveLength(0);
  });

  it('does not make a self-intersection of the same feature into an intersection', () => {
    addDataset('data', [
      toRow({
        id: 'bowtie',
        type: 'LineString',
        coordinates: [
          [-0.1, -0.1],
          [0.1, 0.1],
          [0.1, -0.1],
          [-0.1, 0.1],
        ],
      }),
    ]);

    expect(intersectionCandidates()).toHaveLength(0);
  });

  it('returns no candidates when snapping to the data is disabled', () => {
    addDataset('data', [
      toRow({ id: 'h', type: 'LineString', coordinates: H_LINE }),
      toRow({ id: 'v', type: 'LineString', coordinates: V_LINE }),
    ]);
    enabled = false;

    expect(intersectionCandidates()).toHaveLength(0);
  });
});

describe('getting features for tracing', () => {
  it('can be looked up by dataset ID and feature ID', () => {
    addDataset('data', [toRow({ id: 'line', type: 'LineString', coordinates: H_LINE })]);

    const feature = providers.getFeature('data', 'line');

    expect(feature?.id).toBe('line');
    expect(coordinatesOf(feature)).toEqual(H_LINE);
  });

  it('can look up a feature of a hidden dataset as well', () => {
    const dataset = addDataset('data', [
      toRow({ id: 'line', type: 'LineString', coordinates: H_LINE }),
    ]);
    dataset.setVisible(false);

    expect(providers.getFeature('data', 'line')?.id).toBe('line');
  });

  it('looks up the new feature after a replacement', () => {
    const dataset = addDataset('data', [
      toRow({ id: 'line', type: 'LineString', coordinates: H_LINE }),
    ]);
    dataset.setRows([toRow({ id: 'other', type: 'LineString', coordinates: V_LINE })]);

    expect(providers.getFeature('data', 'line')).toBeNull();
    expect(providers.getFeature('data', 'other')?.id).toBe('other');
  });

  it('returns null for a dataset or a feature that does not exist', () => {
    addDataset('data', [toRow({ id: 'line', type: 'LineString', coordinates: H_LINE })]);

    expect(providers.getFeature('other', 'line')).toBeNull();
    expect(providers.getFeature('data', 'missing')).toBeNull();
  });
});
