import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchGlob } from './glob.js';

test('** matches across segments', () => {
  assert.ok(matchGlob('libs/features/graph/x.ts', 'libs/features/**'));
  assert.ok(matchGlob('src/a/b/c.ts', 'src/**/*.ts'));
  assert.ok(matchGlob('src/c.ts', 'src/**/*.ts'));
});

test('* stays within a segment', () => {
  assert.ok(matchGlob('a/b.ts', '*/*.ts'));
  assert.ok(!matchGlob('a/b/c.ts', '*/*.ts'));
});

test('non-matching prefixes are rejected', () => {
  assert.ok(!matchGlob('lib/x.ts', 'src/**'));
  assert.ok(!matchGlob('src/x.js', 'src/**/*.ts'));
});

test('dots are literal, not wildcards', () => {
  assert.ok(matchGlob('a.ts', 'a.ts'));
  assert.ok(!matchGlob('axts', 'a.ts'));
});
