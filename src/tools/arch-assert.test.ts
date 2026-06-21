import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { runArchAssert } from './arch-assert.js';
import { runArchQuery } from './arch-query.js';
import { runArchList } from './arch-list.js';
import type { AssertionInput } from '../knowledge/assertion-store.js';

// Fixture: two app paths import the shared clone helper and re-indexer; one worker path
// hand-mirrors the clone (imports neither) — the orphan that shares no signal with the others.
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-assert-'));
  mkdirSync(join(dir, 'apps'), { recursive: true });
  mkdirSync(join(dir, 'workers'), { recursive: true });
  writeFileSync(
    join(dir, 'apps/clone-user.ts'),
    "import { cloneRecord } from '@lib/record-clone';\n" +
      "import { reindexAfterClone } from '@lib/reindex';\n" +
      'export function cloneUser() { return reindexAfterClone(cloneRecord([])); }\n',
  );
  writeFileSync(
    join(dir, 'apps/duplicate-account.ts'),
    "import { cloneRecord } from '@lib/record-clone';\n" +
      "import { reindexAfterClone } from '@lib/reindex';\n" +
      'export function duplicateAccount() { return reindexAfterClone(cloneRecord([])); }\n',
  );
  writeFileSync(
    join(dir, 'workers/hand-clone-record.ts'),
    'export function handCloneRecord() { return { cloned: true }; }\n',
  );
  return dir;
}

const RECORD_CLONE: AssertionInput = {
  id: 'record-clone',
  title: 'Record clone paths',
  description: 'Every way a record is cloned.',
  locators: [
    { kind: 'import', of: '@lib/record-clone' },
    { kind: 'path', glob: 'workers/**/hand-clone-record.ts' },
  ],
  must: {
    title: 're-indexes after cloning',
    locators: [{ kind: 'import', of: '@lib/reindex' }],
  },
};

test('A→B: an asserted concept persists and a fresh session inherits it + its conformance verdict', async () => {
  const dir = fixture();
  try {
    const storeA = new IndexStore(dir, new GrammarRegistry());
    await storeA.sync();
    await runArchAssert(dir, RECORD_CLONE);
    assert.ok(existsSync(join(dir, '.arcscope/assertions.yaml')), 'assertion persisted to disk');
    assert.ok(!existsSync(join(dir, '.arcscope/vocab.yaml')));

    const storeB = new IndexStore(dir, new GrammarRegistry());
    const res = await runArchQuery(storeB, dir, { concept: 'record-clone' });

    assert.deepEqual(
      res.resolved.map((r) => r.file).sort(),
      ['apps/clone-user.ts', 'apps/duplicate-account.ts', 'workers/hand-clone-record.ts'],
    );

    assert.equal(res.conformance?.total, 3);
    assert.equal(res.conformance?.conforming, 2);
    assert.deepEqual(
      res.conformance?.violations.map((v) => v.file),
      ['workers/hand-clone-record.ts'],
    );
    assert.match(res.text, /CONFORMANCE/);
    assert.match(res.text, /workers\/hand-clone-record\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixing the orphan clears the violation (conformance re-checks live)', async () => {
  const dir = fixture();
  try {
    const storeA = new IndexStore(dir, new GrammarRegistry());
    await storeA.sync();
    await runArchAssert(dir, RECORD_CLONE);

    writeFileSync(
      join(dir, 'workers/hand-clone-record.ts'),
      "import { reindexAfterClone } from '@lib/reindex';\n" +
        'export function handCloneRecord() { return { cloned: reindexAfterClone([]) }; }\n',
    );

    const storeB = new IndexStore(dir, new GrammarRegistry());
    const res = await runArchQuery(storeB, dir, { concept: 'record-clone' });
    assert.equal(res.conformance?.violations.length, 0);
    assert.match(res.text, /✓ conformance/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch_list shows the asserted concept', async () => {
  const dir = fixture();
  try {
    const storeA = new IndexStore(dir, new GrammarRegistry());
    await storeA.sync();
    await runArchAssert(dir, RECORD_CLONE);

    const storeB = new IndexStore(dir, new GrammarRegistry());
    const list = await runArchList(storeB, dir);
    assert.equal(list.conceptCount, 1);
    assert.match(list.text, /record-clone — Record clone paths/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-asserting the same id updates in place; a second assertion is preserved', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    await store.sync();
    await runArchAssert(dir, RECORD_CLONE);
    await runArchAssert(dir, { ...RECORD_CLONE, title: 'Record clone paths (revised)' });
    await runArchAssert(dir, {
      id: 'persistence-island',
      title: 'Persistence island',
      locators: [{ kind: 'import', of: '@lib/record-clone' }],
    });

    const list = await runArchList(new IndexStore(dir, new GrammarRegistry()), dir);
    assert.equal(list.conceptCount, 2);
    assert.match(list.text, /Record clone paths \(revised\)/);
    assert.match(list.text, /persistence-island/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
