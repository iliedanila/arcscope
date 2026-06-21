import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammarRegistry } from '../engine/grammar-registry.js';
import { IndexStore } from '../engine/index-store.js';
import { runArchAssert } from './arch-assert.js';
import { runArchCandidates } from './arch-candidates.js';

// Fixture: the canonical clone helper, two app members that import it, and an
// orphan that RE-IMPLEMENTS the helper's internals with DIFFERENT names and no
// shared import — the case name/import matching misses but structure catches.
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arcscope-cand-'));
  mkdirSync(join(dir, 'libs'), { recursive: true });
  mkdirSync(join(dir, 'apps'), { recursive: true });
  mkdirSync(join(dir, 'workers'), { recursive: true });

  writeFileSync(
    join(dir, 'libs/record-clone.ts'),
    `export function cloneRecord(items, mapping) {
  const result = [];
  for (const item of items) { result.push(cloneItem(item, mapping)); }
  return result;
}
export function cloneItem(item, mapping) {
  const next = { id: mapping.get(item.id), fields: [] };
  for (const field of item.fields) {
    if (field.nested) { next.fields.push(clonePart(field, mapping)); }
    else { next.fields.push(field); }
  }
  return next;
}
export function clonePart(field, mapping) {
  const out = { id: mapping.get(field.id), nested: field.nested };
  if (field.ref) { out.ref = mapping.get(field.ref); }
  else { out.ref = null; }
  return out;
}
`,
  );

  writeFileSync(
    join(dir, 'apps/clone-user.ts'),
    `import { cloneRecord } from '@lib/record-clone';
import { reindexAfterClone } from '@lib/reindex';
export function cloneUser(rec, mapping) {
  const items = cloneRecord(rec.items, mapping);
  return reindexAfterClone(items);
}
`,
  );
  writeFileSync(
    join(dir, 'apps/duplicate-account.ts'),
    `import { cloneRecord } from '@lib/record-clone';
import { reindexAfterClone } from '@lib/reindex';
export function duplicateAccount(rec, mapping) {
  const items = cloneRecord(rec.items, mapping);
  return reindexAfterClone(items);
}
`,
  );

  writeFileSync(
    join(dir, 'workers/hand-clone-record.ts'),
    `export function copyItem(item, table) {
  const fresh = { id: table.get(item.id), fields: [] };
  for (const part of item.fields) {
    if (part.nested) { fresh.fields.push(copyPart(part, table)); }
    else { fresh.fields.push(part); }
  }
  return fresh;
}
export function copyPart(part, table) {
  const made = { id: table.get(part.id), nested: part.nested };
  if (part.ref) { made.ref = table.get(part.ref); }
  else { made.ref = null; }
  return made;
}
`,
  );
  return dir;
}

test('arch_candidates finds a renamed re-implementation by STRUCTURE (name-independent) and flags the invariant violation', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    await store.sync();
    await runArchAssert(dir, {
      id: 'record-clone',
      title: 'Record clone paths',
      locators: [{ kind: 'import', of: '@lib/record-clone' }],
      must: { title: 're-indexes after cloning', locators: [{ kind: 'import', of: '@lib/reindex' }] },
    });

    const res = await runArchCandidates(store, dir, { concept: 'record-clone' });

    const orphanHits = res.candidates.filter((c) => c.file === 'workers/hand-clone-record.ts');
    assert.ok(orphanHits.length >= 1, 'orphan file flagged as a structural candidate');
    assert.ok(orphanHits.some((c) => c.name === 'copyItem'));
    assert.ok(orphanHits.every((c) => c.score >= 0.8));

    assert.ok(res.candidates.every((c) => c.file === 'workers/hand-clone-record.ts'));

    assert.match(res.text, /would VIOLATE invariant/);
    assert.match(res.text, /workers\/hand-clone-record\.ts/);
    assert.match(res.text, /structural-similarity tier/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch_candidates: once the orphan is pinned as a member, it is no longer a candidate', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    await store.sync();
    await runArchAssert(dir, {
      id: 'record-clone',
      title: 'Record clone paths',
      locators: [
        { kind: 'import', of: '@lib/record-clone' },
        { kind: 'path', glob: 'workers/**/hand-clone-record.ts' },
      ],
    });

    const res = await runArchCandidates(store, dir, { concept: 'record-clone' });
    assert.ok(
      res.candidates.every((c) => c.file !== 'workers/hand-clone-record.ts'),
      'a pinned member is excluded from candidates',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arch_candidates handles an unknown concept gracefully', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    const res = await runArchCandidates(store, dir, { concept: 'nope' });
    assert.deepEqual(res.candidates, []);
    assert.match(res.text, /No concept "nope"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-asserting a concept in the same store is reflected immediately (no stale candidates)', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    await store.sync();
    await runArchAssert(dir, {
      id: 'record-clone',
      title: 'Record clone paths',
      locators: [{ kind: 'import', of: '@lib/record-clone' }],
    });
    const before = await runArchCandidates(store, dir, { concept: 'record-clone' });
    assert.ok(before.candidates.some((c) => c.file === 'workers/hand-clone-record.ts'));

    await runArchAssert(dir, {
      id: 'record-clone',
      title: 'Record clone paths',
      locators: [
        { kind: 'import', of: '@lib/record-clone' },
        { kind: 'path', glob: 'workers/**/hand-clone-record.ts' },
      ],
    });
    const after = await runArchCandidates(store, dir, { concept: 'record-clone' });
    assert.ok(
      after.candidates.every((c) => c.file !== 'workers/hand-clone-record.ts'),
      'the re-asserted (now-pinned) member is excluded on the very next call',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed must invariant degrades — candidates still returned, no crash, no violation flag', async () => {
  const dir = fixture();
  try {
    const store = new IndexStore(dir, new GrammarRegistry());
    await store.sync();
    await runArchAssert(dir, {
      id: 'record-clone',
      title: 'Record clone paths',
      locators: [{ kind: 'import', of: '@lib/record-clone' }],
      must: { title: 'bad', locators: [{ kind: 'symbol', query: 'noSpaceHere' }] },
    });
    const res = await runArchCandidates(store, dir, { concept: 'record-clone' });
    assert.ok(res.candidates.some((c) => c.file === 'workers/hand-clone-record.ts'));
    assert.doesNotMatch(res.text, /would VIOLATE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
