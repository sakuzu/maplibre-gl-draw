// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digestOfKey } from '../api.mjs';
import { readCode } from '../lib/code-text.mjs';
import { recordsOfBuild } from '../lib/declarations.mjs';
import { wordsOf } from '../lib/words.mjs';
import { check } from '../terms.mjs';
import { ABSENT, cleanUp, packageTree, realList, write } from './fixture.mjs';

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
        { where: 'docs/guide.md', term: '\\bhistory', reason: 'the history of git', hits: 1 },
        { where: 'docs/other.md', term: '\\bhistory', reason: 'gone', hits: 1 },
      ],
    });
    write(root, { 'docs/guide.md': 'The history of the edits.\n' });
    const e = errors(root);
    expect(e).not.toContain('docs/guide.md:1');
    expect(e).toContain('matches nothing; remove it: docs/other.md');
  });

  it('reads the identifiers and comments after a template literal with a substitution', () => {
    const root = withTerms();
    write(root, {
      'src/store/memory.ts': [
        'export function label(id: string): string {',
        `  return \`feature \${id} of the layer\`;`,
        '}',
        'export const yjsCrdtServerPeer = 1; // the CRDT server of the peer',
        '',
      ].join('\n'),
    });
    const e = errors(root);
    for (const term of ['crdt', '\\byjs\\b', '\\bservers?\\b', '\\bpeers?\\b(?! dependenc)']) {
      expect(e).toContain(`src/store/memory.ts:4: [${term}]`);
    }
  });

  it('reads the string values and the parts of the template literals of src', () => {
    const root = withTerms();
    write(root, {
      'src/view/kind.ts': [
        "export const kind = 'remote-sync';",
        `export const text = (n: number) => \`\${n} of the history\`;`,
        '',
      ].join('\n'),
    });
    const e = errors(root);
    expect(e).toContain('src/view/kind.ts:1: [\\bsync');
    expect(e).toContain('src/view/kind.ts:2: [\\bhistory]');
  });

  it('reads every identifier and comment of the syntax tree, and counts what it read', () => {
    const code = readCode(
      [
        'class A {',
        `  #first = \`a \${\`b \${/* inner note */ inner} c\`} d\`;`,
        '  /** The size. */',
        '  size = 1; // trailing note',
        '}',
        `export const after = \`\${A}\` + \`\${1}\`; /* last note */`,
        '',
      ].join('\n'),
      'src/a.ts',
    );
    expect(code.identifiers).toBe(code.inTree);
    expect(code.identifiers).toBe(6);
    const text = [...code.lines.values()].join(' ');
    for (const word of ['#first', 'inner note', 'inner', 'The size.', 'trailing note', 'after']) {
      expect(text).toContain(word);
    }
    expect(text).toContain('last note');
    expect(code.comments).toBe(4);
  });

  it('fails when a term is added once more to a place that has an exception for it', () => {
    const root = withTerms({
      allowed: [
        { where: 'docs/guide.md', term: '\\bhistory', reason: 'the history of git', hits: 1 },
      ],
    });
    write(root, { 'docs/guide.md': 'The history of git.\n\nAnd the history of the edits.\n' });
    expect(errors(root)).toContain(
      'docs/guide.md [\\bhistory]: 2 hits, the exception allows 1; new ones were added (the hits: 1, 3)',
    );
  });

  it('fails when a place has fewer hits than its exception allows, and on a row without its number', () => {
    const root = withTerms({
      allowed: [
        { where: 'docs/guide.md', term: '\\bhistory', reason: 'the history of git', hits: 2 },
        { where: 'docs/notes.md', term: '\\bhistory', reason: 'the history of git' },
      ],
    });
    write(root, { 'docs/guide.md': 'The history of git.\n', 'docs/notes.md': 'The history.\n' });
    const e = errors(root);
    expect(e).toContain(
      'docs/guide.md [\\bhistory]: 1 hits, the exception allows 2; lower its hits to 1',
    );
    expect(e).toContain('an exception without the number of its hits: docs/notes.md [\\bhistory]');
  });

  it('reads the declarations that wait for their fixed form: their string values and TSDoc', () => {
    const root = withTerms();
    addMember(
      root,
      "    /** Keeps the things in sync with every copy. */\n    mode: 'send_to_backend_storage';",
    );
    const built = recordsOfBuild(root);
    write(root, {
      'scripts/gates/api-pending.json': {
        entries: ['./store'],
        samples: {},
        declarations: {
          1: { 'store:added:Keeper': ABSENT, 'store:added:Keeper.keep': ABSENT },
          2: { 'main:removed:Thing.mode': digestOfKey(built, 'main:removed:Thing.mode') },
        },
      },
    });
    const e = errors(root);
    for (const term of ['\\bsync', '\\bsend', '\\bbackend', '\\bstorage']) {
      expect(e).toContain(`declarations/main/Thing.mode: [${term}]`);
    }
  });

  it('reads the sources of the other packages and the changelog, but not the samples of api/', () => {
    const root = withTerms();
    write(root, {
      'bench/measure.ts': 'export const syncedRows = 1;\n',
      'playground/main.ts': '// shows the history of the edits\nexport {};\n',
      'ui/src/Panel.svelte': '<script lang="ts">\n  let peer = 1;\n</script>\n',
      'ui/src/rows.ts': 'export const kasaneRows = 1;\n',
      'CHANGELOG.md': '# Changes\n\n- Works with a server.\n',
      'api/samples/sample-keep.ts': '// keeps the history\nexport {};\n',
    });
    const e = errors(root);
    expect(e).toContain('bench/measure.ts:1: [\\bsync');
    expect(e).toContain('playground/main.ts:1: [\\bhistory]');
    expect(e).toContain('ui/src/Panel.svelte:2: [\\bpeers?');
    expect(e).toContain('ui/src/rows.ts:1: [kasane]');
    expect(e).toContain('CHANGELOG.md:3: [\\bservers?\\b]');
    expect(e).not.toContain('api/samples');
  });
});
