// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MemoryUiState
 *
 * The in-memory UiState core holds for every Store (selection / editing / tentative /
 * boxSelection / dragState / vertexSelection / mode / read-only / interaction lock / local
 * visibility). Each setter merges its change into the ChangeBus of the Store.
 *
 * - Selection / mode / features being edited / Tentative are included in data change
 *   notifications
 * - BoxSelection / DragState / VertexSelection are UI-only state, so they only raise the
 *   uiStateChanged flag
 */

import type { UiState } from '../store.js';
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

export class MemoryUiState implements UiState {
  readonly #bus: ChangeBus;

  #selection: Selection = { type: null, ids: [] };
  #editingIds: string[] = [];
  #tentative: TentativeState | null = null;
  #boxSelection: BoxSelection | null = null;
  #dragState: DragState | null = null;
  #selectedVertices: VertexSelection | null = null;
  #followedVertices: VertexSelection[] | null = null;
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

  /**
   * Removes a deleted feature, group or layer from the selection (internal use)
   */
  removeFromSelection(id: string): void {
    const previousType = this.#selection.type;
    const previousIds = this.#selection.ids;
    if (!previousIds.includes(id)) return;

    const ids = previousIds.filter((selected) => selected !== id);
    const type = ids.length === 0 ? null : previousType;
    this.#selection = { type, ids };
    this.#bus.merge({
      selection: { type, ids: [...ids], previousType, previousIds: [...previousIds] },
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

  /** Removal from editing that accompanies a feature deletion (internal use) */
  removeFromEditing(featureId: string): void {
    const idx = this.#editingIds.indexOf(featureId);
    if (idx === -1) return;
    this.#editingIds.splice(idx, 1);
    this.#bus.merge({ editing: { ended: [featureId] } });
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

  // VertexSelection

  getSelectedVertices(): VertexSelection | null {
    return this.#selectedVertices;
  }

  setSelectedVertices(selection: VertexSelection | null): void {
    this.#selectedVertices = selection
      ? {
          featureId: selection.featureId,
          vertexIndices: selection.vertexIndices.map((ref) => ({ ...ref })),
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
            vertexIndices: selection.vertexIndices.map((ref) => ({ ...ref })),
          }))
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

  isLocallyHidden(id: string): boolean {
    return this.#locallyHidden.has(id);
  }

  getLocallyHidden(): ReadonlySet<string> {
    return this.#locallyHidden;
  }

  setLocallyHidden(id: string, hidden: boolean): void {
    const changed = hidden ? !this.#locallyHidden.has(id) : this.#locallyHidden.has(id);
    if (!changed) return;
    if (hidden) this.#locallyHidden.add(id);
    else this.#locallyHidden.delete(id);
    this.#bus.merge({ uiStateChanged: true });
  }

  /** Removes a deleted feature / group / layer from the hidden set (internal use). */
  removeFromLocallyHidden(id: string): void {
    if (this.#locallyHidden.delete(id)) {
      this.#bus.merge({ uiStateChanged: true });
    }
  }
}
