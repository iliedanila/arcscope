import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { ProgramStore } from '../engine/program-store.js';
import { InvocationCounter } from '../adoption/counter.js';
import { runFindDef, findDefInputShape } from '../tools/find-def.js';
import { runFindRefs, findRefsInputShape } from '../tools/find-refs.js';
import { runDepGraph, depGraphInputShape } from '../tools/dep-graph.js';
import { runArchList } from '../tools/arch-list.js';
import { runArchQuery, archQueryInputShape } from '../tools/arch-query.js';
import { runArchAssert, archAssertInputShape } from '../tools/arch-assert.js';
import { runArchCandidates, archCandidatesInputShape } from '../tools/arch-candidates.js';
import { runCallGraph, callGraphInputShape } from '../tools/call-graph.js';
import { runFlow, flowInputShape } from '../tools/flow.js';
import { log, logError } from '../log.js';

// Read from package.json (shipped in the tarball) so it never drifts from the
// published version.
const VERSION = ((): string => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// Server-level instructions are surfaced by the client (Claude Code) at session
// start and are the highest-leverage adoption lever: they tell the agent WHEN to
// reach for arcscope instead of grep. Kept concise (clients truncate ~2KB).
const INSTRUCTIONS = [
  'arcscope navigates this codebase by parsing it with tree-sitter — fully local, no network.',
  'Prefer it over grep/Glob for structural questions about where code lives.',
  '',
  'Use find_def to locate where a named symbol is defined (function, class, method, interface,',
  'type, enum, or exported constant). It returns the exact definition site and signature, and',
  'skips the comments, strings, and unrelated same-named matches that text search turns up.',
  "When you need \"where is X defined?\", call find_def with the symbol name instead of searching text.",
  '',
  'Use find_refs to find who references a symbol. It resolves tsconfig aliases and same-name barrel',
  're-exports (1-hop), so it finds callers grep misses and excludes same-named symbols in unrelated files —',
  'much more precise than grepping a name. Prefer it for "what uses X?" / "who calls X?".',
  '',
  'Use dep_graph to see structure: the most depended-on files (hubs) with no focus, or a file\'s',
  'neighborhood (what it imports / what imports it) with a focus. Prefer it over reading imports by hand.',
  '',
  "Use arch_list to learn this repo's named architecture concepts (its committed vocabulary), and arch_query",
  'to resolve one live to its current code locations. These answer concept-level questions ("the repository',
  'tokens", "the action pipeline") that grep and docs can\'t — recomputed every call, so they never go stale.',
  '',
  'Use arch_assert to RECORD a concept you worked out (a binding of locators + an optional "must" invariant) so a',
  'later session inherits it. arcscope re-verifies it live every call and flags members that violate the rule —',
  "so durable architecture knowledge accrues across sessions without going stale. Use it when you've established",
  'a cross-cutting concept or rule the code structure does not name on its own.',
  '',
  'Use arch_candidates to find a concept\'s likely MISSING members — functions elsewhere that structurally resemble',
  'its implementation (name-independent, so it catches hand-copied re-implementations grep/imports miss). Use it',
  'when a concept might be incomplete (the "fixed it twice" risk); it returns suspects to confirm and pin via arch_assert.',
  '',
  'Use call_graph to trace the exact outgoing calls from a function/method with method dispatch RESOLVED — this.x.foo()',
  'resolves to the concrete implementation (DI/inheritance), which find_refs cannot. Use it to see the full surface a flow',
  'touches before you change it. Heavier than the tree-sitter tools (builds a TypeScript program); use it deliberately.',
  '',
  'Use flow to map the COMPLETE surface of a flow BEFORE changing it — the resolved call closure from an entry point PLUS',
  "each function's edge cases (branches/errors/async), so you catch every case a change must handle. Reach for it when",
  'planning a change to a flow you do not fully know. Heavier (builds a TS program); deliberate use.',
  '',
  "Every result is labeled with a precision tier so you can calibrate trust (currently",
  "'tree-sitter': structural and high-signal, but not compiler-exact).",
].join('\n');

const ARCH_LIST_DESCRIPTION = [
  "List this repo's declared architecture concepts — named, repo-committed ideas (e.g. \"the repository tokens\",",
  '"the editor state pipeline", "the plugin registry") bound to live code locators. Use at the START of working',
  'in an unfamiliar codebase to learn its vocabulary, or when the user names an architectural concept. Each is',
  'answered live against current code (never stale prose).',
].join(' ');

const ARCH_QUERY_DESCRIPTION = [
  'Resolve one named architecture concept to its live code locations. Use when you need to understand or change a',
  'declared concept (from arch_list) — it recomputes the locator against the current tree and returns the exact',
  'files/symbols (a staged concept comes back as an ordered pipeline). More reliable than reading prose docs,',
  'which silently rot; this is recomputed every call and flags drift. If the concept declares an invariant',
  '(a "must" rule), it also reports conformance — which members violate the rule, re-checked live every call.',
].join(' ');

const ARCH_ASSERT_DESCRIPTION = [
  'Record an architecture concept you have worked out so a LATER session inherits it. Use when you discover a',
  'cross-cutting concept the structure does not name on its own — e.g. "every way a document is copied", or an',
  'invariant like "every copy path must call normalizeLinkOrderForCanvas". You write a BINDING (locators that',
  'resolve to the members live — symbol/path/import; pin a scattered member with a path locator) plus an optional',
  'invariant (a "must" rule every member must satisfy). arcscope stores it as a re-checked assertion, never a bare',
  'fact: it re-resolves and re-verifies against current code on every arch_query, so it cannot silently rot.',
].join(' ');

const ARCH_CANDIDATES_DESCRIPTION = [
  'Find likely UNPINNED members of a concept: functions elsewhere that structurally resemble its implementation',
  '(an AST-shape match that is NAME-INDEPENDENT — it catches a hand-copied re-implementation even when every symbol',
  'is renamed and it shares no import or path). Use after arch_query when you suspect a concept misses a scattered',
  'member (the case that causes "fixed it twice" bugs), or before adding a new one. Returns ranked SUSPECTS (the',
  "'structural-similarity' tier is heuristic — confirm each, then pin the real ones with arch_assert). If the",
  'concept has an invariant, candidates that would violate it are flagged — those are the dangerous ones.',
].join(' ');

const CALL_GRAPH_DESCRIPTION = [
  'Trace the COMPILER-EXACT outgoing call graph from an entry-point function or method, with METHOD DISPATCH',
  'resolved through the TypeScript type checker — this.service.foo() resolves to the concrete implementation',
  '(including DI-injected services and inheritance), which tree-sitter find_refs cannot do. Use to see the full',
  'surface a flow touches BEFORE changing it — every in-repo function it transitively calls. Calls into libraries',
  'and unresolved (any/higher-order) calls are counted at the boundary. Precision tier: typescript. Heavier than',
  'the tree-sitter tools: the first call to a given TypeScript project builds its program (seconds); later calls reuse it.',
].join(' ');

const FLOW_DESCRIPTION = [
  'Map the COMPLETE surface of one flow BEFORE changing it. Give an entry point (a service method, an action handler,',
  'the function you are about to modify) and get its method-resolved call closure — every in-repo function the flow',
  "transitively touches, dispatch resolved through the type checker — annotated with each function's structural EDGE",
  'CASES (branches, error handling, async boundaries). Use it to catch every case a change must handle and to see the',
  'full area before you write. Returns a flow tree + an edge-case rollup. Precision tier: typescript; heavier than the',
  'tree-sitter tools (builds a TS program on first use) — use it deliberately when planning a change.',
].join(' ');

const DEP_GRAPH_DESCRIPTION = [
  'Show the module/file dependency graph from real import edges (resolving aliases + barrels).',
  'Use to understand structure: with no focus it returns the most depended-on files (hubs) and a',
  'module summary; with a focus file it returns that file\'s neighborhood — what it imports and what',
  'imports it; with cycles:true it finds circular dependencies (files that import each other).',
  'Optionally a directory prefix focus, or a neighborhood depth (1-2). Token-bounded.',
].join(' ');

const FIND_REFS_DESCRIPTION = [
  'Find where a symbol is referenced (its callers/consumers), following tsconfig path aliases and',
  'same-name barrel re-exports (1-hop; a renamed re-export like `export { X as Y }` is not yet followed).',
  'Use when you need who uses a function, class, method, interface, type, or',
  'constant — e.g. "what calls ActionRouterService?". More precise than text search: it resolves',
  'which files actually import the symbol, so it excludes same-named symbols in unrelated files and',
  'includes references reached through barrels. Each reference carries its kind (call/new/type/...)',
  'and the definition it resolves to.',
].join(' ');

const FIND_DEF_DESCRIPTION = [
  'Find where a symbol is defined and show its signature.',
  'Use when you need the definition site of a named function, class, method, interface, type,',
  "enum, or exported constant — e.g. \"where is GraphReducer defined?\".",
  'More precise than text search: it parses the code, so it skips comments, strings, and unrelated',
  'same-named matches. Returns each definition as file:line, kind, and header signature, with a',
  'precision tier. If no exact match exists, it suggests symbols with similar names — so you can',
  "call it even when you're unsure of the precise name. Optionally scope to part of the repo with a path glob.",
].join(' ');

export async function serve(root: string): Promise<void> {
  const registry = new GrammarRegistry();
  const store = new IndexStore(root, registry);
  const programStore = new ProgramStore(root); // lazy — builds a TS program only on first call_graph request
  const counter = new InvocationCounter(join(root, '.arcscope', 'usage.jsonl'));

  const stats = await store.sync();
  log(`indexed ${stats.fileCount} files, ${stats.symbolCount} symbols in ${stats.elapsedMs}ms (root: ${root})`);

  const server = new McpServer({ name: 'arcscope', version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'find_def',
    {
      title: 'Find symbol definition',
      description: FIND_DEF_DESCRIPTION,
      inputSchema: findDefInputShape,
    },
    async (args) => {
      void counter.record('find_def', args);
      try {
        const { text } = await runFindDef(store, args);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        logError('find_def failed:', err);
        return {
          content: [{ type: 'text', text: `find_def error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'find_refs',
    {
      title: 'Find symbol references',
      description: FIND_REFS_DESCRIPTION,
      inputSchema: findRefsInputShape,
    },
    async (args) => {
      void counter.record('find_refs', args);
      try {
        const { text } = await runFindRefs(store, registry, root, args);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        logError('find_refs failed:', err);
        return {
          content: [{ type: 'text', text: `find_refs error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'dep_graph',
    {
      title: 'Module dependency graph',
      description: DEP_GRAPH_DESCRIPTION,
      inputSchema: depGraphInputShape,
    },
    async (args) => {
      void counter.record('dep_graph', args);
      try {
        const { text } = await runDepGraph(store, root, args);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        logError('dep_graph failed:', err);
        return {
          content: [{ type: 'text', text: `dep_graph error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'arch_list',
    { title: 'List architecture concepts', description: ARCH_LIST_DESCRIPTION },
    async () => {
      void counter.record('arch_list', {});
      try {
        const { text } = await runArchList(store, root);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        logError('arch_list failed:', err);
        return {
          content: [{ type: 'text', text: `arch_list error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'arch_query',
    { title: 'Resolve an architecture concept', description: ARCH_QUERY_DESCRIPTION, inputSchema: archQueryInputShape },
    async (args) => {
      void counter.record('arch_query', args);
      try {
        const { text } = await runArchQuery(store, root, args, programStore);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        logError('arch_query failed:', err);
        return {
          content: [{ type: 'text', text: `arch_query error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'arch_assert',
    { title: 'Record an architecture assertion', description: ARCH_ASSERT_DESCRIPTION, inputSchema: archAssertInputShape },
    async (args) => {
      void counter.record('arch_assert', args);
      try {
        const { text } = await runArchAssert(root, args as Parameters<typeof runArchAssert>[1]);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        logError('arch_assert failed:', err);
        return {
          content: [{ type: 'text', text: `arch_assert error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'arch_candidates',
    { title: 'Find concept re-implementations', description: ARCH_CANDIDATES_DESCRIPTION, inputSchema: archCandidatesInputShape },
    async (args) => {
      void counter.record('arch_candidates', args);
      try {
        const { text } = await runArchCandidates(store, root, args);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        logError('arch_candidates failed:', err);
        return {
          content: [{ type: 'text', text: `arch_candidates error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'call_graph',
    { title: 'Trace the resolved call graph', description: CALL_GRAPH_DESCRIPTION, inputSchema: callGraphInputShape },
    async (args) => {
      void counter.record('call_graph', args);
      try {
        const { text } = await runCallGraph(store, programStore, root, args);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        logError('call_graph failed:', err);
        return {
          content: [{ type: 'text', text: `call_graph error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'flow',
    { title: 'Map a flow surface', description: FLOW_DESCRIPTION, inputSchema: flowInputShape },
    async (args) => {
      void counter.record('flow', args);
      try {
        const { text } = await runFlow(store, programStore, root, args);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        logError('flow failed:', err);
        return {
          content: [{ type: 'text', text: `flow error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('serving on stdio');
}
