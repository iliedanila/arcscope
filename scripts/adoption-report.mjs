#!/usr/bin/env node
// Adoption-gate measurement. Reads a Claude Code session transcript and the target
// repo's .arcscope/usage.jsonl, and reports — in chronological order — which
// search/navigation tool the agent reached for: arcscope's find_def (a win) vs
// grep/Glob/Bash-grep. This is the objective grep-vs-tool signal for the kill-gate
// (the server can only see its own calls; the transcript shows the grep side).
//
// Usage:
//   node scripts/adoption-report.mjs <transcript.jsonl> --repo <repoPath>
//   node scripts/adoption-report.mjs --repo <repoPath> --project=<name>
//     (finds the newest transcript under ~/.claude/projects/*<name>*)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
let transcriptPath = argv.find((a) => a.endsWith('.jsonl'));
const repoIdx = argv.indexOf('--repo');
const repo = repoIdx >= 0 ? argv[repoIdx + 1] : null;
const projectArg = argv.find((a) => a.startsWith('--project='));
const projectFilter = projectArg?.split('=')[1];

if (!repo) {
  console.error('Usage: node scripts/adoption-report.mjs <transcript.jsonl> --repo <repoPath>');
  console.error('   or: node scripts/adoption-report.mjs --repo <repoPath> --project=<name>');
  process.exit(1);
}

function latestTranscript() {
  if (!projectFilter) return null;
  const base = join(homedir(), '.claude', 'projects');
  let best = null;
  let bestMs = -1;
  for (const d of readdirSync(base)) {
    if (!d.includes(projectFilter)) continue;
    let files;
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

transcriptPath ||= latestTranscript();
if (!transcriptPath) {
  console.error('No transcript found. Pass one explicitly or use --project=<name>.');
  process.exit(1);
}

const GREP_RE = /\b(grep|rg|ripgrep|fgrep|egrep|ag|ack)\b/;

function classify(name, input) {
  if (name.startsWith('mcp__arcscope__')) {
    return { kind: 'arcscope', detail: `${name.replace('mcp__arcscope__', '')} ${JSON.stringify(input)}` };
  }
  if (name === 'Grep') return { kind: 'grep', detail: `Grep ${input.pattern ?? ''}${input.path ? ' in ' + input.path : ''}` };
  if (name === 'Glob') return { kind: 'grep', detail: `Glob ${input.pattern ?? ''}` };
  if (name === 'ToolSearch') return { kind: 'search', detail: `ToolSearch "${input.query ?? ''}"` };
  if (name === 'Bash' && GREP_RE.test(input.command ?? '')) return { kind: 'grep', detail: `Bash: ${(input.command ?? '').slice(0, 90)}` };
  return null;
}

const timeline = [];
for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }
  const content = ev.message?.content;
  if (!Array.isArray(content)) continue;
  for (const c of content) {
    if (c?.type === 'tool_use') {
      const cls = classify(c.name, c.input ?? {});
      if (cls) timeline.push(cls);
    }
  }
}

const counts = { arcscope: 0, grep: 0, search: 0 };
console.log(`\nTranscript: ${transcriptPath}`);
console.log('\n=== search/navigation tool timeline (chronological) ===');
if (timeline.length === 0) console.log('  (no search/nav tool calls found)');
for (const t of timeline) {
  counts[t.kind]++;
  const mark = t.kind === 'arcscope' ? 'arcscope ✅' : t.kind === 'grep' ? 'grep     🔎' : 'search   🔍';
  console.log(`  ${mark}  ${t.detail}`);
}

const decisive = counts.arcscope + counts.grep;
console.log('\n=== totals ===');
console.log(`  arcscope find_def : ${counts.arcscope}`);
console.log(`  grep / Glob / Bash: ${counts.grep}`);
console.log(`  ToolSearch        : ${counts.search}`);
console.log(`  find_def share of (find_def + grep): ${decisive ? Math.round((counts.arcscope / decisive) * 100) : 0}%`);

try {
  const usage = readFileSync(join(repo, '.arcscope', 'usage.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  console.log(`\n=== server-side counter: ${usage.length} arcscope tool call(s) in ${repo}/.arcscope/usage.jsonl ===`);
  for (const l of usage) {
    const u = JSON.parse(l);
    console.log(`  ${u.ts}  ${u.tool}  ${JSON.stringify(u.args)}`);
  }
} catch {
  console.log(`\n(no .arcscope/usage.jsonl in ${repo} yet — no arcscope tool calls recorded server-side)`);
}
