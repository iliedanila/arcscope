import { z } from 'zod';
import type { IndexStore } from '../engine/index-store.js';
import type { DefRecord } from '../engine/types.js';

const FUZZY_MIN_LENGTH = 3;

// Zod raw shape for the find_def tool input (registerTool accepts a raw shape).
// The .describe() text is part of the adoption surface the agent reads.
export const findDefInputShape = {
  symbol: z
    .string()
    .min(1)
    .describe("Exact symbol name to locate (case-sensitive), e.g. 'GraphReducer', 'useAuth', 'IThingRepository'."),
  pathGlob: z
    .string()
    .optional()
    .describe("Optional path glob to scope results, e.g. 'libs/features/**' or 'src/**/*.ts'."),
};

export interface FindDefResult {
  records: DefRecord[];
  suggestions: DefRecord[];
  text: string;
}

// Tool logic, independent of the MCP transport so it can be unit-tested directly.
// Re-syncs the index (lazy re-index) so results always reflect the current tree.
// Exact match is the precise default; on zero hits it falls back to close-name
// suggestions so the agent doesn't have to guess the exact symbol name.
export async function runFindDef(
  store: IndexStore,
  args: { symbol: string; pathGlob?: string },
): Promise<FindDefResult> {
  await store.sync();
  const records = store.find(args.symbol, args.pathGlob);
  if (records.length > 0) {
    return { records, suggestions: [], text: formatExact(args.symbol, args.pathGlob, records) };
  }
  const suggestions = args.symbol.length >= FUZZY_MIN_LENGTH ? store.findFuzzy(args.symbol, args.pathGlob) : [];
  return { records: [], suggestions, text: formatMiss(args.symbol, args.pathGlob, suggestions, store.fileCount) };
}

function formatExact(symbol: string, pathGlob: string | undefined, records: DefRecord[]): string {
  const scope = pathGlob ? ` within \`${pathGlob}\`` : '';
  const head = `${records.length} definition${records.length === 1 ? '' : 's'} of \`${symbol}\`${scope} (precision: tree-sitter):`;
  // The symbol is in the header, so exact lines omit it.
  const lines = records.map((r) => `  ${r.file}:${r.line}  [${r.kind}]  ${r.signature}`);
  return [head, ...lines].join('\n');
}

function formatMiss(
  symbol: string,
  pathGlob: string | undefined,
  suggestions: DefRecord[],
  fileCount: number,
): string {
  const scope = pathGlob ? ` within \`${pathGlob}\`` : '';
  if (suggestions.length === 0) {
    return (
      `No definition of \`${symbol}\` found${scope} (searched ${fileCount} files via tree-sitter). ` +
      'It may be defined in a gitignored/untracked file, imported from a dependency, or spelled ' +
      'differently — find_def matches names exactly and is case-sensitive.'
    );
  }
  const head = `No exact definition of \`${symbol}\`${scope}, but ${suggestions.length} symbol${suggestions.length === 1 ? ' has' : 's have'} a similar name (matched by name; locations are exact):`;
  // Suggestions are distinct names, so each line leads with the symbol.
  const lines = suggestions.map((r) => `  ${r.symbol}  [${r.kind}]  ${r.file}:${r.line}  ${r.signature}`);
  return [head, ...lines, 'Re-run find_def with one of these exact names for the full, precise result.'].join('\n');
}
