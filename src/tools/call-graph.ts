import { join } from 'node:path';
import { z } from 'zod';
import type { IndexStore } from '../engine/index-store.js';
import type { ProgramStore } from '../engine/program-store.js';
import { callClosure, findFocusDecl } from '../engine/call-graph.js';
import type { CallNode } from '../engine/call-graph.js';

export const callGraphInputShape = {
  symbol: z
    .string()
    .min(1)
    .describe('The entry-point function or method to trace outgoing calls from (e.g. a flow entry like \'cloneUser\').'),
  pathGlob: z.string().optional().describe("Optional path glob to disambiguate the symbol's definition, e.g. 'apps/**'."),
  depth: z.number().int().min(1).max(8).optional().describe('Max call-tree depth (default 5).'),
};

export interface CallGraphResult {
  text: string;
}

const MAX_NODES = 120;

// Trace the COMPILER-EXACT outgoing call closure from an entry point — method
// dispatch resolved through the TypeScript type checker + LanguageService impl hop.
// The first call to a given TS project pays a one-time Program build (seconds);
// later calls reuse it.
export async function runCallGraph(
  indexStore: IndexStore,
  programStore: ProgramStore,
  root: string,
  args: { symbol: string; pathGlob?: string; depth?: number },
): Promise<CallGraphResult> {
  const sync = await indexStore.sync();
  if (sync.changed > 0 || sync.removed > 0) programStore.invalidate(); // never resolve against a stale Program
  const defs = indexStore.find(args.symbol, args.pathGlob);
  if (defs.length === 0) {
    return { text: `No definition of \`${args.symbol}\` found. Try find_def (it suggests similar names).` };
  }
  const def = defs[0]!;
  const absFile = join(root, def.file);

  const proj = programStore.forFile(absFile);
  if (!proj) {
    return {
      text:
        `\`${args.symbol}\` is at ${def.file}, but no tsconfig governs that file, so the precise call graph is unavailable. ` +
        `(The precise tier needs a TypeScript project; tree-sitter find_refs/dep_graph still apply.)`,
    };
  }

  const focus = findFocusDecl(proj.program, absFile, def.line, args.symbol);
  if (!focus) {
    return {
      text: `Located \`${args.symbol}\` at ${def.file}:${def.line}, but it is not a function/method with a body — the call graph applies to functions and methods.`,
    };
  }

  const { root: tree, nodeCount, hitCap } = callClosure(proj, focus, {
    maxDepth: args.depth ?? 5,
    maxNodes: MAX_NODES,
    maxImplsPerCall: 4,
    relPath: (f) => programStore.relPath(f),
  });

  const head =
    `Call graph from \`${args.symbol}\` (${def.file}:${def.line}) — ${nodeCount} in-repo function${nodeCount === 1 ? '' : 's'}, ` +
    `precision tier: typescript (method dispatch resolved):`;
  const body = renderTree(tree);
  const candidates =
    defs.length > 1
      ? ['', `Note: ${defs.length} definitions of \`${args.symbol}\` — traced the one above. Re-run with pathGlob to pick another:`, ...defs.map((d) => `  ${d.file}:${d.line}`)]
      : [];
  const footer = [
    '',
    'Legend: each node is a resolved in-repo production callee; "+N lib" = calls leaving the flow (libraries/.d.ts/test-mocks),',
    '"+M unresolved" = any-typed/higher-order calls not resolved; "↩" = recursion (a cycle); "⇒" = shown in full above; "…" = depth/size cap.',
    hitCap ? `Note: truncated at ${MAX_NODES} nodes / depth ${args.depth ?? 5} — narrow with a deeper-specific entry point or smaller depth.` : '',
    `Resolved live against tsconfig ${proj.configPath}; non-TS / out-of-project calls fall back to the tree-sitter tier.`,
  ]
    .filter(Boolean)
    .join('\n');

  return { text: [head, ...body, ...candidates, footer].join('\n') };
}

function renderTree(node: CallNode): string[] {
  const lines: string[] = [];
  const walk = (n: CallNode, prefix: string, isLast: boolean, depth: number): void => {
    const branch = depth === 0 ? '' : prefix + (isLast ? '└─ ' : '├─ ');
    const tags: string[] = [];
    if (n.externalCalls > 0) tags.push(`+${n.externalCalls} lib`);
    if (n.unresolvedCalls > 0) tags.push(`+${n.unresolvedCalls} unresolved`);
    if (n.recursion) tags.push('↩');
    if (n.seenElsewhere) tags.push('⇒');
    if (n.truncated) tags.push('…');
    const tag = tags.length ? `  (${tags.join(', ')})` : '';
    lines.push(`${branch}${n.symbol}  ${n.file}:${n.line}${tag}`);
    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
    n.children.forEach((c, i) => walk(c, childPrefix, i === n.children.length - 1, depth + 1));
  };
  walk(node, '', true, 0);
  return lines;
}
