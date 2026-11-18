// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { check as checkBranch } from '../branch.mjs';
import { check as checkTests } from '../test-changes.mjs';
import { cleanUp, git, tree, write } from './fixture.mjs';

afterEach(cleanUp);

/** A repository with main, and redesign/main and redesign/work cut from it */
function repo() {
  const root = tree({
    'src/a.ts': 'export const a = 1;\n',
    'src/a.test.ts': "import { it } from 'vitest';\nit('reads a', () => {});\n",
    'src/e2e/page.ts': 'export const page = 1;\n',
    'scripts/gates/test-changes-allowed.json': { allowed: [] },
    'scripts/gates/provenance.json': { files: [] },
  });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Start');
  git(root, 'branch', 'redesign/main');
  git(root, 'checkout', '-q', '-b', 'redesign/work');
  return root;
}

/** An old branch from main with one file of its own */
function oldBranch(root, name) {
  git(root, 'checkout', '-q', '-b', name, 'main');
  write(root, {
    'scripts/old-check.mjs': '// an old check\nconsole.log("old check of the old branch");\n',
  });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Add an old check');
  git(root, 'checkout', '-q', 'redesign/work');
}

describe('the gate of the changes to the tests', () => {
  it('passes when no test changed, and on a new test file', () => {
    const root = repo();
    write(root, { 'src/b.test.ts': "import { it } from 'vitest';\nit('reads b', () => {});\n" });
    expect(checkTests({ root }).errors).toEqual([]);
  });

  it('fails when a test file that is not listed is changed, even before the commit', () => {
    const root = repo();
    write(root, {
      'src/a.test.ts': "import { it } from 'vitest';\nit('reads a again', () => {});\n",
    });
    expect(checkTests({ root }).errors.join('\n')).toContain('changes src/a.test.ts');
  });

  it('fails when a file of the end-to-end tests is deleted', () => {
    const root = repo();
    git(root, 'rm', '-q', 'src/e2e/page.ts');
    git(root, 'commit', '-q', '-m', 'Remove');
    expect(checkTests({ root }).errors.join('\n')).toContain('deletes src/e2e/page.ts');
  });

  it('fails when a test file that is not listed is changed and committed on redesign/main', () => {
    const root = repo();
    git(root, 'checkout', '-q', 'redesign/main');
    write(root, {
      'src/a.test.ts': "import { it } from 'vitest';\nit('reads a again', () => {});\n",
    });
    git(root, 'commit', '-q', '-am', 'Change a test');
    expect(checkTests({ root }).errors.join('\n')).toContain('changes src/a.test.ts');
  });

  it('passes on a listed change', () => {
    const root = repo();
    write(root, {
      'src/a.test.ts': "import { it } from 'vitest';\nit('reads a again', () => {});\n",
      'scripts/gates/test-changes-allowed.json': {
        allowed: [{ path: 'src/a.test.ts', change: '7', unit: 'U-1' }],
      },
    });
    expect(checkTests({ root }).errors).toEqual([]);
  });
});

describe('the gate of the branch', () => {
  it('passes on a work branch with nothing from an old branch', () => {
    expect(checkBranch({ root: repo() }).errors).toEqual([]);
  });

  it('fails on a branch whose name does not start with redesign/', () => {
    const root = repo();
    git(root, 'checkout', '-q', '-b', 'feature/x');
    expect(checkBranch({ root }).errors.join('\n')).toContain('the branch is feature/x');
  });

  it('fails on a merge commit with a parent from an old branch', () => {
    const root = repo();
    oldBranch(root, 'rebuild/old');
    git(root, 'merge', '-q', '--no-ff', '--no-edit', '-m', 'Take the work', 'rebuild/old');
    expect(checkBranch({ root }).errors.join('\n')).toContain('has a parent from an old branch');
  });

  it('fails on a merge commit that names an old branch, even once the branch is gone', () => {
    const root = repo();
    oldBranch(root, 'proto/try');
    git(root, 'merge', '-q', '--no-ff', '--no-edit', 'proto/try');
    git(root, 'branch', '-q', '-D', 'proto/try');
    expect(checkBranch({ root }).errors.join('\n')).toContain('merges an old branch');
  });

  it('fails on a file copied from an old branch without its row, and passes with it', () => {
    const root = repo();
    oldBranch(root, 'design/old');
    write(root, {
      'scripts/gates/copied.mjs': '// an old check\nconsole.log("old check of the old branch");\n',
    });
    expect(checkBranch({ root }).errors.join('\n')).toContain(
      'scripts/gates/copied.mjs has the content of a file of an old branch',
    );
    write(root, {
      'scripts/gates/provenance.json': {
        files: [
          {
            branch: 'design/old',
            commit: 'abc',
            from: 'scripts/old-check.mjs',
            to: 'scripts/gates/copied.mjs',
          },
        ],
      },
    });
    expect(checkBranch({ root }).errors).toEqual([]);
    rmSync(join(root, 'scripts/gates/copied.mjs'));
  });

  it('fails on a copy of a file of an old branch with a line break added', () => {
    const root = repo();
    oldBranch(root, 'rebuild/old');
    write(root, {
      'scripts/gates/copied.mjs':
        '// an old check\nconsole.log("old check of the old branch");\n\n',
      'scripts/gates/indented.mjs':
        '  // an old check\n  console.log("old check of the old branch");\n',
    });
    const e = checkBranch({ root }).errors.join('\n');
    expect(e).toContain(
      'scripts/gates/copied.mjs has the content of a file of an old branch but for its whitespace',
    );
    expect(e).toContain('scripts/gates/indented.mjs has the content of a file of an old branch');
  });

  it('does not count a file of main that an old branch only spaced differently', () => {
    const root = repo();
    git(root, 'checkout', '-q', '-b', 'rebuild/spaced', 'main');
    write(root, { 'src/a.ts': 'export const a  =  1;\n\n' });
    git(root, 'commit', '-q', '-am', 'Space a');
    git(root, 'checkout', '-q', 'redesign/work');
    expect(checkBranch({ root }).errors).toEqual([]);
  });
});
