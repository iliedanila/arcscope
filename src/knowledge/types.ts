// The architecture vocabulary: named concepts bound to engine-resolved locators.

// A symbol locator is a query over the def index; a path locator is a glob over
// the tree. Both optionally scoped by `in`. NEVER a shell command (invariant 4).
export interface SymbolLocator {
  kind: 'symbol';
  query: string; // "<kind> <namePattern> [= <valueConstraint>]"
  in?: string; // glob scoping which files count
}
export interface PathLocator {
  kind: 'path';
  glob: string;
  in?: string;
}
// An import locator resolves the live IMPORT PERIMETER: every file that imports a
// given module specifier (exactly, or a subpath of it). It reads the engine's
// already-extracted import edges — the SAME data as dep_graph/find_refs, not a new
// backend — so it adds no new failure mode and never reads or evaluates a config
// file (invariant 4: locators resolve through the engine, never shell out). Lets a
// concept assert an import-boundary rule ("who imports @angular/fire/firestore?")
// and drift-detect changes to that perimeter live.
export interface ImportLocator {
  kind: 'import';
  of: string; // module specifier; matches `of` exactly or any subpath `of/...`
  in?: string;
}
export type Locator = SymbolLocator | PathLocator | ImportLocator;

// A stage is a locator with an ordinal title — staged concepts (e.g. an action
// pipeline) are returned in sequence.
export type Stage = Locator & { title: string };

export interface Concept {
  id: string;
  title: string;
  description?: string;
  note?: string; // honest note for degraded concepts (anchors-only)
  locators?: Locator[];
  stages?: Stage[];
}

export interface Vocabulary {
  concepts: Concept[];
}

// One resolved location. `via` records which locator kind produced it; `stage` is
// the stage title for staged concepts. precisionTier stays tree-sitter.
export interface ResolvedLocation {
  file: string;
  line?: number;
  kind: string; // def kind for symbols; 'file' for path locators
  symbol?: string;
  signature?: string;
  stage?: string;
  via: 'symbol' | 'path' | 'import';
  precisionTier: 'tree-sitter';
}
