// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { check } from '../deps.mjs';
import { cleanUp, realList, tree } from './fixture.mjs';

afterEach(cleanUp);

const pkg = (fields) =>
  tree({
    'package.json': fields,
    'scripts/gates/deps-allowed.json': realList('deps-allowed.json'),
  });

describe('the gate of the dependencies', () => {
  it('passes on the dependencies of the published version', () => {
    const root = pkg({
      dependencies: {
        '@types/geojson': '1',
        earcut: '1',
        'polygon-clipping': '1',
        rbush: '1',
        ulid: '1',
      },
      peerDependencies: { 'maplibre-gl': '1' },
    });
    expect(check({ root }).errors).toEqual([]);
  });

  it('fails on a dependency that is not listed', () => {
    const root = pkg({ dependencies: { earcut: '1', 'left-pad': '1' } });
    expect(check({ root }).errors.join('\n')).toContain(
      'dependencies of package.json has left-pad',
    );
  });

  it('fails on a peer dependency or an optional one that is not listed', () => {
    const root = pkg({ peerDependencies: { react: '1' }, optionalDependencies: { yjs: '1' } });
    const e = check({ root }).errors.join('\n');
    expect(e).toContain('peerDependencies of package.json has react');
    expect(e).toContain('optionalDependencies of package.json has yjs');
  });
});
