#!/usr/bin/env node
// Phase 1 precision kill-criterion (spec §13). For each symbol, compare arcscope
// find_refs vs `git grep` on a target repo. The claim find_refs must earn:
// it drops same-named false positives (occurrences in files that don't import the
// symbol) WITHOUT dropping genuine refs. We classify every grep-only file as a
// false positive find_refs correctly excluded, or a potential false negative.
//
// Usage: node scripts/precision-check.mjs --repo <path> [symbol ...]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const repoIdx = argv.indexOf('--repo');
const repo = repoIdx >= 0 ? argv[repoIdx + 1] : null;
const symbols = argv.filter((a) => !a.startsWith('--') && a !== repo);

if (!repo) {
  console.error('Usage: node scripts/precision-check.mjs --repo <path> [symbol ...]');
  process.exit(1);
}
if (symbols.length === 0) {
  console.error('Pass at least one symbol to check, e.g.: node scripts/precision-check.mjs --repo . MyService');
  process.exit(1);
}

const { GrammarRegistry } = await import(join(here, '..', 'dist', 'engine', 'grammar-registry.js'));
const { IndexStore } = await import(join(here, '..', 'dist', 'engine', 'index-store.js'));
const { runFindRefs } = await import(join(here, '..', 'dist', 'tools', 'find-refs.js'));

const registry = new GrammarRegistry();
const store = new IndexStore(repo, registry);

function gitGrepFiles(symbol) {
  try {
    const out = execFileSync('git', ['-C', repo, 'grep', '-l', '-w', symbol, '--', '*.ts', '*.tsx'], { encoding: 'utf8' });
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

function fileImports(repoRel, symbol) {
  try {
    // strip comments first so a symbol named only in a comment isn't counted as an import
    const src = readFileSync(join(repo, repoRel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    return new RegExp(`import[^;]*\\b${symbol}\\b[^;]*from`, 's').test(src);
  } catch {
    return false;
  }
}

console.log(`\nPrecision check vs git grep — repo: ${repo}\n`);
for (const symbol of symbols) {
  const t0 = performance.now();
  const { records } = await runFindRefs(store, registry, repo, { symbol });
  const ms = Math.round(performance.now() - t0);

  const refFiles = new Set(records.map((r) => r.file));
  const grepFiles = gitGrepFiles(symbol);
  const grepOnly = [...grepFiles].filter((f) => !refFiles.has(f));
  const falsePositives = grepOnly.filter((f) => !fileImports(f, symbol)); // has the name, doesn't import it
  const potentialFN = grepOnly.filter((f) => fileImports(f, symbol)); // imports it but find_refs missed

  const resolvesTo = new Set(records.map((r) => r.resolvesTo?.file).filter(Boolean));
  console.log(`■ ${symbol}  (${ms}ms)`);
  console.log(`    find_refs: ${records.length} refs across ${refFiles.size} files; resolves to ${resolvesTo.size} definition(s)`);
  console.log(`    git grep : ${grepFiles.size} files mention the name`);
  console.log(`    grep files find_refs EXCLUDED as false positives (name present, not imported): ${falsePositives.length}`);
  if (falsePositives.length) console.log(`       e.g. ${falsePositives.slice(0, 4).join(', ')}`);
  console.log(`    potential false negatives (imports it but find_refs missed): ${potentialFN.length}`);
  if (potentialFN.length) console.log(`       e.g. ${potentialFN.slice(0, 6).join(', ')}`);
  console.log('');
}
