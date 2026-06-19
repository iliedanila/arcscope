import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { runDepGraph } from './dep-graph.js';

// a -> b -> c, and a -> c (so c is the most depended-on)
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-dep-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/c.ts'), 'export const c = 1;\n');
  writeFileSync(join(dir, 'src/b.ts'), "import { c } from './c';\nexport const b = c;\n");
  writeFileSync(join(dir, 'src/a.ts'), "import { b } from './b';\nimport { c } from './c';\nexport const a = b + c;\n");
  return dir;
}

test('dep_graph hubs view ranks the most depended-on file', async () => {
  const dir = fixture();
  try {
    const registry = new GrammarRegistry();
    const store = new IndexStore(dir, registry);
    const { nodes, text } = await runDepGraph(store, dir, {});
    const c = nodes.find((n) => n.id === 'src/c.ts');
    const a = nodes.find((n) => n.id === 'src/a.ts');
    assert.equal(c?.inDegree, 2); // imported by a and b
    assert.equal(a?.outDegree, 2); // imports b and c
    assert.match(text, /Most depended-on/);
    assert.match(text, /src\/c\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dep_graph cycles:true detects a circular dependency and is silent when acyclic', async () => {
  const acyclic = fixture(); // a -> b -> c, a -> c (no cycle)
  try {
    const registry = new GrammarRegistry();
    const store = new IndexStore(acyclic, registry);
    const clean = await runDepGraph(store, acyclic, { cycles: true });
    assert.equal(clean.cycles?.length, 0);
    assert.match(clean.text, /acyclic/);
  } finally {
    rmSync(acyclic, { recursive: true, force: true });
  }

  // now a genuine cycle: x <-> y
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-cycle-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/x.ts'), "import { y } from './y';\nexport const x = () => y;\n");
    writeFileSync(join(dir, 'src/y.ts'), "import { x } from './x';\nexport const y = () => x;\n");
    const registry = new GrammarRegistry();
    const store = new IndexStore(dir, registry);
    const { cycles, text } = await runDepGraph(store, dir, { cycles: true });
    assert.equal(cycles?.length, 1);
    assert.deepEqual(new Set(cycles?.[0]), new Set(['src/x.ts', 'src/y.ts']));
    assert.match(text, /1 circular dependency group/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dep_graph neighborhood lists imports and dependents of a focus file', async () => {
  const dir = fixture();
  try {
    const registry = new GrammarRegistry();
    const store = new IndexStore(dir, registry);
    const { edges, text } = await runDepGraph(store, dir, { focus: 'src/b.ts' });
    // b imports c, and is imported by a
    assert.ok(edges.some((e) => e.source === 'src/b.ts' && e.target === 'src/c.ts'));
    assert.ok(edges.some((e) => e.source === 'src/a.ts' && e.target === 'src/b.ts'));
    assert.match(text, /Neighborhood of src\/b\.ts/);
    assert.match(text, /imported by/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
