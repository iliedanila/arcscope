import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from './grammar-registry.js';
import { IndexStore } from './index-store.js';

test('deleting a file evicts only its symbols', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-store-'));
  try {
    writeFileSync(join(dir, 'a.ts'), 'export class Foo {}');
    writeFileSync(join(dir, 'b.ts'), 'export class Foo {}\nexport function bar(){}');
    const store = new IndexStore(dir, new GrammarRegistry());
    await store.sync();
    assert.equal(store.find('Foo').length, 2);
    assert.equal(store.find('bar').length, 1);

    rmSync(join(dir, 'b.ts'));
    const stats = await store.sync();
    assert.equal(stats.removed, 1);
    assert.equal(store.find('Foo').length, 1); // a.ts still defines Foo
    assert.equal(store.find('bar').length, 0); // bar fully evicted, key dropped
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('editing a file does not leak its stale definitions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-store-'));
  try {
    const f = join(dir, 'm.ts');
    writeFileSync(f, 'export function gone(){}\nexport function kept(){}');
    const store = new IndexStore(dir, new GrammarRegistry());
    await store.sync();
    assert.equal(store.find('gone').length, 1);

    writeFileSync(f, 'export function kept(){}'); // `gone` removed
    const stats = await store.sync();
    assert.equal(stats.changed, 1);
    assert.equal(store.find('gone').length, 0);
    assert.equal(store.find('kept').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unchanged files are not re-indexed on a repeat sync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-store-'));
  try {
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;');
    const store = new IndexStore(dir, new GrammarRegistry());
    assert.equal((await store.sync()).changed, 1);
    const second = await store.sync();
    assert.equal(second.changed, 0);
    assert.equal(second.removed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
