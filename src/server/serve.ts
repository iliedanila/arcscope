import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { InvocationCounter } from '../adoption/counter.js';
import { runFindDef, findDefInputShape } from '../tools/find-def.js';
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
  "Every result is labeled with a precision tier so you can calibrate trust (currently",
  "'tree-sitter': structural and high-signal, but not compiler-exact).",
].join('\n');

const FIND_DEF_DESCRIPTION = [
  'Find where a symbol is defined and show its signature.',
  'Use when you need the definition site of a named function, class, method, interface, type,',
  "enum, or exported constant — e.g. \"where is GraphReducer defined?\".",
  'More precise than text search: it parses the code, so it skips comments, strings, and unrelated',
  'same-named matches. Returns each definition as file:line, kind, and header signature, with a',
  'precision tier. Optionally scope to part of the repo with a path glob.',
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('serving on stdio');
}
