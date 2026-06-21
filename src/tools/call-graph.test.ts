import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { ProgramStore } from '../engine/program-store.js';
import { runCallGraph } from './call-graph.js';

// A fixture with real DI/interface method dispatch: Service.run calls this.repo.save()
// where repo is typed as the INTERFACE IRepo — so resolving the callee requires the
// type checker + the impl hop (tree-sitter/grep cannot follow it).
function fixture(extra = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-cg-'));
  writeFileSync(
    join(dir, 'app.ts'),
    `interface IRepo { save(x: number): number; }
function helper(x: number): number { return x + 1; }
class Repo implements IRepo {
  save(x: number): number { return helper(x); }
}
export class Service {
  constructor(private repo: IRepo) {}
  run(x: number): number {
    return this.repo.save(Math.max(x, 0));
  }
}
${extra}`,
  );
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: true }, include: ['app.ts'] }),
  );
  return dir;
}

test('call_graph resolves DI/interface method dispatch to the concrete impl and follows it', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    const programStore = new ProgramStore(dir);
    const res = await runCallGraph(store, programStore, dir, { symbol: 'run' });

    assert.match(res.text, /precision tier: typescript/);
    // this.repo.save (IRepo, abstract) -> recovered to Repo.save (concrete) -> helper
    assert.match(res.text, /\brun\b/);
    assert.match(res.text, /\bsave\b/, 'method dispatch resolved to the concrete impl');
    assert.match(res.text, /\bhelper\b/, 'followed the concrete impl into its own calls');
    // Math.max is a library call, counted at the boundary, not followed.
    assert.match(res.text, /lib/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('call_graph: depth limit is honored', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    const programStore = new ProgramStore(dir);
    const shallow = await runCallGraph(store, programStore, dir, { symbol: 'run', depth: 1 });
    // depth 1: run -> save, but save's body (helper) is past the cap
    assert.match(shallow.text, /\bsave\b/);
    assert.doesNotMatch(shallow.text, /\bhelper\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('call_graph: unknown symbol and non-function are handled', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    const programStore = new ProgramStore(dir);
    const miss = await runCallGraph(store, programStore, dir, { symbol: 'doesNotExist' });
    assert.match(miss.text, /No definition of `doesNotExist`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('call_graph: a file with no governing tsconfig degrades gracefully', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-cg-noconfig-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/x.ts'), 'export function lonely() { return helper(); }\nfunction helper() { return 1; }\n');
    const store = new IndexStore(dir, new GrammarRegistry());
    const programStore = new ProgramStore(dir);
    const res = await runCallGraph(store, programStore, dir, { symbol: 'lonely' });
    assert.match(res.text, /no tsconfig governs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function project(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-cg-'));
  writeFileSync(join(dir, 'app.ts'), content);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: true }, include: ['app.ts'] }),
  );
  return dir;
}
const trace = (dir: string, symbol: string, depth?: number) =>
  runCallGraph(new IndexStore(dir, new GrammarRegistry()), new ProgramStore(dir), dir, { symbol, depth });

test('call_graph follows an OVERLOADED free function to its implementation (not dropped as unresolved)', async () => {
  const dir = project(
    `function fmt(x: number): string;
function fmt(x: string): string;
function fmt(x: unknown): string { return String(x); }
export function useFmt(n: number): string { return fmt(n); }`,
  );
  try {
    const res = await trace(dir, 'useFmt');
    assert.match(res.text, /\bfmt\b\s+app\.ts:\d+/, 'overloaded free function resolved to its impl');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('call_graph traverses constructor calls (new X())', async () => {
  const dir = project(
    `function boost(n: number): number { return n * 2; }
class Widget { size: number; constructor(n: number) { this.size = boost(n); } }
export function makeWidget(n: number): Widget { return new Widget(n); }`,
  );
  try {
    const res = await trace(dir, 'makeWidget');
    assert.match(res.text, /constructor/, 'new Widget() followed into the constructor');
    assert.match(res.text, /\bboost\b/, 'and into what the constructor calls');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('call_graph distinguishes DAG re-convergence (⇒) from real recursion (↩)', async () => {
  const dir = project(
    `function shared(x: number): number { return x + 1; }
function leftA(x: number): number { return shared(x); }
function rightA(x: number): number { return shared(x); }
export function diamond(x: number): number { return leftA(x) + rightA(x); }
function countdown(n: number): number { return n <= 0 ? 0 : countdown(n - 1); }
export function startCountdown(n: number): number { return countdown(n); }`,
  );
  try {
    const d = await trace(dir, 'diamond');
    assert.match(d.text, /\(⇒\)/, 'shared reached twice is marked seen-elsewhere');
    assert.doesNotMatch(d.text, /\(↩\)/, 'and NOT mislabeled as recursion');
    const c = await trace(dir, 'startCountdown');
    assert.match(c.text, /\(↩\)/, 'genuine self-recursion is still detected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
