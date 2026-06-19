import type { IndexStore } from '../engine/index-store.js';
import { matchGlob } from '../engine/glob.js';
import { parseSymbolQuery } from './locator.js';
import type { Concept, Locator, ResolvedLocation } from './types.js';

// Resolve a concept LIVE against the current index. Symbol locators filter the def
// index (reuse P0); path locators filter the file set. Staged concepts resolve
// each stage in order and tag results with the stage title. Everything routes
// through the engine — no shell-out.
export function resolveConcept(store: IndexStore, concept: Concept): ResolvedLocation[] {
  if (concept.stages) {
    const out: ResolvedLocation[] = [];
    for (const stage of concept.stages) {
      for (const loc of resolveLocator(store, stage)) out.push({ ...loc, stage: stage.title });
    }
    return out;
  }
  return (concept.locators ?? []).flatMap((loc) => resolveLocator(store, loc));
}

function resolveLocator(store: IndexStore, loc: Locator): ResolvedLocation[] {
  if (loc.kind === 'symbol') {
    const { kind, namePattern, valueConstraint } = parseSymbolQuery(loc.query);
    return store
      .allDefs()
      .filter(
        (d) =>
          d.kind === kind &&
          matchGlob(d.symbol, namePattern) &&
          (loc.in === undefined || matchGlob(d.file, loc.in)) &&
          (valueConstraint === undefined || d.signature.includes(valueConstraint)),
      )
      .sort(byFileLine)
      .map((d) => ({
        file: d.file,
        line: d.line,
        kind: d.kind,
        symbol: d.symbol,
        signature: d.signature,
        via: 'symbol' as const,
        precisionTier: 'tree-sitter' as const,
      }));
  }
  return [...store.relFileSet()]
    .filter((f) => matchGlob(f, loc.glob) && (loc.in === undefined || matchGlob(f, loc.in)))
    .sort()
    .map((f) => ({ file: f, kind: 'file', via: 'path' as const, precisionTier: 'tree-sitter' as const }));
}

function byFileLine(a: { file: string; line: number }, b: { file: string; line: number }): number {
  return a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1;
}
