import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverFiles, isSourceFile } from './discover.js';

test('isSourceFile accepts TS/JS family, rejects .d.ts and others', () => {
  for (const ok of ['a.ts', 'a.tsx', 'a.mts', 'b.js', 'b.jsx', 'b.mjs', 'b.cjs']) {
    assert.ok(isSourceFile(ok), ok);
  }
  for (const no of ['a.d.ts', 'a.d.mts', 'a.json', 'a.css', 'README.md']) {
    assert.ok(!isSourceFile(no), no);
  }
});

test('walk fallback finds sources and skips node_modules/dist/dotdirs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-discover-'));
  try {
    writeFileSync(join(dir, 'keep.ts'), 'export const a = 1;');
    writeFileSync(join(dir, 'types.d.ts'), 'export declare const z: number;');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'nested.tsx'), 'export const b = 2;');
    for (const skip of ['node_modules', 'dist', '.git']) {
      mkdirSync(join(dir, skip));
      writeFileSync(join(dir, skip, 'ignored.ts'), 'export const c = 3;');
    }
    const found = discoverFiles(dir).map((f) => f.slice(dir.length + 1)).sort();
    assert.deepEqual(found, ['keep.ts', 'sub/nested.tsx']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
