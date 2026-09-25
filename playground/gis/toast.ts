// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Toast
 *
 * A lightweight notification that briefly shows feedback for an action, such as the result
 * of a geometry operation, on top of the map.
 */

export type ToastKind = 'info' | 'warn';

const VISIBLE_MS = 2600;
const LEAVE_MS = 320;

/**
 * Toast notification
 */
export class Toast {
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /**
   * Shows a notification.
   */
  show(message: string, kind: ToastKind = 'info'): void {
    const item = document.createElement('div');
    item.className = `toast toast-${kind}`;
    item.textContent = message;
    this.container.appendChild(item);

    setTimeout(() => {
      item.classList.add('toast-leaving');
      setTimeout(() => {
        item.remove();
      }, LEAVE_MS);
    }, VISIBLE_MS);
  }
}
