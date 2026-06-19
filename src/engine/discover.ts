import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Source extensions arcscope parses in P0 (TS/JS family). .d.ts is excluded
// separately — declaration files hold no navigable definitions.
const SOURCE_RE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
const DECL_RE = /\.d\.[cm]?ts$/;

// Directories the non-git fallback walk never descends into.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.arcscope']);

export function isSourceFile(name: string): boolean {
  return SOURCE_RE.test(name) && !DECL_RE.test(name);
}

// Returns absolute paths of source files under `root`.
//
// git-first: `git ls-files` (tracked + untracked-not-ignored) respects .gitignore
// for free, which is the single biggest correctness/perf lever — on a real repo it
// is the difference between ~1k real source files and ~18k including dist/ and
// tool caches. Falls back to a directory walk when `root` is not a git repo.
export function discoverFiles(root: string): string[] {
  return discoverViaGit(root) ?? walk(root, []);
}

function discoverViaGit(root: string): string[] | null {
  try {
    const raw = execFileSync(
      'git',
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return raw
      .split('\0')
      .filter((rel) => rel.length > 0 && isSourceFile(rel))
      .map((rel) => join(root, rel));
  } catch {
    return null; // not a git repo / git unavailable -> walk
  }
}

function walk(dir: string, out: string[]): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(join(dir, e.name), out);
    } else if (e.isFile() && isSourceFile(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}
