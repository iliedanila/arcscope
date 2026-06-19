import { readFileSync, statSync } from 'node:fs';
import { extname, relative, sep } from 'node:path';
import { discoverFiles } from './discover.js';
import { extractDefs } from './extract.js';
import type { GrammarRegistry } from './grammar-registry.js';
import { matchGlob } from './glob.js';
import type { DefRecord, FileEntry } from './types.js';

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
    return [...res].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
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
    const rel = this.relPath(abs);
    const records = extractDefs(parser, grammar.language, grammar.query, rel, source);
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
    this.files.set(abs, { mtimeMs, size, symbols: [...symbols] });
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
    this.files.delete(abs);
  }

  private relPath(abs: string): string {
    const rel = relative(this.root, abs);
    return sep === '/' ? rel : rel.split(sep).join('/');
  }
}
