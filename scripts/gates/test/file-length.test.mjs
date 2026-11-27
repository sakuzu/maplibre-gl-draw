// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { check, codeLines, LIMIT } from '../file-length.mjs';
import { cleanUp, tree, write } from './fixture.mjs';

afterEach(cleanUp);

/** A source file of `n` lines of code */
const code = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};\n`).join('');

/** A source file of `n` lines of code, with a comment and a blank line between every two */
const padded = (n) =>
  Array.from({ length: n }, (_, i) => `// the value ${i}\n\nexport const v${i} = ${i};\n`).join('');

const base = () =>
  tree({
    'scripts/gates/file-length-baseline.json': {
      files: { 'src/view/long.ts': 900 },
    },
    'src/view/long.ts': code(900),
    'src/view/short.ts': code(LIMIT),
    'src/view/short.test.ts': code(LIMIT + 200),
    'src/e2e/scene.ts': code(LIMIT + 200),
    'src/test-utils.ts': code(LIMIT + 200),
    'src/types.d.ts': code(LIMIT + 200),
  });

describe('the lines of code of a file', () => {
  it('leaves out the blank lines and the comments', () => {
    const text = [
      '// a comment',
      '/**',
      ' * The documentation',
      ' */',
      'export const a = 1; // a comment after the code',
      '',
      '   ',
      '/* a comment',
      '   over two lines */',
      '/** The documentation of f */',
      'export function f() {',
      '  /* inside */ return a;',
      '}',
      '',
    ].join('\n');
    expect(codeLines(text, 'src/a.ts')).toBe(4);
  });

  it('counts a comment mark in a string, a template literal and a regular expression as code', () => {
    const text = [
      "const s = '// not a comment';",
      'const t = `a template',
      `// in the template \${s} still in it`,
      '/* and this */',
      '`;',
      'const r = /\\/\\/ and \\/\\*/;',
      `const u = \`\${t}\`; // a comment after a template literal`,
      '// a comment after a template literal',
      'export { s, t, r, u };',
      '',
    ].join('\n');
    expect(codeLines(text, 'src/a.ts')).toBe(8);
  });

  it('reads the lines after a template literal with a substitution as code', () => {
    const text = [
      'const a = 1;',
      `const t = \`\${a}\`;`,
      `const b = \`x \${a + \`y \${a}\`} z\`;`,
      '// a comment',
      'export { t, b };',
      '',
    ].join('\n');
    expect(codeLines(text, 'src/a.ts')).toBe(4);
  });
});

describe('the gate of the length of the files', () => {
  it('passes on a tree whose files keep to the limit and to the list', () => {
    expect(check({ root: base() }).errors).toEqual([]);
  });

  it('passes on a file of the limit and on a long file made of comments and blank lines', () => {
    const root = base();
    write(root, { 'src/view/other.ts': padded(LIMIT) });
    expect(check({ root }).errors).toEqual([]);
  });

  it('notes a file of the list that got shorter and is still over the limit', () => {
    const root = base();
    write(root, { 'src/view/long.ts': code(850) });
    const r = check({ root });
    expect(r.errors).toEqual([]);
    expect(r.notes).toEqual(['src/view/long.ts is 850 lines of code, 900 in the baseline']);
  });

  it('fails on a file of the list one line longer than the list gives', () => {
    const root = base();
    write(root, { 'src/view/long.ts': code(901) });
    expect(check({ root }).errors).toEqual([
      'src/view/long.ts: 901 lines of code, the baseline is 900',
    ]);
  });

  it('fails on a file the list does not have, of one line over the limit', () => {
    const root = base();
    write(root, { 'src/view/short.ts': code(LIMIT + 1) });
    expect(check({ root }).errors).toEqual([
      `src/view/short.ts: ${LIMIT + 1} lines of code, more than ${LIMIT}`,
    ]);
  });

  it('fails on a file of the list that is no longer than the limit', () => {
    const root = base();
    write(root, { 'src/view/long.ts': code(LIMIT) });
    expect(check({ root }).errors).toEqual([
      `src/view/long.ts: ${LIMIT} lines of code, no more than ${LIMIT}; remove it from scripts/gates/file-length-baseline.json`,
    ]);
  });

  it('fails on a row of the list whose length is not a whole number over the limit', () => {
    const root = base();
    write(root, {
      'scripts/gates/file-length-baseline.json': {
        files: {
          'src/view/long.ts': 'x',
          'src/view/other.ts': {},
          'src/view/third.ts': 900.5,
          'src/view/fourth.ts': LIMIT,
        },
      },
      'src/view/long.ts': code(5000),
      'src/view/other.ts': code(900),
      'src/view/third.ts': code(900),
      'src/view/fourth.ts': code(900),
    });
    const list = 'of scripts/gates/file-length-baseline.json is not a whole number over';
    expect(check({ root }).errors).toEqual([
      `src/view/long.ts: the length "x" ${list} ${LIMIT}`,
      `src/view/other.ts: the length {} ${list} ${LIMIT}`,
      `src/view/third.ts: the length 900.5 ${list} ${LIMIT}`,
      `src/view/fourth.ts: the length ${LIMIT} ${list} ${LIMIT}`,
    ]);
  });

  it('fails on a list whose files are not an object', () => {
    const root = base();
    write(root, { 'scripts/gates/file-length-baseline.json': { files: ['src/view/long.ts'] } });
    expect(check({ root }).errors).toEqual([
      'the files of scripts/gates/file-length-baseline.json are not an object of the files and their lengths',
    ]);
  });

  it('fails on a file of the list that is gone, or is not a source file of the library', () => {
    const root = base();
    write(root, {
      'scripts/gates/file-length-baseline.json': {
        files: { 'src/view/long.ts': 900, 'src/view/gone.ts': 900, 'src/view/short.test.ts': 1000 },
      },
    });
    expect(check({ root }).errors).toEqual([
      'src/view/gone.ts: not a source file of the library; remove it from scripts/gates/file-length-baseline.json',
      'src/view/short.test.ts: not a source file of the library; remove it from scripts/gates/file-length-baseline.json',
    ]);
  });
});
