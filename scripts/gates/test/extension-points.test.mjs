// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { check } from '../extension-points.mjs';
import { cleanUp, packageTree, write } from './fixture.mjs';

afterEach(cleanUp);

const points = (list) => ({ 'scripts/gates/extension-points.json': { points: list } });

describe('the gate of the extension points', () => {
  it('passes when every point is in the build and in the fixed declarations', () => {
    const root = packageTree(points([{ key: 'Thing.move' }, { key: 'Options' }]));
    expect(check({ root }).errors).toEqual([]);
  });

  it('fails when the build loses a point', () => {
    const root = packageTree(points([{ key: 'Thing.move' }]));
    const file = join(root, 'dist/api/thing.d.ts');
    write(root, {
      'dist/api/thing.d.ts': readFileSync(file, 'utf8').replace(
        / {4}\/\*\*\n {5}\* Moves[\s\S]*?boolean;\n/,
        '',
      ),
    });
    expect(check({ root }).errors.join('\n')).toContain(
      'Thing.move: the build has lost this extension point',
    );
  });

  it('fails when the fixed declarations do not have a point', () => {
    const root = packageTree(points([{ key: 'Thing.turn' }]));
    expect(check({ root }).errors.join('\n')).toContain(
      'Thing.turn: the fixed declarations do not have',
    );
  });

  it('keeps a point a change took out while the build still has it, and fails once it is gone', () => {
    const taken = { key: 'Thing.shape', removed: { change: 9, why: 'test' }, pending: true };
    const root = packageTree(points([taken]));
    write(root, {
      'api/core.main.d.ts': readFileSync(join(root, 'api/core.main.d.ts'), 'utf8').replace(
        '  /** The shape of the thing. */\n  shape: Feature;\n',
        '',
      ),
    });
    expect(check({ root }).errors).toEqual([]);
    const file = join(root, 'dist/api/thing.d.ts');
    write(root, {
      'dist/api/thing.d.ts': readFileSync(file, 'utf8').replace(
        '    /** The shape of the thing. */\n    shape: GeoJSONFeature;\n',
        '',
      ),
    });
    expect(check({ root }).errors.join('\n')).toContain('Thing.shape is out of the build now');
  });
});
