import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePatch, folderTree } from './patch';

test('parsePatch maps hunks, additions and deletions', () => {
  const patch = [
    '@@ -1,4 +1,5 @@',
    ' a',
    '-b',
    '+B',
    '+B2',
    ' c',
    ' d',
    '@@ -10,2 +11 @@ fn()',
    ' x',
    '-y',
    '\\ No newline at end of file',
  ].join('\n');
  assert.deepEqual(parsePatch(patch), {
    newRanges: [[1, 5], [11, 11]],
    oldRanges: [[1, 4], [10, 11]],
    added: [2, 3],
    deletedAt: [2, 12],
  });
});

test('parsePatch handles new files and missing patches', () => {
  assert.deepEqual(parsePatch('@@ -0,0 +1,2 @@\n+a\n+b'), { newRanges: [[1, 2]], oldRanges: [], added: [1, 2], deletedAt: [] });
  assert.deepEqual(parsePatch(undefined), { newRanges: [], oldRanges: [], added: [], deletedAt: [] });
});

test('folderTree: folders first, sorted, single-child chains compacted', () => {
  const tree = folderTree(['README.md', 'src/app/util.ts', 'src/app/main.ts', 'docs/a/b/guide.md', 'src/index.ts'], (p) => p);
  assert.deepEqual(tree, [
    { name: 'docs/a/b', path: 'docs/a/b', children: ['docs/a/b/guide.md'] },
    { name: 'src', path: 'src', children: [{ name: 'app', path: 'src/app', children: ['src/app/main.ts', 'src/app/util.ts'] }, 'src/index.ts'] },
    'README.md',
  ]);
});
