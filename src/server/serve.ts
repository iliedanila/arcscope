import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { InvocationCounter } from '../adoption/counter.js';
import { runFindDef, findDefInputShape } from '../tools/find-def.js';
import { runFindRefs, findRefsInputShape } from '../tools/find-refs.js';
import { runDepGraph, depGraphInputShape } from '../tools/dep-graph.js';
import { log, logError } from '../log.js';

const VERSION = '0.0.0';

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
  'Use find_refs to find who references a symbol. It resolves tsconfig aliases and barrel',
  're-exports, so it finds callers grep misses and excludes same-named symbols in unrelated files —',
  'much more precise than grepping a name. Prefer it for "what uses X?" / "who calls X?".',
  '',
  'Use dep_graph to see structure: the most depended-on files (hubs) with no focus, or a file\'s',
  'neighborhood (what it imports / what imports it) with a focus. Prefer it over reading imports by hand.',
  '',
  "Every result is labeled with a precision tier so you can calibrate trust (currently",
  "'tree-sitter': structural and high-signal, but not compiler-exact).",
].join('\n');

const DEP_GRAPH_DESCRIPTION = [
  'Show the module/file dependency graph from real import edges (resolving aliases + barrels).',
  'Use to understand structure: with no focus it returns the most depended-on files (hubs) and a',
  'module summary; with a focus file it returns that file\'s neighborhood — what it imports and what',
  'imports it; with cycles:true it finds circular dependencies (files that import each other).',
  'Optionally a directory prefix focus, or a neighborhood depth (1-2). Token-bounded.',
].join(' ');

const FIND_REFS_DESCRIPTION = [
  'Find where a symbol is referenced (its callers/consumers), following tsconfig path aliases and',
  'barrel re-exports. Use when you need who uses a function, class, method, interface, type, or',
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('serving on stdio');
}
