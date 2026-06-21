# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-21

A major expansion: an agent-authored knowledge layer and a compiler-exact precise
tier. Nine tools (was five). All still fully local — no network at query time or at
spawn.

### Added

- **Precise tier (TypeScript).** A local `ts.Program` + language service (no network)
  that resolves **method dispatch** — `this.service.foo()` to the concrete
  implementation, including DI and inheritance — which tree-sitter cannot.
  - **`call_graph`** — the method-resolved outgoing call closure from an entry point.
  - **`flow`** — the complete surface of a flow before changing it: the call closure
    plus a per-function structural edge-case checklist (branches / error handling /
    async) and a rollup, so a change accounts for every case.
  - **`find_refs` is now compiler-exact for methods** — member access (`obj.method()`)
    resolves to its call sites and concrete implementation. Functions/classes/consts/
    types stay on the fast tree-sitter import path. **The member-access caveat is
    retired.**
- **Agent-authored knowledge (a read-write vocabulary).**
  - **`arch_assert`** — the agent records a concept (a binding of live locators) so a
    later session inherits it, re-verified on read — never a frozen fact.
  - **Conformance (`must`)** — a concept can carry an invariant every member must
    satisfy, re-checked live; violations surface on every `arch_query`.
  - **`arch_candidates`** — finds a concept's likely **missing** members by structural
    (AST-shape) similarity, name-independent — the "fixed it twice" antidote.
  - **Flow concepts** — `arch_assert` a reviewed flow by entry point; `arch_query`
    recomputes it live (precise tier) and **drifts** when a function enters/leaves it.

### Changed

- Concepts merge the human-authored `vocab.yaml` with an agent-owned `assertions.yaml`,
  with provenance shown.
- Results carry a `precisionTier` of `typescript` when resolved compiler-exact.
- `typescript` is now a runtime dependency.

### Notes

- The precise tier is TS/JS-only and per-`tsconfig`; it builds a program on first use
  (cached after). Residual limits (`any`/higher-order callbacks, runtime-wired DI
  providers, cross-project flows) are counted at the boundary, never hidden.

## [0.0.4] - 2026-06-20

### Changed

- `find_refs` now gives an honest, actionable message when a symbol has no
  import-resolved references: it always names **member access** (`obj.method()`)
  as the deferred compiler-accurate tier (out of scope for v1's tree-sitter tier)
  and points to the fallback (grep `.name`, or `find_refs` the declaring class),
  instead of only hinting when the symbol happened to be a method.
- README: added a copy-pasteable **drift walkthrough** (fresh → DRIFTED →
  reaccept) and a **"Precision tiers & limits"** section documenting the
  tree-sitter tier's boundaries (member access, renamed re-exports, 1-hop
  barrels, general-first grouping, TS/JS/TSX-only). Dropped the hardcoded
  version from the status line so it can't go stale.

## [0.0.3] - 2026-06-20

### Added

- A third vocabulary locator kind, **`import`**: `{ kind: import, of: "<module>" }`
  resolves every file that imports a module specifier (exactly or via a subpath).
  It reads the engine's existing import-edge index — the same data as `dep_graph`
  and `find_refs`, not a new backend — so a concept can assert an **import
  boundary** (e.g. "who imports `@angular/fire/firestore`?") and `arch_query`
  drift-detects a new importer the moment it appears. Resolves through the engine
  only; never reads or evaluates a config file.

## [0.0.2] - 2026-06-20

### Added

- `arcscope init` scaffolds a commented, project-agnostic starter
  `.arcscope/vocab.yaml` so a freshly-installed repo has a template to author
  concepts against. Examples stay commented, so `arch_list` starts empty until
  you write real ones (no auto-bootstrap — that stays out of v1).

### Fixed

- **A single malformed locator no longer blanks the whole Knowledge layer.** A
  symbol query missing its kind (e.g. `"noSpaceHere"`) made both `arch_list` and
  `arch_query` throw, hiding every valid concept. Resolution now degrades
  per-concept: the bad concept is flagged with a clear `⚠ invalid locator`
  message while the rest still resolve.

### Changed

- `find_refs` documentation (README + tool description) now states its barrel
  coverage honestly: same-name re-exports, 1-hop. A renamed re-export
  (`export { X as Y }`) is not yet followed.

## [0.0.1] - 2026-06-19

### Added

- Initial public release. Fully-local, tree-sitter-based code-navigation MCP
  server with five tools — `find_def`, `find_refs`, `dep_graph`, `arch_list`,
  `arch_query` — and an `init` / `serve` bin. TS / JS / TSX, no network at query
  time or server spawn.

[0.0.4]: https://github.com/iliedanila/arcscope/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/iliedanila/arcscope/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/iliedanila/arcscope/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/iliedanila/arcscope/releases/tag/v0.0.1
