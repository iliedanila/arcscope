import { readFileSync, statSync } from 'node:fs';
import { extname, relative, sep } from 'node:path';
import { discoverFiles } from './discover.js';
import { extractDefs } from './extract.js';
import { extractImports } from './imports.js';
import type { GrammarRegistry } from './grammar-registry.js';
import { matchGlob } from './glob.js';
import type { DefRecord, FileEntry, ImportEdge } from './types.js';

export interface SyncStats {
  fileCount: number;
  symbolCount: number;
  changed: number;
  removed: number;
  elapsedMs: number;
}

// The in-memory index: bare symbol name -> definitions across the repo. No
// persistent store, no file watcher (a deliberate slice cut). `sync()` is the
// single idempotent index lifecycle: the first call is a full build; later calls
// re-discover and re-extract only files whose mtime/size changed, and evict
// deleted ones. That's the lazy re-index — cheap because unchanged files are
// never re-read.
export class IndexStore {
  private readonly defs = new Map<string, DefRecord[]>();
  private readonly files = new Map<string, FileEntry>(); // absolute path -> entry
  private readonly edges = new Map<string, ImportEdge[]>(); // absolute path -> import/re-export edges

  constructor(
    private readonly root: string,
    private readonly registry: GrammarRegistry,
  ) {}

  get fileCount(): number {
    return this.files.size;
  }

  get symbolCount(): number {
    let n = 0;
    for (const arr of this.defs.values()) n += arr.length;
    return n;
  }

  get edgeCount(): number {
    let n = 0;
    for (const arr of this.edges.values()) n += arr.length;
    return n;
  }

  // All definitions across the repo (used by the vocabulary resolver).
  allDefs(): DefRecord[] {
    const out: DefRecord[] = [];
    for (const arr of this.defs.values()) out.push(...arr);
    return out;
  }

  // All import/re-export edges across the repo (used by the import graph).
  allEdges(): ImportEdge[] {
    const out: ImportEdge[] = [];
    for (const arr of this.edges.values()) out.push(...arr);
    return out;
  }

  // The set of indexed files, relative-posix — used to confirm a resolved
  // module specifier actually points at a file arcscope knows about.
  relFileSet(): Set<string> {
    const out = new Set<string>();
    for (const abs of this.files.keys()) out.add(this.relPath(abs));
    return out;
  }

  async sync(): Promise<SyncStats> {
    const start = performance.now();
    const current = discoverFiles(this.root);
    const currentSet = new Set(current);

    let removed = 0;
    for (const abs of [...this.files.keys()]) {
      if (!currentSet.has(abs)) {
        this.evict(abs);
        removed++;
      }
    }

    let changed = 0;
    for (const abs of current) {
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const prev = this.files.get(abs);
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
      await this.indexFile(abs, st.mtimeMs, st.size);
      changed++;
    }

    return {
      fileCount: this.files.size,
      symbolCount: this.symbolCount,
      changed,
      removed,
      elapsedMs: Math.round(performance.now() - start),
    };
  }

  find(symbol: string, pathGlob?: string): DefRecord[] {
    const arr = this.defs.get(symbol) ?? [];
    const res = pathGlob ? arr.filter((r) => matchGlob(r.file, pathGlob)) : arr;
    return [...res].sort(byFileLine);
  }

  // Approximate name matches, used only when an exact find() returns nothing — so
  // the agent doesn't have to guess the precise symbol name. Returns one
  // representative definition per similarly-named symbol (case-insensitive),
  // ranked: prefix match, then substring, then the query containing the name.
  // Matching is by NAME only; the returned locations are still exact.
  findFuzzy(symbol: string, pathGlob?: string, limit = 12): DefRecord[] {
    const q = symbol.toLowerCase();
    const matches: { rec: DefRecord; score: number }[] = [];
    for (const [name, recs] of this.defs) {
      const lower = name.toLowerCase();
      if (lower === q) continue; // exact is handled by find()
      let score: number;
      if (lower.startsWith(q)) score = 0;
      else if (lower.includes(q)) score = 1;
      // The weakest signal — the query contains the symbol's name — only counts for
      // substantial names, else tiny symbols like `y`/`ry` pollute every query.
      else if (lower.length >= 4 && q.includes(lower)) score = 2;
      else continue;
      const inScope = pathGlob ? recs.filter((r) => matchGlob(r.file, pathGlob)) : recs;
      if (inScope.length === 0) continue;
      matches.push({ rec: [...inScope].sort(byFileLine)[0]!, score });
    }
    matches.sort(
      (a, b) =>
        a.score - b.score ||
        a.rec.symbol.length - b.rec.symbol.length ||
        (a.rec.symbol < b.rec.symbol ? -1 : 1),
    );
    return matches.slice(0, limit).map((m) => m.rec);
  }

  private async indexFile(abs: string, mtimeMs: number, size: number): Promise<void> {
    this.evict(abs);
    const grammar = await this.registry.getForExt(extname(abs));
    if (!grammar) return; // unsupported extension (shouldn't happen after discovery filter)
    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      return;
    }
    const parser = await this.registry.ensureInit();
    parser.setLanguage(grammar.language);
    const tree = parser.parse(source);
    if (!tree) return;
    const rel = this.relPath(abs);
    try {
      const records = extractDefs(grammar.query, rel, tree);
      const fileEdges = extractImports(rel, tree);
      const symbols = new Set<string>();
      for (const r of records) {
        let arr = this.defs.get(r.symbol);
        if (!arr) {
          arr = [];
          this.defs.set(r.symbol, arr);
        }
        arr.push(r);
        symbols.add(r.symbol);
      }
      if (fileEdges.length > 0) this.edges.set(abs, fileEdges);
      this.files.set(abs, { mtimeMs, size, symbols: [...symbols] });
    } finally {
      tree.delete();
    }
  }

  private evict(abs: string): void {
    const entry = this.files.get(abs);
    if (!entry) return;
    const rel = this.relPath(abs);
    for (const sym of entry.symbols) {
      const arr = this.defs.get(sym);
      if (!arr) continue;
      const kept = arr.filter((r) => r.file !== rel);
      if (kept.length) this.defs.set(sym, kept);
      else this.defs.delete(sym);
    }
    this.edges.delete(abs);
    this.files.delete(abs);
  }

  private relPath(abs: string): string {
    const rel = relative(this.root, abs);
    return sep === '/' ? rel : rel.split(sep).join('/');
  }
}

function byFileLine(a: DefRecord, b: DefRecord): number {
  return a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1;
}
