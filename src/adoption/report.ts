// Pure adoption logic for `arcscope stats`. Given a Claude Code session transcript,
// it classifies each search/navigation tool call as arcscope vs grep vs ToolSearch
// and tallies arcscope's share of (arcscope + grep) — the objective grep-vs-tool
// signal the server can't see on its own (it only records its own calls). No I/O
// here: stats.ts finds and reads the transcript, then calls formatAdoptionSection.

export type ToolKind = 'arcscope' | 'grep' | 'search';

export interface ClassifiedCall {
  kind: ToolKind;
  detail: string;
}

// Match a grep-family tool only as the *first word of a command segment* — so an
// actual `grep …` / `find … | rg …` / `git grep …` counts, but a
// `git commit -m "…grep…"` or `echo "…grep…"` (the word merely mentioned) does
// not. Segments split on the shell separators that start a new command:
// | ; && || and newlines.
const GREP_CMD_RE = /^(grep|rg|ripgrep|fgrep|egrep|ag|ack)\b/;
const GIT_GREP_RE = /^git\s+grep\b/;

function isGrepCommand(cmd: string): boolean {
  return cmd.split(/[\n;|&]+/).some((seg) => {
    const s = seg.trim();
    return GREP_CMD_RE.test(s) || GIT_GREP_RE.test(s);
  });
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Classify a single tool_use. Returns null for calls that aren't code search/nav
// (Read, Edit, …) — only the decisive grep-vs-tool calls belong in the timeline.
export function classifyToolCall(name: string, input: Record<string, unknown>): ClassifiedCall | null {
  if (name.startsWith('mcp__arcscope__')) {
    return { kind: 'arcscope', detail: `${name.replace('mcp__arcscope__', '')} ${JSON.stringify(input)}` };
  }
  if (name === 'Grep') {
    const where = typeof input.path === 'string' ? ` in ${input.path}` : '';
    return { kind: 'grep', detail: `Grep ${str(input.pattern)}${where}` };
  }
  if (name === 'Glob') return { kind: 'grep', detail: `Glob ${str(input.pattern)}` };
  if (name === 'ToolSearch') return { kind: 'search', detail: `ToolSearch "${str(input.query)}"` };
  if (name === 'Bash') {
    const cmd = str(input.command);
    if (isGrepCommand(cmd)) return { kind: 'grep', detail: `Bash: ${cmd.slice(0, 90)}` };
  }
  return null;
}

// Walk a JSONL transcript in order, emitting one ClassifiedCall per matched
// tool_use. Malformed lines and non-message events are skipped — the report must
// be resilient to partial/streamed transcripts.
export function buildTimeline(transcriptRaw: string): ClassifiedCall[] {
  const timeline: ClassifiedCall[] = [];
  for (const line of transcriptRaw.split('\n')) {
    if (!line.trim()) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (ev as { message?: { content?: unknown } })?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === 'tool_use' && typeof c.name === 'string') {
        const cls = classifyToolCall(c.name, (c.input as Record<string, unknown>) ?? {});
        if (cls) timeline.push(cls);
      }
    }
  }
  return timeline;
}

export interface AdoptionTotals {
  arcscope: number;
  grep: number;
  search: number;
  /** arcscope / (arcscope + grep), as a whole-number percentage; 0 when neither occurred. */
  sharePct: number;
}

export function tally(timeline: ClassifiedCall[]): AdoptionTotals {
  let arcscope = 0;
  let grep = 0;
  let search = 0;
  for (const c of timeline) {
    if (c.kind === 'arcscope') arcscope++;
    else if (c.kind === 'grep') grep++;
    else search++;
  }
  const decisive = arcscope + grep;
  return { arcscope, grep, search, sharePct: decisive ? Math.round((arcscope / decisive) * 100) : 0 };
}

// The "Adoption (grep vs arcscope)" block of `arcscope stats`, as output lines.
// transcriptPath is null when no transcript was found for the repo; transcriptRaw
// is null when a transcript was found but couldn't be read — distinct cases so the
// message isn't misleading. Replay is Claude Code-only (see latestTranscript).
export function formatAdoptionSection(transcriptPath: string | null, transcriptRaw: string | null): string[] {
  if (!transcriptPath) {
    return ['Adoption (grep vs arcscope): no Claude Code session transcript found for this repo (the grep-vs-tool ratio needs one).'];
  }
  if (transcriptRaw === null) {
    return [`Adoption (grep vs arcscope): could not read session transcript at ${transcriptPath}.`];
  }
  const timeline = buildTimeline(transcriptRaw);
  const lines = [`Adoption (grep vs arcscope) — from ${transcriptPath}:`];
  if (timeline.length === 0) {
    lines.push('  (no search/navigation tool calls in this transcript)');
    return lines;
  }
  for (const c of timeline) {
    const mark = c.kind === 'arcscope' ? 'arcscope ✅' : c.kind === 'grep' ? 'grep     🔎' : 'search   🔍';
    lines.push(`  ${mark}  ${c.detail}`);
  }
  const t = tally(timeline);
  lines.push(`  totals: arcscope ${t.arcscope} · grep/Glob/Bash ${t.grep} · ToolSearch ${t.search}`);
  lines.push(`  arcscope share of (arcscope + grep): ${t.sharePct}%`);
  return lines;
}
