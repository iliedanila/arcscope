# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.0.2]: https://github.com/iliedanila/arcscope/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/iliedanila/arcscope/releases/tag/v0.0.1
