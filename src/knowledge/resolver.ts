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
  return resolveLocators(store, concept.locators ?? []);
}

// Resolve a flat list of locators (members of a concept, or the locators of a
// `must` invariant) against the live index. Used by both the concept resolver and
// the conformance checker so they share one resolution path.
export function resolveLocators(store: IndexStore, locators: Locator[]): ResolvedLocation[] {
  return locators.flatMap((loc) => resolveLocator(store, loc));
}

export interface ConceptResolution {
  locations: ResolvedLocation[];
  error?: string;
}

// Resolve a concept without throwing on a malformed locator. A committed
// vocab.yaml travels to every teammate, so a single authoring slip (e.g. a
// symbol query missing its kind) must not blank the whole Knowledge layer: the
// error is reported per-concept (loud, never silently dropped) while siblings
// still resolve. Both arch tools route through here.
export function resolveConceptSafe(store: IndexStore, concept: Concept): ConceptResolution {
  try {
    return { locations: resolveConcept(store, concept) };
  } catch (err) {
    return { locations: [], error: err instanceof Error ? err.message : String(err) };
  }
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
  if (loc.kind === 'import') {
    // The import perimeter: distinct files whose import/re-export edges name this
    // specifier (exactly or a subpath of it). Pure string match over already-
    // extracted edges — no module resolution, no config read, no shell-out.
    const importers = new Set<string>();
    for (const e of store.allEdges()) {
      if (e.specifier === loc.of || e.specifier.startsWith(loc.of + '/')) {
        if (loc.in === undefined || matchGlob(e.file, loc.in)) importers.add(e.file);
      }
    }
    return [...importers]
      .sort()
      .map((f) => ({ file: f, kind: 'file', via: 'import' as const, precisionTier: 'tree-sitter' as const }));
  }
  return [...store.relFileSet()]
    .filter((f) => matchGlob(f, loc.glob) && (loc.in === undefined || matchGlob(f, loc.in)))
    .sort()
    .map((f) => ({ file: f, kind: 'file', via: 'path' as const, precisionTier: 'tree-sitter' as const }));
}

function byFileLine(a: { file: string; line: number }, b: { file: string; line: number }): number {
  return a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1;
}
