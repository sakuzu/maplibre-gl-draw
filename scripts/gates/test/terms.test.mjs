// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { wordsOf } from '../lib/words.mjs';
import { check } from '../terms.mjs';
import { cleanUp, packageTree, realList, write } from './fixture.mjs';

afterEach(cleanUp);

/** A made-up product name, standing for the names of the local lists */
const PRODUCT = 'Acmemaps';

function withTerms({ local = true, allowed = [] } = {}) {
  const root = packageTree({
    'scripts/gates/terms.json': realList('terms.json'),
    'scripts/gates/terms-allowed.json': { allowed },
    ...(local
      ? {
          'scripts/terms.local/product.json': {
            documents: [
              { name: 'product name', source: `\\b${PRODUCT.toLowerCase()}\\b`, flags: 'i' },
            ],
          },
        }
      : {}),
    'src/shared/clean.ts': '// Brings two values in line\nexport const clean = 1;\n',
  });
  return root;
}

/** Adds a member to the built declaration of Thing */
function addMember(root, member) {
  const file = join(root, 'dist/api/thing.d.ts');
  const text = readFileSync(file, 'utf8');
  write(root, {
    'dist/api/thing.d.ts': text.replace(
      '    shape: GeoJSONFeature;\n',
      `    shape: GeoJSONFeature;\n${member}\n`,
    ),
  });
}

const errors = (root, env = {}) => check({ root, env }).errors.join('\n');

describe('cutting text into words', () => {
  it('cuts camelCase, snake_case, kebab-case and capitals the same way', () => {
    for (const s of [
      'remoteClient',
      'remote_client',
      'remote-client',
      'REMOTE_CLIENT',
      '"Remote client"',
    ]) {
      expect(wordsOf(s)).toBe('remote client');
    }
    expect(wordsOf('XMLHttpRequest')).toBe('xml http request');
  });
});

describe('the gate of the forbidden terms', () => {
  it('passes on a tree without the terms', () => {
    expect(check({ root: withTerms(), env: {} }).errors).toEqual([]);
  });

  it('finds the name of the row library in an identifier of the declarations, in any case', () => {
    const root = withTerms();
    addMember(root, '    /** The table. */\n    kasaneTable: number;');
    expect(errors(root)).toContain('declarations/main/Thing.kasaneTable: [kasane]');
  });

  it('finds the name of the row library in the TSDoc without quotes', () => {
    const root = withTerms();
    addMember(root, '    /** Rows kept by Kasane. */\n    kept: number;');
    expect(errors(root)).toContain('declarations/main/Thing.kept: [kasane]');
  });

  it('finds a general term in the TSDoc and in a snake_case identifier', () => {
    const root = withTerms();
    addMember(
      root,
      '    /** Keeps the things in sync. */\n    keep: number;\n    /** Kept. */\n    last_sync_at: number;',
    );
    const e = errors(root);
    expect(e).toContain('declarations/main/Thing.keep: [\\bsync');
    expect(e).toContain('declarations/main/Thing.last_sync_at: [\\bsync');
  });

  it('finds a general term inside a camelCase identifier', () => {
    const root = withTerms();
    addMember(root, '    /** The id. */\n    ownerId: string;');
    expect(errors(root)).toContain('declarations/main/Thing.ownerId: [\\bowner');
  });

  it('finds a term in a kebab-case string value', () => {
    const root = withTerms();
    addMember(root, "    /** The kind. */\n    kind: 'remote-client' | 'local';");
    expect(errors(root)).toContain('declarations/main/Thing.kind: [\\bremote (client');
  });

  it('finds the product name of the local lists in an identifier and in the TSDoc', () => {
    const root = withTerms();
    addMember(
      root,
      `    /** Made for ${PRODUCT.toUpperCase()}. */\n    made: number;\n    /** The id. */\n    ${PRODUCT.toLowerCase()}Id: string;`,
    );
    const e = errors(root);
    expect(e).toContain('declarations/main/Thing.made: [(local)');
    expect(e).toContain(`declarations/main/Thing.${PRODUCT.toLowerCase()}Id: [(local)`);
  });

  it('finds the short name of the extension as a word of its own, and not inside provider or property', () => {
    const root = withTerms();
    addMember(
      root,
      '    /** The provider of the property. */\n    providerProperty: string;\n    /** On. */\n    proPlugin: boolean;',
    );
    const e = errors(root);
    expect(e).not.toContain('Thing.providerProperty');
    expect(e).toContain('declarations/main/Thing.proPlugin: [\\bpro\\b]');
  });

  it('looks in the identifiers and comments of src, the names of the tests, the documents and the examples', () => {
    const root = withTerms();
    write(root, {
      'src/view/draw.ts': '// draws what the peer sent\nexport const serverTime = 1;\n',
      'src/view/draw.test.ts':
        "import { it } from 'vitest';\nit('keeps the copies in sync', () => {});\n",
      'docs/guide.md': '# Guide\n\nThe history of the edits.\n',
      'examples/main.ts': `// ${PRODUCT} example\nexport {};\n`,
    });
    const e = errors(root);
    expect(e).toContain('src/view/draw.ts:1: [\\bpeers?');
    expect(e).toContain('src/view/draw.ts:2: [\\bservers?\\b]');
    expect(e).toContain('src/view/draw.test.ts:2: [\\bsync');
    expect(e).toContain('docs/guide.md:3: [\\bhistory]');
    expect(e).toContain('examples/main.ts:1: [(local)');
  });

  it('lets the code of src use the name of the row library, but not the documents', () => {
    const root = withTerms();
    write(root, {
      'src/store/rows.ts': '// the tables of kasane\nexport const kasaneTables = 1;\n',
      'docs/rows.md': 'Rows are kept in Kasane.\n',
    });
    const e = errors(root);
    expect(e).not.toContain('src/store/rows.ts');
    expect(e).toContain('docs/rows.md:1: [kasane]');
  });

  it('fails without the local lists', () => {
    const root = withTerms({ local: false });
    expect(errors(root)).toContain(
      'the local lists of product and extension names are not present',
    );
  });

  it('passes without the local lists only in the CI of the public repository, with a notice', () => {
    const root = withTerms({ local: false });
    const r = check({ root, env: { GITHUB_ACTIONS: 'true' } });
    expect(r.errors).toEqual([]);
    expect(r.notes.join('\n')).toContain('are not present');
  });

  it('lets a listed exception through, and fails on one that matches nothing', () => {
    const root = withTerms({
      allowed: [
        { where: 'docs/guide.md', term: '\\bhistory', reason: 'the history of git' },
        { where: 'docs/other.md', term: '\\bhistory', reason: 'gone' },
      ],
    });
    write(root, { 'docs/guide.md': 'The history of the edits.\n' });
    const e = errors(root);
    expect(e).not.toContain('docs/guide.md:1');
    expect(e).toContain('matches nothing; remove it: docs/other.md');
  });
});
