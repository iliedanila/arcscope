# arcscope

A fully-local MCP server that gives an AI coding agent three stacked views of an unfamiliar codebase — **symbols**, the **module/dependency graph**, and a repo-declared **architecture vocabulary** answered _live_ against current code — so it stops re-deriving structure with grep every session.

**Status:** early preview (`v0.0.1`). The v1 slice — all three layers — works end-to-end. TS / JS / TSX.

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
| `find_refs` | who references it — follows tsconfig path aliases + barrel re-exports, so it beats grep on same-named symbols |
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

## How it works

Three layers in one local Node process speaking MCP over stdio:

- **Engine** — web-tree-sitter parses each file (lazy WASM grammars) into symbols + import edges. The always-on breadth substrate.
- **Graph** — a derived view over those import edges (dependency graph, cycles), grouped by directory + import-clustering — never a build tool's project model (`nx.json`, BUILD files).
- **Knowledge** — the live architecture vocabulary above. The net-new, defensible layer.

See the full design, roadmap, and the reasoning behind every constraint: [`docs/arcscope-spec.html`](docs/arcscope-spec.html).

> Building with Claude Code? Start at [`CLAUDE.md`](CLAUDE.md).
