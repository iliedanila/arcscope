import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageJsonl, summarizeUsage } from './usage-summary.js';

test('parseUsageJsonl skips blank and malformed lines', () => {
  const raw = [
    '',
    '{"ts":"2026-01-01T00:00:00.000Z","tool":"find_def","args":{"symbol":"Foo"}}',
    'not json',
    '{"ts":"2026-01-02T00:00:00.000Z","tool":"arch_query","args":{"concept":"tokens"}}',
  ].join('\n');
  const records = parseUsageJsonl(raw);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.tool, 'find_def');
  assert.equal(records[1]!.args.concept, 'tokens');
});

test('summarizeUsage aggregates by tool and top symbols/concepts', () => {
  const records = parseUsageJsonl(
    [
      '{"ts":"2026-01-01T00:00:00.000Z","tool":"find_def","args":{"symbol":"A"}}',
      '{"ts":"2026-01-01T00:01:00.000Z","tool":"find_def","args":{"symbol":"A"}}',
      '{"ts":"2026-01-01T00:02:00.000Z","tool":"find_refs","args":{"symbol":"B"}}',
      '{"ts":"2026-01-01T00:03:00.000Z","tool":"arch_query","args":{"concept":"c1"}}',
      '{"ts":"2026-01-01T00:04:00.000Z","tool":"call_graph","args":{"entry":"main"}}',
    ].join('\n'),
  );
  const s = summarizeUsage(records);
  assert.equal(s.total, 5);
  assert.equal(s.byTool.find_def, 2);
  assert.equal(s.byTool.find_refs, 1);
  assert.equal(s.topSymbols[0]!.symbol, 'A');
  assert.equal(s.topSymbols[0]!.count, 2);
  assert.equal(s.topConcepts[0]!.concept, 'c1');
  assert.equal(s.topEntries[0]!.entry, 'main');
});
