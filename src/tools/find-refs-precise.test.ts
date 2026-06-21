import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { ProgramStore } from '../engine/program-store.js';
import { runFindRefs } from './find-refs.js';

function project(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-fr-'));
  writeFileSync(join(dir, 'app.ts'), content);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: true }, include: ['app.ts'] }),
  );
  return dir;
}

// The exact case the member-access caveat was about: a method invoked via
// `obj.method()`. The tree-sitter import tier finds zero; the precise tier resolves
// the call sites compiler-exact.
const SRC = `class Repo {
  save(x: number): number { return x; }
}
function useIt(r: Repo): void {
  r.save(1);
  r.save(2);
}
function alsoUse(r: Repo): void {
  const n = r.save(3);
}`;

test('find_refs resolves a method via member access (precise tier) — the retired caveat', async () => {
  const dir = project(SRC);
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    const ps = new ProgramStore(dir);
    const res = await runFindRefs(store, new GrammarRegistry(), dir, { symbol: 'save' }, ps);
    assert.match(res.text, /precision: typescript/);
    assert.match(res.text, /incl\. member access/);
    // three r.save(...) call sites resolved
    assert.equal(res.records.length, 3);
    assert.ok(res.records.every((r) => r.precisionTier === 'typescript'));
    assert.ok(res.records.every((r) => r.refKind === 'call'));
    assert.doesNotMatch(res.text, /deferred|not in v1|cannot follow/); // no caveat
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('find_refs without a precise tier still degrades honestly for a method', async () => {
  const dir = project(SRC);
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    // no ProgramStore passed -> tree-sitter path; method member-access can't resolve
    const res = await runFindRefs(store, new GrammarRegistry(), dir, { symbol: 'save' });
    assert.match(res.text, /precise tier/); // points at the precise tier, not a dead end
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('find_refs stays on the fast tree-sitter tier for a non-method symbol', async () => {
  const dir = project(
    `export function helper(x: number): number { return x + 1; }\nexport function caller(): number { return helper(2); }`,
  );
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    const ps = new ProgramStore(dir);
    const res = await runFindRefs(store, new GrammarRegistry(), dir, { symbol: 'helper' }, ps);
    assert.match(res.text, /precision: tree-sitter/); // not escalated to the precise tier
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
