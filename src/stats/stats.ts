import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { loadKnowledge } from '../knowledge/vocab-loader.js';
import { loadAnchorStore } from '../knowledge/drift.js';
import { formatAdoptionSection } from '../adoption/report.js';
import { parseUsageJsonl, summarizeUsage } from './usage-summary.js';

// Human-facing summary of local arcscope usage — everything in one place: how much
// it's used (.arcscope/usage.jsonl), the committed knowledge + drift baselines, and
// whether the agent actually reached for arcscope over grep (grep-vs-tool adoption,
// read from the newest Claude Code session transcript for this repo). Fully local:
// no network, reads only cache files and the local transcript store.
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
  const transcriptPath = latestTranscript(basename(root));
  const transcriptRaw = transcriptPath ? safeRead(transcriptPath) : null;
  for (const l of formatAdoptionSection(transcriptPath, transcriptRaw)) lines.push(l);

  return lines.join('\n');
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// Newest *.jsonl under ~/.claude/projects/*<filter>* (Claude Code's transcript
// store), or null when nothing matches — then the adoption ratio is unavailable.
function latestTranscript(projectFilter: string): string | null {
  if (!projectFilter) return null;
  const base = join(homedir(), '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(base);
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestMs = -1;
  for (const d of dirs) {
    if (!d.includes(projectFilter)) continue;
    let files: string[];
    try {
      files = readdirSync(join(base, d));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(base, d, f);
      const ms = statSync(p).mtimeMs;
      if (ms > bestMs) {
        bestMs = ms;
        best = p;
      }
    }
  }
  return best;
}

export function stats(root: string): void {
  process.stdout.write(formatStats(root) + '\n');
}
