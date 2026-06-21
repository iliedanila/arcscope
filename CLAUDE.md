# CLAUDE.md — arcscope

Behavioral guidelines to reduce common LLM coding mistakes, followed by the rules for this project.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

-   State your assumptions explicitly. If uncertain, ask.
-   If multiple interpretations exist, present them - don't pick silently.
-   If a simpler approach exists, say so. Push back when warranted.
-   If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

-   No features beyond what was asked.
-   No abstractions for single-use code.
-   No "flexibility" or "configurability" that wasn't requested.
-   No error handling for impossible scenarios.
-   If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

-   Don't "improve" adjacent code, comments, or formatting.
-   Don't refactor things that aren't broken.
-   Match existing style, even if you'd do it differently.
-   If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

-   Remove imports/variables/functions that YOUR changes made unused.
-   Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

-   "Add validation" → "Write tests for invalid inputs, then make them pass"
-   "Fix the bug" → "Write a test that reproduces it, then make it pass"
-   "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## Project: arcscope

**arcscope** is a fully-local MCP server that an AI coding agent drives to navigate an unknown codebase: where a symbol is defined and who references it, the module/dependency graph, and — the differentiator — a repo-declared **architecture vocabulary** answered *live* against current code.

> This file is the operating contract. The full design docs and specs are kept **internally** (not in this public repo); ask the maintainer if you need them.

## Status

Greenfield. Only the spec exists. **Next: Phase 0** (see spec §10).

## What we're building (one breath)

Three stacked layers. **Engine** = web-tree-sitter (WASM grammars, lazy-loaded) → symbols + import edges via `tags.scm`. **Graph** = a derived view over those import edges. **Knowledge** = a repo-committed `.arcscope/assertions.yaml` of **agent-authored** named concepts (written via `arch_assert`, never hand-edited) bound to engine-resolved locators, answered live with drift detection. The spine (Engine + Graph) is borrowed/commodity; the Knowledge layer is the net-new, defensible product.

## Invariants — violating one is a blocking error, not a style nit

1. **Local-only.** No network calls, no telemetry, no embeddings API — at query time *and* at server spawn. "Nothing leaves the machine" is a hard guarantee.
2. **tree-sitter only for v1.** LSP is a *deferred* precision tier. Don't add it, ctags, SCIP, or stack-graphs to the committed build. Every result carries a `precisionTier` label; never let a heuristic answer be presented as compiler-accurate.
3. **General-first, no build-tool coupling.** Module grouping comes from universal signals — directory structure + import-graph clustering is the *primary* path; tsconfig paths / workspace manifests are secondary where present. Never read `nx.json`, BUILD files, or any single tool's project model.
4. **Manifest locators resolve through the engine — NEVER shell out.** A committed `assertions.yaml` must not be able to execute arbitrary commands on a teammate's machine. Locator kinds: `path` (glob), `symbol` (tree-sitter query), `import` (module specifier). No `grep`/`find`/exec.
5. **Thin vertical slice; nothing speculative.** Don't build incrementality machinery (persistent store, file watcher), ranking (PageRank), or auto-bootstrap before a measurement justifies it. In-memory index + lazy re-index for the slice.
6. **stdio hygiene.** Log to **stderr only** — a stray `console.log` on stdout corrupts the JSON-RPC stream and silently hangs the server.

## Load-bearing bets — these are kill-criteria, validate them, don't assume them

- **Adoption:** does the agent actually invoke arcscope's tools instead of grep? Phase 0 *measures* this against the real agent with a kill-criterion before building further.
- **Precision:** does tree-sitter `find_refs` (with tsconfig-path + barrel re-export resolution) actually beat grep on real barrel/alias-heavy code? If not, the precise-nav half of the pitch falls to the deferred LSP tier — re-decide.

## Intended tech stack

Node ≥ 20, TypeScript, **ESM**. `@modelcontextprotocol/sdk` + `zod` for the MCP server. `web-tree-sitter` for parsing. stdio transport. A single `bin` that branches on argv (`init` | `serve`). Package shape mirrors the official MCP servers: `"type":"module"`, `"files":["dist"]` (+ vendored `.wasm` grammars and `tags.scm`), shebang on line 1, `tsc && shx chmod +x`.

## Roadmap (spec §10)

- **P0** — tree-sitter engine + `find_def` + `init`/`serve` bin + the adoption kill-gate. TS/JS only. Measure cold-index time on a real repo before quoting any figure.
- **P1** — import-edge index → `find_refs` (follows aliases/barrels) + `dep_graph`.
- **P2** — `arch_list`/`arch_query` + the live, agent-authored knowledge layer (`arch_assert` writes `.arcscope/assertions.yaml`); first npm publish (`--tag next`).
- Later/out of v1: LSP overlay, auto-bootstrap, persistent store, more languages, ast-grep accelerator, CI conformance mode.

## Dogfood / "user #0"

The first consumer is the **knowledge-graph** repo at `/Users/ilie/workspace/knowledge-graph` (an Nx Angular/Firebase monorepo). Its architecture vocabulary — the five concepts arcscope must resolve live, recorded via `arch_assert` — is drafted in spec §7. arcscope is *not* part of that repo; it only navigates it.

## Verification (as code lands)

A change isn't done until it builds (`tsc --noEmit`), its tests pass, and lint is clean. Keep tests next to source. Add focused tests for the engine extraction, the locator resolver, and each MCP tool. Conventional Commits.

## Distribution

Public npm publish is a **milestone, not a test step** (versions are permanently immutable). Inner loop: run the local bin directly. Then `npm pack` + tarball-install into a scratch consumer. Verdaccio + first public publish only when the slice works (spec §9).
