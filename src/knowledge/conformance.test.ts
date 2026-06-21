import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { resolveConcept } from './resolver.js';
import { checkConformance } from './conformance.js';
import type { Concept } from './types.js';

async function storeOver(files: Record<string, string>): Promise<{ store: IndexStore; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-conf-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  const store = new IndexStore(dir, new GrammarRegistry());
  await store.sync();
  return { store, dir };
}

test('checkConformance returns undefined when the concept declares no invariant', async () => {
  const { store, dir } = await storeOver({ 'a.ts': "import { x } from '@lib/foo';\nexport const a = 1;\n" });
  try {
    const concept: Concept = { id: 'c', title: 'c', locators: [{ kind: 'import', of: '@lib/foo' }] };
    assert.equal(checkConformance(store, concept, resolveConcept(store, concept)), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkConformance partitions members into conforming and violating by the invariant set', async () => {
  const { store, dir } = await storeOver({
    'ok.ts': "import { c } from '@lib/clone';\nimport { n } from '@lib/norm';\nexport const ok = 1;\n",
    'bad.ts': "import { c } from '@lib/clone';\nexport const bad = 2;\n", // member, but missing @lib/norm
  });
  try {
    const concept: Concept = {
      id: 'copy',
      title: 'copy',
      locators: [{ kind: 'import', of: '@lib/clone' }],
      must: { title: 'normalizes', locators: [{ kind: 'import', of: '@lib/norm' }] },
    };
    const report = checkConformance(store, concept, resolveConcept(store, concept));
    assert.equal(report?.total, 2);
    assert.equal(report?.conforming, 1);
    assert.deepEqual(report?.violations.map((v) => v.file), ['bad.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkConformance degrades (error, no throw) when the invariant locator is malformed', async () => {
  const { store, dir } = await storeOver({ 'a.ts': "import { c } from '@lib/clone';\nexport const a = 1;\n" });
  try {
    const concept: Concept = {
      id: 'c',
      title: 'c',
      locators: [{ kind: 'import', of: '@lib/clone' }],
      must: { title: 'bad', locators: [{ kind: 'symbol', query: 'noSpaceHere' }] }, // invalid query
    };
    const report = checkConformance(store, concept, resolveConcept(store, concept));
    assert.ok(report?.error);
    assert.deepEqual(report?.violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
