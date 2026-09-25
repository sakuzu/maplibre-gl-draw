// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The render scope belongs to one draw instance
 *
 * The terrain state and the caches keyed by feature id are created per CustomLayer, so two
 * instances never share them; the selection scope is the one handed in (shared with the modes
 * of the same instance).
 */

import { describe, expect, it } from 'vitest';
import { createSelectionScope } from '../ui/selection-scope.js';
import { createRenderScope } from './render-scope.js';

describe('createRenderScope', () => {
  it('gives each draw instance its own terrain state and caches', () => {
    const editor = createRenderScope(createSelectionScope());
    const preview = createRenderScope(createSelectionScope());

    expect(editor.terrain).not.toBe(preview.terrain);
    expect(editor.earcut).not.toBe(preview.earcut);
    expect(editor.styleRules).not.toBe(preview.styleRules);

    editor.earcut.set('same', [0, 1, 2]);
    expect(preview.earcut.get('same')).toBeNull();
  });

  it('keeps the selection scope it was given (the one the modes of the instance use)', () => {
    const selection = createSelectionScope();
    expect(createRenderScope(selection).selection).toBe(selection);
  });
});
