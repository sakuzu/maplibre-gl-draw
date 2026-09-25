// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CursorManager
 *
 * Responsible for managing the mouse cursor state.
 */

import type { SelectionUIConfig } from '../shared/config/selection.js';
import type { CoordinateTransform } from '../shared/math/index.js';
import type { Feature } from '../store/types.js';
import {
  getCursorForHandle,
  type HandleHitResult,
  hitTestHandles,
} from '../view/ui/handle-test.js';
import type { SelectionScope } from '../view/ui/selection-scope.js';
import type { BoundingBoxCoords } from '../view/ui/selection-ui/index.js';

/**
 * Cursor management class
 *
 * @internal
 */
export class CursorManager {
  private canvas: HTMLCanvasElement;
  private defaultCursor: string;

  constructor(canvas: HTMLCanvasElement, defaultCursor = 'default') {
    this.canvas = canvas;
    this.defaultCursor = defaultCursor;
  }

  /**
   * Sets the default cursor
   */
  setDefault(): void {
    this.canvas.style.cursor = this.defaultCursor;
  }

  /**
   * Sets the cursor
   */
  set(cursor: string): void {
    this.canvas.style.cursor = cursor;
  }

  /**
   * Sets the cursor based on the handle hit result
   */
  setForHandle(handleHit: HandleHitResult): void {
    this.canvas.style.cursor = getCursorForHandle(handleHit);
  }

  /**
   * Sets the pointer cursor
   */
  setPointer(): void {
    this.canvas.style.cursor = 'pointer';
  }

  /**
   * Sets the text cursor
   */
  setText(): void {
    this.canvas.style.cursor = 'text';
  }

  /**
   * Updates the cursor based on the selected features and the mouse position
   *
   * @returns true if a handle was hit
   */
  updateForSelection(
    screenPoint: { x: number; y: number },
    selectedFeatures: Feature[],
    bbox: BoundingBoxCoords | null,
    transform: CoordinateTransform,
    config: SelectionUIConfig,
    zoom: number,
    scope: SelectionScope,
  ): boolean {
    if (!bbox || selectedFeatures.length === 0) {
      return false;
    }

    const handleHit = hitTestHandles(screenPoint, selectedFeatures, transform, config, zoom, scope);

    if (handleHit) {
      this.setForHandle(handleHit);
      return true;
    }

    return false;
  }
}
