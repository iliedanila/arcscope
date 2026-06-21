import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IndexStore } from '../engine/index-store.js';
import type { GrammarRegistry } from '../engine/grammar-registry.js';
import { ImportGraph } from '../engine/import-graph.js';
import { findOccurrences } from '../engine/ref-scan.js';
import { matchGlob } from '../engine/glob.js';
import type { RefRecord } from '../engine/types.js';
import type { ProgramStore } from '../engine/program-store.js';
import { preciseReferences } from '../engine/precise-refs.js';

export const findRefsInputShape = {
  symbol: z
    .string()
    .min(1)
    .describe("Exact symbol name to find references to (case-sensitive), e.g. 'useAuth'."),
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
  programStore?: ProgramStore,
): Promise<FindRefsResult> {
  const sync = await store.sync();
  const defs = store.find(args.symbol);
  if (defs.length === 0) {
    return {
      records: [],
      text: `No definition of \`${args.symbol}\` found, so there is nothing to resolve references against. Try find_def first (it suggests similar names).`,
    };
  }

  // A method's references are member access (obj.method()), which the tree-sitter
  // import-resolution tier cannot follow — that was the long-standing caveat.
  // Escalate to the precise tier (compiler-exact, via the LanguageService) for
  // methods; everything else stays on the fast tree-sitter path (already complete
  // for imported symbols). Non-TS files fall back to tree-sitter too.
  if (programStore && defs.some((d) => d.kind === 'method')) {
    if (sync.changed > 0 || sync.removed > 0) programStore.invalidate();
    const precise: RefRecord[] = [];
    let usedPrecise = false;
    for (const def of defs) {
      const proj = programStore.forFile(join(root, def.file));
      if (!proj) continue;
      usedPrecise = true;
      precise.push(...preciseReferences(proj, join(root, def.file), def.line, args.symbol, (f) => programStore.relPath(f)));
    }
    if (usedPrecise) {
      // Drop the definitions themselves (with >1 same-named def, findReferences can
      // surface a sibling def as a "reference"), dedupe each call site once (a member
      // call can resolve to multiple impls; keep the first = the real implementation,
      // since defs are searched in file order), then apply the path scope.
      const defKeys = new Set(defs.map((d) => `${d.file}:${d.line}`));
      const seen = new Set<string>();
      const filtered: RefRecord[] = [];
      for (const r of precise) {
        if (defKeys.has(`${r.file}:${r.line}`)) continue;
        const site = `${r.file}:${r.line}:${r.column}`;
        if (seen.has(site)) continue;
        seen.add(site);
        if (args.pathGlob && !matchGlob(r.file, args.pathGlob)) continue;
        filtered.push(r);
      }
      filtered.sort(byFileLine);
      return { records: filtered, text: formatPrecise(args.symbol, args.pathGlob, defs.length, filtered) };
    }
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
      ? ` \`${symbol}\` is a method (member access, \`obj.${symbol}()\`); arcscope resolves those via its precise tier — but only when a TypeScript project governs the file, which is not the case here.`
      : ` If \`${symbol}\` is invoked via member access (\`obj.${symbol}()\`), import-resolution cannot follow it; arcscope's precise tier resolves member access when a TypeScript project is present.`;
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

function byFileLine(a: RefRecord, b: RefRecord): number {
  return a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1;
}

// Compiler-exact references via the precise tier — includes member access, so no
// caveat. Zero here is a real "unused", not a tool limitation.
function formatPrecise(symbol: string, pathGlob: string | undefined, defCount: number, records: RefRecord[]): string {
  const scope = pathGlob ? ` within \`${pathGlob}\`` : '';
  if (records.length === 0) {
    return `0 references to \`${symbol}\`${scope} (precision: typescript — compiler-exact). It is defined but has no call sites${scope ? ' in scope' : ''}.`;
  }
  const defNote = defCount > 1 ? ` (${defCount} definitions share this name)` : '';
  const head = `${records.length} reference${records.length === 1 ? '' : 's'} to \`${symbol}\`${scope}${defNote} — compiler-exact, incl. member access (precision: typescript):`;
  const lines = records.map(
    (r) => `  ${r.file}:${r.line}  [${r.refKind}]  ${r.snippet}` + (r.resolvesTo ? `  -> ${r.resolvesTo.file}:${r.resolvesTo.line}` : ''),
  );
  return [head, ...lines].join('\n');
}
