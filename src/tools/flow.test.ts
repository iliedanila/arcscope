import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { ProgramStore } from '../engine/program-store.js';
import { runFlow } from './flow.js';

function project(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-flow-'));
  writeFileSync(join(dir, 'app.ts'), content);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: true }, include: ['app.ts'] }),
  );
  return dir;
}
const flow = (dir: string, symbol: string) =>
  runFlow(new IndexStore(dir, new GrammarRegistry()), new ProgramStore(dir), dir, { symbol });

test('flow annotates each function with its structural edge cases and rolls them up', async () => {
  const dir = project(
    `async function fetchIt(n: number): Promise<number> { return n; }
async function risky(x: number): Promise<number> {
  if (x < 0) { throw new Error('neg'); }
  try {
    const y = await fetchIt(x);
    return x > 10 ? y : 0;
  } catch (e) {
    return -1;
  }
}
export async function startRisky(x: number): Promise<number> { return risky(x); }`,
  );
  try {
    const res = await flow(dir, 'startRisky');
    // risky: if + ternary = 2 branches; try + throw = 2 error sites; 1 await
    assert.match(res.text, /risky\s+app\.ts:\d+.*\{2 branch, 2 err, 1 await\}/);
    // rollup line
    assert.match(res.text, /2 decision points/);
    assert.match(res.text, /2 error-handling sites/);
    assert.match(res.text, /1 async boundary/);
    assert.match(res.text, /precision tier: typescript/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flow on a branch-free flow reports a zero edge-case surface', async () => {
  const dir = project(
    `function add(a: number, b: number): number { return a + b; }
export function compute(a: number, b: number): number { return add(a, b); }`,
  );
  try {
    const res = await flow(dir, 'compute');
    assert.match(res.text, /0 decision points/);
    assert.match(res.text, /0 error-handling sites/);
    assert.match(res.text, /0 async boundaries/);
    assert.match(res.text, /add {2}app\.ts:\d+$/m); // tree node carries no edge-case tag
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flow degrades gracefully without a tsconfig', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-flow-nc-'));
  try {
    writeFileSync(join(dir, 'x.ts'), 'export function lonely() { return 1; }\n');
    const res = await flow(dir, 'lonely');
    assert.match(res.text, /no tsconfig governs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
