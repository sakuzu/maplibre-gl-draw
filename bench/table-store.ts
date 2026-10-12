// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Store of the measurement page that holds its features as rows of columns
 *
 * It holds layers and the state of this client, and hands out the tables of its features
 * (`tables`); it holds no feature as an object. The writes of features, groups and files are
 * refused: the page only draws and measures.
 */

import type {
  DocumentChange,
  Feature,
  FeatureTables,
  FileData,
  Group,
  Layer,
  Metadata,
  Mode,
  Selection,
  SelectionType,
  Store,
  UpdateSource,
  VertexSelection,
} from '@sakuzu/maplibre-gl-draw';

export class TableStore implements Store {
  private readonly layers = new Map<string, Layer>();
  private order: string[] = [];
  private selection: Selection = { type: null, ids: [] };
  private editing: string[] = [];
  private vertices: VertexSelection | null = null;
  private mode: Mode = 'select';
  private readOnly = false;
  private locked = false;
  private readonly hidden = new Set<string>();
  private metadata: Metadata = {};
  private readonly listeners = new Set<(changes: DocumentChange) => void>();
  private pending: DocumentChange | null = null;
  private depth = 0;

  constructor(readonly tables: FeatureTables) {}

  // The document: reads

  getFeature(): Feature | undefined {
    return undefined;
  }
  listFeatures(): Feature[] {
    return [];
  }
  listFeaturesInOrder(): Feature[] {
    return [];
  }
  getLayer(id: string): Layer | undefined {
    return this.layers.get(id);
  }
  listLayers(): Layer[] {
    return [...this.layers.values()];
  }
  getLayerOrder(): readonly string[] {
    return this.order;
  }
  getGroup(): Group | undefined {
    return undefined;
  }
  listGroups(): Group[] {
    return [];
  }
  getFile(): FileData | undefined {
    return undefined;
  }
  listFiles(): FileData[] {
    return [];
  }
  getMetadata(): Metadata {
    return this.metadata;
  }

  // The document: writes (the features, groups and files are rows the page does not write)

  createFeature(): boolean {
    return false;
  }
  updateFeature(): boolean {
    return false;
  }
  deleteFeature(): boolean {
    return false;
  }
  createLayer(layer: Layer): boolean {
    if (this.layers.has(layer.id)) return false;
    const created = Object.freeze({ ...layer, items: [] });
    this.layers.set(layer.id, created);
    const previous = this.order;
    if (!this.order.includes(layer.id)) this.order = [...this.order, layer.id];
    this.notify({
      layers: {
        created: [created],
        orderChanged: { order: [...this.order], previous: [...previous] },
      },
    });
    return true;
  }
  updateLayer(id: string, updates: Partial<Layer>): boolean {
    const previous = this.layers.get(id);
    if (!previous) return false;
    const layer = Object.freeze({ ...previous, ...updates, id, items: [] });
    this.layers.set(id, layer);
    this.notify({ layers: { updated: [{ id, layer, previous }] } });
    return true;
  }
  deleteLayer(): boolean {
    return false;
  }
  setLayerOrder(order: string[]): boolean {
    const previous = this.order;
    this.order = [...new Set(order.filter((id) => id !== ''))];
    this.notify({ layers: { orderChanged: { order: [...this.order], previous: [...previous] } } });
    return true;
  }
  reorderInLayer(): boolean {
    return false;
  }
  reorderInGroup(): boolean {
    return false;
  }
  createGroup(): boolean {
    return false;
  }
  updateGroup(): boolean {
    return false;
  }
  deleteGroup(): boolean {
    return false;
  }
  createFile(): boolean {
    return false;
  }
  deleteFile(): boolean {
    return false;
  }
  setMetadata(metadata: Partial<Metadata>): boolean {
    const previous = this.metadata;
    this.metadata = { ...previous, ...metadata };
    this.notify({ metadata: { metadata: this.metadata, previous } });
    return true;
  }

  // The state of this client

  getSelection(): Selection {
    return this.selection;
  }
  setSelection(type: SelectionType | null, ids: string[]): void {
    const previous = this.selection;
    this.selection = { type: ids.length > 0 ? type : null, ids: [...ids] };
    this.notify({
      selection: {
        type: this.selection.type,
        ids: [...this.selection.ids],
        previousType: previous.type,
        previousIds: [...previous.ids],
      },
    });
  }
  getEditingIds(): readonly string[] {
    return this.editing;
  }
  startEditing(ids: string[]): void {
    this.editing = [...new Set([...this.editing, ...ids])];
    this.notify({ editing: { started: [...ids] } });
  }
  endEditing(ids: string[]): void {
    this.editing = this.editing.filter((id) => !ids.includes(id));
    this.notify({ editing: { ended: [...ids] } });
  }
  getVertexSelection(): VertexSelection | null {
    return this.vertices;
  }
  setSelectedVertices(selection: VertexSelection | null): void {
    this.vertices = selection;
    this.notify({});
  }
  getMode(): Mode {
    return this.mode;
  }
  setMode(mode: Mode): void {
    const previous = this.mode;
    this.mode = mode;
    this.notify({ mode: { mode, previous } });
  }
  isReadOnly(): boolean {
    return this.readOnly;
  }
  setReadOnly(value: boolean): void {
    this.readOnly = value;
    this.notify({});
  }
  isInteractionLocked(): boolean {
    return this.locked;
  }
  setInteractionLock(value: boolean): void {
    this.locked = value;
    this.notify({});
  }
  isHidden(id: string): boolean {
    return this.hidden.has(id);
  }
  listHidden(): ReadonlySet<string> {
    return this.hidden;
  }
  setLocallyHidden(id: string, hidden: boolean): void {
    if (hidden) this.hidden.add(id);
    else this.hidden.delete(id);
    this.notify({});
  }

  // Subscription and transactions

  subscribe(listener: (changes: DocumentChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  transact<T>(fn: () => T, source: UpdateSource = 'local'): T {
    this.depth++;
    try {
      return fn();
    } finally {
      this.depth--;
      if (this.depth === 0 && this.pending) {
        const changes = { ...this.pending, source };
        this.pending = null;
        for (const listener of this.listeners) listener(changes);
      }
    }
  }

  /** Notifies a change (folded into the notification of the transaction it is in) */
  private notify(changes: DocumentChange): void {
    if (this.depth > 0) {
      this.pending = { ...this.pending, ...changes };
      return;
    }
    const notification = { ...changes, source: 'local' as const };
    for (const listener of this.listeners) listener(notification);
  }
}
