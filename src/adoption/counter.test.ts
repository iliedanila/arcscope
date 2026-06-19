import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvocationCounter } from './counter.js';

test('records JSONL lines and creates the directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-counter-'));
  try {
    const counter = new InvocationCounter(join(dir, 'nested', 'usage.jsonl'));
    await counter.record('find_def', { symbol: 'Foo' });
    await counter.record('find_def', { symbol: 'Bar', pathGlob: 'src/**' });

    const lines = readFileSync(join(dir, 'nested', 'usage.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!);
    assert.equal(first.tool, 'find_def');
    assert.equal(first.args.symbol, 'Foo');
    assert.ok(typeof first.ts === 'string' && first.ts.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing write never throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-counter-'));
  try {
    // A real file used as a directory segment forces mkdir to fail (ENOTDIR).
    writeFileSync(join(dir, 'blocker'), 'x');
    const counter = new InvocationCounter(join(dir, 'blocker', 'usage.jsonl'));
    // Should resolve without throwing even though mkdir/append fail.
    await counter.record('find_def', { symbol: 'Z' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
