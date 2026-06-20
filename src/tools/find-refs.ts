import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IndexStore } from '../engine/index-store.js';
import type { GrammarRegistry } from '../engine/grammar-registry.js';
import { ImportGraph } from '../engine/import-graph.js';
import { findOccurrences } from '../engine/ref-scan.js';
import { matchGlob } from '../engine/glob.js';
import type { RefRecord } from '../engine/types.js';

export const findRefsInputShape = {
  symbol: z
    .string()
    .min(1)
    .describe("Exact symbol name to find references to (case-sensitive), e.g. 'GraphReducer'."),
  pathGlob: z
    .string()
    .optional()
    .describe("Optional path glob to scope which referencing files are reported, e.g. 'apps/**'."),
};

export interface FindRefsResult {
  records: RefRecord[];
  text: string;
}

// Who references a symbol — resolved through tsconfig aliases + barrel re-exports.
// Uses the import graph to find which files actually import the symbol, then scans
// only those files (+ the definition file) for usages. Same-named symbols in
// files that don't import it are excluded — that's the precision win over grep.
export async function runFindRefs(
  store: IndexStore,
  registry: GrammarRegistry,
  root: string,
  args: { symbol: string; pathGlob?: string },
): Promise<FindRefsResult> {
  await store.sync();
  const defs = store.find(args.symbol);
  if (defs.length === 0) {
    return {
      records: [],
      text: `No definition of \`${args.symbol}\` found, so there is nothing to resolve references against. Try find_def first (it suggests similar names).`,
    };
  }

  const graph = new ImportGraph(store, root);
  const records: RefRecord[] = [];
  let importerCount = 0;
  const scanned = new Set<string>();

  for (const def of defs) {
    const sites = [
      { file: def.file, local: args.symbol }, // intra-file uses in the definition file
      ...graph.importersOf(args.symbol, def.file),
    ];
    for (const site of sites) {
      if (site.file !== def.file) importerCount++;
      if (scanned.has(site.file)) continue;
      scanned.add(site.file);
      let source: string;
      try {
        source = readFileSync(join(root, site.file), 'utf8');
      } catch {
        continue;
      }
      for (const occ of await findOccurrences(registry, site.file, source, site.local)) {
        if (args.pathGlob && !matchGlob(occ.file, args.pathGlob)) continue;
        records.push({
          symbol: site.local,
          file: occ.file,
          line: occ.line,
          column: occ.column,
          snippet: occ.snippet,
          refKind: occ.refKind,
          resolved: true,
          resolvesTo: { file: def.file, line: def.line },
          precisionTier: 'tree-sitter',
        });
      }
    }
  }

  records.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  const kinds = new Set(defs.map((d) => d.kind));
  return { records, text: format(args.symbol, args.pathGlob, defs.length, importerCount, records, kinds) };
}

function format(
  symbol: string,
  pathGlob: string | undefined,
  defCount: number,
  importerCount: number,
  records: RefRecord[],
  kinds: Set<string>,
): string {
  const scope = pathGlob ? ` within \`${pathGlob}\`` : '';
  if (records.length === 0) {
    // find_refs is import-resolution based, so a symbol never imported by name
    // (member access, same-file-only use, or namespace/default import) yields
    // nothing. Member access is the dominant cause and is the deferred
    // compiler-accurate tier's job, so ALWAYS give the actionable fallback —
    // never present its absence as "no callers". Sharper when we know it's a method.
    const memberHint = kinds.has('method')
      ? ` \`${symbol}\` is a method, so it is invoked via member access (\`obj.${symbol}()\`), which import-resolution cannot follow — that is the deferred (compiler-accurate) tier, not in v1.`
      : ` If \`${symbol}\` is invoked via member access (\`obj.${symbol}()\`), import-resolution cannot follow it — that is the deferred (compiler-accurate) tier, not in v1.`;
    return (
      `No import-resolved references to \`${symbol}\`${scope} (${defCount} definition${defCount === 1 ? '' : 's'}). find_refs follows imports, so it does not see a symbol used only within its own file or reached through namespace/default imports.` +
      memberHint +
      ` To find member-access call sites, grep \`.${symbol}\` or find_refs its declaring class/interface.`
    );
  }
  const defNote = defCount > 1 ? ` (${defCount} definitions share this name; refs are split by the one they resolve to)` : '';
  const head = `${records.length} reference${records.length === 1 ? '' : 's'} to \`${symbol}\`${scope}${defNote} — resolved through imports/barrels (precision: tree-sitter):`;
  const lines = records.map(
    (r) => `  ${r.file}:${r.line}  [${r.refKind}]  ${r.snippet}` + (r.resolvesTo ? `  -> ${r.resolvesTo.file}:${r.resolvesTo.line}` : ''),
  );
  const foot = `Resolved across ${importerCount} importing file${importerCount === 1 ? '' : 's'} + the definition; same-named symbols in files that don't import it are excluded.`;
  return [head, ...lines, foot].join('\n');
}
