import { join } from 'node:path';
import { z } from 'zod';
import type { IndexStore } from '../engine/index-store.js';
import type { ProgramStore } from '../engine/program-store.js';
import { callClosure, findFocusDecl } from '../engine/call-graph.js';
import type { CallNode } from '../engine/call-graph.js';

export const flowInputShape = {
  symbol: z
    .string()
    .min(1)
    .describe('The entry point of the flow to map — a service method, an action handler, or any function you are about to change.'),
  pathGlob: z.string().optional().describe("Optional path glob to disambiguate the entry point's definition, e.g. 'apps/**'."),
  depth: z.number().int().min(1).max(8).optional().describe('Max flow depth (default 6).'),
};

export interface FlowResult {
  text: string;
}

const MAX_NODES = 150;

// Expose the COMPLETE area of one flow BEFORE changing it: the method-resolved call
// closure from an entry point, annotated with each function's structural edge cases
// (branches, error handling, async) so the agent can verify a change handles every
// decision/failure/await point. The model judges which edges the new behaviour must
// cover; arcscope guarantees the surface is structurally complete (to the precise
// tier's resolution).
export async function runFlow(
  indexStore: IndexStore,
  programStore: ProgramStore,
  root: string,
  args: { symbol: string; pathGlob?: string; depth?: number },
): Promise<FlowResult> {
  const sync = await indexStore.sync();
  if (sync.changed > 0 || sync.removed > 0) programStore.invalidate();
  const defs = indexStore.find(args.symbol, args.pathGlob);
  if (defs.length === 0) {
    return { text: `No definition of \`${args.symbol}\` found. Try find_def (it suggests similar names).` };
  }
  const def = defs[0]!;
  const absFile = join(root, def.file);

  const proj = programStore.forFile(absFile);
  if (!proj) {
    return {
      text: `\`${args.symbol}\` is at ${def.file}, but no tsconfig governs that file — the flow surface needs a TypeScript project (tree-sitter find_refs/dep_graph still apply).`,
    };
  }
  const focus = findFocusDecl(proj.program, absFile, def.line, args.symbol);
  if (!focus) {
    return {
      text: `Located \`${args.symbol}\` at ${def.file}:${def.line}, but it is not a function/method — a flow starts from a function.`,
    };
  }

  const { root: tree, nodeCount, hitCap } = callClosure(proj, focus, {
    maxDepth: args.depth ?? 6,
    maxNodes: MAX_NODES,
    maxImplsPerCall: 4,
    relPath: (f) => programStore.relPath(f),
    collectEdgeCases: true,
  });

  const roll = rollup(tree);
  const head = `Flow surface from \`${args.symbol}\` (${def.file}:${def.line}) — ${nodeCount} function${nodeCount === 1 ? '' : 's'}, precision tier: typescript:`;
  const body = renderTree(tree);
  const surface = [
    '',
    `Edge-case surface: ${roll.branches} decision point${plural(roll.branches)} (if/switch/ternary) · ` +
      `${roll.errorHandling} error-handling site${plural(roll.errorHandling)} (try/throw) · ` +
      `${roll.asyncPoints} async boundar${roll.asyncPoints === 1 ? 'y' : 'ies'} (await).`,
    'Each {…} tag marks where behaviour forks, fails, or awaits — verify your change handles each before you write it.',
  ];
  const candidates =
    defs.length > 1
      ? ['', `Note: ${defs.length} definitions of \`${args.symbol}\` — mapped the one above. Re-run with pathGlob to pick another:`, ...defs.map((d) => `  ${d.file}:${d.line}`)]
      : [];
  const footer = [
    '',
    'Legend: tree = the resolved in-repo call closure (method dispatch resolved). "{N branch, M err, K await}" = that function\'s edge cases.',
    '"+N lib" = calls leaving the flow (libraries/.d.ts/test-mocks); "+M unresolved" = any/higher-order; "↩" recursion; "⇒" shown above; "…" cap.',
    hitCap ? `Truncated at ${MAX_NODES} nodes / depth ${args.depth ?? 6} — narrow with a deeper-specific entry point or smaller depth.` : '',
    `Resolved live against tsconfig ${proj.configPath}.`,
  ].filter(Boolean);

  return { text: [head, ...body, ...surface, ...candidates, ...footer].join('\n') };
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

function rollup(root: CallNode): { branches: number; errorHandling: number; asyncPoints: number } {
  const acc = { branches: 0, errorHandling: 0, asyncPoints: 0 };
  const seen = new Set<string>();
  const walk = (n: CallNode): void => {
    const key = `${n.file}:${n.line}`;
    if (!n.recursion && !n.seenElsewhere && !seen.has(key)) {
      seen.add(key);
      acc.branches += n.edges.branches;
      acc.errorHandling += n.edges.errorHandling;
      acc.asyncPoints += n.edges.asyncPoints;
    }
    n.children.forEach(walk);
  };
  walk(root);
  return acc;
}

function renderTree(node: CallNode): string[] {
  const lines: string[] = [];
  const walk = (n: CallNode, prefix: string, isLast: boolean, depth: number): void => {
    const branch = depth === 0 ? '' : prefix + (isLast ? '└─ ' : '├─ ');
    const boundary: string[] = [];
    if (n.externalCalls > 0) boundary.push(`+${n.externalCalls} lib`);
    if (n.unresolvedCalls > 0) boundary.push(`+${n.unresolvedCalls} unresolved`);
    if (n.recursion) boundary.push('↩');
    if (n.seenElsewhere) boundary.push('⇒');
    if (n.truncated) boundary.push('…');
    const edges: string[] = [];
    if (n.edges.branches > 0) edges.push(`${n.edges.branches} branch`);
    if (n.edges.errorHandling > 0) edges.push(`${n.edges.errorHandling} err`);
    if (n.edges.asyncPoints > 0) edges.push(`${n.edges.asyncPoints} await`);
    const b = boundary.length ? `  (${boundary.join(', ')})` : '';
    const e = edges.length ? `  {${edges.join(', ')}}` : '';
    lines.push(`${branch}${n.symbol}  ${n.file}:${n.line}${b}${e}`);
    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
    n.children.forEach((c, i) => walk(c, childPrefix, i === n.children.length - 1, depth + 1));
  };
  walk(node, '', true, 0);
  return lines;
}
