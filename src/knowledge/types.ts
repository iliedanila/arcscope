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

// An invariant (the `must` clause): a rule every member of a concept has to
// satisfy, expressed in the SAME locator vocabulary. Conformance = every member
// file must appear in the set resolved by these locators; members outside it are
// violations. This is what makes an agent-written assertion safe — it is
// re-checked against live code on every read, never stored as a bare fact.
export interface Invariant {
  title?: string;
  locators: Locator[];
}

// A flow binding: the concept is one FLOW, resolved live via the precise tier (the
// method-resolved call closure + edge cases) from an entry point. Lets the agent
// persist a reviewed flow so a later session inherits it — re-run on read, with
// drift on the flow's membership (a function entering/leaving the flow).
export interface FlowBinding {
  entry: string; // entry-point function/method symbol
  pathGlob?: string; // disambiguate the entry's definition
}

export interface Concept {
  id: string;
  title: string;
  description?: string;
  note?: string; // honest note for degraded concepts (anchors-only) / the agent's flow notes
  locators?: Locator[];
  stages?: Stage[];
  must?: Invariant; // optional conformance rule (v2)
  flow?: FlowBinding; // a flow concept (precise tier) instead of locators/stages
  source?: 'vocab' | 'agent'; // provenance: human-authored vs agent-asserted (assigned at load)
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
