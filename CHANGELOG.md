# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-22

### Added

- **`arcscope stats` now answers "is it useful?", not just "how much".** Alongside the
  per-tool usage summary (read from `.arcscope/usage.jsonl`), `stats` reads the newest
  local Claude Code session transcript for the repo and reports arcscope's share of
  `arcscope + grep` — the grep-vs-tool adoption signal the server can't observe on its
  own. Fully local; no transcript → the usage half still prints. The Bash classifier
  counts only real grep invocations (`grep` / `rg` / `git grep` as a command's first
  word), not commands that merely mention the word. Transcript discovery targets Claude
  Code's exact per-cwd project dir so short repo names can't match unrelated projects.

### Removed

- The `scripts/adoption-report.mjs` dev script. Its grep-vs-tool logic moved into
  `src/adoption/report.ts` (now shipped in the package) and folded into `arcscope stats`,
  so consumers get the adoption signal after `npm i` instead of it living only in source.
- The human-editable `.arcscope/vocab.yaml`. The knowledge layer is now
  **agent-authored only**: a single committed `.arcscope/assertions.yaml` written via
  `arch_assert`, re-verified live on read. `init` no longer scaffolds a starter vocab;
  `.gitignore` now commits `assertions.yaml`. The `source`/provenance distinction
  (`[agent]` / `[agent-asserted]` labels) is gone — every concept is, by construction,
  a machine-asserted binding. This reverses the v1 "repo-declared, hand-authored
  vocabulary" premise in favor of the v2 "store assertions, not facts" direction.

## [0.1.1] - 2026-06-21

### Fixed

- Documentation accuracy. An adversarial audit of the README against the source
  corrected five real inaccuracies: `find_refs` is no longer credited with
  `call_graph`'s concrete-implementation/DI resolution (it uses `findReferences`);
  the method path is noted as compiler-exact only when a `tsconfig` governs the file;
  the `init`, `flow`, and drift examples were made faithful to actual tool output.
- `arcscope init` help text now lists the `.arcscope/vocab.yaml` scaffold it writes,
  and drops the misleading "index this repo" (the live index is built at server start,
  not persisted from `init`).

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
