# arcscope

A fully-local MCP server that gives an AI coding agent precise views of an unfamiliar codebase — fast symbol navigation, a **compiler-exact** call graph and flow surface, and a repo-declared **architecture vocabulary** answered _live_ against current code — so it stops re-deriving structure with grep, and stops missing the `this.service.foo()` calls grep can't see.

**Status:** 0.1.0. Three tiers — tree-sitter breadth, an agent-authored knowledge layer, and a compiler-exact TypeScript precise tier — work end-to-end. TS / JS / TSX.

```bash
npm i -D arcscope
npx arcscope init        # index once, write an offline .mcp.json, update .gitignore
# restart your MCP client (e.g. Claude Code) — it reads .mcp.json and connects
```

Everything runs on your machine: **no network at query time or at server spawn, no telemetry, no embeddings.** Breadth comes from tree-sitter (WASM grammars bundled offline); precision comes from the TypeScript compiler running locally. Every result carries a precision tier so the agent never mistakes a heuristic for a compiler-accurate answer.

## Tools

| tool | answers |
| --- | --- |
| `find_def` | where a symbol is defined, with its signature |
| `find_refs` | who references it — **compiler-exact for methods** when a `tsconfig` governs the file (member access `obj.method()` resolved); import-resolved otherwise |
| `dep_graph` | the file/module dependency graph: hubs, a file's neighborhood, or circular dependencies |
| `call_graph` | the **method-resolved** outgoing call graph from a function — follows `this.x.foo()` through the type checker |
| `flow` | the complete surface of a flow **before you change it**: the call closure + a structural edge-case checklist |
| `arch_list` | the repo's named architecture concepts (committed + agent-asserted) |
| `arch_query` | resolve one concept to its **live** code locations, with **drift** + **conformance** |
| `arch_assert` | record a concept — or a reviewed flow — so a later session inherits it, re-verified live |
| `arch_candidates` | find a concept's likely **missing** members by structural (AST-shape) similarity |

## The precise tier — compiler-exact, still local

tree-sitter can't tell you who calls `this.documentService.clone()` — resolving a method call needs the receiver's *type*. arcscope's precise tier runs the **TypeScript compiler + language service** locally (no network) to answer that exactly:

- **`find_refs`** on a method finds its member-access call sites (`obj.method()`), resolved through the type checker — the call sites grep and import-resolution miss.
- **`call_graph`** traces the outgoing closure from an entry point with method dispatch resolved to the concrete implementation (DI-injected services, inheritance).
- **`flow`** maps the *complete surface* of a flow before you touch it: every function it transitively calls, annotated with each function's edge cases (branches, error handling, async). So you catch every case a change must handle.

```
flow forkDocument
# Flow surface from `forkDocument` (apps/.../document-fork.service.ts:44) — 38 functions, precision tier: typescript:
# forkDocument  apps/.../document-fork.service.ts:44  (+5 lib)  {2 branch}
# ├─ getDocumentSnapshot  apps/.../firestore-document.repository.ts:183  (+2 lib)  {2 branch, 3 await}
# │  └─ …
# └─ _performFork  apps/.../document-fork.service.ts:62  (+3 lib)  {1 err, 1 await}
#    └─ cloneGraphForDocument  libs/utils/.../graph-clone.ts:32  (+1 lib)
#       └─ cloneNode  libs/utils/.../graph-clone.ts:104
#          └─ normalizeLinkOrderForCanvas  libs/.../element-mutation-policy.ts:141
# … (38 functions; tree abbreviated)
# Edge-case surface: 6 decision points (if/switch/ternary) · 1 error-handling site (try/throw) · 7 async boundaries (await).
# Each {…} tag marks where behaviour forks, fails, or awaits — verify your change handles each before you write it.
```

## The architecture vocabulary — the differentiator

Where other tools keep project knowledge as static prose that silently rots, arcscope binds each named concept to an **executable locator recomputed on every query**. The knowledge is **agent-authored, not hand-edited**: as the agent works out a concept, it records it with `arch_assert` into a committed `.arcscope/assertions.yaml` — a binding of locators, never a frozen list — so a later session inherits it. One concept looks like:

```yaml
concepts:
  repository-tokens:
    title: Repository-token pattern (I{Name}Repository)
    locators:
      - { kind: symbol, query: "interface I*Repository", in: "libs/data-access/**" }
      - { kind: symbol, query: "const *_REPOSITORY = InjectionToken", in: "libs/**/tokens/**" }
      - { kind: path,   glob: "apps/**/firestore-*.repository.ts" }
```

`arch_query repository-tokens` resolves this against the _current_ tree and flags **drift** when the resolved set diverges from its accepted baseline. Locators come in three kinds — `symbol` (a tree-sitter query), `path` (a glob), and `import` (every file importing a module specifier) — and resolve through arcscope's own engine; a committed assertion can never run a shell command.

Three things keep an agent-written assertion honest:

- a **`must`** invariant — a rule every member must satisfy, re-checked live (**conformance**); a violation surfaces on every query, not when it ships.
- **`arch_candidates`** — finds the members a binding *missed*, by AST-shape similarity (name-independent, so it catches a hand-copied re-implementation that shares no name or import). The "fixed it twice" antidote.
- a **flow concept** — `arch_assert` a reviewed flow by its entry point; `arch_query` recomputes the whole flow live (precise tier) and **drifts** when a function enters or leaves it.

Nothing is stored as a bare fact: every assertion is re-verified against live code on read, so it can't silently rot.

### Drift in practice

The **first** `arch_query` records a baseline; later queries compare against it:

```
arch_query repository-tokens
# Concept `repository-tokens` — Repository-token pattern (7 locations, fresh (baseline captured)):
#  … later, someone adds apps/audit/firestore-audit.repository.ts …
arch_query repository-tokens
# Concept `repository-tokens` — Repository-token pattern (8 locations, DRIFTED):
#   ⚠ DRIFT vs baseline: 1 added, 0 removed, 0 changed.
#     + apps/audit/firestore-audit.repository.ts
arch_query repository-tokens reaccept:true     # accept the new shape → fresh again
```

## How it works

One local Node process speaking MCP over stdio, in tiers:

- **Engine (tree-sitter)** — web-tree-sitter parses each file (lazy WASM grammars) into symbols + import edges. The always-on breadth substrate.
- **Graph** — a derived view over those import edges (dependency graph, cycles), grouped by directory + import-clustering — never a build tool's project model (`nx.json`, BUILD files).
- **Knowledge** — the live, agent-authored architecture vocabulary above.
- **Precise tier (TypeScript)** — a local `ts.Program` + language service, built lazily per `tsconfig` and cached, powering the call graph, flow surface, and compiler-exact method references.

## Precision tiers & limits

Two tiers, **labeled on every result**:

- **`tree-sitter`** — fast, broad (multi-language breadth), structural. The always-on substrate; complete for imported-symbol references.
- **`typescript`** — compiler-exact, via the local TypeScript compiler + language service. Resolves method dispatch, DI, inheritance, overloads.

arcscope never presents a tree-sitter heuristic as compiler-exact. Honest residual limits (the precise tier counts these at the boundary, never hides them):

- **`any`-typed / higher-order callbacks** and **runtime-wired providers** (`InjectionToken`, `useFactory`) may resolve to the *declared* member rather than the concrete impl.
- the precise tier is **per-`tsconfig`** — a single flow rarely spans module systems, but cross-project closures aren't unioned. It builds a TS program on first use (seconds), cached after.
- **TS / JS / TSX only**; module grouping is general-first (directory + import clustering), never a build tool's project model.

> Building with Claude Code? Start at [`CLAUDE.md`](CLAUDE.md).
