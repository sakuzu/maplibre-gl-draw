// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The typedoc step of the documentation gate (scripts/docs-check.mjs): a link that does not
// resolve to a name of the fixed declarations waits and is listed, any other issue is an error.

import { describe, expect, it } from 'vitest';
import { classifyTypedocIssues, declaredNames } from '../../docs-check.mjs';

const FIXED = `
export interface Thing {
  /** A field */
  readonly size: number;
  /** An object */
  readonly parts?: {
    first?: string[];
  };
  run(): void;
}
export type Alias = { readonly kind: string };
export declare function makeThing(): Thing;
export declare const KINDS: readonly string[];
`;

const unresolved = (name) =>
  `[warning] Failed to resolve link to "${name}" in comment for package/entry.Somewhere`;

describe('the names of the fixed declarations', () => {
  it('are the top-level names and their members, as a link names them', () => {
    expect([...declaredNames([FIXED])].sort()).toEqual([
      'Alias',
      'Alias.kind',
      'KINDS',
      'Thing',
      'Thing.parts',
      'Thing.parts.first',
      'Thing.run',
      'Thing.size',
      'makeThing',
    ]);
  });
});

describe('the issues of typedoc', () => {
  const fixed = declaredNames([FIXED]);

  it('list a link to a fixed declaration the build does not have yet, and fail on nothing else', () => {
    const r = classifyTypedocIssues(
      [
        'info line',
        unresolved('makeThing'),
        unresolved('Thing.parts.first'),
        unresolved('makeThing'),
        '[warning] Found 0 errors and 3 warnings',
      ],
      fixed,
    );
    expect(r).toEqual({ errors: [], pending: ['makeThing', 'Thing.parts.first'] });
  });

  it('fail on a link to a name the fixed declarations do not have', () => {
    const r = classifyTypedocIssues(
      [unresolved('makeThing'), unresolved('Nothing'), '[warning] Found 0 errors and 2 warnings'],
      fixed,
    );
    expect(r.pending).toEqual(['makeThing']);
    expect(r.errors).toEqual([unresolved('Nothing'), '[warning] Found 0 errors and 2 warnings']);
  });

  it('fail on a member the fixed declarations do not have, even of a fixed declaration', () => {
    const r = classifyTypedocIssues([unresolved('Thing.other')], fixed);
    expect(r).toEqual({ errors: [unresolved('Thing.other')], pending: [] });
  });

  it('fail on any other warning or error', () => {
    const other = '[warning] Thing.size, defined in ./src/x.ts, does not have any documentation';
    const error = '[error] Something went wrong';
    const r = classifyTypedocIssues([other, error, '[warning] Found 1 error and 1 warning'], fixed);
    expect(r).toEqual({
      errors: [other, error, '[warning] Found 1 error and 1 warning'],
      pending: [],
    });
  });
});
