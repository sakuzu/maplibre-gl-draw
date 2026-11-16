// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { check } from '../entries.mjs';
import { cleanUp, tree } from './fixture.mjs';

afterEach(cleanUp);

const pkg = (names, waiting = []) =>
  tree({
    'package.json': { exports: Object.fromEntries(names.map((n) => [n, `./dist/${n}.js`])) },
    'scripts/gates/api-pending.json': { entries: waiting, samples: [], declarations: {} },
  });

describe('the gate of the entries', () => {
  it('passes on the five entries', () => {
    const root = pkg(['.', './geometry', './table', './webgl', './store', './package.json']);
    expect(check({ root }).errors).toEqual([]);
  });

  it('passes while a missing entry waits in the list', () => {
    const root = pkg(['.', './geometry', './table', './webgl', './package.json'], ['./store']);
    expect(check({ root }).errors).toEqual([]);
  });

  it('fails on an entry kept for the parts that wait for their place', () => {
    const extra = ['.', 'kasane'].join('/');
    const root = pkg(['.', './geometry', './table', './webgl', extra], ['./store']);
    expect(check({ root }).errors.join('\n')).toContain(`not one of the library: ${extra}`);
  });

  it('fails on a missing entry that does not wait', () => {
    const root = pkg(['.', './geometry', './table', './webgl']);
    expect(check({ root }).errors.join('\n')).toContain('an entry is missing: ./store');
  });

  it('fails when an entry that is there still waits', () => {
    const root = pkg(['.', './geometry', './table', './webgl', './store'], ['./store']);
    expect(check({ root }).errors.join('\n')).toContain('./store is there now');
  });
});
