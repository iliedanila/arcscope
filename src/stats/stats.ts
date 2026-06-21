import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKnowledge } from '../knowledge/vocab-loader.js';
import { loadAnchorStore } from '../knowledge/drift.js';
import { parseUsageJsonl, summarizeUsage } from './usage-summary.js';

// Human-facing summary of local arcscope usage. Reads only gitignored cache files
// under .arcscope/ — no network, no transcript required. Grep-vs-tool adoption
// still needs scripts/adoption-report.mjs + a session transcript.
export function formatStats(root: string): string {
  const lines: string[] = ['arcscope stats', ''];

  const usagePath = join(root, '.arcscope', 'usage.jsonl');
  if (!existsSync(usagePath)) {
    lines.push('Usage: no .arcscope/usage.jsonl yet (no MCP tool calls recorded).');
  } else {
    const records = parseUsageJsonl(readFileSync(usagePath, 'utf8'));
    const s = summarizeUsage(records);
    lines.push(`Usage: ${s.total} tool call(s) recorded`);
    if (s.firstTs && s.lastTs) lines.push(`  period: ${s.firstTs} → ${s.lastTs}`);
    if (s.total > 0) {
      lines.push('  by tool:');
      for (const [tool, count] of Object.entries(s.byTool).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
        lines.push(`    ${tool}: ${count}`);
      }
      if (s.topSymbols.length) {
        lines.push('  top symbols (find_def / find_refs):');
        for (const { symbol, count } of s.topSymbols) lines.push(`    ${symbol}: ${count}`);
      }
      if (s.topConcepts.length) {
        lines.push('  top concepts (arch_query):');
        for (const { concept, count } of s.topConcepts) lines.push(`    ${concept}: ${count}`);
      }
      if (s.topEntries.length) {
        lines.push('  top entry points (call_graph / flow):');
        for (const { entry, count } of s.topEntries) lines.push(`    ${entry}: ${count}`);
      }
    }
  }

  lines.push('');
  const vocab = loadKnowledge(root);
  const withInvariant = vocab.concepts.filter((c) => c.must).length;
  const flowConcepts = vocab.concepts.filter((c) => c.flow).length;
  lines.push(`Knowledge: ${vocab.concepts.length} concept(s) in .arcscope/assertions.yaml`);
  if (vocab.concepts.length > 0) {
    if (withInvariant) lines.push(`  with must invariant: ${withInvariant}`);
    if (flowConcepts) lines.push(`  flow concepts: ${flowConcepts}`);
  }

  const anchors = loadAnchorStore(root);
  const baselineIds = Object.keys(anchors.concepts);
  lines.push('');
  if (baselineIds.length === 0) {
    lines.push('Drift baselines: none captured yet (run arch_query to establish).');
  } else {
    lines.push(`Drift baselines: ${baselineIds.length} concept(s) with a captured baseline`);
    for (const id of baselineIds.sort()) {
      const captured = anchors.concepts[id]?.capturedAt;
      lines.push(`  ${id}${captured ? ` (since ${captured})` : ''}`);
    }
    lines.push('  (live drift/conformance status: run arch_query on each concept)');
  }

  lines.push('');
  lines.push(
    'Adoption (grep vs arcscope): not observable server-side. Use scripts/adoption-report.mjs with a session transcript.',
  );

  return lines.join('\n');
}

export function stats(root: string): void {
  process.stdout.write(formatStats(root) + '\n');
}
