import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { ProgramStore } from '../engine/program-store.js';
import { runArchAssert } from './arch-assert.js';
import { runArchQuery } from './arch-query.js';
import { runArchList } from './arch-list.js';

function project(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-flowc-'));
  writeFileSync(join(dir, 'app.ts'), content);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: true }, include: ['app.ts'] }),
  );
  return dir;
}

const BASE = `function leaf(x: number): number { return x + 1; }
function mid(x: number): number { return leaf(x); }
export function startFlow(x: number): number { return mid(x); }`;

test('A→B: a flow concept is asserted, then a FRESH session recomputes it live (precise tier) with a drift baseline', async () => {
  const dir = project(BASE);
  try {
    // ── Session A: record the flow concept (entry only — never a frozen member list). ──
    await runArchAssert(dir, { id: 'doc-flow', title: 'Doc flow', flow: { entry: 'startFlow' } });
    assert.ok(existsSync(join(dir, '.arcscope/assertions.yaml')));

    // ── Session B: brand-new stores; arch_query recomputes the flow from the entry. ──
    const res = await runArchQuery(new IndexStore(dir, new GrammarRegistry()), dir, { concept: 'doc-flow' }, new ProgramStore(dir));
    assert.match(res.text, /Flow concept `doc-flow` \[agent-asserted\]/);
    assert.match(res.text, /\bstartFlow\b/);
    assert.match(res.text, /\bmid\b/);
    assert.match(res.text, /\bleaf\b/); // resolved live, not stored
    assert.match(res.text, /baseline captured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a flow concept DRIFTS when a function enters the flow', async () => {
  const dir = project(BASE);
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    const ps = new ProgramStore(dir);
    await runArchAssert(dir, { id: 'doc-flow', title: 'Doc flow', flow: { entry: 'startFlow' } });
    await runArchQuery(store, dir, { concept: 'doc-flow' }, ps); // captures baseline

    // mid now also calls a new function -> it enters the flow.
    writeFileSync(
      join(dir, 'app.ts'),
      `function extra(x: number): number { return x * 2; }
function leaf(x: number): number { return x + 1; }
function mid(x: number): number { return leaf(extra(x)); }
export function startFlow(x: number): number { return mid(x); }`,
    );
    const drifted = await runArchQuery(store, dir, { concept: 'doc-flow' }, ps);
    assert.match(drifted.text, /DRIFTED/);
    assert.match(drifted.text, /1 entered, 0 left the flow/);
    assert.match(drifted.text, /\+ app\.ts#extra/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch_list labels a flow concept (cheaply, without building the program)', async () => {
  const dir = project(BASE);
  try {
    await runArchAssert(dir, { id: 'doc-flow', title: 'Doc flow', flow: { entry: 'startFlow' } });
    const list = await runArchList(new IndexStore(dir, new GrammarRegistry()), dir);
    assert.match(list.text, /doc-flow \(flow\) \[agent\] — Doc flow · from startFlow/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch_assert rejects a concept with neither a binding nor a flow', async () => {
  const dir = project(BASE);
  try {
    const res = await runArchAssert(dir, { id: 'empty', title: 'Empty' });
    assert.match(res.text, /needs either "locators".*or a "flow"/);
    assert.ok(!existsSync(join(dir, '.arcscope/assertions.yaml')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
