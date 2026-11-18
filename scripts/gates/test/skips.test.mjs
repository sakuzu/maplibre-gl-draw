// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { check } from '../skips.mjs';
import { cleanUp, tree, write } from './fixture.mjs';

afterEach(cleanUp);

// The marks are written in pieces, so that this file does not count as one that has them
const SKIP = ['it', 'skip'].join('.');
const TODO = ['it', 'todo'].join('.');
const FAILS = ['test', 'fails'].join('.');
const KNOWN = ['known', 'failures'].join(' ');

const CONFIG = `import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'src/e2e/**'],
    coverage: { include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts'] },
  },
});
`;
const E2E_CONFIG = `import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['src/e2e/**/*.test.ts'] } });
`;

const base = (extra = {}) =>
  tree({
    'scripts/gates/skips-baseline.json': {
      marks: {},
      known: {},
      allowances: { 'src/e2e/draw.e2e.test.ts:TOLERANCE_DEG': '2e-5' },
      configs: {
        'vitest.config.ts': {
          include: "['src/**/*.test.ts']",
          exclude: "[... configDefaults.exclude, 'src/e2e/**']",
        },
        'src/e2e/vitest.config.ts': { include: "['src/e2e/**/*.test.ts']", exclude: null },
      },
    },
    'vitest.config.ts': CONFIG,
    'src/e2e/vitest.config.ts': E2E_CONFIG,
    'src/a.test.ts': "import { it } from 'vitest';\nit('adds', () => {});\n",
    'src/e2e/draw.e2e.test.ts': 'const TOLERANCE_DEG = 2e-5;\nexport {};\n',
    ...extra,
  });

describe('the gate of the tests left out', () => {
  it('passes on the baseline', () => {
    expect(check({ root: base() }).errors).toEqual([]);
  });

  it('fails when a test is left out', () => {
    const root = base();
    write(root, { 'src/a.test.ts': `import { it } from 'vitest';\n${SKIP}('adds', () => {});\n` });
    expect(check({ root }).errors.join('\n')).toContain('src/a.test.ts: 1 marks');
  });

  it('fails on the other marks too', () => {
    const root = base();
    write(root, {
      'src/b.test.ts': `${TODO}('later');\n${FAILS}('breaks', () => {});\nit('x', { ${'skip'}: true }, () => {});\n`,
    });
    expect(check({ root }).errors.join('\n')).toContain('src/b.test.ts: 3 marks');
  });

  it('fails on a list of failures that are accepted', () => {
    const root = base();
    write(root, { 'src/e2e/list.ts': `// the ${KNOWN} of the browser\nexport const LIST = [];\n` });
    expect(check({ root }).errors.join('\n')).toContain(`mentions of ${KNOWN}`);
  });

  it('fails when an allowance of an end-to-end test is widened, or a new one is added', () => {
    const root = base();
    write(root, {
      'src/e2e/draw.e2e.test.ts':
        'const TOLERANCE_DEG = 2e-4;\nconst NEW_THRESHOLD = 3;\nexport {};\n',
    });
    const e = check({ root }).errors.join('\n');
    expect(e).toContain('TOLERANCE_DEG = 2e-4: the baseline gives it as 2e-5');
    expect(e).toContain('NEW_THRESHOLD = 3: an allowance the baseline does not have');
  });

  it('fails when an allowance is widened by an expression', () => {
    const root = base();
    write(root, { 'src/e2e/draw.e2e.test.ts': 'const TOLERANCE_DEG = 2e-5 * 100;\nexport {};\n' });
    expect(check({ root }).errors.join('\n')).toContain(
      'TOLERANCE_DEG = 2e-5 * 100: the baseline gives it as 2e-5',
    );
  });

  it('does not fail when only the whitespace of an allowance changes', () => {
    const root = base();
    write(root, { 'src/e2e/draw.e2e.test.ts': 'const TOLERANCE_DEG =   2e-5 ;\nexport {};\n' });
    expect(check({ root }).errors).toEqual([]);
  });

  it('fails when the configuration leaves a folder of tests out', () => {
    const root = base();
    write(root, {
      'vitest.config.ts': CONFIG.replace(
        "exclude: [...configDefaults.exclude, 'src/e2e/**'],",
        "exclude: [...configDefaults.exclude, 'src/e2e/**', 'src/geometry/**'],",
      ),
    });
    expect(check({ root }).errors.join('\n')).toContain(
      "vitest.config.ts: the exclude of the tests is [... configDefaults.exclude, 'src/e2e/**', 'src/geometry/**']",
    );
  });

  it('fails when the configuration of the end-to-end tests includes fewer files, or is gone', () => {
    const root = base();
    write(root, {
      'src/e2e/vitest.config.ts': E2E_CONFIG.replace('**/*.test.ts', 'draw.e2e.test.ts'),
    });
    expect(check({ root }).errors.join('\n')).toContain(
      "src/e2e/vitest.config.ts: the include of the tests is ['src/e2e/draw.e2e.test.ts']",
    );
    rmSync(join(root, 'src/e2e/vitest.config.ts'));
    expect(check({ root }).errors.join('\n')).toContain(
      'src/e2e/vitest.config.ts: the configuration of the tests is missing',
    );
  });
});
