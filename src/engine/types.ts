// Shared engine shapes.

// Honest trust label on every result. tree-sitter is the only tier in v1; the
// field exists so an LSP-backed tier can be added later WITHOUT changing tool
// shapes, and so a heuristic answer is never presented as compiler-accurate.
export type PrecisionTier = 'tree-sitter';

// `kind` is the suffix of the tags.scm @definition.<kind> capture that matched
// (function, method, class, interface, type, enum, module, constant). Kept as a
// plain string so extending the vendored queries can't break the type.
export interface DefRecord {
  symbol: string;
  kind: string;
  file: string; // path relative to the index root, posix-style ('/')
  line: number; // 1-based, the line of the symbol's name
  signature: string; // first header line of the definition node, collapsed + truncated
  precisionTier: PrecisionTier;
}

// Per-file index bookkeeping. mtime+size is the cheap staleness signal (avoids
// re-reading unchanged files); `symbols` lets us evict a file's contributions on
// re-index without rescanning the whole def map.
export interface FileEntry {
  mtimeMs: number;
  size: number;
  symbols: string[];
}

// One import or re-export statement's edge data, extracted in the same parse pass
// as definitions. `names` holds the bindings: for an import, { imported: name in
// the source module, local: local alias }; for a re-export, { imported: name in
// the source, local: exported-as name }. Defaults use imported 'default';
// namespace/star use imported '*'. `names` is empty for side-effect imports and
// plain `export *` (star=true).
export interface ImportBinding {
  imported: string;
  local: string;
}

export interface ImportEdge {
  file: string; // the file containing the statement, relative to root (posix)
  specifier: string; // raw module specifier, e.g. './x' or '@scope/pkg'
  kind: 'import' | 're-export';
  star: boolean; // `import * as` or `export *`
  names: ImportBinding[];
  line: number;
}

export type RefKind = 'import' | 'call' | 'new' | 'type' | 'extends' | 'access' | 'identifier';

// A reference returned by find_refs. `resolved` is true when the import graph ties
// this occurrence to the target definition; otherwise precisionTier is
// 'unresolved-candidate' and it is never presented as compiler-accurate.
export interface RefRecord {
  symbol: string; // local name as referenced
  file: string;
  line: number;
  column: number;
  snippet: string;
  refKind: RefKind;
  resolved: boolean;
  resolvesTo: { file: string; line: number } | null;
  precisionTier: 'tree-sitter' | 'unresolved-candidate' | 'typescript';
}
