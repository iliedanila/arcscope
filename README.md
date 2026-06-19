# arcscope

A fully-local MCP server that gives an AI coding agent three stacked views of an unfamiliar codebase — symbols, the module/dependency graph, and a repo-declared **architecture vocabulary** answered *live* against current code — so it stops re-deriving structure with grep every session.

**Status:** design complete, pre-build. See the full spec: [`docs/arcscope-spec.html`](docs/arcscope-spec.html).

The wedge: where existing tools keep project knowledge as static prose that silently rots, arcscope binds each named concept to an executable locator that is recomputed on every query — so drift is a signal, not a surprise.

> Building with Claude Code? Start at [`CLAUDE.md`](CLAUDE.md).
