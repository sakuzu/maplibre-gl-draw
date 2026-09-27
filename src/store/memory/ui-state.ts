// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The local state of a client, in memory, in two parts
 *
 * - MemoryClientState: the state of this client that the Store contract holds (selection,
 *   editing, vertex selection, mode, read-only, interaction lock, local visibility). The
 *   in-memory Store keeps it next to the document.
 * - MemoryDrawingState: the state only the drawing reads (the geometry being drawn, the box
 *   selection, the drag, the vertices that follow along). Core keeps it around whatever Store
 *   holds the rest.
 *
 * Each setter merges its change into the ChangeBus it was given: the selection, the editing
 * and the mode with their categories, the geometry being drawn with `tentative`, and the rest
 * with the uiStateChanged flag.
 */

import type {
  BoxSelection,
  DragState,
  Mode,
  Selection,
  SelectionType,
  TentativeState,
  VertexSelection,
} from '../types.js';
import type { ChangeBus } from './change-bus.js';

/**
 * The state of this client the Store contract holds, in memory
 *
 * @internal
 */
export class MemoryClientState {
  readonly #bus: ChangeBus;

  #selection: Selection = { type: null, ids: [] };
  #editingIds: string[] = [];
  #selectedVertices: VertexSelection | null = null;
  #mode: Mode = 'select';
  // Read-only (forbids local writes to the document). Local state, not part of the document.
  #readOnly = false;
  // Interaction lock (selection is allowed, but starting an edit operation is suppressed).
  // Local state that is orthogonal to readOnly and not part of the document. It does not stop writes
  // to the Store; it only rejects the start of an editing interaction from user input, for a
  // screen where the drawing is looked at and selected but not edited.
  #interactionLocked = false;
  // The set of hidden ids for this client only (feature / group / layer). It is a layer separate
  // from the visible flag of the document, and rendering, hit testing and box selection all
  // respect it. Not part of the document.
  readonly #locallyHidden = new Set<string>();

  constructor(bus: ChangeBus) {
    this.#bus = bus;
  }

  // Selection

  getSelection(): Selection {
    return { type: this.#selection.type, ids: [...this.#selection.ids] };
  }

  setSelection(type: SelectionType | null, ids: string[]): void {
    const previousType = this.#selection.type;
    const previousIds = [...this.#selection.ids];
    this.#selection = { type, ids: [...ids] };
    this.#bus.merge({
      selection: { type, ids: [...ids], previousType, previousIds },
    });
  }

  // Editing

  getEditingIds(): readonly string[] {
    // Returning the internal array as is would let a retained snapshot be rewritten by a later
    // startEditing/endEditing, so a defensive copy is returned.
    return [...this.#editingIds];
  }

  startEditing(ids: string[]): void {
    const newIds = ids.filter((id) => !this.#editingIds.includes(id));
    if (newIds.length === 0) return;
    this.#editingIds.push(...newIds);
    this.#bus.merge({ editing: { started: newIds } });
  }

  endEditing(ids: string[]): void {
    const endedIds = ids.filter((id) => this.#editingIds.includes(id));
    if (endedIds.length === 0) return;
    this.#editingIds = this.#editingIds.filter((id) => !ids.includes(id));
    this.#bus.merge({ editing: { ended: endedIds } });
  }

  // VertexSelection

  getVertexSelection(): VertexSelection | null {
    return this.#selectedVertices;
  }

  setSelectedVertices(selection: VertexSelection | null): void {
    this.#selectedVertices = selection
      ? {
          featureId: selection.featureId,
          vertices: selection.vertices.map((ref) => ({ ...ref })),
        }
      : null;
    this.#bus.merge({ uiStateChanged: true });
  }

  // Mode

  getMode(): Mode {
    return this.#mode;
  }

  setMode(mode: Mode): void {
    const previous = this.#mode;
    if (mode === previous) return;
    this.#mode = mode;
    this.#bus.merge({ mode: { mode, previous } });
  }

  // ReadOnly

  isReadOnly(): boolean {
    return this.#readOnly;
  }

  setReadOnly(value: boolean): void {
    if (this.#readOnly === value) return;
    this.#readOnly = value;
    // Whether handles are shown depends on read-only, so prompt a re-render.
    this.#bus.merge({ uiStateChanged: true });
  }

  // InteractionLock

  isInteractionLocked(): boolean {
    return this.#interactionLocked;
  }

  setInteractionLock(value: boolean): void {
    if (this.#interactionLocked === value) return;
    this.#interactionLocked = value;
    // While the interaction lock is on, no handles are shown (only the selection box), so
    // prompt a re-render.
    this.#bus.merge({ uiStateChanged: true });
  }

  // LocallyHidden

  isHidden(id: string): boolean {
    return this.#locallyHidden.has(id);
  }

  listHidden(): ReadonlySet<string> {
    return this.#locallyHidden;
  }

  setLocallyHidden(id: string, hidden: boolean): void {
    const changed = hidden ? !this.#locallyHidden.has(id) : this.#locallyHidden.has(id);
    if (!changed) return;
    if (hidden) this.#locallyHidden.add(id);
    else this.#locallyHidden.delete(id);
    this.#bus.merge({ uiStateChanged: true });
  }
}

/**
 * The state only the drawing reads, in memory
 *
 * @internal
 */
export class MemoryDrawingState {
  readonly #bus: ChangeBus;

  #tentative: TentativeState | null = null;
  #boxSelection: BoxSelection | null = null;
  #dragState: DragState | null = null;
  #followedVertices: VertexSelection[] | null = null;

  constructor(bus: ChangeBus) {
    this.#bus = bus;
  }

  // Tentative

  getTentative(): TentativeState | null {
    return this.#tentative;
  }

  setTentative(state: TentativeState | null): void {
    const previous = this.#tentative;
    this.#tentative = state ? { ...state, coordinates: [...state.coordinates] } : null;
    this.#bus.merge({ tentative: { state: this.#tentative, previous } });
  }

  // BoxSelection

  getBoxSelection(): BoxSelection | null {
    return this.#boxSelection;
  }

  setBoxSelection(box: BoxSelection | null): void {
    this.#boxSelection = box
      ? {
          startPoint: [...box.startPoint],
          endPoint: [...box.endPoint],
          previousSelection: [...box.previousSelection],
        }
      : null;
    this.#bus.merge({ uiStateChanged: true });
  }

  // DragState

  getDragState(): DragState | null {
    return this.#dragState;
  }

  setDragState(state: DragState | null): void {
    this.#dragState = state
      ? {
          operation: state.operation,
          activeVertex: state.activeVertex ? { ...state.activeVertex } : undefined,
          activeFeatureId: state.activeFeatureId,
          rotateInfo: state.rotateInfo,
          movingFeatureIds: state.movingFeatureIds ? [...state.movingFeatureIds] : undefined,
        }
      : null;
    this.#bus.merge({ uiStateChanged: true });
  }

  // FollowedVertices (vertices that follow along when shared vertices move together. Set only
  // during a drag)

  getFollowedVertices(): VertexSelection[] | null {
    return this.#followedVertices;
  }

  setFollowedVertices(selections: VertexSelection[] | null): void {
    // Since null is written every time a drag ends, null -> null is not notified (raising
    // uiStateChanged every time would cause a wasteful re-render).
    if (this.#followedVertices === null && (selections === null || selections.length === 0)) {
      return;
    }
    this.#followedVertices =
      selections && selections.length > 0
        ? selections.map((selection) => ({
            featureId: selection.featureId,
            vertices: selection.vertices.map((ref) => ({ ...ref })),
          }))
        : null;
    this.#bus.merge({ uiStateChanged: true });
  }
}
