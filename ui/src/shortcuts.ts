// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The keyboard shortcuts of the interface: the key of each tool and Delete and Backspace for the
// selection. kata's Shell listens for them on the document.
//
// Core listens for its own keys on the map's canvas (Delete, Backspace and Escape among them),
// and those events go on to the document. A shortcut that core also has declines an event from
// the canvas, so that the key does not act twice.

import type { Shortcut } from '@sakuzu/kata/svelte';
import type { Messages } from './messages.js';
import { shortcutKey } from './tools.js';
import type { DrawUIDraw, ToolSpec } from './types.js';

/** Whether a key event comes from the map's canvas, where core has handled it already */
export function fromMapCanvas(draw: Pick<DrawUIDraw, 'getMap'>, e: KeyboardEvent): boolean {
  return e.target === draw.getMap().getCanvas();
}

/** The shortcuts of the tools and of the delete button */
export function toolbarShortcuts(
  draw: DrawUIDraw,
  specs: readonly ToolSpec[],
  messages: Messages,
  deletable: boolean,
): Shortcut[] {
  const out: Shortcut[] = [];
  for (const spec of specs) {
    if (!spec.shortcut) continue;
    out.push({
      key: shortcutKey(spec.shortcut),
      label: spec.label,
      group: messages.toolsGroup,
      // setMode returns false when the mode cannot be entered now: the key goes on
      run: () => draw.setMode(spec.mode),
    });
  }
  if (deletable) {
    for (const key of ['delete', 'backspace']) {
      out.push({
        key,
        label: messages.deleteSelection,
        group: messages.editGroup,
        when: () => draw.selection.get().ids.length > 0,
        run: (e) => !fromMapCanvas(draw, e) && draw.selection.delete(),
      });
    }
  }
  return out;
}
