import { existsSync, readFileSync } from 'node:fs';
import { posix, join } from 'node:path';

const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx'];

interface Alias {
  prefix: string; // text before the '*' (or the whole key for exact aliases)
  wildcard: boolean;
  targets: string[]; // repo-relative, '*' kept for substitution
}

// Resolves a module specifier (as written in an import) to the repo-relative file
// it points at, or null for external/unresolvable specifiers. Handles relative
// paths and tsconfig `paths` aliases — the one sanctioned config read (spec §4
// lists tsconfig paths as a secondary signal; no nx.json/project.json/BUILD).
// File existence is delegated so resolution is tied to arcscope's index, not raw FS.
export class ModuleResolver {
  private aliases: Alias[] | null = null;

  constructor(
    private readonly root: string,
    private readonly fileExists: (rel: string) => boolean,
  ) {}

  resolve(importerRel: string, specifier: string): string | null {
    if (specifier.startsWith('.')) {
      const base = posix.dirname(importerRel);
      return this.tryCandidate(posix.normalize(posix.join(base, specifier)));
    }
    for (const alias of this.loadAliases()) {
      const substituted = this.matchAlias(alias, specifier);
      if (substituted === null) continue;
      for (const target of substituted) {
        const hit = this.tryCandidate(posix.normalize(target));
        if (hit) return hit;
      }
    }
    return null; // bare specifier (@angular/core, rxjs, …) — external
  }

  private matchAlias(alias: Alias, specifier: string): string[] | null {
    if (!alias.wildcard) {
      return specifier === alias.prefix ? alias.targets : null;
    }
    if (!specifier.startsWith(alias.prefix)) return null;
    const rest = specifier.slice(alias.prefix.length);
    return alias.targets.map((t) => t.replace('*', rest));
  }

  private tryCandidate(p: string): string | null {
    if (this.fileExists(p)) return p; // tsconfig targets often already carry .ts
    // NodeNext writes a './x.js' specifier for a './x.ts' source — strip the JS
    // extension so the candidate loop can find the real TS/JS file.
    const base = p.replace(/\.[cm]?jsx?$/, '');
    for (const ext of EXTS) if (this.fileExists(base + ext)) return base + ext;
    for (const ext of EXTS) if (this.fileExists(`${base}/index${ext}`)) return `${base}/index${ext}`;
    return null;
  }

  private loadAliases(): Alias[] {
    if (this.aliases) return this.aliases;
    this.aliases = [];
    for (const name of ['tsconfig.base.json', 'tsconfig.json']) {
      const file = join(this.root, name);
      if (!existsSync(file)) continue;
      let config: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
      try {
        config = JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
      } catch {
        continue;
      }
      const paths = config.compilerOptions?.paths;
      if (!paths) continue;
      const baseUrl = config.compilerOptions?.baseUrl ?? '.';
      for (const [key, targets] of Object.entries(paths)) {
        const wildcard = key.endsWith('*');
        this.aliases.push({
          prefix: wildcard ? key.slice(0, -1) : key,
          wildcard,
          targets: targets.map((t) => posix.normalize(posix.join(baseUrl, t))),
        });
      }
      break; // first tsconfig with paths wins
    }
    return this.aliases;
  }
}

// Tolerant JSON-with-comments parse prep: strip // and /* */ comments (respecting
// string literals) and trailing commas, so real-world tsconfigs parse.
function stripJsonc(s: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  let strCh = '';
  while (i < s.length) {
    const c = s[i]!;
    const n = s[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === strCh) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      strCh = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
