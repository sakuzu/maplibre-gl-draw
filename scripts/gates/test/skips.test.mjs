// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { check } from '../skips.mjs';
import { cleanUp, tree, write } from './fixture.mjs';

afterEach(cleanUp);

// The marks are written in pieces, so that this file does not count as one that has them
const SKIP = ['it', 'skip'].join('.');
const TODO = ['it', 'todo'].join('.');
const FAILS = ['test', 'fails'].join('.');
const KNOWN = ['known', 'failures'].join(' ');

const base = (extra = {}) =>
  tree({
    'scripts/gates/skips-baseline.json': {
      marks: {},
      known: {},
      allowances: { 'src/e2e/draw.e2e.test.ts:TOLERANCE_DEG': 0.00002 },
    },
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
    expect(e).toContain('TOLERANCE_DEG = 0.0002: wider than the baseline');
    expect(e).toContain('NEW_THRESHOLD = 3: an allowance the baseline does not have');
  });
});
