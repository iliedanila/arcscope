import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { runFindDef } from './find-def.js';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-finddef-'));
  mkdirSync(join(dir, 'a'));
  mkdirSync(join(dir, 'b'));
  writeFileSync(join(dir, 'a', 'widget.ts'), 'export class Widget {}\nexport function helper(){}');
  writeFileSync(join(dir, 'b', 'widget.ts'), 'export class Widget {}'); // same name, different file
  return dir;
}

test('find_def returns all matches, scopes by glob, and reports not-found', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());

    const all = await runFindDef(store, { symbol: 'Widget' });
    assert.equal(all.records.length, 2);
    assert.ok(all.records.every((r) => r.kind === 'class'));
    assert.match(all.text, /2 definitions of `Widget`/);

    const scoped = await runFindDef(store, { symbol: 'Widget', pathGlob: 'a/**' });
    assert.equal(scoped.records.length, 1);
    assert.equal(scoped.records[0]?.file, 'a/widget.ts');

    const helper = await runFindDef(store, { symbol: 'helper' });
    assert.equal(helper.records.length, 1);
    assert.equal(helper.records[0]?.kind, 'function');

    const missing = await runFindDef(store, { symbol: 'DoesNotExist' });
    assert.equal(missing.records.length, 0);
    assert.match(missing.text, /No definition of `DoesNotExist`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lazy re-index picks up edits without a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-reindex-'));
  try {
    const file = join(dir, 'm.ts');
    writeFileSync(file, 'export const original = 1;');
    const store = new IndexStore(dir, new GrammarRegistry());

    const before = await runFindDef(store, { symbol: 'added' });
    assert.equal(before.records.length, 0);

    // Edit the file; bump mtime is implicit in writeFileSync.
    writeFileSync(file, 'export const original = 1;\nexport function added(){}');
    const after = await runFindDef(store, { symbol: 'added' });
    assert.equal(after.records.length, 1);
    assert.equal(after.records[0]?.kind, 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
