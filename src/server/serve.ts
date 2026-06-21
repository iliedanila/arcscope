import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { InvocationCounter } from '../adoption/counter.js';
import { runFindDef, findDefInputShape } from '../tools/find-def.js';
import { runFindRefs, findRefsInputShape } from '../tools/find-refs.js';
import { runDepGraph, depGraphInputShape } from '../tools/dep-graph.js';
import { runArchList } from '../tools/arch-list.js';
import { runArchQuery, archQueryInputShape } from '../tools/arch-query.js';
import { runArchAssert, archAssertInputShape } from '../tools/arch-assert.js';
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
        const { text } = await runArchQuery(store, root, args);
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('serving on stdio');
}
