import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStats } from './stats.js';

test('formatStats reports usage, knowledge, and adoption note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-stats-'));
  try {
    const arc = join(dir, '.arcscope');
    mkdirSync(arc, { recursive: true });
    writeFileSync(
      join(arc, 'usage.jsonl'),
      '{"ts":"2026-01-01T00:00:00.000Z","tool":"find_def","args":{"symbol":"X"}}\n',
      'utf8',
    );
    writeFileSync(
      join(arc, 'assertions.yaml'),
      'concepts:\n  demo:\n    title: Demo\n    locators:\n      - { kind: path, glob: "src/**" }\n',
      'utf8',
    );
    writeFileSync(
      join(arc, 'anchors.json'),
      JSON.stringify({ concepts: { demo: { anchors: [], capturedAt: '2026-01-01' } } }),
      'utf8',
    );

    const out = formatStats(dir);
    assert.match(out, /1 tool call/);
    assert.match(out, /find_def: 1/);
    assert.match(out, /1 concept\(s\) in \.arcscope\/assertions\.yaml/);
    assert.match(out, /1 concept\(s\) with a captured baseline/);
    assert.match(out, /adoption-report\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
