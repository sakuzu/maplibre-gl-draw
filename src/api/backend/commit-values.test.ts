// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The commits of the instance as operations on values: random runs of commits, cut into parts,
 * put together again and applied with `applyOperations`, give the document the instance writes
 * out, on a Store of objects and on a Store of rows
 */

import { type Value, valueToJSON } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { createMapStub } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import type { DrawDocument, FeatureInput, FeaturePatch, StyleRule } from '../model.js';
import type { Placement, Transaction } from '../write.js';
import { CommitValues, fileRecordOf } from './commit-values.js';
import { batchesOf, createPartCollector } from './parts.js';
import {
  applyOperations,
  createStoredDocument,
  type StoredDocument,
  type ValueBatch,
} from './values.js';

const KEY = (name: string) => `maplibre-gl-draw:${name}`;

/** A small generator of numbers, the same for the same seed */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

const KINDS: ReadonlyArray<readonly [string, () => Store]> = [
  ['objects', () => new MemoryStore()],
  ['rows', () => createTableStore().store],
];

// ============================================================================
// The document both ways, in one shape to compare
// ============================================================================

/** The properties in their JSON form */
function jsonOf(properties: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) out[key] = valueToJSON(value as Value);
  return out;
}

/** What a document written out holds, in one shape */
function writtenOf(document: DrawDocument) {
  const layers = new Map((document.layers ?? []).map((layer) => [layer.id, layer]));
  return {
    layers: document.layerOrder
      .filter((id) => layers.has(id))
      .map((id) => {
        const layer = layers.get(id) as NonNullable<DrawDocument['layers']>[number];
        return {
          id,
          name: layer.name,
          visible: layer.visible,
          locked: layer.locked,
          styleRule: layer.styleRule ?? null,
          items: [...layer.items],
        };
      }),
    groups: (document.groups ?? [])
      .map((group) => ({
        id: group.id,
        name: group.name,
        layerId: group.layerId,
        visible: group.visible,
        locked: group.locked,
        featureIds: [...group.featureIds],
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    features: document.features
      .map((feature) => ({
        id: feature.id,
        geometry: feature.geometry,
        properties: jsonOf(feature.properties),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    title: document.metadata?.title ?? '',
    description: document.metadata?.description ?? '',
  };
}

/** The IDs of records in the order of their keys */
function byKey(entries: Iterable<[string, { key: string }]>): string[] {
  return [...entries]
    .sort(([a, x], [b, y]) => (x.key < y.key ? -1 : x.key > y.key ? 1 : a < b ? -1 : 1))
    .map(([id]) => id);
}

/** What the records of a storage hold, in the same shape */
function storedOf(document: StoredDocument) {
  const features = [...document.features];
  const layerOf = (id: string) => document.features.get(id)?.properties[KEY('layerId')];
  const groupOf = (id: string) => document.features.get(id)?.properties[KEY('groupId')];
  return {
    layers: byKey(document.layers).map((id) => {
      const layer = document.layers.get(id) as NonNullable<ReturnType<typeof document.layers.get>>;
      const items: [string, { key: string }][] = [
        ...[...document.groups].filter(([, g]) => g.layerId === id && g.parentId === null),
        ...features.filter(([fid]) => layerOf(fid) === id && groupOf(fid) === undefined),
      ];
      return {
        id,
        name: layer.name,
        visible: layer.visible,
        locked: layer.locked,
        styleRule: layer.styleRule,
        items: byKey(items),
      };
    }),
    groups: [...document.groups]
      .map(([id, group]) => ({
        id,
        name: group.name,
        layerId: group.layerId,
        visible: group.visible,
        locked: group.locked,
        featureIds: byKey(features.filter(([fid]) => groupOf(fid) === id)),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    features: features
      .map(([id, record]) => ({ id, geometry: record.geometry, properties: record.properties }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    title: document.title,
    description: document.description,
  };
}

// ============================================================================
// A storage that receives the commits
// ============================================================================

/**
 * The commits of the instance read as operations, cut into small parts, sent in an order mixed
 * within each commit with some parts sent twice, put together again and applied
 */
function receiver(store: Store, next: () => number) {
  const values = new CommitValues(store);
  const document = createStoredDocument();
  applyOperations(document, values.documentOperations());
  const collector = createPartCollector();
  let commits = 0;
  let parts = 0;
  const stop = store.subscribe((changes) => {
    const operations = values.changeOperations(changes);
    if (operations === null) throw new Error('The document was replaced');
    commits++;
    const batches = batchesOf(
      { commit: `c${commits}`, writtenAtMilliseconds: commits },
      operations,
      700,
    );
    parts += batches.length;
    const sent: ValueBatch[] = [...batches];
    if (sent.length > 1 && next() < 0.5) sent.push(sent[0]);
    for (let i = sent.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [sent[i], sent[j]] = [sent[j], sent[i]];
    }
    let applied = 0;
    for (const batch of sent) {
      const complete = collector.add(batch);
      if (complete === null) continue;
      applied++;
      const { skipped } = applyOperations(document, complete);
      if (skipped.length > 0) throw new Error(`Skipped ${skipped.join(', ')}`);
    }
    if (batches.length > 0 && applied !== 1) throw new Error('A commit was applied twice');
  });
  return { document, stop, counts: () => ({ commits, parts }) };
}

// ============================================================================
// Random commits
// ============================================================================

function geometryOf(next: () => number): Geometry {
  const x = Math.round(next() * 100) / 10;
  const y = Math.round(next() * 100) / 10;
  const pick = next();
  if (pick < 0.4) return { type: 'Point', coordinates: [x, y] };
  if (pick < 0.7) {
    return {
      type: 'LineString',
      coordinates: [
        [x, y],
        [x + 1, y + 0.5],
      ],
    };
  }
  // Rings drawn both ways: they are written in the right-hand rule
  const ring = [
    [x, y],
    [x + 1, y],
    [x + 1, y + 1],
    [x, y + 1],
    [x, y],
  ];
  return { type: 'Polygon', coordinates: [next() < 0.5 ? ring : ring.reverse()] };
}

const NAMES = ['height', 'name', 'kind', 'note', 'tags'];
const COLORS = ['#ff0000', '#00ff00', '#0000ff'];

function randomValue(next: () => number): unknown {
  const pick = next();
  if (pick < 0.3) return Math.round(next() * 1000);
  if (pick < 0.6) return `v${Math.floor(next() * 10)}`;
  if (pick < 0.75) return { nested: { depth: Math.floor(next() * 3) }, list: [1, 'two'] };
  if (pick < 0.85) return null;
  return next() < 0.5;
}

function stylePatch(next: () => number): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  if (next() < 0.6) style.strokeColor = COLORS[Math.floor(next() * COLORS.length)];
  if (next() < 0.4) style.strokeWidth = 1 + Math.floor(next() * 4);
  if (next() < 0.4) style.fillOpacity = Math.round(next() * 10) / 10;
  if (Object.keys(style).length === 0) style.pointColor = COLORS[0];
  return style;
}

function styleRuleOf(next: () => number): StyleRule {
  return next() < 0.5
    ? { kind: 'single', color: COLORS[Math.floor(next() * COLORS.length)] }
    : { kind: 'categorical', property: 'kind', map: { a: COLORS[0] }, other: COLORS[1] };
}

/** One random write, or an undo or a redo */
async function step(
  d: Draw,
  next: () => number,
  ids: { feature: number; layer: number; group: number },
): Promise<void> {
  const pick = <T>(list: readonly T[]): T | undefined =>
    list.length === 0 ? undefined : list[Math.floor(next() * list.length)];
  const features = d.features.list({}, { limit: 100000 }).map((feature) => feature.id);
  const layers = d.layers.list().map((layer) => layer.id);
  const groups = d.groups.list().map((group) => group.id);
  const write = (fn: (tx: Transaction) => Promise<unknown>) =>
    d.write(fn).then(
      () => undefined,
      () => undefined,
    );
  const featureInput = (): FeatureInput => {
    const properties: Record<string, unknown> = {
      [KEY('layerId')]: pick(layers),
    };
    for (const name of NAMES) if (next() < 0.3) properties[name] = randomValue(next);
    if (next() < 0.3) properties[KEY('style')] = stylePatch(next);
    if (next() < 0.1) properties[KEY('visible')] = false;
    return {
      type: 'Feature',
      id: `f${++ids.feature}`,
      geometry: geometryOf(next),
      properties,
    } as FeatureInput;
  };
  const choice = next();
  if (choice < 0.18 || features.length < 3) {
    const count = next() < 0.3 ? 3 : 1;
    const inputs = Array.from({ length: count }, featureInput);
    await write((tx) => tx.features.create(inputs));
  } else if (choice < 0.36) {
    const id = pick(features) as string;
    const properties: Record<string, unknown> = {};
    for (const name of NAMES) if (next() < 0.3) properties[name] = randomValue(next);
    if (next() < 0.3) properties[KEY('style')] = stylePatch(next);
    if (next() < 0.15) properties[KEY('visible')] = next() < 0.5;
    if (next() < 0.1) properties[KEY('locked')] = next() < 0.3;
    const existing = Object.keys(d.features.get(id)?.properties ?? {}).filter(
      (key) => !key.startsWith('maplibre-gl-draw:'),
    );
    const unsetKeys = existing.filter(() => next() < 0.3);
    const styleKeys = Object.keys(
      (d.features.get(id)?.properties[KEY('style')] as object | undefined) ?? {},
    ).filter(() => next() < 0.5);
    const patch = {
      ...(next() < 0.3 && { geometry: geometryOf(next) }),
      ...(Object.keys(properties).length > 0 && { properties }),
      ...((unsetKeys.length > 0 || styleKeys.length > 0) && {
        unset: {
          ...(unsetKeys.length > 0 && { properties: unsetKeys }),
          ...(styleKeys.length > 0 && { style: styleKeys }),
        },
      }),
    };
    if (Object.keys(patch).length === 0) return;
    await write((tx) => tx.features.update(id, patch as FeaturePatch));
  } else if (choice < 0.44) {
    const chosen = features.filter(() => next() < 0.2);
    if (chosen.length > 0) await write((tx) => tx.features.delete(chosen));
  } else if (choice < 0.56) {
    const chosen = features.filter(() => next() < 0.2);
    if (chosen.length === 0) return;
    const other = pick(features) as string;
    const where = next();
    const to: Placement =
      where < 0.3
        ? { layerId: pick(layers) as string }
        : where < 0.5 && groups.length > 0
          ? { groupId: pick(groups) as string }
          : where < 0.75
            ? { below: other }
            : { above: other };
    await write((tx) => tx.features.place(chosen, to));
  } else if (choice < 0.62) {
    const id = `layer${++ids.layer}`;
    await write((tx) => tx.layers.create({ id, name: id }));
  } else if (choice < 0.68) {
    const id = pick(layers) as string;
    const patch = {
      ...(next() < 0.4 && { name: `renamed${Math.floor(next() * 5)}` }),
      ...(next() < 0.3 && { visible: next() < 0.5 }),
      ...(next() < 0.2 && { locked: next() < 0.3 }),
      ...(next() < 0.3 && { styleRule: styleRuleOf(next) }),
    };
    if (Object.keys(patch).length > 0) await write((tx) => tx.layers.update(id, patch));
  } else if (choice < 0.71) {
    if (layers.length > 2) await write((tx) => tx.layers.delete(pick(layers) as string));
  } else if (choice < 0.75) {
    const id = pick(layers) as string;
    const other = pick(layers) as string;
    if (id !== other) await write((tx) => tx.layers.place(id, { below: other }));
  } else if (choice < 0.81) {
    // A group of features of one layer
    const layerId = pick(layers) as string;
    const members = d.features
      .list({ layerId }, { limit: 100000 })
      .map((feature) => feature.id)
      .filter(() => next() < 0.5);
    if (members.length === 0) return;
    const id = `group${++ids.group}`;
    await write((tx) => tx.groups.create({ id, name: id, members }));
  } else if (choice < 0.84) {
    const id = pick(groups);
    if (!id) return;
    await write((tx) =>
      tx.groups.update(id, {
        ...(next() < 0.5 && { name: `g${Math.floor(next() * 5)}` }),
        ...(next() < 0.5 && { visible: next() < 0.5 }),
      }),
    );
  } else if (choice < 0.87) {
    const id = pick(groups);
    if (!id) return;
    const members = next() < 0.5 ? 'keep' : 'delete';
    await write((tx) => tx.groups.delete(id, { members }));
  } else if (choice < 0.89) {
    const id = pick(groups);
    if (!id) return;
    await write((tx) => tx.groups.place(id, { layerId: pick(layers) as string }));
  } else if (choice < 0.91) {
    await write((tx) =>
      tx.document.update(
        next() < 0.5
          ? { title: `title ${Math.floor(next() * 5)}` }
          : { description: `about ${Math.floor(next() * 5)}` },
      ),
    );
  } else if (choice < 0.94) {
    // Several writes in one commit
    const id = pick(features) as string;
    const inputs = [featureInput(), featureInput()];
    await write(async (tx) => {
      await tx.features.create(inputs);
      await tx.features.update(id, { properties: { note: 'together' } });
      await tx.features.place([inputs[0].id as string], { above: inputs[1].id as string });
    });
  } else if (choice < 0.98) {
    await d.undo().catch(() => undefined);
  } else {
    await d.redo().catch(() => undefined);
  }
}

describe('CommitValues', () => {
  for (const [kind, makeStore] of KINDS) {
    it(`gives, applied part by part, the document written out (${kind})`, async () => {
      let total = { commits: 0, parts: 0 };
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const next = random(seed);
        const store = makeStore();
        draw = createDraw(createMapStub().map, { store, initDefaultLayer: false });
        await draw.write(async (tx) => {
          await tx.layers.create({ id: 'a', name: 'A' });
          await tx.layers.create({ id: 'b', name: 'B' });
        });
        const storage = receiver(store, next);
        const ids = { feature: 0, layer: 0, group: 0 };
        for (let i = 0; i < 80; i++) {
          await step(draw, next, ids);
          const written = writtenOf(draw.document.toJSON());
          const stored = storedOf(storage.document);
          if (JSON.stringify(stored) !== JSON.stringify(written)) {
            expect({ seed, step: i, stored }).toEqual({ seed, step: i, stored: written });
          }
        }
        const counts = storage.counts();
        total = { commits: total.commits + counts.commits, parts: total.parts + counts.parts };
        storage.stop();
        draw.destroy();
        draw = undefined;
      }
      // The runs made commits cut into more than one part
      expect(total.parts).toBeGreaterThan(total.commits);
    });

    it(`reads a document as the operations that create it (${kind})`, async () => {
      const store = makeStore();
      draw = createDraw(createMapStub().map, { store, initDefaultLayer: false });
      const next = random(9);
      await draw.write(async (tx) => {
        await tx.layers.create({ id: 'a', name: 'A' });
        await tx.layers.create({ id: 'b', name: 'B' });
      });
      const ids = { feature: 0, layer: 0, group: 0 };
      for (let i = 0; i < 40; i++) await step(draw, next, ids);
      const document = createStoredDocument();
      const { skipped } = applyOperations(document, new CommitValues(store).documentOperations());
      expect(skipped).toEqual([]);
      expect(storedOf(document)).toEqual(writtenOf(draw.document.toJSON()));
    });
  }

  it('gives a file its bytes in base64', () => {
    expect(
      fileRecordOf({ id: 'i', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAEC' }),
    ).toEqual({ mediaType: 'image/png', content: 'AAEC' });
    expect(
      fileRecordOf({ id: 's', mimeType: 'image/svg+xml', dataURL: 'data:image/svg+xml,%3Csvg%3E' }),
    ).toEqual({ mediaType: 'image/svg+xml', content: btoa('<svg>') });
  });
});
