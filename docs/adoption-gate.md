# Phase 0 adoption kill-gate

The single load-bearing bet of arcscope is **adoption**: does a real coding agent
reach for `find_def` instead of grep, *unprompted*? A registered-but-ignored tool
is worthless. This is an empirical gate with a kill-criterion — run it before
investing in Phase 1.

> arcscope can only observe its **own** invocations (it appends them to
> `.arcscope/usage.jsonl`). It cannot see the agent's grep/Glob calls from inside
> the server — read those from the session transcript. The gate is therefore a
> human-in-the-loop measurement, not something the server self-scores.

## Kill-criterion (state it before running)

> On **≥ 70%** of the navigation tasks below, the agent invokes `find_def`
> **unprompted, as its first navigation move** (not after grep/Glob has already
> failed), in a fresh session where the tool was never named.

Below that, after tuning the three levers (next section), the wedge's "precise
nav" half is failing — **stop and rethink before building Phase 1.**

## How to run

1. In the **target repo** (the dogfood repo `knowledge-graph`), register arcscope
   and add the nudge:
   - `node /Users/ilie/workspace/arcscope/dist/index.js init` (writes `.mcp.json`,
     pointing at the locally-resolved bin — offline spawn).
   - Add the [CLAUDE.md nudge](#lever-3-claudemd-nudge) to that repo's `CLAUDE.md`.
2. Start a **fresh** agent session in that repo (cold context — the tool must be
   *discovered*, not pre-loaded into the conversation).
3. Paste the tasks **one at a time**. Do **not** mention arcscope, `find_def`, or
   "use the MCP tool". Observe the agent's first navigation action.
4. Score each task: did it call `find_def` first (✓), call it only after grep (~),
   or never (✗)? Compute the ✓ rate.
5. After the run, inspect `.arcscope/usage.jsonl` for the tool-call record and the
   transcript for grep/Glob calls to compute the grep-vs-tool ratio. Then
   `rm -rf .arcscope` and revert the CLAUDE.md nudge if you don't want to keep it.

## Tasks (never name the tool)

Each has a verified answer (resolved live by `find_def` against the current tree).

| # | Prompt to paste | Expected answer |
|---|---|---|
| 1 | "Where is the `GraphReducer` class defined?" | `libs/features/graph/src/lib/state/graph.reducer.ts:100` (class) |
| 2 | "I need to change how editor actions are routed — find where `ActionRouterService` lives." | `libs/features/graph/src/lib/services/core/action-router.service.ts:71` (class) |
| 3 | "Find the `GraphEditorFacade` definition so I can read its public surface." | `libs/features/graph/src/lib/services/core/graph-editor.facade.ts:82` (class) |
| 4 | "Where is the shape plugin registry implemented?" | `PluginRegistryService` — `libs/features/graph/src/lib/services/plugin-registry.service.ts:22` (class) |
| 5 | "Locate `GraphEditorStateService`." | `libs/features/graph/src/lib/services/core/graph-editor-state.service.ts:36` (class) |
| 6 | "Is there a document normalizer? Where is it defined?" | `DocumentNormalizerService` — `libs/features/graph/src/lib/services/persistence/document-normalizer.service.ts:62` (class) |
| 7 | "How many places define a `normalizeElement` — list each one." | 12 sites: interface decl, `base-shape.plugin`, `table`/`text` plugin overrides, `document-normalizer.service`, plugin-sdk interface, specs |
| 8 | "Where is the `CORE_PLUGIN_PROVIDERS` list declared?" | `libs/features/graph/src/lib/plugins/core-plugin-providers.ts:24` (constant) |

Tasks 7 and 8 are the strongest grep-beaters: 7 distinguishes `[method]` vs
`[function]` across many same-named sites; 8 finds an exported constant that text
search buries under every usage site.

## The three levers (tune in this order, re-run after each)

### Lever 1 — server `instructions`
Highest leverage; surfaced by the client at session start. Defined in
[`src/server/serve.ts`](../src/server/serve.ts) (`INSTRUCTIONS`). Frame *when* to
reach for the tool, not what it does internally.

### Lever 2 — `find_def` tool `description`
"Use when…" phrasing, specific keywords ("where is X defined", "definition",
"class/function/interface"). Also in `serve.ts` (`FIND_DEF_DESCRIPTION`).

### Lever 3 — CLAUDE.md nudge
Project rules take precedence over MCP discovery — the backstop. Add to the
**target repo's** `CLAUDE.md` (it has no existing navigation guidance):

```md
## Code navigation

When you need to find **where a symbol is defined** (a class, function, method,
interface, type, enum, or exported constant), call the `find_def` tool instead of
grepping. It parses the code with tree-sitter and returns the exact definition
site and signature, skipping the comments and same-named false positives that text
search hits.
```

## Measuring the run

Two data sources, combined by [`scripts/adoption-report.mjs`](../scripts/adoption-report.mjs):

1. **Server-side** — `.arcscope/usage.jsonl` (gitignored, never networked), one line
   per `find_def` call: `{"ts":"…","tool":"find_def","args":{"symbol":"GraphReducer"}}`.
2. **Client-side** — the Claude Code session transcript, which records *every* tool
   call (the grep side the server can't see). arcscope's tool appears there as
   `mcp__arcscope__find_def`.

Run after (or during) a gate session:

```bash
node scripts/adoption-report.mjs                 # newest knowledge-graph transcript
node scripts/adoption-report.mjs <transcript.jsonl>   # a specific session
```

It prints a chronological timeline of every search/nav call (`arcscope` vs `grep`
vs `ToolSearch`), the totals, and the `find_def` share of `(find_def + grep)` — the
number the kill-criterion is measured against.
