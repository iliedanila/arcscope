# arcscope

A fully-local MCP server that gives an AI coding agent three stacked views of an unfamiliar codebase — **symbols**, the **module/dependency graph**, and a repo-declared **architecture vocabulary** answered _live_ against current code — so it stops re-deriving structure with grep every session.

**Status:** early preview. The v1 slice — all three layers — works end-to-end. TS / JS / TSX.

```bash
npm i -D arcscope
npx arcscope init        # index the repo, write an offline .mcp.json, update .gitignore
# restart your MCP client (e.g. Claude Code) — it reads .mcp.json and connects
```

Everything runs on your machine: **no network at query time or at server spawn, no telemetry, no embeddings.** Parsing is tree-sitter (WASM grammars bundled offline), and every result carries a precision tier so the agent never mistakes a heuristic for a compiler-accurate answer.

## Tools

| tool | answers |
| --- | --- |
| `find_def` | where a symbol is defined, with its signature |
| `find_refs` | who references it — follows tsconfig path aliases + same-name barrel re-exports (1-hop), so it beats grep on same-named symbols |
| `dep_graph` | the file/module dependency graph: hubs, a file's neighborhood, or circular dependencies |
| `arch_list` | the repo's named architecture concepts (its committed vocabulary) |
| `arch_query` | resolve one concept to its **live** code locations, with drift detection |

## The architecture vocabulary — the differentiator

Where other tools keep project knowledge as static prose that silently rots, arcscope binds each named concept to an **executable locator recomputed on every query**. Declare your architecture in a committed `.arcscope/vocab.yaml`:

```yaml
concepts:
  repository-tokens:
    title: Repository-token pattern (I{Name}Repository)
    locators:
      - { kind: symbol, query: "interface I*Repository", in: "libs/data-access/**" }
      - { kind: symbol, query: "const *_REPOSITORY = InjectionToken", in: "libs/**/tokens/**" }
      - { kind: path,   glob: "apps/**/firestore-*.repository.ts" }
```

`arch_query repository-tokens` resolves this against the _current_ tree and flags **drift** when the resolved set diverges from its accepted baseline — so a stale concept is a signal, not a surprise. Locators resolve through arcscope's own engine; a committed manifest can never run a shell command.

Locators come in three kinds: `symbol` (a tree-sitter query), `path` (a glob), and `import` — every file that imports a module specifier, e.g. `{ kind: import, of: "@angular/fire/firestore" }`. The last lets a concept assert an **import boundary** ("who reaches for Firestore?") and drift-detect a new breach the moment it lands.

### Drift in practice

After authoring a concept, resolve it (these run as MCP tools inside your agent). The **first** query records a baseline; later queries compare against it:

```
arch_query data-layer
# Concept `data-layer` — Data-access repositories (7 locations, fresh (baseline captured)):
#   src/users/user.repository.ts:12   [class]  class UserRepository   ← precision: tree-sitter
#   …

#  … later, someone adds src/audit/audit.repository.ts …

arch_query data-layer
# Concept `data-layer` — Data-access repositories (8 locations, DRIFTED):
#   …
#   ⚠ DRIFT vs baseline: 1 added, 0 removed, 0 changed.
#     + src/audit/audit.repository.ts#AuditRepository
#   If this change is correct, re-run arch_query with reaccept:true to update the baseline.

arch_query data-layer reaccept:true     # accept the new shape → fresh again
```

The concept can't silently rot: it's recomputed every call, and the baseline turns a divergence into a signal instead of a stale lie.

## How it works

Three layers in one local Node process speaking MCP over stdio:

- **Engine** — web-tree-sitter parses each file (lazy WASM grammars) into symbols + import edges. The always-on breadth substrate.
- **Graph** — a derived view over those import edges (dependency graph, cycles), grouped by directory + import-clustering — never a build tool's project model (`nx.json`, BUILD files).
- **Knowledge** — the live architecture vocabulary above. The net-new, defensible layer.

See the full design, roadmap, and the reasoning behind every constraint: [`docs/arcscope-spec.html`](docs/arcscope-spec.html).

## Precision tiers & limits

Every result carries a `precisionTier` so the agent can calibrate trust. v1 has one tier — **`tree-sitter`**: structural and high-signal, but not compiler-exact. arcscope never presents a heuristic as compiler-accurate; an LSP-backed precise tier is deliberately deferred.

What that means in practice:

- **`find_refs` resolves through imports.** It follows tsconfig path aliases and **same-name** barrel re-exports (1-hop). It does **not** follow a renamed re-export (`export { X as Y }`), and it does **not** see a symbol reached via **member access** (`obj.method()`), used only within its own file, or imported via namespace/default. For member access, grep `.name` or `find_refs` the declaring class — that precision is the deferred tier's job, not v1's.
- **Module grouping is general-first** — directory structure + import-graph clustering, never a build tool's project model (`nx.json`, BUILD files).
- **TS / JS / TSX only** in v1.

> Building with Claude Code? Start at [`CLAUDE.md`](CLAUDE.md).
