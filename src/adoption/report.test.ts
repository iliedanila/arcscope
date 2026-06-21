import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, classifyToolCall, formatAdoptionSection, tally } from './report.js';

test('classifyToolCall labels arcscope, grep, glob, bash-grep, toolsearch — and ignores the rest', () => {
  assert.equal(classifyToolCall('mcp__arcscope__find_def', { symbol: 'X' })?.kind, 'arcscope');
  assert.equal(classifyToolCall('mcp__arcscope__arch_query', { concept: 'tokens' })?.kind, 'arcscope');
  assert.equal(classifyToolCall('Grep', { pattern: 'foo' })?.kind, 'grep');
  assert.equal(classifyToolCall('Glob', { pattern: '*.ts' })?.kind, 'grep');
  assert.equal(classifyToolCall('Bash', { command: 'rg foo src' })?.kind, 'grep');
  assert.equal(classifyToolCall('Bash', { command: 'cat x.ts | grep foo' })?.kind, 'grep');
  assert.equal(classifyToolCall('Bash', { command: 'git grep -l foo' })?.kind, 'grep');
  assert.equal(classifyToolCall('Bash', { command: 'ls -la' }), null);
  // mentions of "grep" that aren't an actual grep invocation must NOT count
  assert.equal(classifyToolCall('Bash', { command: 'git commit -m "prefer arcscope over grep"' }), null);
  assert.equal(classifyToolCall('Bash', { command: 'echo "see grep usage" && node x.js' }), null);
  assert.equal(classifyToolCall('ToolSearch', { query: 'q' })?.kind, 'search');
  assert.equal(classifyToolCall('Read', { file_path: 'a.ts' }), null);
});

test('buildTimeline + tally compute arcscope share of (arcscope + grep)', () => {
  const transcript = [
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'mcp__arcscope__find_def', input: { symbol: 'A' } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'A' } }] } }),
    'not json — skipped',
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'mcp__arcscope__find_refs', input: { symbol: 'A' } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'q' } }] } }),
  ].join('\n');

  const timeline = buildTimeline(transcript);
  assert.equal(timeline.length, 4);
  const t = tally(timeline);
  assert.equal(t.arcscope, 2);
  assert.equal(t.grep, 1);
  assert.equal(t.search, 1);
  assert.equal(t.sharePct, 67); // 2 / (2 + 1) = 67%
});

test('formatAdoptionSection renders the ratio, and notes a missing transcript', () => {
  const noTranscript = formatAdoptionSection(null, null).join('\n');
  assert.match(noTranscript, /no Claude Code session transcript found for this repo/);

  // a transcript that was found but couldn't be read is a distinct, non-misleading case
  const unreadable = formatAdoptionSection('/tmp/session.jsonl', null).join('\n');
  assert.match(unreadable, /could not read session transcript at \/tmp\/session\.jsonl/);

  const transcript = [
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'mcp__arcscope__find_def', input: { symbol: 'A' } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'A' } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'mcp__arcscope__find_refs', input: { symbol: 'A' } }] } }),
  ].join('\n');
  const section = formatAdoptionSection('/tmp/session.jsonl', transcript).join('\n');
  assert.match(section, /from \/tmp\/session\.jsonl/);
  assert.match(section, /arcscope ✅/);
  assert.match(section, /grep     🔎/);
  assert.match(section, /arcscope share of \(arcscope \+ grep\): 67%/);
});
