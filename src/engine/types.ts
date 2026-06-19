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
